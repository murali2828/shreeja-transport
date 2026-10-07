// backend/src/routes/quality.js
// Quality team: tanker dispatch vs truck-sheet (RMRD) entries — migration 052.
// Independent of the tanker team's executions: own table, own module
// permission ('quality'), no reference data from executions is exposed here.
// Mounted at /api/quality.
const express = require('express');
const router  = express.Router();
const ExcelJS = require('exceljs');
const { query } = require('../config/db');
const { authenticate, authorizeModule } = require('../middleware/auth');
const { fmtDateDisplay } = require('../utils/date');
const { computeDispatch, computeTruckSheet, variations, n } = require('../services/qaDispatch');

const gate = [authenticate, authorizeModule('quality')];
const COMPARTMENTS = ['FC', 'MC', 'BC'];
// Tanker Master keeps compartments as text ('2C', '3C', '3'); 2 → FC, BC; 3+ → FC, MC, BC; unknown → all.
const compartmentCodes = txt => { const k = parseInt(String(txt || '').replace(/[^0-9]/g, ''), 10); return k === 2 ? ['FC', 'BC'] : k === 1 ? ['FC'] : COMPARTMENTS; };
// 'MC,FC' / ['FC','MC'] → 'FC,MC' in canonical order; null when empty or invalid.
const normalizeCompartments = v => {
  const list = (Array.isArray(v) ? v : String(v || '').split(',')).map(s => String(s).trim().toUpperCase()).filter(Boolean);
  if (!list.length || list.some(c => !COMPARTMENTS.includes(c))) return null;
  return COMPARTMENTS.filter(c => list.includes(c)).join(',');
};
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const SHIFTS = /^(\d{1,2}[EM])(,\d{1,2}[EM])*$/i;

// GET /api/quality/lookups — everything the entry form needs in one call.
// Route → BMCU membership comes from Route Master rows plus the last 180 days
// of trip plans on that route (Route Master membership is sparse).
router.get('/lookups', ...gate, async (req, res) => {
  try {
    const tankers = (await query('SELECT id, tanker_number, compartments, capacity_litres FROM tankers WHERE is_active = TRUE ORDER BY tanker_number')).rows;
    const bmcus   = (await query('SELECT id, bmcu_code, bmcu_name FROM bmcus WHERE is_active = TRUE ORDER BY bmcu_code')).rows;
    const routes  = (await query('SELECT id, route_name FROM route_masters ORDER BY route_name')).rows;
    const members = (await query(`
      SELECT route_id, bmcu_id FROM route_bmcus
      UNION
      SELECT tp.route_id, tpb.bmcu_id FROM trip_plans tp JOIN trip_plan_bmcus tpb ON tpb.trip_plan_id = tp.id
      WHERE tp.route_id IS NOT NULL AND tp.plan_for_date >= CURRENT_DATE - 180 AND tp.status NOT IN ('cancelled','deleted')`)).rows;
    const byRoute = {};
    for (const m of members) (byRoute[m.route_id] ||= []).push(m.bmcu_id);
    res.json({ tankers: tankers.map(t => ({ ...t, compartment_codes: compartmentCodes(t.compartments) })), bmcus, routes: routes.map(r => ({ ...r, bmcu_ids: byRoute[r.id] || [] })) });
  } catch (err) { console.error('[quality] lookups error:', err); res.status(500).json({ error: `Failed to load lookups: ${err.message}` }); }
});

async function validate(b) {
  const errs = [];
  if (!ISO.test(b.lifting_date || '')) errs.push('lifting date');
  if (b.ts_date && !ISO.test(b.ts_date)) errs.push('truck sheet date');
  if (!normalizeCompartments(b.compartment)) errs.push('compartment (one or more of FC / MC / BC)');
  if (b.shifts && !SHIFTS.test(String(b.shifts).replace(/\s/g, ''))) errs.push('shifts (e.g. 23E,24M,24E)');
  for (const [k, label] of [['scale_reading', 'scale reading'], ['d_qty_litres', 'dispatch litres'], ['d_fat_pct', 'dispatch fat %'], ['d_clr', 'CLR'],
                            ['ts_qty_litres', 'truck sheet litres'], ['ts_fat_pct', 'truck sheet fat %'], ['ts_snf_pct', 'truck sheet SNF %']]) {
    const v = n(b[k]); if (Number.isNaN(v) || (v != null && v < 0)) errs.push(label + ' must be a number');
  }
  if (n(b.d_qty_litres) == null) errs.push('dispatch litres');
  if (errs.length) return { error: 'Check: ' + errs.join(', ') };
  const tanker = (await query('SELECT id, tanker_number FROM tankers WHERE id=$1', [b.tanker_id])).rows[0];
  const bmcu   = (await query('SELECT id, bmcu_code, bmcu_name FROM bmcus WHERE id=$1', [b.bmcu_id])).rows[0];
  const route  = b.route_id ? (await query('SELECT id, route_name FROM route_masters WHERE id=$1', [b.route_id])).rows[0] : null;
  if (!tanker) return { error: 'Tanker not found' };
  if (!bmcu) return { error: 'BMCU not found' };
  return { tanker, bmcu, route };
}

function rowValues(b, { tanker, bmcu, route }, user) {
  const d = computeDispatch({ qty_litres: b.d_qty_litres, fat_pct: b.d_fat_pct, clr: b.d_clr });
  const t = computeTruckSheet({ qty_litres: b.ts_qty_litres, fat_pct: b.ts_fat_pct, snf_pct: b.ts_snf_pct });
  return [b.lifting_date, route?.id || null, route?.route_name || null, tanker.id, tanker.tanker_number, bmcu.id, bmcu.bmcu_code, bmcu.bmcu_name,
    normalizeCompartments(b.compartment), n(b.scale_reading), b.shifts ? String(b.shifts).replace(/\s/g, '').toUpperCase() : null,
    d.d_qty_litres, d.d_fat_pct, d.d_clr, d.d_snf_pct, d.d_qty_kgs, d.d_kg_fat, d.d_kg_snf,
    b.ts_date || b.lifting_date, b.ts_shift ? String(b.ts_shift).replace(/\s/g, '').toUpperCase() : null,
    t.ts_qty_litres, t.ts_fat_pct, t.ts_snf_pct, t.ts_qty_kgs, t.ts_kg_fat, t.ts_kg_snf,
    String(b.remarks || '').trim() || null, user.id, user.full_name || user.user_id];
}
const COLS = `lifting_date, route_id, route_name, tanker_id, tanker_number, bmcu_id, bmcu_code, bmcu_name, compartment, scale_reading, shifts,
  d_qty_litres, d_fat_pct, d_clr, d_snf_pct, d_qty_kgs, d_kg_fat, d_kg_snf,
  ts_date, ts_shift, ts_qty_litres, ts_fat_pct, ts_snf_pct, ts_qty_kgs, ts_kg_fat, ts_kg_snf, remarks, entered_by, entered_by_name`;
const withVar = r => ({ ...r, ...variations(r) });

router.post('/entries', ...gate, async (req, res) => {
  try {
    const v = await validate(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const vals = rowValues(req.body, v, req.user);
    const r = await query(`INSERT INTO qa_dispatch_entries (${COLS}) VALUES (${vals.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *, lifting_date::text AS lifting_date, ts_date::text AS ts_date, submission_date::text AS submission_date`, vals);
    res.status(201).json(withVar(r.rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This tanker, BMCU and compartment are already entered for that lifting date — edit the existing row' });
    console.error('[quality] create error:', err); res.status(500).json({ error: 'Failed to save the entry' });
  }
});

router.put('/entries/:id', ...gate, async (req, res) => {
  try {
    const ex = (await query('SELECT id, entered_by FROM qa_dispatch_entries WHERE id=$1', [req.params.id])).rows[0];
    if (!ex) return res.status(404).json({ error: 'Entry not found' });
    if (req.user.role !== 'admin' && ex.entered_by !== req.user.id) return res.status(403).json({ error: 'Only the person who entered this row or an admin can change it' });
    const v = await validate(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const vals = rowValues(req.body, v, req.user);
    const cols = COLS.split(',').map(s => s.trim()).filter(c => !['entered_by', 'entered_by_name'].includes(c));
    const sets = cols.map((c, i) => `${c}=$${i + 1}`).join(', ');
    const r = await query(`UPDATE qa_dispatch_entries SET ${sets}, updated_at=NOW() WHERE id=$${cols.length + 1}
                           RETURNING *, lifting_date::text AS lifting_date, ts_date::text AS ts_date, submission_date::text AS submission_date`,
      [...vals.slice(0, cols.length), req.params.id]);
    res.json(withVar(r.rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Another row already covers this tanker, BMCU, compartment and lifting date' });
    console.error('[quality] update error:', err); res.status(500).json({ error: 'Failed to update the entry' });
  }
});

router.delete('/entries/:id', authenticate, authorizeModule('quality'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can delete a QA entry' });
    const r = await query('DELETE FROM qa_dispatch_entries WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Entry not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to delete the entry' }); }
});

function listSql(q) {
  const where = []; const params = [];
  const add = (cond, v) => { params.push(v); where.push(cond.replace('?', '$' + params.length)); };
  if (ISO.test(q.from || '')) add('lifting_date >= ?', q.from);
  if (ISO.test(q.to || '')) add('lifting_date <= ?', q.to);
  if (q.tanker_id) add('tanker_id = ?', q.tanker_id);
  if (q.bmcu_id) add('bmcu_id = ?', q.bmcu_id);
  if (q.route_id) add('route_id = ?', q.route_id);
  return { sql: `SELECT *, lifting_date::text AS lifting_date, ts_date::text AS ts_date, submission_date::text AS submission_date
                 FROM qa_dispatch_entries ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY lifting_date DESC, tanker_number, bmcu_code, compartment LIMIT 2000`, params };
}

router.get('/entries', ...gate, async (req, res) => {
  try { const { sql, params } = listSql(req.query); res.json((await query(sql, params)).rows.map(withVar)); }
  catch (err) { console.error('[quality] list error:', err); res.status(500).json({ error: `Failed to load entries: ${err.message}` }); }
});

// Excel in the quality team's format (column order fixed, 2026-10-07).
router.get('/entries/excel', ...gate, async (req, res) => {
  try {
    const { sql, params } = listSql(req.query);
    const rows = (await query(sql, params)).rows.map(withVar);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Tanker Dispatch');
    const head = ws.addRow(['Submission Date', 'Route Name', 'Milk Lifting Date', 'Tanker No', 'BMCU Code', 'BMCU Name', 'Compartment', 'Scale Reading', 'Shift',
      'Qty Lts (Dispatch)', 'Fat % (Dispatch)', 'CLR (Dispatch)', 'SNF (Dispatch)', 'Qty Kgs (Dispatch)', 'KG Fat (Dispatch)', 'KG SNF (Dispatch)',
      'Qty Lts (Truck Sheet)', 'Fat % (Truck Sheet)', 'SNF (Truck Sheet)', 'Qty Kgs (Truck Sheet)', 'KG Fat (Truck Sheet)', 'KG SNF (Truck Sheet)',
      'Qty Variation (Lts)', 'Fat Variation', 'SNF Variation', 'Remarks', 'Entered By']);
    head.font = { bold: true }; ws.columns.forEach(c => { c.width = 16; });
    const f = v => (v == null ? null : parseFloat(v));
    for (const r of rows.slice().reverse())
      ws.addRow([fmtDateDisplay(r.submission_date), r.route_name, fmtDateDisplay(r.lifting_date), r.tanker_number, r.bmcu_code, r.bmcu_name, r.compartment,
        f(r.scale_reading), r.shifts, f(r.d_qty_litres), f(r.d_fat_pct), f(r.d_clr), f(r.d_snf_pct), f(r.d_qty_kgs), f(r.d_kg_fat), f(r.d_kg_snf),
        f(r.ts_qty_litres), f(r.ts_fat_pct), f(r.ts_snf_pct), f(r.ts_qty_kgs), f(r.ts_kg_fat), f(r.ts_kg_snf),
        r.qty_var_litres, r.fat_var, r.snf_var, r.remarks, r.entered_by_name]);
    const sum = k => rows.reduce((s, r) => s + (parseFloat(r[k]) || 0), 0);
    const tot = ws.addRow(['TOTAL', '', '', '', '', '', '', '', '', sum('d_qty_litres'), '', '', '', sum('d_qty_kgs'), sum('d_kg_fat'), sum('d_kg_snf'),
      sum('ts_qty_litres'), '', '', sum('ts_qty_kgs'), sum('ts_kg_fat'), sum('ts_kg_snf'), sum('qty_var_litres'), '', '', '', '']);
    tot.font = { bold: true };
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=qa_tanker_dispatch_${req.query.from || 'all'}_${req.query.to || ''}.xlsx`);
    res.send(buf);
  } catch (err) { console.error('[quality] excel error:', err); res.status(500).json({ error: 'Failed to build the Excel' }); }
});

module.exports = router;
