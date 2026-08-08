// backend/src/routes/analytics.js
// Phase-1 analytics: KPI summary, daily trend, BMCU / tanker leaderboards and
// delivery-point performance over a date range (trip_plans.plan_for_date).
//
// Measurement points per trip (same math as the Daily TS Report):
//   RMRD     = shift rows (litres → kgs ×1.0285) ± adjustment entries
//              (Left Over −, Lifted +, New MPP +, Internal Shifting ±)
//   Dispatch = all non-deleted trip_execution_bmcus rows (stored kgs/fat/snf)
//   Ack      = trip_acknowledgements (stored kgs/fat/snf)
// Qty gain/loss = Ack − RMRD (kgs); TS = Kg.Fat + Kg.SNF; TS gain/loss % uses
// the confirmed formula (diff TS / base TS × 100).
const express = require('express');
const router  = express.Router();
const { query } = require('../config/db');
const { authenticate } = require('../middleware/auth');

const KG = 1.0285;
// Common query-filter parsing: [from, to, delivery_point_id, route_name, tanker_number]
const filterParams = req => [
  req.query.from, req.query.to,
  req.query.delivery_point_id ? parseInt(req.query.delivery_point_id) : null,
  req.query.route_name || null,
  req.query.tanker_number || null,
];
const rN = (v, d = 2) => v == null ? null : Math.round(parseFloat(v) * 10 ** d) / 10 ** d;

// Shared filter: closed/complete executions of published plans in the range.
// Optional delivery-point filter narrows every panel.
const baseTripsCte = `
  trips AS (
    SELECT tp.id AS plan_id, tp.plan_for_date, tp.delivery_point_id,
           te.id AS execution_id, te.status AS exec_status, te.updated_at,
           t.id AS tanker_id, t.tanker_number, t.capacity_litres,
           COALESCE(te.actual_km, te.calculated_km, 0) AS km,
           COALESCE(t.per_km_rate,0) * COALESCE(te.actual_km, te.calculated_km, 0) AS trip_cost,
           rm.route_name, dp.name AS delivery_point,
           EXISTS (SELECT 1 FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS has_ack
    FROM trip_plans tp
    JOIN trip_executions te ON te.trip_plan_id = tp.id
    LEFT JOIN tankers t          ON t.id  = tp.tanker_id
    LEFT JOIN route_masters rm   ON rm.id = tp.route_id
    LEFT JOIN delivery_points dp ON dp.id = tp.delivery_point_id
    WHERE tp.plan_for_date BETWEEN $1 AND $2
      AND tp.status NOT IN ('cancelled','deleted')
      AND ($3::int IS NULL OR tp.delivery_point_id = $3::int)
      AND ($4::text IS NULL OR rm.route_name = $4::text)
      AND ($5::text IS NULL OR t.tanker_number = $5::text)
  ),
  disp AS (
    SELECT teb.execution_id,
           SUM(teb.qty_litres) AS litres, SUM(teb.qty_kgs) AS kgs,
           SUM(teb.kg_fat) AS kg_fat, SUM(teb.kg_snf) AS kg_snf
    FROM trip_execution_bmcus teb
    WHERE teb.execution_id IN (SELECT execution_id FROM trips) AND teb.is_deleted=FALSE
    GROUP BY teb.execution_id
  ),
  rmrd_shift AS (
    SELECT s.execution_id,
           SUM(s.rmrd_qty) AS litres,
           SUM(s.rmrd_qty * ${KG}) AS kgs,
           SUM(s.rmrd_qty * ${KG} * COALESCE(s.rmrd_fat_pct,0) / 100) AS kg_fat,
           SUM(s.rmrd_qty * ${KG} * COALESCE(s.rmrd_snf_pct,0) / 100) AS kg_snf
    FROM trip_execution_bmcu_shifts s
    JOIN trip_execution_bmcus b
      ON b.execution_id=s.execution_id AND b.seq_no=s.bmcu_seq_no AND b.is_deleted=FALSE
    WHERE s.execution_id IN (SELECT execution_id FROM trips)
    GROUP BY s.execution_id
  ),
  rmrd_adj AS (
    SELECT e.execution_id,
           SUM(sgn.v * e.qty_litres) AS litres,
           SUM(sgn.v * e.qty_litres * ${KG}) AS kgs,
           SUM(sgn.v * e.qty_litres * ${KG} * COALESCE(e.fat_pct,0) / 100) AS kg_fat,
           SUM(sgn.v * e.qty_litres * ${KG} * COALESCE(e.snf_pct,0) / 100) AS kg_snf
    FROM trip_execution_bmcu_entries e
    JOIN trip_execution_bmcus pb
      ON pb.execution_id=e.execution_id AND pb.seq_no=e.bmcu_seq_no AND pb.is_deleted=FALSE
    CROSS JOIN LATERAL (SELECT CASE
        WHEN e.kind='balance_milk' AND e.category='Left Over milk' THEN -1
        WHEN e.kind='balance_milk' AND e.category='Lifted milk'    THEN  1
        WHEN e.kind='new_mpp'                                      THEN  1
        WHEN e.kind='internal_shifting'                            THEN  1
        ELSE 0 END AS v) sgn
    WHERE e.execution_id IN (SELECT execution_id FROM trips) AND e.qty_litres IS NOT NULL
    GROUP BY e.execution_id
  ),
  shift_ded AS (
    -- Internal shifting: milk added to the receiving trip above must be
    -- deducted from the trip carrying the SOURCE plant (prefer the same trip).
    SELECT tgt.execution_id,
           SUM(e.qty_litres) AS litres,
           SUM(e.qty_litres * ${KG}) AS kgs,
           SUM(e.qty_litres * ${KG} * COALESCE(e.fat_pct,0)/100) AS kg_fat,
           SUM(e.qty_litres * ${KG} * COALESCE(e.snf_pct,0)/100) AS kg_snf
    FROM trip_execution_bmcu_entries e
    JOIN trip_execution_bmcus pb
      ON pb.execution_id=e.execution_id AND pb.seq_no=e.bmcu_seq_no AND pb.is_deleted=FALSE
    JOIN LATERAL (
      SELECT teb2.execution_id
      FROM trip_execution_bmcus teb2
      WHERE teb2.bmcu_id = e.source_bmcu_id AND teb2.is_deleted=FALSE
        AND teb2.execution_id IN (SELECT execution_id FROM trips)
      ORDER BY (teb2.execution_id = e.execution_id) DESC
      LIMIT 1
    ) tgt ON TRUE
    WHERE e.kind='internal_shifting' AND e.qty_litres IS NOT NULL
      AND e.execution_id IN (SELECT execution_id FROM trips)
    GROUP BY tgt.execution_id
  ),
  ack AS (
    SELECT ta.execution_id,
           SUM(ta.qty_litres) AS litres, SUM(ta.qty_kgs) AS kgs,
           SUM(ta.kg_fat) AS kg_fat, SUM(ta.kg_snf) AS kg_snf
    FROM trip_acknowledgements ta
    WHERE ta.execution_id IN (SELECT execution_id FROM trips)
    GROUP BY ta.execution_id
  ),
  per_trip AS (
    SELECT tr.*,
      COALESCE(d.litres,0)  AS disp_litres,  COALESCE(d.kgs,0)  AS disp_kgs,
      COALESCE(d.kg_fat,0)  AS disp_kg_fat,  COALESCE(d.kg_snf,0) AS disp_kg_snf,
      COALESCE(rs.litres,0) + COALESCE(ra.litres,0) - COALESCE(sd.litres,0) AS rmrd_litres,
      COALESCE(rs.kgs,0)    + COALESCE(ra.kgs,0)    - COALESCE(sd.kgs,0)    AS rmrd_kgs,
      COALESCE(rs.kg_fat,0) + COALESCE(ra.kg_fat,0) - COALESCE(sd.kg_fat,0) AS rmrd_kg_fat,
      COALESCE(rs.kg_snf,0) + COALESCE(ra.kg_snf,0) - COALESCE(sd.kg_snf,0) AS rmrd_kg_snf,
      COALESCE(a.litres,0)  AS ack_litres,  COALESCE(a.kgs,0)  AS ack_kgs,
      COALESCE(a.kg_fat,0)  AS ack_kg_fat,  COALESCE(a.kg_snf,0) AS ack_kg_snf
    FROM trips tr
    LEFT JOIN disp d        ON d.execution_id  = tr.execution_id
    LEFT JOIN rmrd_shift rs ON rs.execution_id = tr.execution_id
    LEFT JOIN rmrd_adj ra   ON ra.execution_id = tr.execution_id
    LEFT JOIN shift_ded sd  ON sd.execution_id = tr.execution_id
    LEFT JOIN ack a         ON a.execution_id  = tr.execution_id
  )`;

// Aggregate a set of per_trip rows into the section sums the panels share.
// Gains only use acknowledged trips (unacked would skew everything negative).
const aggSelect = `
  COUNT(*)::int AS trips,
  COUNT(*) FILTER (WHERE has_ack)::int AS acked_trips,
  SUM(disp_litres) AS disp_litres, SUM(disp_kgs) AS disp_kgs,
  SUM(disp_kg_fat) AS disp_kg_fat, SUM(disp_kg_snf) AS disp_kg_snf,
  SUM(rmrd_litres) AS rmrd_litres, SUM(rmrd_kgs) AS rmrd_kgs,
  SUM(rmrd_kg_fat) AS rmrd_kg_fat, SUM(rmrd_kg_snf) AS rmrd_kg_snf,
  SUM(ack_litres)  AS ack_litres,  SUM(ack_kgs)  AS ack_kgs,
  SUM(ack_kg_fat)  AS ack_kg_fat,  SUM(ack_kg_snf) AS ack_kg_snf,
  SUM(ack_kgs    - rmrd_kgs)    FILTER (WHERE has_ack) AS qty_gain_kgs,
  SUM(ack_litres - rmrd_litres) FILTER (WHERE has_ack) AS qty_gain_litres,
  SUM((ack_kg_fat+ack_kg_snf) - (rmrd_kg_fat+rmrd_kg_snf)) FILTER (WHERE has_ack) AS ts_gain,
  SUM(rmrd_kg_fat+rmrd_kg_snf) FILTER (WHERE has_ack) AS ts_base,
  SUM(disp_kgs - rmrd_kgs) AS stage_transit_kgs,
  SUM(ack_kgs  - disp_kgs) FILTER (WHERE has_ack) AS stage_unload_kgs,
  SUM(trip_cost) AS trip_cost,
  SUM(km) AS km`;

const mapAgg = r => ({
  trips: r.trips, acked_trips: r.acked_trips,
  disp:  { litres: rN(r.disp_litres), kgs: rN(r.disp_kgs), kg_fat: rN(r.disp_kg_fat), kg_snf: rN(r.disp_kg_snf) },
  rmrd:  { litres: rN(r.rmrd_litres), kgs: rN(r.rmrd_kgs), kg_fat: rN(r.rmrd_kg_fat), kg_snf: rN(r.rmrd_kg_snf) },
  ack:   { litres: rN(r.ack_litres),  kgs: rN(r.ack_kgs),  kg_fat: rN(r.ack_kg_fat),  kg_snf: rN(r.ack_kg_snf) },
  qty_gain_kgs: rN(r.qty_gain_kgs), qty_gain_litres: rN(r.qty_gain_litres),
  ts_gain: rN(r.ts_gain),
  ts_gain_pct: parseFloat(r.ts_base) > 0 ? rN(parseFloat(r.ts_gain) / parseFloat(r.ts_base) * 100, 3) : null,
  stage_transit_kgs: rN(r.stage_transit_kgs),
  stage_unload_kgs:  rN(r.stage_unload_kgs),
  avg_fat: parseFloat(r.ack_kgs) > 0 ? rN(parseFloat(r.ack_kg_fat) / parseFloat(r.ack_kgs) * 100) : null,
  avg_snf: parseFloat(r.ack_kgs) > 0 ? rN(parseFloat(r.ack_kg_snf) / parseFloat(r.ack_kgs) * 100) : null,
  // Quality drift: weighted Ack % minus weighted RMRD % (dilution indicator)
  fat_drift: (parseFloat(r.ack_kgs) > 0 && parseFloat(r.rmrd_kgs) > 0)
    ? rN(parseFloat(r.ack_kg_fat)/parseFloat(r.ack_kgs)*100 - parseFloat(r.rmrd_kg_fat)/parseFloat(r.rmrd_kgs)*100, 3) : null,
  snf_drift: (parseFloat(r.ack_kgs) > 0 && parseFloat(r.rmrd_kgs) > 0)
    ? rN(parseFloat(r.ack_kg_snf)/parseFloat(r.ack_kgs)*100 - parseFloat(r.rmrd_kg_snf)/parseFloat(r.rmrd_kgs)*100, 3) : null,
  trip_cost: rN(r.trip_cost),
  cost_per_1000l: parseFloat(r.disp_litres) > 0 ? rN(parseFloat(r.trip_cost) / parseFloat(r.disp_litres) * 1000) : null,
  km: rN(r.km, 1),
  km_per_trip: r.trips > 0 ? rN(parseFloat(r.km) / r.trips, 1) : null,
  // Collection efficiency: litres collected (dispatch) per km run
  l_per_km: parseFloat(r.km) > 0 ? rN(parseFloat(r.disp_litres) / parseFloat(r.km), 1) : null,
});

async function buildSummary(params) {
  const [from, to, dp] = params;
  {

    const [kpis, daily, tankers, plants, routes] = await Promise.all([
      query(`WITH ${baseTripsCte} SELECT ${aggSelect} FROM per_trip`, params),
      query(`WITH ${baseTripsCte}
        SELECT plan_for_date::text AS date, ${aggSelect}
        FROM per_trip GROUP BY plan_for_date ORDER BY plan_for_date`, params),
      query(`WITH ${baseTripsCte}
        SELECT tanker_number, ${aggSelect}
        FROM per_trip WHERE tanker_number IS NOT NULL
        GROUP BY tanker_number ORDER BY SUM((ack_kg_fat+ack_kg_snf)-(rmrd_kg_fat+rmrd_kg_snf)) FILTER (WHERE has_ack) NULLS LAST`, params),
      query(`WITH ${baseTripsCte}
        SELECT delivery_point, ${aggSelect}
        FROM per_trip GROUP BY delivery_point
        ORDER BY SUM(ack_kgs) DESC NULLS LAST`, params),
      query(`WITH ${baseTripsCte}
        SELECT route_name, ${aggSelect}
        FROM per_trip WHERE route_name IS NOT NULL
        GROUP BY route_name ORDER BY SUM((ack_kg_fat+ack_kg_snf)-(rmrd_kg_fat+rmrd_kg_snf)) FILTER (WHERE has_ack) NULLS LAST`, params),
    ]);

    // BMCU leaderboard — Dispatch Vs RMRD per BMCU (ack is trip-level only).
    const bmcus = await query(`WITH ${baseTripsCte},
      bm_disp AS (
        SELECT teb.bmcu_id, b.bmcu_code, b.bmcu_name,
               SUM(teb.qty_litres) AS disp_litres, SUM(teb.qty_kgs) AS disp_kgs,
               SUM(teb.kg_fat) AS disp_kg_fat, SUM(teb.kg_snf) AS disp_kg_snf
        FROM trip_execution_bmcus teb
        JOIN bmcus b ON b.id = teb.bmcu_id
        WHERE teb.execution_id IN (SELECT execution_id FROM trips) AND teb.is_deleted=FALSE
        GROUP BY teb.bmcu_id, b.bmcu_code, b.bmcu_name
      ),
      bm_rmrd AS (
        SELECT teb.bmcu_id,
               SUM(s.rmrd_qty) AS litres, SUM(s.rmrd_qty * ${KG}) AS kgs,
               SUM(s.rmrd_qty * ${KG} * COALESCE(s.rmrd_fat_pct,0)/100) AS kg_fat,
               SUM(s.rmrd_qty * ${KG} * COALESCE(s.rmrd_snf_pct,0)/100) AS kg_snf
        FROM trip_execution_bmcu_shifts s
        JOIN trip_execution_bmcus teb
          ON teb.execution_id=s.execution_id AND teb.seq_no=s.bmcu_seq_no AND teb.is_deleted=FALSE
        WHERE s.execution_id IN (SELECT execution_id FROM trips)
        GROUP BY teb.bmcu_id
      ),
      bm_adj AS (
        SELECT pb.bmcu_id,
               SUM(sgn.v * e.qty_litres) AS litres,
               SUM(sgn.v * e.qty_litres * ${KG}) AS kgs,
               SUM(sgn.v * e.qty_litres * ${KG} * COALESCE(e.fat_pct,0)/100) AS kg_fat,
               SUM(sgn.v * e.qty_litres * ${KG} * COALESCE(e.snf_pct,0)/100) AS kg_snf
        FROM trip_execution_bmcu_entries e
        JOIN trip_execution_bmcus pb
          ON pb.execution_id=e.execution_id AND pb.seq_no=e.bmcu_seq_no AND pb.is_deleted=FALSE
        CROSS JOIN LATERAL (SELECT CASE
            WHEN e.kind='balance_milk' AND e.category='Left Over milk' THEN -1
            WHEN e.kind='balance_milk' AND e.category='Lifted milk'    THEN  1
            WHEN e.kind='new_mpp'                                      THEN  1
            WHEN e.kind='internal_shifting'                            THEN  1
            ELSE 0 END AS v) sgn
        WHERE e.execution_id IN (SELECT execution_id FROM trips) AND e.qty_litres IS NOT NULL
        GROUP BY pb.bmcu_id
      ),
      bm_shift_ded AS (
        -- Internal shifting deducts from the SOURCE BMCU's RMRD.
        SELECT e.source_bmcu_id AS bmcu_id,
               SUM(e.qty_litres) AS litres, SUM(e.qty_litres * ${KG}) AS kgs,
               SUM(e.qty_litres * ${KG} * COALESCE(e.fat_pct,0)/100) AS kg_fat,
               SUM(e.qty_litres * ${KG} * COALESCE(e.snf_pct,0)/100) AS kg_snf
        FROM trip_execution_bmcu_entries e
        JOIN trip_execution_bmcus pb
          ON pb.execution_id=e.execution_id AND pb.seq_no=e.bmcu_seq_no AND pb.is_deleted=FALSE
        WHERE e.kind='internal_shifting' AND e.qty_litres IS NOT NULL
          AND e.source_bmcu_id IS NOT NULL
          AND e.execution_id IN (SELECT execution_id FROM trips)
        GROUP BY e.source_bmcu_id
      )
      SELECT d.bmcu_code, d.bmcu_name,
        d.disp_litres, d.disp_kgs, d.disp_kg_fat, d.disp_kg_snf,
        COALESCE(r.litres,0)+COALESCE(a.litres,0)-COALESCE(sd.litres,0) AS rmrd_litres,
        COALESCE(r.kgs,0)+COALESCE(a.kgs,0)-COALESCE(sd.kgs,0)          AS rmrd_kgs,
        COALESCE(r.kg_fat,0)+COALESCE(a.kg_fat,0)-COALESCE(sd.kg_fat,0) AS rmrd_kg_fat,
        COALESCE(r.kg_snf,0)+COALESCE(a.kg_snf,0)-COALESCE(sd.kg_snf,0) AS rmrd_kg_snf
      FROM bm_disp d
      LEFT JOIN bm_rmrd r ON r.bmcu_id=d.bmcu_id
      LEFT JOIN bm_adj a  ON a.bmcu_id=d.bmcu_id
      LEFT JOIN bm_shift_ded sd ON sd.bmcu_id=d.bmcu_id`, params);

    const bmcuRows = bmcus.rows.map(b => {
      const tsDiff = (parseFloat(b.disp_kg_fat) + parseFloat(b.disp_kg_snf))
                   - (parseFloat(b.rmrd_kg_fat) + parseFloat(b.rmrd_kg_snf));
      const tsBase = parseFloat(b.rmrd_kg_fat) + parseFloat(b.rmrd_kg_snf);
      return {
        bmcu_code: b.bmcu_code, bmcu_name: b.bmcu_name,
        rmrd_kgs: rN(b.rmrd_kgs), disp_kgs: rN(b.disp_kgs),
        qty_gain_kgs: rN(parseFloat(b.disp_kgs) - parseFloat(b.rmrd_kgs)),
        ts_gain: rN(tsDiff),
        ts_gain_pct: tsBase > 0 ? rN(tsDiff / tsBase * 100, 3) : null,
      };
    }).sort((a, b) => (a.ts_gain ?? 0) - (b.ts_gain ?? 0));

    // Previous period of equal length, immediately before `from` — the
    // comparison basis for the KPI deltas.
    const dFrom = new Date(from + 'T00:00:00Z'), dTo = new Date(to + 'T00:00:00Z');
    const lenDays = Math.round((dTo - dFrom) / 86400000) + 1;
    const pTo   = new Date(dFrom); pTo.setUTCDate(pTo.getUTCDate() - 1);
    const pFrom = new Date(pTo);   pFrom.setUTCDate(pFrom.getUTCDate() - (lenDays - 1));
    const prevParams = [pFrom.toISOString().slice(0,10), pTo.toISOString().slice(0,10), ...params.slice(2)];
    const prev = await query(`WITH ${baseTripsCte} SELECT ${aggSelect} FROM per_trip`, prevParams);

    // Data freshness: latest entry timestamps across the whole system.
    const fresh = await query(`
      SELECT (SELECT MAX(created_at) FROM trip_acknowledgements) AS last_ack_entry,
             (SELECT MAX(updated_at) FROM trip_executions)       AS last_execution_update`);

    // BMCU collection compliance: planned BMCU visits vs those with milk
    // quantity actually recorded on the execution.
    const comp = await query(`WITH ${baseTripsCte}
      SELECT COUNT(*)::int AS planned,
             COUNT(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM trip_execution_bmcus teb
               WHERE teb.execution_id = tr.execution_id
                 AND teb.bmcu_id = tpb.bmcu_id
                 AND teb.is_deleted = FALSE
                 AND COALESCE(teb.qty_litres,0) > 0))::int AS collected
      FROM trips tr
      JOIN trip_plan_bmcus tpb ON tpb.trip_plan_id = tr.plan_id`, params);

    // Ops signals: tanker maintenance days overlapping the range (Maintainance
    // gate passes) and execution change-request volume by requester.
    const [maint, crs] = await Promise.all([
      query(`
        SELECT COALESCE(SUM(
          GREATEST(0, EXTRACT(EPOCH FROM (
            LEAST(COALESCE(returned_at, NOW()), ($2::date + 1)::timestamptz)
            - GREATEST(issued_at, $1::date::timestamptz)
          )) / 86400)), 0) AS days,
          COUNT(*) FILTER (WHERE returned_at IS NULL)::int AS open_passes
        FROM non_trip_gate_passes
        WHERE reason='Maintainance'
          AND issued_at < ($2::date + 1)::timestamptz
          AND COALESCE(returned_at, NOW()) > $1::date::timestamptz`, [from, to]),
      query(`
        SELECT COALESCE(requested_by_name,'—') AS requester, status, COUNT(*)::int AS n
        FROM execution_change_requests
        WHERE created_at >= $1::date AND created_at < ($2::date + 1)
        GROUP BY 1, 2 ORDER BY COUNT(*) DESC`, [from, to]),
    ]);

    const compR = comp.rows[0];
    return ({
      from, to, delivery_point_id: dp,
      prev_period: { from: prevParams[0], to: prevParams[1], kpis: mapAgg(prev.rows[0]) },
      freshness: {
        last_ack_entry: fresh.rows[0].last_ack_entry,
        last_execution_update: fresh.rows[0].last_execution_update,
      },
      compliance: {
        planned: compR.planned, collected: compR.collected,
        pct: compR.planned > 0 ? rN(compR.collected / compR.planned * 100, 1) : null,
      },
      ops: {
        maintenance_days: rN(maint.rows[0]?.days, 1),
        open_maintenance: maint.rows[0]?.open_passes || 0,
        change_requests: crs.rows.reduce((s, r) => s + r.n, 0),
        change_requests_pending: crs.rows.filter(r => r.status === 'pending').reduce((s, r) => s + r.n, 0),
        top_requesters: Object.entries(crs.rows.reduce((m, r) => {
          m[r.requester] = (m[r.requester] || 0) + r.n; return m;
        }, {})).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => ({ name, n })),
      },
      kpis: mapAgg(kpis.rows[0]),
      daily: daily.rows.map(r => ({ date: r.date, ...mapAgg(r) })),
      tankers: tankers.rows.map(r => ({ tanker_number: r.tanker_number, ...mapAgg(r) })),
      delivery_points: plants.rows.map(r => ({ delivery_point: r.delivery_point || '—', ...mapAgg(r) })),
      routes: routes.rows.map(r => ({ route_name: r.route_name, ...mapAgg(r) })),
      bmcus: bmcuRows,
    });
  }
}

router.get('/summary', authenticate, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
  try {
    res.json(await buildSummary(filterParams(req)));
  } catch (err) {
    console.error('Analytics summary error:', err);
    res.status(500).json({ error: 'Failed to build analytics summary' });
  }
});

// ─── Excel export of the current dashboard view ──────────────────────────────
router.get('/export', authenticate, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
  try {
    const ExcelJS = require('exceljs');
    const d = await buildSummary(filterParams(req));
    const wb = new ExcelJS.Workbook();

    const head = (ws, cols) => {
      ws.addRow(cols).font = { bold: true };
      ws.columns.forEach(c => { c.width = 16; });
    };
    const aggRow = (label, a) => [label, a.trips, a.acked_trips,
      a.disp?.kgs, a.rmrd?.kgs, a.ack?.kgs, a.qty_gain_kgs, a.ts_gain, a.ts_gain_pct];
    const AGG_HEADS = ['', 'Trips', 'Acked', 'Dispatch Kg', 'RMRD Kg', 'Ack Kg',
      'Qty Gain/Loss Kg', 'TS Gain/Loss Kg', 'TS %'];

    const ws1 = wb.addWorksheet('Summary');
    ws1.addRow([`Analytics Summary ${from} → ${to}`]).font = { bold: true, size: 13 };
    ws1.addRow([]);
    head(ws1, AGG_HEADS);
    ws1.addRow(aggRow('This period', d.kpis));
    ws1.addRow(aggRow(`Previous (${d.prev_period.from} → ${d.prev_period.to})`, d.prev_period.kpis));
    ws1.addRow([]);
    ws1.addRow(['Transport Cost (₹)', d.kpis.trip_cost, '₹/1000L', d.kpis.cost_per_1000l]);
    ws1.addRow(['Fat drift (Ack−RMRD)', d.kpis.fat_drift, 'SNF drift', d.kpis.snf_drift]);
    ws1.addRow(['BMCU collection', `${d.compliance.collected}/${d.compliance.planned}`, '%', d.compliance.pct]);
    ws1.addRow(['Maintenance days', d.ops.maintenance_days, 'Change requests', d.ops.change_requests]);

    const sheet = (name, rows, firstHead, firstKey) => {
      const ws = wb.addWorksheet(name);
      head(ws, [firstHead, ...AGG_HEADS.slice(1)]);
      rows.forEach(r => ws.addRow(aggRow(r[firstKey], r).map((v, i) => i === 0 ? r[firstKey] : v)));
    };
    sheet('Daily', d.daily, 'Date', 'date');
    sheet('Delivery Points', d.delivery_points, 'Delivery Point', 'delivery_point');
    sheet('Routes', d.routes, 'Route', 'route_name');
    sheet('Tankers', d.tankers, 'Tanker', 'tanker_number');

    const wsB = wb.addWorksheet('BMCUs');
    head(wsB, ['Code', 'BMCU', 'RMRD Kg', 'Dispatch Kg', 'Qty Gain/Loss Kg', 'TS Gain/Loss Kg', 'TS %']);
    d.bmcus.forEach(b => wsB.addRow([b.bmcu_code, b.bmcu_name, b.rmrd_kgs, b.disp_kgs,
      b.qty_gain_kgs, b.ts_gain, b.ts_gain_pct]));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=analytics_${from}_${to}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Analytics export error:', err);
    res.status(500).json({ error: 'Failed to export analytics' });
  }
});

// ─── Alerts: exceptions that must never be buried ────────────────────────────
// 1. pending acknowledgements (with age; >24h flagged)
// 2. trips loaded past 110% of tanker capacity
// 3. single-trip TS loss worse than −25 Kg (Ack Vs RMRD)
router.get('/alerts', authenticate, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
  try {
    const params = filterParams(req);
    const r = await query(`WITH ${baseTripsCte}
      SELECT plan_for_date::text AS date, execution_id, tanker_number, route_name,
             delivery_point, exec_status, capacity_litres,
             EXTRACT(EPOCH FROM (NOW() - updated_at)) / 3600 AS hours_since_update,
             disp_litres,
             CASE WHEN has_ack THEN (ack_kg_fat+ack_kg_snf) - (rmrd_kg_fat+rmrd_kg_snf) END AS ts_gain
      FROM per_trip`, params);

    const pending = [], overCap = [], bigLoss = [];
    for (const x of r.rows) {
      const base = { date: x.date, execution_id: x.execution_id,
        tanker_number: x.tanker_number, route_name: x.route_name, delivery_point: x.delivery_point || '—' };
      if (x.exec_status === 'pending_ack')
        pending.push({ ...base, hours: rN(x.hours_since_update, 1), overdue: parseFloat(x.hours_since_update) > 24 });
      const cap = parseFloat(x.capacity_litres) || 0;
      if (cap > 0 && parseFloat(x.disp_litres) > cap * 1.10)
        overCap.push({ ...base, disp_litres: rN(x.disp_litres), capacity_litres: rN(cap),
          over_pct: rN((parseFloat(x.disp_litres) / cap - 1) * 100, 1) });
      if (x.ts_gain != null && parseFloat(x.ts_gain) < -25)
        bigLoss.push({ ...base, ts_gain: rN(x.ts_gain, 1) });
    }
    pending.sort((a, b) => b.hours - a.hours);
    bigLoss.sort((a, b) => a.ts_gain - b.ts_gain);

    res.json({ pending_acks: pending, over_capacity: overCap, big_ts_loss: bigLoss });
  } catch (err) {
    console.error('Analytics alerts error:', err);
    res.status(500).json({ error: 'Failed to load alerts' });
  }
});

// ─── Tanker utilisation ──────────────────────────────────────────────────────
// Per tanker over the range: trips, active days, idle days, maintenance days,
// capacity fill % (ACK quantity vs capacity on acknowledged trips — dispatch
// used as fallback for unacked trips), trips per active day. Includes tankers
// with ZERO trips so unused fleet is visible.
router.get('/utilisation', authenticate, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
  try {
    const params = filterParams(req);
    const periodDays = Math.round(
      (new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1;

    const r = await query(`WITH ${baseTripsCte},
      per_tanker AS (
        SELECT tanker_id,
               COUNT(*)::int AS trips,
               COUNT(*) FILTER (WHERE has_ack)::int AS acked_trips,
               COUNT(DISTINCT plan_for_date)::int AS active_days,
               SUM(ack_litres)  AS ack_litres,
               SUM(disp_litres) AS disp_litres,
               SUM(ack_litres)  FILTER (WHERE has_ack) AS acked_litres,
               SUM(disp_litres) FILTER (WHERE NOT has_ack) AS unacked_disp_litres,
               SUM(km) AS km
        FROM per_trip GROUP BY tanker_id
      ),
      maint AS (
        SELECT tanker_id, SUM(GREATEST(0, EXTRACT(EPOCH FROM (
                 LEAST(COALESCE(returned_at, NOW()), ($2::date + 1)::timestamptz)
                 - GREATEST(issued_at, $1::date::timestamptz))) / 86400)) AS days
        FROM non_trip_gate_passes
        WHERE reason='Maintainance'
          AND issued_at < ($2::date + 1)::timestamptz
          AND COALESCE(returned_at, NOW()) > $1::date::timestamptz
        GROUP BY tanker_id
      )
      SELECT t.id, t.tanker_number, t.capacity_litres,
             COALESCE(pt.trips,0) AS trips, COALESCE(pt.acked_trips,0) AS acked_trips,
             COALESCE(pt.active_days,0) AS active_days,
             COALESCE(pt.acked_litres,0) AS acked_litres,
             COALESCE(pt.unacked_disp_litres,0) AS unacked_disp_litres,
             COALESCE(pt.disp_litres,0) AS disp_litres,
             COALESCE(pt.km,0) AS km,
             COALESCE(m.days,0) AS maintenance_days
      FROM tankers t
      LEFT JOIN per_tanker pt ON pt.tanker_id = t.id
      LEFT JOIN maint m ON m.tanker_id = t.id
      WHERE ($5::text IS NULL OR t.tanker_number = $5::text)
      ORDER BY t.tanker_number`, params);

    const rows = r.rows.map(x => {
      const cap = parseFloat(x.capacity_litres) || 0;
      // Fill % basis: ACK litres on acked trips; dispatch litres stand in for
      // trips not yet acknowledged so fresh days don't read as empty runs.
      const filledL = parseFloat(x.acked_litres) + parseFloat(x.unacked_disp_litres);
      const fillPct = cap > 0 && x.trips > 0 ? rN(filledL / (cap * x.trips) * 100, 1) : null;
      const idle = Math.max(0, periodDays - x.active_days - Math.round(parseFloat(x.maintenance_days)));
      return {
        tanker_number: x.tanker_number, capacity_litres: rN(cap),
        trips: x.trips, acked_trips: x.acked_trips,
        active_days: x.active_days, idle_days: idle,
        maintenance_days: rN(x.maintenance_days, 1),
        trips_per_active_day: x.active_days > 0 ? rN(x.trips / x.active_days, 2) : null,
        ack_litres: rN(x.acked_litres), disp_litres: rN(x.disp_litres), km: rN(x.km, 1),
        avg_fill_pct: fillPct,
      };
    });

    // Fleet KPIs (capacity-weighted fill over tankers that ran)
    const ran = rows.filter(x => x.trips > 0 && x.capacity_litres > 0);
    const fleetFill = ran.length
      ? rN(ran.reduce((s2, x) => s2 + (x.avg_fill_pct ?? 0) * x.trips, 0)
           / ran.reduce((s2, x) => s2 + x.trips, 0), 1)
      : null;
    const most = ran.length ? ran.reduce((a, b) => ((b.avg_fill_pct ?? 0) > (a.avg_fill_pct ?? 0) ? b : a)) : null;
    const least = ran.length ? ran.reduce((a, b) => ((b.avg_fill_pct ?? 101) < (a.avg_fill_pct ?? 101) ? b : a)) : null;

    res.json({
      period_days: periodDays,
      fleet: {
        tankers: rows.length, ran: ran.length,
        zero_trip: rows.filter(x => x.trips === 0).length,
        avg_fill_pct: fleetFill,
        most_utilised: most ? { tanker_number: most.tanker_number, fill_pct: most.avg_fill_pct } : null,
        least_utilised: least ? { tanker_number: least.tanker_number, fill_pct: least.avg_fill_pct } : null,
      },
      tankers: rows,
    });
  } catch (err) {
    console.error('Analytics utilisation error:', err);
    res.status(500).json({ error: 'Failed to build utilisation' });
  }
});

// ─── Milk freshness: shifts of milk lifted per BMCU collection ───────────────
// Ideally a tanker lifts ONE shift's milk from a BMCU (fresh). Each extra
// shift sitting in the BMCU at lifting time means fresh milk mixed with older
// milk. Per collection = one non-deleted trip_execution_bmcus block; its shift
// rows are the shifts lifted together. Milk age = lifting date − oldest
// milk_date in the block.
router.get('/freshness', authenticate, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
  try {
    const params = filterParams(req);
    const r = await query(`WITH ${baseTripsCte},
      collections AS (
        SELECT teb.execution_id, teb.seq_no, teb.bmcu_id,
               b.bmcu_code, b.bmcu_name, tr.plan_for_date,
               COUNT(s.*)::int AS shifts,
               SUM(s.rmrd_qty) AS rmrd_litres,
               MIN(s.milk_date) AS oldest_milk_date
        FROM trip_execution_bmcus teb
        JOIN trips tr ON tr.execution_id = teb.execution_id
        JOIN bmcus b  ON b.id = teb.bmcu_id
        LEFT JOIN trip_execution_bmcu_shifts s
          ON s.execution_id = teb.execution_id AND s.bmcu_seq_no = teb.seq_no
        WHERE teb.is_deleted = FALSE
        GROUP BY teb.execution_id, teb.seq_no, teb.bmcu_id, b.bmcu_code, b.bmcu_name, tr.plan_for_date
        HAVING COUNT(s.*) > 0
      )
      SELECT bmcu_code, bmcu_name,
        COUNT(*)::int AS collections,
        AVG(shifts) AS avg_shifts,
        MAX(shifts)::int AS max_shifts,
        COUNT(*) FILTER (WHERE shifts = 1)::int AS single_shift,
        COUNT(*) FILTER (WHERE shifts >= 3)::int AS three_plus,
        SUM(rmrd_litres) AS rmrd_litres,
        AVG(GREATEST(0, plan_for_date - oldest_milk_date)) AS avg_age_days,
        MAX(GREATEST(0, plan_for_date - oldest_milk_date))::int AS max_age_days
      FROM collections
      GROUP BY bmcu_code, bmcu_name
      ORDER BY AVG(shifts) DESC`, params);

    const rows = r.rows.map(x => ({
      bmcu_code: x.bmcu_code, bmcu_name: x.bmcu_name,
      collections: x.collections,
      avg_shifts: rN(x.avg_shifts, 2), max_shifts: x.max_shifts,
      single_shift_pct: rN(x.single_shift / x.collections * 100, 1),
      three_plus: x.three_plus,
      rmrd_litres: rN(x.rmrd_litres),
      avg_age_days: rN(x.avg_age_days, 1), max_age_days: x.max_age_days,
    }));

    const totC = rows.reduce((s2, x) => s2 + x.collections, 0);
    const kpi = {
      collections: totC,
      avg_shifts: totC ? rN(rows.reduce((s2, x) => s2 + x.avg_shifts * x.collections, 0) / totC, 2) : null,
      fresh_pct: totC ? rN(rows.reduce((s2, x) => s2 + x.single_shift_pct / 100 * x.collections, 0) / totC * 100, 1) : null,
      three_plus: rows.reduce((s2, x) => s2 + x.three_plus, 0),
      avg_age_days: totC ? rN(rows.reduce((s2, x) => s2 + (x.avg_age_days ?? 0) * x.collections, 0) / totC, 1) : null,
    };
    res.json({ kpi, bmcus: rows });
  } catch (err) {
    console.error('Analytics freshness error:', err);
    res.status(500).json({ error: 'Failed to build freshness analytics' });
  }
});

// ─── Drill-down: trips behind any dashboard figure ───────────────────────────
// Filters compose: date range (+ optional single date), delivery point id,
// route name, tanker number. Returns one row per trip with the three section
// totals and gains — each row links back to its execution screen.
router.get('/trips', authenticate, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
  try {
    const params = filterParams(req);
    const extra = [];
    if (req.query.date)          { params.push(req.query.date);          extra.push(`plan_for_date = $${params.length}`); }
    if (req.query.delivery_point){ params.push(req.query.delivery_point);extra.push(`COALESCE(delivery_point,'—') = $${params.length}`); }
    const where = extra.length ? `WHERE ${extra.join(' AND ')}` : '';

    const r = await query(`WITH ${baseTripsCte}
      SELECT plan_for_date::text AS date, execution_id, tanker_number, route_name,
             delivery_point, has_ack,
             disp_litres, disp_kgs, rmrd_litres, rmrd_kgs, ack_litres, ack_kgs,
             CASE WHEN has_ack THEN ack_kgs - rmrd_kgs END AS qty_gain_kgs,
             CASE WHEN has_ack THEN (ack_kg_fat+ack_kg_snf) - (rmrd_kg_fat+rmrd_kg_snf) END AS ts_gain,
             CASE WHEN has_ack AND (rmrd_kg_fat+rmrd_kg_snf) > 0
               THEN ((ack_kg_fat+ack_kg_snf) - (rmrd_kg_fat+rmrd_kg_snf)) / (rmrd_kg_fat+rmrd_kg_snf) * 100 END AS ts_gain_pct
      FROM per_trip ${where}
      ORDER BY plan_for_date, tanker_number`, params);

    res.json(r.rows.map(x => ({
      date: x.date, execution_id: x.execution_id, tanker_number: x.tanker_number,
      route_name: x.route_name, delivery_point: x.delivery_point || '—', has_ack: x.has_ack,
      disp_litres: rN(x.disp_litres), disp_kgs: rN(x.disp_kgs),
      rmrd_litres: rN(x.rmrd_litres), rmrd_kgs: rN(x.rmrd_kgs),
      ack_litres: rN(x.ack_litres), ack_kgs: rN(x.ack_kgs),
      qty_gain_kgs: rN(x.qty_gain_kgs), ts_gain: rN(x.ts_gain), ts_gain_pct: rN(x.ts_gain_pct, 3),
    })));
  } catch (err) {
    console.error('Analytics trips error:', err);
    res.status(500).json({ error: 'Failed to load trips' });
  }
});

// ─── Drill-down: one BMCU's Dispatch Vs RMRD per trip ────────────────────────
router.get('/bmcu-detail', authenticate, async (req, res) => {
  const { from, to, bmcu_code } = req.query;
  if (!from || !to || !bmcu_code)
    return res.status(400).json({ error: 'from, to and bmcu_code are required' });
  try {
    const params = [...filterParams(req), bmcu_code];
    const r = await query(`WITH ${baseTripsCte}
      SELECT tr.plan_for_date::text AS date, tr.execution_id, tr.tanker_number,
             tr.route_name, tr.delivery_point,
             SUM(teb.qty_kgs) AS disp_kgs,
             SUM(teb.kg_fat + teb.kg_snf) AS disp_ts,
             COALESCE(SUM(sh.rmrd_kgs),0) AS rmrd_kgs,
             COALESCE(SUM(sh.rmrd_ts),0)  AS rmrd_ts
      FROM trips tr
      JOIN trip_execution_bmcus teb
        ON teb.execution_id = tr.execution_id AND teb.is_deleted=FALSE
      JOIN bmcus b ON b.id = teb.bmcu_id AND b.bmcu_code = $6
      LEFT JOIN LATERAL (
        SELECT SUM(s.rmrd_qty * ${KG}) AS rmrd_kgs,
               SUM(s.rmrd_qty * ${KG} * (COALESCE(s.rmrd_fat_pct,0)+COALESCE(s.rmrd_snf_pct,0)) / 100) AS rmrd_ts
        FROM trip_execution_bmcu_shifts s
        WHERE s.execution_id = teb.execution_id AND s.bmcu_seq_no = teb.seq_no
      ) sh ON TRUE
      GROUP BY tr.plan_for_date, tr.execution_id, tr.tanker_number, tr.route_name, tr.delivery_point
      ORDER BY tr.plan_for_date`, params);

    res.json(r.rows.map(x => ({
      date: x.date, execution_id: x.execution_id, tanker_number: x.tanker_number,
      route_name: x.route_name, delivery_point: x.delivery_point || '—',
      disp_kgs: rN(x.disp_kgs), rmrd_kgs: rN(x.rmrd_kgs),
      qty_gain_kgs: rN(parseFloat(x.disp_kgs) - parseFloat(x.rmrd_kgs)),
      ts_gain: rN(parseFloat(x.disp_ts) - parseFloat(x.rmrd_ts)),
    })));
  } catch (err) {
    console.error('Analytics bmcu-detail error:', err);
    res.status(500).json({ error: 'Failed to load BMCU detail' });
  }
});

module.exports = router;
