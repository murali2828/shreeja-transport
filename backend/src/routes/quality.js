// backend/src/routes/quality.js
// Quality team: tanker dispatch vs truck-sheet (RMRD) entries — migration 052.
// Independent of the tanker team's executions: own table, own module
// permission ('quality'). The one exception (owner, 2026-10-10): the report
// shows, per tanker × lifting date, the plant acknowledgement totals keyed by
// the logistics team, read-only, so QA can compare. Mounted at /api/quality.
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
  { const m = n(b.ts_mbrt_hours); if (Number.isNaN(m) || (m != null && (m < 0 || m > 24))) errs.push('MBRT (hours, 0–24)'); }
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
    t.ts_qty_litres, t.ts_fat_pct, t.ts_snf_pct, t.ts_qty_kgs, t.ts_kg_fat, t.ts_kg_snf, n(b.ts_mbrt_hours),
    String(b.remarks || '').trim() || null, user.id, user.full_name || user.user_id];
}
const COLS = `lifting_date, route_id, route_name, tanker_id, tanker_number, bmcu_id, bmcu_code, bmcu_name, compartment, scale_reading, shifts,
  d_qty_litres, d_fat_pct, d_clr, d_snf_pct, d_qty_kgs, d_kg_fat, d_kg_snf,
  ts_date, ts_shift, ts_qty_litres, ts_fat_pct, ts_snf_pct, ts_qty_kgs, ts_kg_fat, ts_kg_snf, ts_mbrt_hours, remarks, entered_by, entered_by_name`;
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
  if (ISO.test(q.from || '')) add('e.lifting_date >= ?', q.from);
  if (ISO.test(q.to || '')) add('e.lifting_date <= ?', q.to);
  if (q.tanker_id) add('e.tanker_id = ?', q.tanker_id);
  if (q.bmcu_id) add('e.bmcu_id = ?', q.bmcu_id);
  if (q.route_id) add('e.route_id = ?', q.route_id);
  // Aliases shadow the columns, so WHERE / ORDER BY qualify them with the table alias.
  return { sql: `SELECT e.*, e.lifting_date::text AS lifting_date, e.ts_date::text AS ts_date, e.submission_date::text AS submission_date
                 FROM qa_dispatch_entries e ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY e.lifting_date DESC, e.tanker_number, e.bmcu_code, e.compartment LIMIT 2000`, params };
}

const r2 = v => (v == null || !Number.isFinite(parseFloat(v)) ? null : Math.round(parseFloat(v) * 100) / 100);
// Plant acknowledgement per tanker × lifting date for the QA rows in the
// filter: live (non-cancelled) executions of milk plans of that tanker on that
// plan date, all chambers. Keyed "tanker_id|YYYY-MM-DD".
async function ackFor(rows) {
  const keys = [...new Set(rows.map(r => `${r.tanker_id}|${r.lifting_date}`))];
  if (!keys.length) return {};
  const tankerIds = keys.map(k => parseInt(k.split('|')[0], 10));
  const dates = keys.map(k => k.split('|')[1]);
  const r = await query(`
    SELECT tp.tanker_id, tp.plan_for_date::text AS d, COUNT(DISTINCT te.id)::int AS trips,
           SUM(a.qty_litres) AS litres, SUM(a.qty_kgs) AS kgs, SUM(a.kg_fat) AS kg_fat, SUM(a.kg_snf) AS kg_snf
    FROM unnest($1::int[], $2::date[]) AS k(tanker_id, d)
    JOIN trip_plans tp ON tp.tanker_id = k.tanker_id AND tp.plan_for_date = k.d AND tp.status NOT IN ('cancelled','deleted')
    JOIN trip_executions te ON te.trip_plan_id = tp.id AND te.status <> 'cancelled'
    LEFT JOIN trip_acknowledgements a ON a.execution_id = te.id
    GROUP BY tp.tanker_id, tp.plan_for_date`, [tankerIds, dates]);
  const out = {};
  for (const x of r.rows) {
    const kgs = parseFloat(x.kgs) || 0;
    out[`${x.tanker_id}|${x.d}`] = { trips: x.trips, litres: x.litres == null ? null : r2(x.litres), kgs: x.kgs == null ? null : r2(x.kgs),
      kg_fat: x.kg_fat == null ? null : r2(x.kg_fat), kg_snf: x.kg_snf == null ? null : r2(x.kg_snf),
      fat_pct: kgs > 0 ? r2(parseFloat(x.kg_fat) / kgs * 100) : null, snf_pct: kgs > 0 ? r2(parseFloat(x.kg_snf) / kgs * 100) : null };
  }
  return out;
}

// Route → tanker × lifting date groups with QA totals and the acknowledgement.
const SUMS = ['d_qty_litres', 'd_qty_kgs', 'd_kg_fat', 'd_kg_snf', 'ts_qty_litres', 'ts_qty_kgs', 'ts_kg_fat', 'ts_kg_snf'];
function totalsOf(rows) {
  const t = {};
  for (const k of SUMS) t[k] = r2(rows.reduce((s, r) => s + (parseFloat(r[k]) || 0), 0));
  t.d_fat_pct = t.d_qty_kgs > 0 ? r2(t.d_kg_fat / t.d_qty_kgs * 100) : null;
  t.d_snf_pct = t.d_qty_kgs > 0 ? r2(t.d_kg_snf / t.d_qty_kgs * 100) : null;
  t.ts_fat_pct = t.ts_qty_kgs > 0 ? r2(t.ts_kg_fat / t.ts_qty_kgs * 100) : null;
  t.ts_snf_pct = t.ts_qty_kgs > 0 ? r2(t.ts_kg_snf / t.ts_qty_kgs * 100) : null;
  t.qty_var_litres = r2(t.d_qty_litres - t.ts_qty_litres);
  const mb = rows.map(r => parseFloat(r.ts_mbrt_hours)).filter(Number.isFinite);
  t.ts_mbrt_min = mb.length ? r2(Math.min(...mb)) : null;      // lowest MBRT = weakest milk in the group
  return t;
}
function addAck(a, b) {
  if (!b) return a;
  const out = { ...a };
  for (const k of ['litres', 'kgs', 'kg_fat', 'kg_snf']) out[k] = r2((a[k] || 0) + (b[k] || 0));
  out.trips = (a.trips || 0) + (b.trips || 0);
  out.fat_pct = out.kgs > 0 ? r2(out.kg_fat / out.kgs * 100) : null;
  out.snf_pct = out.kgs > 0 ? r2(out.kg_snf / out.kgs * 100) : null;
  return out;
}
function withAckVar(t, ack) {
  if (!ack || ack.litres == null) return { ...t, ack: ack || null };
  // Acknowledgement vs RMRD (truck sheet): qty, kgs, fat % and SNF % points.
  return { ...t, ack, ack_vs_ts_litres: r2(ack.litres - t.ts_qty_litres), ack_vs_d_litres: r2(ack.litres - t.d_qty_litres),
    ack_vs_ts_kgs: r2(ack.kgs - t.ts_qty_kgs),
    ack_vs_ts_fat: ack.fat_pct != null && t.ts_fat_pct != null ? r2(ack.fat_pct - t.ts_fat_pct) : null,
    ack_vs_ts_snf: ack.snf_pct != null && t.ts_snf_pct != null ? r2(ack.snf_pct - t.ts_snf_pct) : null };
}
function groupReport(rows, acks) {
  const routes = new Map();
  for (const r of rows) {
    const rk = r.route_name || '— No route —';
    if (!routes.has(rk)) routes.set(rk, new Map());
    const tk = `${r.tanker_id}|${r.lifting_date}`;
    const g = routes.get(rk);
    if (!g.has(tk)) g.set(tk, { key: tk, tanker_number: r.tanker_number, lifting_date: r.lifting_date, rows: [] });
    g.get(tk).rows.push(r);
  }
  let grandAck = {};
  const out = [...routes.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([route, g]) => {
    let routeAck = {};
    const tankers = [...g.values()].sort((a, b) => b.lifting_date.localeCompare(a.lifting_date) || a.tanker_number.localeCompare(b.tanker_number))
      .map(t => { const ack = acks[t.key] || null; routeAck = addAck(routeAck, ack); return { ...t, totals: withAckVar(totalsOf(t.rows), ack) }; });
    grandAck = addAck(grandAck, routeAck);
    const routeRows = tankers.flatMap(t => t.rows);
    return { route, tankers, totals: withAckVar(totalsOf(routeRows), routeAck.trips ? routeAck : null) };
  });
  return { routes: out, totals: withAckVar(totalsOf(rows), grandAck.trips ? grandAck : null) };
}

// GET /api/quality/entries/report — same filter, grouped with acknowledgement.
router.get('/entries/report', ...gate, async (req, res) => {
  try {
    const { sql, params } = listSql(req.query);
    const rows = (await query(sql, params)).rows.map(withVar);
    res.json(groupReport(rows, await ackFor(rows)));
  } catch (err) { console.error('[quality] report error:', err); res.status(500).json({ error: `Failed to build the report: ${err.message}` }); }
});

router.get('/entries', ...gate, async (req, res) => {
  try { const { sql, params } = listSql(req.query); res.json((await query(sql, params)).rows.map(withVar)); }
  catch (err) { console.error('[quality] list error:', err); res.status(500).json({ error: `Failed to load entries: ${err.message}` }); }
});

// Excel in the quality team's format (column order fixed, 2026-10-07), grouped
// by route and tanker × lifting date with the plant acknowledgement on each
// tanker subtotal (owner, 2026-10-10); section-coloured headers.
const SECTIONS = [
  ['Entry', 9, 'FFE2E8F0'], ['Dispatch', 7, 'FFDBEAFE'], ['Truck Sheet (RMRD)', 7, 'FFDCFCE7'],
  ['Variation (Dispatch − Truck Sheet)', 3, 'FFFEF3C7'], ['Plant Acknowledgement (Logistics)', 6, 'FFEDE9FE'], ['Ack vs RMRD (Truck Sheet)', 5, 'FFFCE7F3'], ['', 2, 'FFF1F5F9'],
];
router.get('/entries/excel', ...gate, async (req, res) => {
  try {
    const { sql, params } = listSql(req.query);
    const rows = (await query(sql, params)).rows.map(withVar);
    const rep = groupReport(rows, await ackFor(rows));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Tanker Dispatch');
    const FILL = c => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: c } });
    const thin = { style: 'thin', color: { argb: 'FFBFC7D1' } }, BOX = { top: thin, bottom: thin, left: thin, right: thin };
    const HEADS = ['Submission Date', 'Route Name', 'Milk Lifting Date', 'Tanker No', 'BMCU Code', 'BMCU Name', 'Compartment', 'Scale Reading', 'Shift',
      'Qty Lts (Dispatch)', 'Fat % (Dispatch)', 'CLR (Dispatch)', 'SNF (Dispatch)', 'Qty Kgs (Dispatch)', 'KG Fat (Dispatch)', 'KG SNF (Dispatch)',
      'Qty Lts (Truck Sheet)', 'Fat % (Truck Sheet)', 'SNF (Truck Sheet)', 'Qty Kgs (Truck Sheet)', 'KG Fat (Truck Sheet)', 'KG SNF (Truck Sheet)', 'MBRT (hrs)',
      'Qty Variation (Lts)', 'Fat Variation', 'SNF Variation',
      'Ack Qty Lts', 'Ack Qty Kgs', 'Ack Fat %', 'Ack SNF %', 'Ack KG Fat', 'Ack KG SNF',
      'Ack − RMRD Lts', 'Ack − RMRD Kgs', 'Ack − RMRD Fat %', 'Ack − RMRD SNF %', 'Ack − Dispatch Lts',
      'Remarks', 'Entered By'];
    const NC = HEADS.length;
    ws.mergeCells(1, 1, 1, NC);
    ws.getCell(1, 1).value = `QA Tanker Dispatch Report ${req.query.from ? fmtDateDisplay(req.query.from) : ''} → ${req.query.to ? fmtDateDisplay(req.query.to) : ''}`;
    ws.getCell(1, 1).fill = FILL('FF005BA3'); ws.getCell(1, 1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 }; ws.getRow(1).height = 22;
    // Section band row + column header row, coloured per section.
    let c = 1; const colFill = [];
    for (const [label, span, argb] of SECTIONS) {
      if (span > 1) ws.mergeCells(2, c, 2, c + span - 1);
      const cell = ws.getCell(2, c); cell.value = label; cell.font = { bold: true }; cell.alignment = { horizontal: 'center' };
      for (let k = c; k < c + span; k++) { ws.getCell(2, k).fill = FILL(argb); ws.getCell(2, k).border = BOX; colFill[k] = argb; }
      c += span;
    }
    const hr = ws.getRow(3); HEADS.forEach((h, i) => { const cell = hr.getCell(i + 1); cell.value = h; cell.font = { bold: true, size: 10 };
      cell.fill = FILL(colFill[i + 1]); cell.border = BOX; cell.alignment = { wrapText: true, horizontal: 'center', vertical: 'middle' }; });
    hr.height = 42;
    const f = v => (v == null ? null : parseFloat(v));
    const ackCells = t => t.ack ? [t.ack.litres, t.ack.kgs, t.ack.fat_pct, t.ack.snf_pct, t.ack.kg_fat, t.ack.kg_snf,
                                   t.ack_vs_ts_litres ?? null, t.ack_vs_ts_kgs ?? null, t.ack_vs_ts_fat ?? null, t.ack_vs_ts_snf ?? null, t.ack_vs_d_litres ?? null]
                                : ['no trip', '', '', '', '', '', '', '', '', '', ''];
    const totCells = (label, route, t) => [label, route, '', '', '', '', '', '', '',
      t.d_qty_litres, t.d_fat_pct, '', t.d_snf_pct, t.d_qty_kgs, t.d_kg_fat, t.d_kg_snf,
      t.ts_qty_litres, t.ts_fat_pct, t.ts_snf_pct, t.ts_qty_kgs, t.ts_kg_fat, t.ts_kg_snf, t.ts_mbrt_min,
      t.qty_var_litres, '', '', ...ackCells(t), '', ''];
    const styleRow = (row, fill) => { for (let k = 1; k <= NC; k++) { const cell = row.getCell(k); cell.border = BOX; if (fill) { cell.fill = FILL(fill); cell.font = { bold: true }; }
      if (k >= 8 && k <= 37 && typeof cell.value === 'number') cell.numFmt = '#,##0.00'; } };
    let zebra = 0;
    for (const rg of rep.routes) {
      for (const tg of rg.tankers) {
        for (const r of tg.rows) {
          const row = ws.addRow([fmtDateDisplay(r.submission_date), r.route_name, fmtDateDisplay(r.lifting_date), r.tanker_number, r.bmcu_code, r.bmcu_name, r.compartment,
            f(r.scale_reading), r.shifts, f(r.d_qty_litres), f(r.d_fat_pct), f(r.d_clr), f(r.d_snf_pct), f(r.d_qty_kgs), f(r.d_kg_fat), f(r.d_kg_snf),
            f(r.ts_qty_litres), f(r.ts_fat_pct), f(r.ts_snf_pct), f(r.ts_qty_kgs), f(r.ts_kg_fat), f(r.ts_kg_snf), f(r.ts_mbrt_hours),
            r.qty_var_litres, r.fat_var, r.snf_var, '', '', '', '', '', '', '', '', '', '', '', r.remarks, r.entered_by_name]);
          styleRow(row, (zebra++ % 2) ? 'FFF5F8FC' : null);
          if (zebra % 2 === 0) row.font = { bold: false };
        }
      }
      styleRow(ws.addRow(totCells(`Route total · ${rg.route}`, '', rg.totals)), 'FFDBEAFE');
    }
    styleRow(ws.addRow(totCells('GRAND TOTAL', '', rep.totals)), 'FFFFF9C4');
    ws.columns.forEach((col, i) => { col.width = i === 0 ? 30 : [5, 37].includes(i) ? 22 : 13; });
    ws.views = [{ state: 'frozen', ySplit: 3, xSplit: 4 }];
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=qa_tanker_dispatch_${req.query.from || 'all'}_${req.query.to || ''}.xlsx`);
    res.send(buf);
  } catch (err) { console.error('[quality] excel error:', err); res.status(500).json({ error: 'Failed to build the Excel' }); }
});

module.exports = router;
