// backend/src/services/executionData.js
// Shared execution-data logic used by the executions routes AND the
// change-request approval flow (post-closure corrections):
//   - milk quantity math (litres → kgs, kg fat/snf)
//   - computeExecutionDistance: road km for start → BMCUs → delivery
//   - applyExecutionData: persist bmcus/shift rows/entries/acknowledgements,
//     recalc totals and distance — the single write path for execution data.

const { haversineKm, ROAD_FACTOR } = require('../utils/geo');
const { getMasterDistanceKm, upsertMasterDistanceKm } = require('./distanceLookup');
const { googleLegKm } = require('./roadDistance');

const KG_FACTOR = 1.0285;

function calcKgs(litres)          { return litres ? parseFloat(litres) * KG_FACTOR : 0; }
function calcKgFat(kgs, fatPct)   { return kgs && fatPct ? parseFloat(kgs) * parseFloat(fatPct) / 100 : 0; }
function calcKgSnf(kgs, snfPct)   { return kgs && snfPct ? parseFloat(kgs) * parseFloat(snfPct) / 100 : 0; }

const coord = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

// Compute the road distance a tanker covered on this execution:
//   start point → each covered BMCU (in seq order) → delivery point.
// Per-leg km resolution cascade: Distance Master (exact) → Google Routes API
// (cached back into Distance Master) → Haversine × road factor (flagged estimated).
// Persists calculated_km / km_estimated_leg_count / km_incomplete and returns the breakdown.
async function computeExecutionDistance(client, execId, userId) {
  const head = await client.query(`
    SELECT tp.start_point_id, tp.delivery_point_id,
           sp.name AS start_name, sp.latitude AS start_lat, sp.longitude AS start_lng,
           dp.name AS del_name,   dp.latitude AS del_lat,   dp.longitude AS del_lng
    FROM trip_executions te
    JOIN trip_plans tp           ON tp.id = te.trip_plan_id
    LEFT JOIN starting_points sp ON sp.id = tp.start_point_id
    LEFT JOIN delivery_points dp ON dp.id = tp.delivery_point_id
    WHERE te.id = $1`, [execId]);
  if (!head.rows.length) return { total_km: 0, legs: [], estimated_leg_count: 0, incomplete: false };
  const h = head.rows[0];

  const bmcus = await client.query(`
    SELECT teb.bmcu_id, teb.seq_no, b.bmcu_code, b.bmcu_name, b.latitude, b.longitude
    FROM trip_execution_bmcus teb
    JOIN bmcus b ON b.id = teb.bmcu_id
    WHERE teb.execution_id = $1 AND teb.is_deleted = FALSE
    ORDER BY teb.seq_no`, [execId]);

  // Ordered node chain: start → BMCUs → delivery.
  const nodes = [];
  if (h.start_point_id)
    nodes.push({ type: 'starting_point', id: h.start_point_id, lat: coord(h.start_lat), lng: coord(h.start_lng), label: `[Start] ${h.start_name || ''}`.trim() });
  for (const b of bmcus.rows)
    nodes.push({ type: 'bmcu', id: b.bmcu_id, lat: coord(b.latitude), lng: coord(b.longitude), label: `${b.bmcu_code} — ${b.bmcu_name}` });
  if (h.delivery_point_id)
    nodes.push({ type: 'delivery_point', id: h.delivery_point_id, lat: coord(h.del_lat), lng: coord(h.del_lng), label: `[Plant] ${h.del_name || ''}`.trim() });

  const legs = [];
  let total = 0, estimated = 0, incomplete = false;

  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], z = nodes[i + 1];
    let km = 0, source = 'missing';

    const master = await getMasterDistanceKm(client, a.type, a.id, z.type, z.id);
    if (master != null) {
      km = master; source = 'master';
    } else if (a.lat != null && a.lng != null && z.lat != null && z.lng != null) {
      const g = await googleLegKm(a.lat, a.lng, z.lat, z.lng);
      if (g != null) {
        km = g; source = 'google';
        await upsertMasterDistanceKm(client, a.type, a.id, z.type, z.id, g, 'auto: Google Routes API', userId);
      } else {
        km = haversineKm(a.lat, a.lng, z.lat, z.lng) * ROAD_FACTOR;
        source = 'estimated'; estimated++;
      }
    } else {
      incomplete = true; // no master value and missing coordinates
    }

    km = Math.round(km * 100) / 100;
    total += km;
    legs.push({ from_label: a.label, to_label: z.label, km, source });
  }

  total = Math.round(total * 100) / 100;
  await client.query(
    'UPDATE trip_executions SET calculated_km=$1, km_estimated_leg_count=$2, km_incomplete=$3 WHERE id=$4',
    [total, estimated, incomplete, execId]
  );
  return { total_km: total, legs, estimated_leg_count: estimated, incomplete };
}

// ─── 110% capacity guard ──────────────────────────────────────────────────────
const CAPACITY_TOLERANCE = 1.1;
const fmtL = v => Math.round(parseFloat(v)).toLocaleString('en-IN');

function capacityError(area, entered, capacity) {
  const limit = capacity * CAPACITY_TOLERANCE;
  return Object.assign(
    new Error(`${area}: entered volume ${fmtL(entered)} L exceeds 110% of tanker capacity ${fmtL(capacity)} L (limit ${fmtL(limit)} L)`),
    { code: 400 });
}

// Validates every volume area of an execution against 110% of the tanker's
// registered capacity. Skipped when capacity is 0/NULL (legacy tankers).
async function assertWithinCapacity(client, execId) {
  const cap = await client.query(`
    SELECT t.capacity_litres
    FROM trip_executions te
    JOIN trip_plans tp ON tp.id=te.trip_plan_id
    LEFT JOIN tankers t ON t.id=tp.tanker_id
    WHERE te.id=$1`, [execId]);
  const capacity = parseFloat(cap.rows[0]?.capacity_litres) || 0;
  if (capacity <= 0) return;
  const limit = capacity * CAPACITY_TOLERANCE;

  const sums = await client.query(`
    SELECT
      COALESCE((SELECT SUM(qty_litres) FROM trip_execution_bmcus
        WHERE execution_id=$1 AND is_deleted=FALSE),0) AS dispatch_l,
      COALESCE((SELECT SUM(s.rmrd_qty) FROM trip_execution_bmcu_shifts s
        JOIN trip_execution_bmcus b
          ON b.execution_id=s.execution_id AND b.seq_no=s.bmcu_seq_no AND b.is_deleted=FALSE
        WHERE s.execution_id=$1),0) AS rmrd_l,
      COALESCE((SELECT SUM(qty_litres) FROM trip_acknowledgements
        WHERE execution_id=$1),0) AS ack_l`, [execId]);
  const s = sums.rows[0];

  if (parseFloat(s.dispatch_l) > limit) throw capacityError('BMCU dispatch total', s.dispatch_l, capacity);
  if (parseFloat(s.rmrd_l)     > limit) throw capacityError('RMRD shift total', s.rmrd_l, capacity);
  if (parseFloat(s.ack_l)      > limit) throw capacityError('Acknowledgement total', s.ack_l, capacity);
}

// Persist a full execution-data payload inside the caller's transaction.
// data: { actual_km, delivery_point_id, start_point_id, bmcus, shift_rows,
//         entries, ack_date, acknowledgements }  (all optional except what changes)
// opts.setSavedStatus — the normal PUT flow marks status='saved'; the approval
// flow leaves the status untouched (closed stays closed).
async function applyExecutionData(client, execId, data, userId, opts = {}) {
  const { setSavedStatus = false } = opts;
  const { actual_km, delivery_point_id, start_point_id,
          bmcus, shift_rows, entries, ack_date, acknowledgements } = data || {};

  const exec = await client.query('SELECT * FROM trip_executions WHERE id=$1', [execId]);
  if (!exec.rows.length) throw new Error('Execution not found');

  if (bmcus?.length) {
    for (const bm of bmcus) {
      if (bm.is_deleted) {
        await client.query('UPDATE trip_execution_bmcus SET is_deleted=TRUE WHERE id=$1', [bm.id]);
        continue;
      }
      const kgs    = calcKgs(bm.qty_litres);
      const kgFat  = calcKgFat(kgs, bm.fat_pct);
      const kgSnf  = calcKgSnf(kgs, bm.snf_pct);
      const dpsKgs = calcKgs(bm.dps_qty_litres);

      if (bm.id) {
        await client.query(
          `UPDATE trip_execution_bmcus SET
             milk_date=$1,shift=$2,qty_litres=$3,qty_kgs=$4,fat_pct=$5,snf_pct=$6,
             kg_fat=$7,kg_snf=$8,description=$9,source_bmcu_id=$10,chamber=$11,
             dps_qty_litres=$12,dps_qty_kgs=$13,is_deleted=FALSE
           WHERE id=$14 AND execution_id=$15`,
          [bm.milk_date||null, bm.shift||null,
           bm.qty_litres||null, kgs||null, bm.fat_pct||null, bm.snf_pct||null,
           kgFat||null, kgSnf||null, bm.description||'RMRD',
           bm.source_bmcu_id||null, bm.chamber||null,
           bm.dps_qty_litres||0, dpsKgs||0,
           bm.id, execId]
        );
      } else {
        await client.query(
          `INSERT INTO trip_execution_bmcus
             (execution_id,seq_no,bmcu_id,milk_date,shift,qty_litres,qty_kgs,
              fat_pct,snf_pct,kg_fat,kg_snf,description,source_bmcu_id,chamber,
              dps_qty_litres,dps_qty_kgs)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [execId, bm.seq_no, bm.bmcu_id, bm.milk_date||null, bm.shift||null,
           bm.qty_litres||null, kgs||null, bm.fat_pct||null, bm.snf_pct||null,
           kgFat||null, kgSnf||null, bm.description||'RMRD',
           bm.source_bmcu_id||null, bm.chamber||null,
           bm.dps_qty_litres||0, dpsKgs||0]
        );
      }
    }
  }

  // Shift rows (replace-all)
  if (shift_rows !== undefined) {
    await client.query('DELETE FROM trip_execution_bmcu_shifts WHERE execution_id=$1', [execId]);
    for (const sr of (shift_rows || [])) {
      await client.query(
        `INSERT INTO trip_execution_bmcu_shifts
           (execution_id, bmcu_seq_no, milk_date, shift, rmrd_qty, rmrd_fat_pct, rmrd_snf_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [execId, sr.bmcu_seq_no, sr.milk_date||null, sr.shift||null,
         sr.rmrd_qty||null, sr.rmrd_fat_pct||null, sr.rmrd_snf_pct||null]
      );
    }
  }

  // Sub-entries (balance milk / new MPP / internal shifting) — replace-all
  if (entries !== undefined) {
    const seqToBmcu = {};
    for (const bm of (bmcus || [])) {
      if (bm.bmcu_id && bm.seq_no != null) seqToBmcu[bm.seq_no] = bm.bmcu_id;
    }
    await client.query('DELETE FROM trip_execution_bmcu_entries WHERE execution_id=$1', [execId]);
    for (const e of (entries || [])) {
      const bmcuId = seqToBmcu[e.bmcu_seq_no] || e.bmcu_id || null;
      await client.query(
        `INSERT INTO trip_execution_bmcu_entries
           (execution_id, bmcu_seq_no, bmcu_id, kind, category, source_bmcu_id, qty_litres, fat_pct, snf_pct, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [execId, e.bmcu_seq_no, bmcuId, e.kind, e.category||null,
         e.source_bmcu_id||null, e.qty_litres||null, e.fat_pct||null, e.snf_pct||null,
         (e.remarks || '').trim() || null]
      );
    }
  }

  // Acknowledgements (replace-all) — mirrors POST /:id/acknowledgements math.
  if (acknowledgements !== undefined) {
    await client.query('DELETE FROM trip_acknowledgements WHERE execution_id=$1', [execId]);
    for (const ch of (acknowledgements || [])) {
      // Preserve the user-ENTERED kgs (see executions.js ack handler).
      const kgs    = parseFloat(ch.qty_kgs) || calcKgs(ch.qty_litres);
      const kgFat  = calcKgFat(kgs, ch.fat_pct);
      const kgSnf  = calcKgSnf(kgs, ch.snf_pct);
      await client.query(
        `INSERT INTO trip_acknowledgements
           (execution_id,ack_date,chamber,qty_litres,qty_kgs,fat_pct,snf_pct,kg_fat,kg_snf,temperature,description,entered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [execId, ch.ack_date || ack_date || null, ch.chamber, ch.qty_litres||null,
         kgs||null, ch.fat_pct||null, ch.snf_pct||null, kgFat||null, kgSnf||null,
         ch.temperature||null, ch.description||null, userId || null]
      );
    }
  }

  // Capacity guard: no volume area may exceed 110% of the tanker's registered
  // capacity. Throws (code 400) → the caller's transaction rolls back. Covers
  // the PUT save AND change-request approval, since both route through here.
  await assertWithinCapacity(client, execId);

  // Recalculate execution totals (exclude Balance Milk)
  const totals = await client.query(`
    SELECT
      COALESCE(SUM(qty_litres),0) AS total_litres,
      COALESCE(SUM(qty_kgs),0)    AS total_kgs,
      COALESCE(SUM(kg_fat),0)     AS total_kg_fat,
      COALESCE(SUM(kg_snf),0)     AS total_kg_snf
    FROM trip_execution_bmcus
    WHERE execution_id=$1 AND is_deleted=FALSE AND description != 'Balance Milk'`,
    [execId]
  );
  const t = totals.rows[0];
  const avgFat = t.total_kgs > 0 ? (t.total_kg_fat / t.total_kgs) * 100 : 0;
  const avgSnf = t.total_kgs > 0 ? (t.total_kg_snf / t.total_kgs) * 100 : 0;

  if (delivery_point_id != null) {
    await client.query('UPDATE trip_plans SET delivery_point_id=$1 WHERE id=$2',
      [delivery_point_id || null, exec.rows[0].trip_plan_id]);
  }
  if (start_point_id != null) {
    await client.query('UPDATE trip_plans SET start_point_id=$1 WHERE id=$2',
      [start_point_id || null, exec.rows[0].trip_plan_id]);
  }

  const statusSql = setSavedStatus ? ", status='saved'" : '';
  const r = await client.query(
    `UPDATE trip_executions SET
       actual_km=$1,
       total_qty_litres=$2, total_qty_kgs=$3,
       avg_fat=$4, avg_snf=$5, total_kg_fat=$6, total_kg_snf=$7,
       updated_by=COALESCE($9, updated_by)
       ${statusSql}, updated_at=NOW()
     WHERE id=$8 RETURNING *`,
    [actual_km !== undefined ? (actual_km || null) : exec.rows[0].actual_km,
     t.total_litres, t.total_kgs,
     Math.round(avgFat * 10000) / 10000, Math.round(avgSnf * 10000) / 10000,
     t.total_kg_fat, t.total_kg_snf,
     execId, userId || null]
  );

  const dist = await computeExecutionDistance(client, execId, userId);
  return { execution: r.rows[0], dist };
}

module.exports = {
  KG_FACTOR, calcKgs, calcKgFat, calcKgSnf,
  computeExecutionDistance, applyExecutionData, assertWithinCapacity,
};
