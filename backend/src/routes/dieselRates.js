// backend/src/routes/dieselRates.js
// Diesel price master per state per fortnight (migration 058, owner 2026-10-08).
// Purchase's fortnightly annexure derives every ₹/km rate from the state's
// diesel price: rate = previous rate + (diesel − previous diesel) ÷ mileage.
// Here the price is kept once per state × fortnight; the Tanker Rate Master
// rows of a fortnight can be GENERATED from it (preview first, the user
// confirms, nothing is written automatically) and the annexure downloaded in
// purchase's layout. Reads are open to the roles that use rates; writes are
// masters / admin.
const express = require('express');
const router  = express.Router();
const ExcelJS = require('exceljs');
const { query, pool } = require('../config/db');
const { authenticate, authorizeOrModule } = require('../middleware/auth');
const { STATES, dieselPriceFor, fortnightError, previousFortnight } = require('../services/rates');
const { fmtDateDisplay } = require('../utils/date');

const READERS = ['admin', 'planner', 'biller', 'viewer'];
const TYPES   = ['BMCU/CC to Dairy/CC', 'Point to Point'];
const round2  = v => Math.round(v * 100) / 100;
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function validate(b) {
  const state = STATES.find(s => s.toLowerCase() === String(b.state || '').trim().toLowerCase());
  if (!state) return { error: `state must be one of: ${STATES.join(', ')}` };
  if (!isDate(b.effective_from) || !isDate(b.effective_to)) return { error: 'effective_from and effective_to are required (YYYY-MM-DD)' };
  const fe = fortnightError(b.effective_from, b.effective_to);
  if (fe) return { error: fe };
  const price = num(b.price_per_litre);
  if (price == null || price <= 0) return { error: 'price_per_litre must be a positive number' };
  return { row: { state, effective_from: b.effective_from, effective_to: b.effective_to, price, source: (b.source || '').trim() || null } };
}

const SELECT = `SELECT id, state, effective_from::text AS effective_from, effective_to::text AS effective_to,
  price_per_litre, source, created_by_name, created_at, updated_at FROM diesel_rates`;

// ── GET /api/diesel-rates?from&to&state ──────────────────────────────────────
router.get('/', authenticate, authorizeOrModule('masters', ...READERS), async (req, res) => {
  try {
    const cond = []; const params = [];
    if (req.query.state) { params.push(req.query.state); cond.push(`state = $${params.length}`); }
    if (isDate(req.query.from)) { params.push(req.query.from); cond.push(`effective_to >= $${params.length}::date`); }
    if (isDate(req.query.to))   { params.push(req.query.to);   cond.push(`effective_from <= $${params.length}::date`); }
    const r = await query(`${SELECT} ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY effective_from DESC, state`, params);
    res.json(r.rows);
  } catch (err) {
    console.error('[diesel-rates] list error:', err);
    res.status(500).json({ error: 'Failed to load diesel rates' });
  }
});

// ── GET /api/diesel-rates/matrix?periods=12 — fortnights × states grid ───────
router.get('/matrix', authenticate, authorizeOrModule('masters', ...READERS), async (req, res) => {
  try {
    const n = Math.min(Math.max(parseInt(req.query.periods) || 12, 1), 60);
    const r = await query(`${SELECT} WHERE effective_from IN (
        SELECT DISTINCT effective_from FROM diesel_rates ORDER BY effective_from DESC LIMIT $1)
      ORDER BY effective_from DESC, state`, [n]);
    const periods = [];
    const byKey = new Map();
    for (const x of r.rows) {
      const k = x.effective_from;
      if (!byKey.has(k)) { byKey.set(k, { effective_from: k, effective_to: x.effective_to, prices: {} }); periods.push(byKey.get(k)); }
      byKey.get(k).prices[x.state] = { id: x.id, price: parseFloat(x.price_per_litre), source: x.source };
    }
    res.json({ states: STATES, periods });
  } catch (err) {
    console.error('[diesel-rates] matrix error:', err);
    res.status(500).json({ error: 'Failed to load diesel rate matrix' });
  }
});

// ── GET /api/diesel-rates/period?date= — price per state valid on a date ─────
router.get('/period', authenticate, authorizeOrModule('masters', ...READERS), async (req, res) => {
  if (!isDate(req.query.date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
  try {
    const out = {};
    for (const s of STATES) out[s] = await dieselPriceFor(s, req.query.date);
    res.json(out);
  } catch (err) {
    console.error('[diesel-rates] period error:', err);
    res.status(500).json({ error: 'Failed to load diesel prices' });
  }
});

// ── POST /api/diesel-rates ───────────────────────────────────────────────────
router.post('/', authenticate, authorizeOrModule('masters', 'admin'), async (req, res) => {
  const v = validate(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const r = await query(`
      INSERT INTO diesel_rates (state, effective_from, effective_to, price_per_litre, source, created_by, created_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [v.row.state, v.row.effective_from, v.row.effective_to, v.row.price, v.row.source,
       req.user.id, req.user.user_id || req.user.full_name || null]);
    res.json({ id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `A diesel price for ${v.row.state} from ${fmtDateDisplay(v.row.effective_from)} already exists — edit it instead` });
    console.error('[diesel-rates] create error:', err);
    res.status(500).json({ error: 'Failed to save diesel rate' });
  }
});

// ── PUT /api/diesel-rates/:id ────────────────────────────────────────────────
router.put('/:id', authenticate, authorizeOrModule('masters', 'admin'), async (req, res) => {
  const v = validate(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const r = await query(`
      UPDATE diesel_rates SET state=$1, effective_from=$2, effective_to=$3, price_per_litre=$4, source=$5, updated_at=NOW()
      WHERE id=$6 RETURNING id`,
      [v.row.state, v.row.effective_from, v.row.effective_to, v.row.price, v.row.source, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Diesel rate not found' });
    res.json({ id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `A diesel price for ${v.row.state} from ${fmtDateDisplay(v.row.effective_from)} already exists` });
    console.error('[diesel-rates] update error:', err);
    res.status(500).json({ error: 'Failed to update diesel rate' });
  }
});

// ── DELETE /api/diesel-rates/:id ─────────────────────────────────────────────
router.delete('/:id', authenticate, authorizeOrModule('masters', 'admin'), async (req, res) => {
  try {
    const r = await query('DELETE FROM diesel_rates WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Diesel rate not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[diesel-rates] delete error:', err);
    res.status(500).json({ error: 'Failed to delete diesel rate' });
  }
});

// ── Rate generation by the purchase escalation formula ──────────────────────
// For the target fortnight: every Tanker Rate Master row of the PREVIOUS
// fortnight (same state × capacity × type) is carried forward with
//   new rate = prev rate + (diesel_new − diesel_prev) ÷ mileage
// where diesel_prev is the price the previous row was built from (its own
// diesel_price, else the master's price for that period). No mileage → the
// row is listed but cannot be generated.
async function buildPreview(from, to) {
  const prev = previousFortnight(from);
  const [prevRows, target, diesel, prevDiesel] = await Promise.all([
    query(`SELECT state, capacity_kl, transport_type, mileage_km_per_litre, rate_per_km, diesel_price
           FROM tanker_rates WHERE effective_from = $1::date ORDER BY state, capacity_kl, transport_type`, [prev.from]),
    query(`SELECT id, state, capacity_kl, transport_type, rate_per_km FROM tanker_rates WHERE effective_from = $1::date`, [from]),
    query(`SELECT state, price_per_litre FROM diesel_rates WHERE effective_from = $1::date`, [from]),
    query(`SELECT state, price_per_litre FROM diesel_rates WHERE effective_from = $1::date`, [prev.from]),
  ]);
  const dieselNew = Object.fromEntries(diesel.rows.map(x => [x.state, parseFloat(x.price_per_litre)]));
  const dieselOld = Object.fromEntries(prevDiesel.rows.map(x => [x.state, parseFloat(x.price_per_litre)]));
  const existing = new Map(target.rows.map(x => [`${x.state}|${x.capacity_kl}|${x.transport_type}`, x]));
  const rows = prevRows.rows.map(p => {
    const key = `${p.state}|${p.capacity_kl}|${p.transport_type}`;
    const mileage = num(p.mileage_km_per_litre);
    const dNew = dieselNew[p.state] ?? null;
    const dOld = num(p.diesel_price) ?? dieselOld[p.state] ?? null;
    let new_rate = null, reason = null;
    if (dNew == null)            reason = `No diesel price for ${p.state} in the target period`;
    else if (dOld == null)       reason = `No diesel price behind the previous rate (${p.state})`;
    else if (!mileage)           reason = 'No mileage on the previous rate row';
    else new_rate = round2(parseFloat(p.rate_per_km) + (dNew - dOld) / mileage);
    const ex = existing.get(key);
    return {
      state: p.state, capacity_kl: parseFloat(p.capacity_kl), transport_type: p.transport_type,
      mileage_km_per_litre: mileage, prev_rate: parseFloat(p.rate_per_km),
      diesel_prev: dOld, diesel_new: dNew, new_rate, delta: new_rate == null ? null : round2(new_rate - parseFloat(p.rate_per_km)),
      reason, existing_id: ex ? ex.id : null, existing_rate: ex ? parseFloat(ex.rate_per_km) : null,
    };
  });
  return {
    effective_from: from, effective_to: to, previous: prev,
    diesel_new: dieselNew, diesel_prev: dieselOld,
    rows, generatable: rows.filter(r => r.new_rate != null).length,
    existing: target.rows.length, previous_rows: prevRows.rows.length,
  };
}

router.post('/generate-preview', authenticate, authorizeOrModule('masters', 'admin'), async (req, res) => {
  const { effective_from, effective_to } = req.body || {};
  const fe = fortnightError(effective_from, effective_to);
  if (fe) return res.status(400).json({ error: fe });
  try {
    res.json(await buildPreview(effective_from, effective_to));
  } catch (err) {
    console.error('[diesel-rates] preview error:', err);
    res.status(500).json({ error: 'Failed to build the rate preview' });
  }
});

// POST /generate { effective_from, effective_to, replace } — writes the
// previewed rows into tanker_rates in one transaction. Existing rows of the
// period are skipped unless replace=true (then rate / diesel / mileage are updated).
router.post('/generate', authenticate, authorizeOrModule('masters', 'admin'), async (req, res) => {
  const { effective_from, effective_to, replace } = req.body || {};
  const fe = fortnightError(effective_from, effective_to);
  if (fe) return res.status(400).json({ error: fe });
  const client = await pool.connect();
  try {
    const pv = await buildPreview(effective_from, effective_to);
    if (!pv.previous_rows) return res.status(400).json({ error: `No Tanker Rate Master rows for the previous fortnight (${fmtDateDisplay(pv.previous.from)} → ${fmtDateDisplay(pv.previous.to)}) to carry forward` });
    await client.query('BEGIN');
    let inserted = 0, updated = 0, skipped = 0;
    const by = req.user.user_id || req.user.full_name || null;
    for (const r of pv.rows) {
      if (r.new_rate == null) { skipped++; continue; }
      if (r.existing_id) {
        if (!replace) { skipped++; continue; }
        await client.query(`UPDATE tanker_rates SET rate_per_km=$1, diesel_price=$2, mileage_km_per_litre=$3, updated_at=NOW() WHERE id=$4`,
          [r.new_rate, r.diesel_new, r.mileage_km_per_litre, r.existing_id]);
        updated++;
        continue;
      }
      // An overlapping (non-fortnight) row for the same key blocks the insert — report, don't guess.
      const ov = await client.query(`SELECT 1 FROM tanker_rates WHERE state=$1 AND capacity_kl=$2 AND transport_type=$3
        AND effective_from <= $5::date AND effective_to >= $4::date LIMIT 1`,
        [r.state, r.capacity_kl, r.transport_type, effective_from, effective_to]);
      if (ov.rows.length) { skipped++; continue; }
      await client.query(`
        INSERT INTO tanker_rates (effective_from, effective_to, state, capacity_kl, transport_type,
          mileage_km_per_litre, rate_per_km, diesel_price, created_by, created_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [effective_from, effective_to, r.state, r.capacity_kl, r.transport_type,
         r.mileage_km_per_litre, r.new_rate, r.diesel_new, req.user.id, by]);
      inserted++;
    }
    await client.query('COMMIT');
    res.json({ inserted, updated, skipped });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[diesel-rates] generate error:', err);
    res.status(500).json({ error: 'Failed to generate the rates' });
  } finally {
    client.release();
  }
});

// ── GET /api/diesel-rates/annexure?effective_from= — purchase's annexure ─────
// One row per capacity; per state the BMCU/CC and Point-to-Point rates of the
// fortnight with the previous fortnight's beside them; diesel prices on top.
router.get('/annexure', authenticate, authorizeOrModule('masters', ...READERS), async (req, res) => {
  const from = req.query.effective_from;
  if (!isDate(from)) return res.status(400).json({ error: 'effective_from (YYYY-MM-DD) is required' });
  try {
    const prev = previousFortnight(from);
    const [cur, old, dsl, dslPrev] = await Promise.all([
      query(`SELECT state, capacity_kl, transport_type, mileage_km_per_litre, rate_per_km, effective_to::text AS effective_to FROM tanker_rates WHERE effective_from=$1::date`, [from]),
      query(`SELECT state, capacity_kl, transport_type, rate_per_km FROM tanker_rates WHERE effective_from=$1::date`, [prev.from]),
      query(`SELECT state, price_per_litre FROM diesel_rates WHERE effective_from=$1::date`, [from]),
      query(`SELECT state, price_per_litre FROM diesel_rates WHERE effective_from=$1::date`, [prev.from]),
    ]);
    if (!cur.rows.length) return res.status(404).json({ error: `No Tanker Rate Master rows effective from ${fmtDateDisplay(from)}` });
    const effTo = cur.rows[0].effective_to;
    const key = r => `${r.state}|${parseFloat(r.capacity_kl)}|${r.transport_type}`;
    const curMap = new Map(cur.rows.map(r => [key(r), r]));
    const oldMap = new Map(old.rows.map(r => [key(r), parseFloat(r.rate_per_km)]));
    const caps = [...new Set(cur.rows.map(r => parseFloat(r.capacity_kl)))].sort((a, b) => a - b);
    const dNew = Object.fromEntries(dsl.rows.map(x => [x.state, parseFloat(x.price_per_litre)]));
    const dOld = Object.fromEntries(dslPrev.rows.map(x => [x.state, parseFloat(x.price_per_litre)]));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Annexure');
    const bold = { bold: true };
    const fillHead = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE9F7' } };
    ws.mergeCells(1, 1, 1, 4 + STATES.length * 4);
    ws.getCell(1, 1).value = `Tanker transport rates effective ${fmtDateDisplay(from)} → ${fmtDateDisplay(effTo)} (previous fortnight ${fmtDateDisplay(prev.from)} → ${fmtDateDisplay(prev.to)})`;
    ws.getCell(1, 1).font = { bold: true, size: 12 };
    // Row 2: diesel prices
    ws.getCell(2, 1).value = 'Diesel ₹/L (previous → current)'; ws.getCell(2, 1).font = bold;
    STATES.forEach((s, i) => {
      const c = 5 + i * 4;
      ws.mergeCells(2, c, 2, c + 3);
      const cell = ws.getCell(2, c);
      cell.value = `${dOld[s] != null ? dOld[s].toFixed(2) : '—'} → ${dNew[s] != null ? dNew[s].toFixed(2) : '—'}`
        + (dOld[s] != null && dNew[s] != null ? ` (${dNew[s] - dOld[s] >= 0 ? '+' : ''}${(dNew[s] - dOld[s]).toFixed(2)})` : '');
      cell.alignment = { horizontal: 'center' };
    });
    // Row 3: state groups; Row 4: column heads
    STATES.forEach((s, i) => {
      const c = 5 + i * 4;
      ws.mergeCells(3, c, 3, c + 3);
      ws.getCell(3, c).value = s; ws.getCell(3, c).font = bold; ws.getCell(3, c).fill = fillHead;
      ws.getCell(3, c).alignment = { horizontal: 'center' };
    });
    const heads = ['S.No', 'Capacity (KL)', 'Mileage BMCU/CC', 'Mileage P2P'];
    STATES.forEach(() => heads.push('BMCU/CC prev', 'BMCU/CC new', 'P2P prev', 'P2P new'));
    heads.forEach((h, i) => { const cell = ws.getCell(4, i + 1); cell.value = h; cell.font = bold; cell.fill = fillHead; cell.alignment = { horizontal: 'center', wrapText: true }; });
    caps.forEach((cap, i) => {
      const r = 5 + i;
      ws.getCell(r, 1).value = i + 1;
      ws.getCell(r, 2).value = cap;
      const m0 = cur.rows.find(x => parseFloat(x.capacity_kl) === cap && x.transport_type === TYPES[0]);
      const m1 = cur.rows.find(x => parseFloat(x.capacity_kl) === cap && x.transport_type === TYPES[1]);
      ws.getCell(r, 3).value = m0 ? num(m0.mileage_km_per_litre) : null;
      ws.getCell(r, 4).value = m1 ? num(m1.mileage_km_per_litre) : null;
      STATES.forEach((s, si) => {
        TYPES.forEach((t, ti) => {
          const k = `${s}|${cap}|${t}`;
          const c = 5 + si * 4 + ti * 2;
          ws.getCell(r, c).value = oldMap.has(k) ? oldMap.get(k) : null;
          const cr = curMap.get(k);
          ws.getCell(r, c + 1).value = cr ? parseFloat(cr.rate_per_km) : null;
          if (cr) ws.getCell(r, c + 1).font = bold;
        });
      });
    });
    ws.columns.forEach((c, i) => { c.width = i < 2 ? 10 : 13; });
    ws.views = [{ state: 'frozen', ySplit: 4, xSplit: 2 }];
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Disposition', `attachment; filename=rate_annexure_${from}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('[diesel-rates] annexure error:', err);
    res.status(500).json({ error: 'Failed to build the annexure' });
  }
});

module.exports = router;
