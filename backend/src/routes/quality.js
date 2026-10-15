// backend/src/routes/quality.js
// Quality team: tanker dispatch vs truck-sheet (RMRD) entries — migration 052.
// Independent of the tanker team's executions: own table, own module
// permission ('quality'). The report shows, per tanker × lifting date, the
// plant acknowledgement keyed by the QA team itself (qa_acknowledgements,
// migration 069, owner 2026-10-15; replaced the logistics team's acks shown
// since 2026-10-10). Mounted at /api/quality.
const express = require('express');
const router  = express.Router();
const ExcelJS = require('exceljs');
const { query, pool } = require('../config/db');
const { authenticate, authorizeModule } = require('../middleware/auth');
const { fmtDateDisplay } = require('../utils/date');
const { computeDispatch, computeTruckSheet, adjustRmrd, variations, chamberBreakup, n } = require('../services/qaDispatch');

const gate = [authenticate, authorizeModule('quality')];
const COMPARTMENTS = ['FC', 'MC', 'BC'];
// Tanker Master keeps compartments as text ('2C', '3C', '3'); 2 → FC, BC; 3+ → FC, MC, BC; unknown → all.
const { compartmentCodes } = require('../utils/compartments');
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
  if (!['Cow', 'Buffalo', 'Mixed'].includes(b.milk_type)) errs.push('milk type (Cow / Buffalo / Mixed)');
  if (b.shifts && !SHIFTS.test(String(b.shifts).replace(/\s/g, ''))) errs.push('shifts (e.g. 23E,24M,24E)');
  for (const [k, label] of [['scale_reading', 'scale reading'], ['d_qty_litres', 'dispatch litres'], ['d_fat_pct', 'dispatch fat %'], ['d_clr', 'CLR'],
                            ['ts_qty_litres', 'truck sheet litres'], ['ts_fat_pct', 'truck sheet fat %'], ['ts_snf_pct', 'truck sheet SNF %'],
                            ['lo_qty_litres', 'left over milk litres'], ['lo_fat_pct', 'left over milk fat %'], ['lo_snf_pct', 'left over milk SNF %'],
                            ['lf_qty_litres', 'lifted milk litres'], ['lf_fat_pct', 'lifted milk fat %'], ['lf_snf_pct', 'lifted milk SNF %']]) {
    const v = n(b[k]); if (Number.isNaN(v) || (v != null && v < 0)) errs.push(label + ' must be a number');
  }
  if (n(b.d_qty_litres) == null) errs.push('dispatch litres');
  { const m = n(b.ts_mbrt_mins); if (Number.isNaN(m) || (m != null && (m < 0 || m > 1440))) errs.push('MBRT (minutes, 0–1440)'); }
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
    normalizeCompartments(b.compartment), b.milk_type, n(b.scale_reading), b.shifts ? String(b.shifts).replace(/\s/g, '').toUpperCase() : null,
    d.d_qty_litres, d.d_fat_pct, d.d_clr, d.d_snf_pct, d.d_qty_kgs, d.d_kg_fat, d.d_kg_snf,
    b.ts_date || b.lifting_date, b.ts_shift ? String(b.ts_shift).replace(/\s/g, '').toUpperCase() : null,
    t.ts_qty_litres, t.ts_fat_pct, t.ts_snf_pct, t.ts_qty_kgs, t.ts_kg_fat, t.ts_kg_snf, n(b.ts_mbrt_mins),
    n(b.lo_qty_litres), n(b.lo_fat_pct), n(b.lo_snf_pct), String(b.lo_remarks || '').trim() || null,
    n(b.lf_qty_litres), n(b.lf_fat_pct), n(b.lf_snf_pct), String(b.lf_remarks || '').trim() || null,
    String(b.remarks || '').trim() || null, user.id, user.full_name || user.user_id];
}
const COLS = `lifting_date, route_id, route_name, tanker_id, tanker_number, bmcu_id, bmcu_code, bmcu_name, compartment, milk_type, scale_reading, shifts,
  d_qty_litres, d_fat_pct, d_clr, d_snf_pct, d_qty_kgs, d_kg_fat, d_kg_snf,
  ts_date, ts_shift, ts_qty_litres, ts_fat_pct, ts_snf_pct, ts_qty_kgs, ts_kg_fat, ts_kg_snf, ts_mbrt_mins,
  lo_qty_litres, lo_fat_pct, lo_snf_pct, lo_remarks, lf_qty_litres, lf_fat_pct, lf_snf_pct, lf_remarks, remarks, entered_by, entered_by_name`;
// Balance milk (migration 068): left over / lifted kgs and the adjusted RMRD are computed on read.
const withVar = r => ({ ...r, ...adjustRmrd(r), ...variations(r) });

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
// filter: the QA team's own acknowledgement (qa_acknowledgements, migration
// 069), all chambers. Keyed "tanker_id|YYYY-MM-DD"; `trips` = 1 marks presence.
async function ackFor(rows) {
  const keys = [...new Set(rows.map(r => `${r.tanker_id}|${r.lifting_date}`))];
  if (!keys.length) return {};
  const tankerIds = keys.map(k => parseInt(k.split('|')[0], 10));
  const dates = keys.map(k => k.split('|')[1]);
  const r = await query(`
    SELECT a.tanker_id, a.lifting_date::text AS d, 1 AS trips,
           SUM(a.qty_litres) AS litres, SUM(a.qty_kgs) AS kgs, SUM(a.kg_fat) AS kg_fat, SUM(a.kg_snf) AS kg_snf,
           MIN(a.mbrt_mins) AS mbrt_min
    FROM unnest($1::int[], $2::date[]) AS k(tanker_id, d)
    JOIN qa_acknowledgements a ON a.tanker_id = k.tanker_id AND a.lifting_date = k.d
    GROUP BY a.tanker_id, a.lifting_date`, [tankerIds, dates]);
  const out = {};
  for (const x of r.rows) {
    const kgs = parseFloat(x.kgs) || 0;
    out[`${x.tanker_id}|${x.d}`] = { trips: x.trips, litres: x.litres == null ? null : r2(x.litres), kgs: x.kgs == null ? null : r2(x.kgs),
      kg_fat: x.kg_fat == null ? null : r2(x.kg_fat), kg_snf: x.kg_snf == null ? null : r2(x.kg_snf),
      fat_pct: kgs > 0 ? r2(parseFloat(x.kg_fat) / kgs * 100) : null, snf_pct: kgs > 0 ? r2(parseFloat(x.kg_snf) / kgs * 100) : null,
      mbrt_min: x.mbrt_min == null ? null : r2(x.mbrt_min) };   // lowest chamber MBRT = weakest milk
  }
  return out;
}
// Sibling of ackFor: the QA acknowledgement per chamber, keyed "tanker_id|YYYY-MM-DD"
// → { FC: {...}, MC: {...}, BC: {...} } (owner, 2026-10-15).
async function ackChambersFor(rows) {
  const keys = [...new Set(rows.map(r => `${r.tanker_id}|${r.lifting_date}`))];
  if (!keys.length) return {};
  const r = await query(`
    SELECT a.tanker_id, a.lifting_date::text AS d, a.chamber, a.qty_litres, a.qty_kgs, a.fat_pct, a.snf_pct, a.kg_fat, a.kg_snf, a.mbrt_mins
    FROM unnest($1::int[], $2::date[]) AS k(tanker_id, d)
    JOIN qa_acknowledgements a ON a.tanker_id = k.tanker_id AND a.lifting_date = k.d`,
    [keys.map(k => parseInt(k.split('|')[0], 10)), keys.map(k => k.split('|')[1])]);
  const out = {};
  for (const x of r.rows) {
    const key = `${x.tanker_id}|${x.d}`;
    (out[key] || (out[key] = {}))[x.chamber] = { litres: r2(x.qty_litres), kgs: r2(x.qty_kgs), fat_pct: r2(x.fat_pct), snf_pct: r2(x.snf_pct),
      kg_fat: r2(x.kg_fat), kg_snf: r2(x.kg_snf), mbrt_min: r2(x.mbrt_mins) };
  }
  return out;
}

// ── QA plant acknowledgement (migration 069, owner 2026-10-15) ─────────────
// Kgs first like the logistics Acknowledgement screen; litres / kg fat / kg SNF
// derived here with KG_FACTOR. Writes only qa_acknowledgements.
const { KG_FACTOR } = require('../services/executionData');
const r3 = v => Math.round(v * 1000) / 1000;
const ACK_COLS = `id, lifting_date::text AS lifting_date, tanker_id, tanker_number, chamber, ack_date::text AS ack_date, qty_kgs, qty_litres,
  fat_pct, snf_pct, kg_fat, kg_snf, mbrt_mins, remarks, entered_by_name, updated_at`;

// GET /api/quality/acks/tankers?date= — tankers with QA entries (or QA acks) that lifting date.
router.get('/acks/tankers', ...gate, async (req, res) => {
  if (!ISO.test(req.query.date || '')) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
  try {
    const r = await query(`
      SELECT t.id, t.tanker_number, t.compartments,
             EXISTS (SELECT 1 FROM qa_acknowledgements a WHERE a.tanker_id = t.id AND a.lifting_date = $1) AS has_ack,
             (SELECT COUNT(*)::int FROM qa_dispatch_entries e WHERE e.tanker_id = t.id AND e.lifting_date = $1) AS entries
      FROM tankers t
      WHERE t.id IN (SELECT tanker_id FROM qa_dispatch_entries WHERE lifting_date = $1
                     UNION SELECT tanker_id FROM qa_acknowledgements WHERE lifting_date = $1)
      ORDER BY t.tanker_number`, [req.query.date]);
    res.json(r.rows.map(t => ({ ...t, compartment_codes: compartmentCodes(t.compartments) })));
  } catch (err) { console.error('[quality] ack tankers error:', err); res.status(500).json({ error: 'Failed to load tankers' }); }
});

async function ackState(date, tankerId) {
  const tk = (await query('SELECT id, tanker_number, compartments FROM tankers WHERE id=$1', [tankerId])).rows[0];
  if (!tk) return null;
  const codes = compartmentCodes(tk.compartments);
  const saved = (await query(`SELECT ${ACK_COLS} FROM qa_acknowledgements WHERE lifting_date=$1 AND tanker_id=$2`, [date, tankerId])).rows;
  const entries = (await query(`SELECT e.*, e.lifting_date::text AS lifting_date FROM qa_dispatch_entries e WHERE e.lifting_date=$1 AND e.tanker_id=$2`, [date, tankerId])).rows.map(withVar);
  const t = totalsOf(entries);
  const chambers = COMPARTMENTS.filter(c => codes.includes(c) || saved.some(s => s.chamber === c))
    .map(c => saved.find(s => s.chamber === c) || { chamber: c, qty_kgs: null, qty_litres: null, fat_pct: null, snf_pct: null, kg_fat: null, kg_snf: null, mbrt_mins: null, remarks: null });
  return {
    lifting_date: date, tanker_id: tk.id, tanker_number: tk.tanker_number, compartment_codes: codes,
    ack_date: saved.find(s => s.ack_date)?.ack_date || null, chambers,
    reference: { entries: entries.length, d_qty_litres: t.d_qty_litres, d_qty_kgs: t.d_qty_kgs, d_fat_pct: t.d_fat_pct, d_snf_pct: t.d_snf_pct,
      rmrd_adj_qty_litres: t.rmrd_adj_qty_litres, rmrd_adj_qty_kgs: t.rmrd_adj_qty_kgs, rmrd_adj_fat_pct: t.rmrd_adj_fat_pct, rmrd_adj_snf_pct: t.rmrd_adj_snf_pct },
  };
}

// GET /api/quality/acks?date=&tanker_id= — chamber rows (saved or blank) plus QA dispatch / RMRD reference.
router.get('/acks', ...gate, async (req, res) => {
  const { date, tanker_id } = req.query;
  if (!ISO.test(date || '') || !parseInt(tanker_id, 10)) return res.status(400).json({ error: 'date and tanker_id required' });
  try {
    const st = await ackState(date, parseInt(tanker_id, 10));
    if (!st) return res.status(404).json({ error: 'Tanker not found' });
    res.json(st);
  } catch (err) { console.error('[quality] ack load error:', err); res.status(500).json({ error: 'Failed to load the acknowledgement' }); }
});

// PUT /api/quality/acks — upsert per chamber in one transaction; blank qty deletes the chamber's row.
router.put('/acks', ...gate, async (req, res) => {
  const b = req.body || {};
  const tankerId = parseInt(b.tanker_id, 10);
  if (!ISO.test(b.lifting_date || '') || !tankerId) return res.status(400).json({ error: 'lifting_date and tanker_id required' });
  if (b.ack_date && !ISO.test(b.ack_date)) return res.status(400).json({ error: 'ack_date must be YYYY-MM-DD' });
  if (b.ack_date && b.ack_date < b.lifting_date) return res.status(400).json({ error: 'ack_date cannot be before the lifting date' });
  if (!Array.isArray(b.chambers) || !b.chambers.length) return res.status(400).json({ error: 'chambers required' });
  const tk = (await query('SELECT id, tanker_number, compartments FROM tankers WHERE id=$1', [tankerId]).catch(() => ({ rows: [] }))).rows[0];
  if (!tk) return res.status(404).json({ error: 'Tanker not found' });
  const codes = compartmentCodes(tk.compartments);
  const blank = v => v == null || String(v).trim() === '';
  const rows = []; const seen = new Set();
  for (const c of b.chambers) {
    const ch = String(c.chamber || '').toUpperCase();
    if (!COMPARTMENTS.includes(ch)) return res.status(400).json({ error: `Unknown chamber ${c.chamber}` });
    if (seen.has(ch)) return res.status(400).json({ error: `Chamber ${ch} listed twice` });
    seen.add(ch);
    if (blank(c.qty_kgs)) { rows.push({ chamber: ch, del: true }); continue; }
    if (!codes.includes(ch)) return res.status(400).json({ error: `Tanker ${tk.tanker_number} has only ${codes.join(', ')}` });
    const kgs = parseFloat(c.qty_kgs);
    if (!Number.isFinite(kgs) || kgs <= 0) return res.status(400).json({ error: `${ch}: qty (kgs) must be a positive number` });
    const fat = blank(c.fat_pct) ? null : parseFloat(c.fat_pct);
    const snf = blank(c.snf_pct) ? null : parseFloat(c.snf_pct);
    if (fat != null && !(fat >= 0 && fat <= 15)) return res.status(400).json({ error: `${ch}: fat % must be between 0 and 15` });
    if (snf != null && !(snf >= 0 && snf <= 15)) return res.status(400).json({ error: `${ch}: SNF % must be between 0 and 15` });
    const mbrt = blank(c.mbrt_mins) ? null : parseFloat(c.mbrt_mins);
    if (mbrt != null && !(mbrt >= 0 && mbrt <= 1440)) return res.status(400).json({ error: `${ch}: MBRT (minutes) must be between 0 and 1440` });
    rows.push({ chamber: ch, kgs, litres: r3(kgs / KG_FACTOR), fat, snf,
      kg_fat: fat == null ? null : r3(kgs * fat / 100), kg_snf: snf == null ? null : r3(kgs * snf / 100), mbrt,
      remarks: String(c.remarks || '').trim() || null });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      if (r.del) { await client.query('DELETE FROM qa_acknowledgements WHERE lifting_date=$1 AND tanker_id=$2 AND chamber=$3', [b.lifting_date, tankerId, r.chamber]); continue; }
      await client.query(`
        INSERT INTO qa_acknowledgements (lifting_date, tanker_id, tanker_number, chamber, ack_date, qty_kgs, qty_litres, fat_pct, snf_pct, kg_fat, kg_snf, mbrt_mins, remarks, entered_by, entered_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT ON CONSTRAINT uq_qa_acknowledgements_trip_chamber DO UPDATE SET
          tanker_number=EXCLUDED.tanker_number, ack_date=EXCLUDED.ack_date, qty_kgs=EXCLUDED.qty_kgs, qty_litres=EXCLUDED.qty_litres,
          fat_pct=EXCLUDED.fat_pct, snf_pct=EXCLUDED.snf_pct, kg_fat=EXCLUDED.kg_fat, kg_snf=EXCLUDED.kg_snf, mbrt_mins=EXCLUDED.mbrt_mins, remarks=EXCLUDED.remarks,
          entered_by=EXCLUDED.entered_by, entered_by_name=EXCLUDED.entered_by_name, updated_at=NOW()`,
        [b.lifting_date, tankerId, tk.tanker_number, r.chamber, b.ack_date || null, r.kgs, r.litres, r.fat, r.snf, r.kg_fat, r.kg_snf, r.mbrt, r.remarks,
          req.user.id, req.user.full_name || req.user.user_id]);
    }
    // One ack date per tanker × lifting date.
    await client.query('UPDATE qa_acknowledgements SET ack_date=$3 WHERE lifting_date=$1 AND tanker_id=$2', [b.lifting_date, tankerId, b.ack_date || null]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[quality] ack save error:', err);
    return res.status(500).json({ error: 'Failed to save the acknowledgement' });
  } finally { client.release(); }
  try { res.json(await ackState(b.lifting_date, tankerId)); }
  catch (err) { console.error('[quality] ack reload error:', err); res.status(500).json({ error: 'Saved, but failed to reload' }); }
});

// Route → tanker × lifting date groups with QA totals and the acknowledgement.
const SUMS = ['d_qty_litres', 'd_qty_kgs', 'd_kg_fat', 'd_kg_snf', 'ts_qty_litres', 'ts_qty_kgs', 'ts_kg_fat', 'ts_kg_snf',
  'lo_qty_litres', 'lo_qty_kgs', 'lo_kg_fat', 'lo_kg_snf', 'lf_qty_litres', 'lf_qty_kgs', 'lf_kg_fat', 'lf_kg_snf',
  'rmrd_adj_qty_litres', 'rmrd_adj_qty_kgs', 'rmrd_adj_kg_fat', 'rmrd_adj_kg_snf'];
const pctOf = (kg, kgs) => (kgs > 0 ? r2(kg / kgs * 100) : null);
function totalsOf(rows) {
  const t = {};
  for (const k of SUMS) t[k] = r2(rows.reduce((s, r) => s + (parseFloat(r[k]) || 0), 0));
  t.d_fat_pct = t.d_qty_kgs > 0 ? r2(t.d_kg_fat / t.d_qty_kgs * 100) : null;
  t.d_snf_pct = t.d_qty_kgs > 0 ? r2(t.d_kg_snf / t.d_qty_kgs * 100) : null;
  t.ts_fat_pct = t.ts_qty_kgs > 0 ? r2(t.ts_kg_fat / t.ts_qty_kgs * 100) : null;
  t.ts_snf_pct = t.ts_qty_kgs > 0 ? r2(t.ts_kg_snf / t.ts_qty_kgs * 100) : null;
  for (const p of ['lo', 'lf']) { t[`${p}_fat_pct`] = pctOf(t[`${p}_kg_fat`], t[`${p}_qty_kgs`]); t[`${p}_snf_pct`] = pctOf(t[`${p}_kg_snf`], t[`${p}_qty_kgs`]); }
  t.rmrd_adj_fat_pct = pctOf(t.rmrd_adj_kg_fat, t.rmrd_adj_qty_kgs);
  t.rmrd_adj_snf_pct = pctOf(t.rmrd_adj_kg_snf, t.rmrd_adj_qty_kgs);
  t.qty_var_litres = r2(t.d_qty_litres - t.rmrd_adj_qty_litres);   // dispatch − RMRD adjusted for balance milk
  // Fat / SNF points on kg-weighted %, same sign as the entry rows (owner, 2026-10-15).
  t.fat_var = t.d_fat_pct != null && t.rmrd_adj_fat_pct != null ? r2(t.d_fat_pct - t.rmrd_adj_fat_pct) : null;
  t.snf_var = t.d_snf_pct != null && t.rmrd_adj_snf_pct != null ? r2(t.d_snf_pct - t.rmrd_adj_snf_pct) : null;
  const mb = rows.map(r => parseFloat(r.ts_mbrt_mins)).filter(Number.isFinite);
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
  const mb = [a.mbrt_min, b.mbrt_min].filter(v => v != null);
  out.mbrt_min = mb.length ? Math.min(...mb) : null;   // lowest MBRT across the group
  return out;
}
function withAckVar(t, ack) {
  if (!ack || ack.litres == null) return { ...t, ack: ack || null };
  // Acknowledgement vs RMRD (truck sheet adjusted for balance milk, migration 068): qty, kgs, fat % and SNF % points.
  return { ...t, ack, ack_vs_ts_litres: r2(ack.litres - t.rmrd_adj_qty_litres), ack_vs_d_litres: r2(ack.litres - t.d_qty_litres),
    ack_vs_ts_kgs: r2(ack.kgs - t.rmrd_adj_qty_kgs),
    ack_vs_ts_fat: ack.fat_pct != null && t.rmrd_adj_fat_pct != null ? r2(ack.fat_pct - t.rmrd_adj_fat_pct) : null,
    ack_vs_ts_snf: ack.snf_pct != null && t.rmrd_adj_snf_pct != null ? r2(ack.snf_pct - t.rmrd_adj_snf_pct) : null };
}
function groupReport(rows, acks, ackCh = {}) {
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
      .map(t => { const ack = acks[t.key] || null; routeAck = addAck(routeAck, ack); const chambers = chamberBreakup(t.rows, ackCh[t.key]);
        // A chamber filled by exactly one entry shows its QA ack on that entry's row
        // (no repeated line); a separate chamber row stays only for shared / split chambers (owner, 2026-10-15).
        for (const ch of chambers) {
          const hits = t.rows.filter(r => String(r.compartment || '').split(',').map(c => c.trim().toUpperCase()).includes(ch.chamber));
          if (hits.length === 1 && String(hits[0].compartment).trim().toUpperCase() === ch.chamber) { hits[0].chamber_ack = ch; ch.inline = true; }
        }
        return { ...t, totals: withAckVar(totalsOf(t.rows), ack), chambers: chambers.filter(ch => !ch.inline) }; });
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
    res.json(groupReport(rows, await ackFor(rows), await ackChambersFor(rows)));
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
  ['Entry', 10, 'FFE2E8F0'], ['Dispatch', 7, 'FFDBEAFE'], ['Truck Sheet (RMRD)', 19, 'FFDCFCE7'],
  ['Dispatch − RMRD (adjusted)', 3, 'FFFEF3C7'], ['Plant Acknowledgement (QA)', 7, 'FFEDE9FE'], ['Ack vs RMRD (adjusted)', 5, 'FFFCE7F3'], ['', 2, 'FFF1F5F9'],
];
router.get('/entries/excel', ...gate, async (req, res) => {
  try {
    const { sql, params } = listSql(req.query);
    const rows = (await query(sql, params)).rows.map(withVar);
    const rep = groupReport(rows, await ackFor(rows), await ackChambersFor(rows));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Tanker Dispatch');
    const FILL = c => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: c } });
    const thin = { style: 'thin', color: { argb: 'FFBFC7D1' } }, BOX = { top: thin, bottom: thin, left: thin, right: thin };
    const HEADS = ['Submission Date', 'Route Name', 'Milk Lifting Date', 'Tanker No', 'BMCU Code', 'BMCU Name', 'Compartment', 'Milk Type', 'Scale Reading', 'Shift',
      'Qty Lts (Dispatch)', 'Fat % (Dispatch)', 'CLR (Dispatch)', 'SNF (Dispatch)', 'Qty Kgs (Dispatch)', 'KG Fat (Dispatch)', 'KG SNF (Dispatch)',
      'Qty Lts (Truck Sheet)', 'Fat % (Truck Sheet)', 'SNF (Truck Sheet)', 'Qty Kgs (Truck Sheet)', 'KG Fat (Truck Sheet)', 'KG SNF (Truck Sheet)', 'MBRT (mins)',
      'Left Over Lts', 'Left Over Fat %', 'Left Over SNF %', 'Lifted Lts', 'Lifted Fat %', 'Lifted SNF %',
      'RMRD adjusted Lts', 'RMRD adjusted Kgs', 'RMRD adjusted Fat %', 'RMRD adjusted SNF %', 'RMRD adjusted KG Fat', 'RMRD adjusted KG SNF',
      'Qty Variation (Lts)', 'Fat Variation', 'SNF Variation',
      'Ack Qty Lts', 'Ack Qty Kgs', 'Ack Fat %', 'Ack SNF %', 'Ack KG Fat', 'Ack KG SNF', 'Ack MBRT (mins)',
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
    const ackCells = t => t.ack ? [t.ack.litres, t.ack.kgs, t.ack.fat_pct, t.ack.snf_pct, t.ack.kg_fat, t.ack.kg_snf, t.ack.mbrt_min ?? null,
                                   t.ack_vs_ts_litres ?? null, t.ack_vs_ts_kgs ?? null, t.ack_vs_ts_fat ?? null, t.ack_vs_ts_snf ?? null, t.ack_vs_d_litres ?? null]
                                : ['no QA ack', '', '', '', '', '', '', '', '', '', '', ''];
    const totCells = (label, route, t) => [label, route, '', '', '', '', '', '', '', '',
      t.d_qty_litres, t.d_fat_pct, '', t.d_snf_pct, t.d_qty_kgs, t.d_kg_fat, t.d_kg_snf,
      t.ts_qty_litres, t.ts_fat_pct, t.ts_snf_pct, t.ts_qty_kgs, t.ts_kg_fat, t.ts_kg_snf, t.ts_mbrt_min,
      t.lo_qty_litres, t.lo_fat_pct, t.lo_snf_pct, t.lf_qty_litres, t.lf_fat_pct, t.lf_snf_pct,
      t.rmrd_adj_qty_litres, t.rmrd_adj_qty_kgs, t.rmrd_adj_fat_pct, t.rmrd_adj_snf_pct, t.rmrd_adj_kg_fat, t.rmrd_adj_kg_snf,
      t.qty_var_litres, t.fat_var, t.snf_var, ...ackCells(t), '', ''];
    const styleRow = (row, fill) => { for (let k = 1; k <= NC; k++) { const cell = row.getCell(k); cell.border = BOX; if (fill) { cell.fill = FILL(fill); cell.font = { bold: true }; }
      if (k >= 9 && k <= NC - 2 && typeof cell.value === 'number') cell.numFmt = MBRT_COLS.includes(k) ? '0.0' : '#,##0.00'; } };
    const MBRT_COLS = [HEADS.indexOf('MBRT (mins)') + 1, HEADS.indexOf('Ack MBRT (mins)') + 1];
    let zebra = 0;
    for (const rg of rep.routes) {
      for (const tg of rg.tankers) {
        for (const r of tg.rows) {
          const row = ws.addRow([fmtDateDisplay(r.submission_date), r.route_name, fmtDateDisplay(r.lifting_date), r.tanker_number, r.bmcu_code, r.bmcu_name, r.compartment, r.milk_type,
            f(r.scale_reading), r.shifts, f(r.d_qty_litres), f(r.d_fat_pct), f(r.d_clr), f(r.d_snf_pct), f(r.d_qty_kgs), f(r.d_kg_fat), f(r.d_kg_snf),
            f(r.ts_qty_litres), f(r.ts_fat_pct), f(r.ts_snf_pct), f(r.ts_qty_kgs), f(r.ts_kg_fat), f(r.ts_kg_snf), f(r.ts_mbrt_mins),
            f(r.lo_qty_litres), f(r.lo_fat_pct), f(r.lo_snf_pct), f(r.lf_qty_litres), f(r.lf_fat_pct), f(r.lf_snf_pct),
            r.rmrd_adj_qty_litres, r.rmrd_adj_qty_kgs, r.rmrd_adj_fat_pct, r.rmrd_adj_snf_pct, r.rmrd_adj_kg_fat, r.rmrd_adj_kg_snf,
            r.qty_var_litres, r.fat_var, r.snf_var, ...(r.chamber_ack ? ackCells(r.chamber_ack) : Array(12).fill('')), r.remarks, r.entered_by_name]);
          styleRow(row, (zebra++ % 2) ? 'FFF5F8FC' : null);
          if (zebra % 2 === 0) row.font = { bold: false };
        }
        // Chamber-wise QA acknowledgement under the tanker's last entry (owner, 2026-10-15).
        for (const ch of tg.chambers || []) {
          const row = ws.addRow([`${tg.tanker_number} · ${ch.chamber}`, '', fmtDateDisplay(tg.lifting_date), tg.tanker_number, '', '', ch.chamber, '', '', '',
            ch.d_qty_litres ?? null, ch.d_fat_pct ?? null, '', ch.d_snf_pct ?? null, ch.d_qty_kgs ?? null, ch.d_kg_fat ?? null, ch.d_kg_snf ?? null,
            '', '', '', '', '', '', '', '', '', '', '', '', '',
            ch.rmrd_adj_qty_litres ?? null, ch.rmrd_adj_qty_kgs ?? null, ch.rmrd_adj_fat_pct ?? null, ch.rmrd_adj_snf_pct ?? null, ch.rmrd_adj_kg_fat ?? null, ch.rmrd_adj_kg_snf ?? null,
            ch.qty_var_litres ?? null, ch.fat_var ?? null, ch.snf_var ?? null, ...ackCells(ch), '', '']);
          styleRow(row, 'FFF5F3FF');
        }
      }
      styleRow(ws.addRow(totCells(`Route total · ${rg.route}`, '', rg.totals)), 'FFDBEAFE');
    }
    styleRow(ws.addRow(totCells('GRAND TOTAL', '', rep.totals)), 'FFFFF9C4');
    ws.columns.forEach((col, i) => { col.width = i === 0 ? 30 : [5, NC - 2].includes(i) ? 22 : 13; });
    ws.views = [{ state: 'frozen', ySplit: 3, xSplit: 4 }];
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=qa_tanker_dispatch_${req.query.from || 'all'}_${req.query.to || ''}.xlsx`);
    res.send(buf);
  } catch (err) { console.error('[quality] excel error:', err); res.status(500).json({ error: 'Failed to build the Excel' }); }
});

// ─── Dispatch challan + COA (migration 064) ─────────────────────────────────
// One document set per tanker × lifting date. GET returns the saved copy or a
// prefill from QA entries, the plan of that tanker/date and the masters.
const PARTY_KEYS = ['name', 'customer_code', 'sap_vendor_code', 'address', 'place_of_supply', 'gstin', 'state', 'state_code'];
const fyStart = iso => { const [y, m] = iso.split('-').map(Number); return m >= 4 ? y : y - 1; };
const fyLabel = y => `${String(y).slice(2)}-${String(y + 1).slice(2)}`;

router.get('/docs/tankers', ...gate, async (req, res) => {
  if (!ISO.test(req.query.date || '')) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
  try {
    const r = await query(`
      SELECT e.tanker_id, MAX(e.tanker_number) AS tanker_number,
             STRING_AGG(DISTINCT e.route_name, ', ') AS route_name,
             SUM(e.d_qty_litres) AS litres, MAX(d.challan_no) AS challan_no
      FROM qa_dispatch_entries e
      LEFT JOIN qa_trip_documents d ON d.tanker_id = e.tanker_id AND d.lifting_date = e.lifting_date
      WHERE e.lifting_date = $1 GROUP BY e.tanker_id ORDER BY 2`, [req.query.date]);
    res.json(r.rows);
  } catch (err) { console.error('[quality] docs tankers error:', err); res.status(500).json({ error: 'Failed to load tankers' }); }
});

// Milk Dispatch Voucher template defaults (yellow fields of Dispatch.docx).
const DEFAULT_BILL_TO = { name: 'NDDB Dairy Services', address: 'NDDB House, Safdarjung Enclave, South West Delhi, New Delhi 110029',
  gstin: '07AADCN1059J1ZG', state: 'Delhi', state_code: '07' };
const DEFAULT_SHIP_TO = { sap_vendor_code: '4024119', name: 'Mother Dairy Fruit and Vegetable Private Limited (c/o Balaji Dairy)',
  place_of_supply: 'TIRUPATI', gstin: '37AACCM3174A1ZU', state: 'ANDHRA PRADESH', state_code: '37' };
async function docPrefill(date, tankerId) {
  const tk = (await query(`SELECT t.id, t.tanker_number, t.compartments,
      COALESCE(v.vendor_name, t.vendor_name) AS vendor_name
    FROM tankers t LEFT JOIN vendors v ON v.id = t.vendor_id WHERE t.id = $1`, [tankerId])).rows[0];
  if (!tk) return null;
  const entries = (await query(`SELECT * FROM qa_dispatch_entries WHERE lifting_date = $1 AND tanker_id = $2 ORDER BY id`, [date, tankerId])).rows;
  const plan = (await query(`
    SELECT rm.route_name, sp.name AS start_point, tp.delivery_point_id, tp.driver_name
    FROM trip_plans tp
    LEFT JOIN route_masters rm ON rm.id = tp.route_id
    LEFT JOIN starting_points sp ON sp.id = tp.start_point_id
    WHERE tp.tanker_id = $1 AND tp.plan_for_date = $2 AND tp.status NOT IN ('cancelled','deleted')
    ORDER BY tp.id DESC LIMIT 1`, [tankerId, date])).rows[0] || {};
  // Litres per compartment: a row ticked for several compartments is split equally.
  const comp = { FC: { litres: 0, types: new Set() }, MC: { litres: 0, types: new Set() }, BC: { litres: 0, types: new Set() } };
  let kgs = 0, kgFat = 0, kgSnf = 0, litres = 0, mbrt = null;
  for (const e of entries) {
    const codes = String(e.compartment || 'FC').split(',');
    for (const c of codes) { if (!comp[c]) continue; comp[c].litres += (parseFloat(e.d_qty_litres) || 0) / codes.length; if (e.milk_type) comp[c].types.add(e.milk_type); }
    litres += parseFloat(e.d_qty_litres) || 0; kgs += parseFloat(e.d_qty_kgs) || 0;
    kgFat += parseFloat(e.d_kg_fat) || 0; kgSnf += parseFloat(e.d_kg_snf) || 0;
    const m = e.ts_mbrt_mins != null ? parseFloat(e.ts_mbrt_mins) : null;
    if (m != null && (mbrt == null || m < mbrt)) mbrt = m;
  }
  const typeOf = s => (s.size === 0 ? '' : s.size === 1 ? [...s][0] : 'Mixed');
  const allTypes = new Set(entries.map(e => e.milk_type).filter(Boolean));
  const milkType = typeOf(allTypes);
  const fat = kgs ? r2(kgFat / kgs * 100) : null, snf = kgs ? r2(kgSnf / kgs * 100) : null;
  const routeName = plan.route_name || [...new Set(entries.map(e => e.route_name).filter(Boolean))].join(', ');
  const dpId = plan.delivery_point_id || null;
  const dp = dpId ? (await query('SELECT id, name, bill_to, ship_to FROM delivery_points WHERE id = $1', [dpId])).rows[0] : null;
  const mtWord = { Cow: 'RAW COW MILK', Buffalo: 'RAW BUFFALO MILK', Mixed: 'RAW MIXED MILK' };
  const compartments = {};
  for (const c of ['FC', 'MC', 'BC']) compartments[c] = { milk_type: typeOf(comp[c].types), litres: comp[c].litres ? r2(comp[c].litres) : '', seal_no: '' };
  return {
    lifting_date: date, tanker_id: tk.id, tanker_number: tk.tanker_number, delivery_point_id: dpId,
    challan_no: '',
    data: {
      challan_date: date, route_name: routeName, dispatch_center_code: '', dispatch_from: plan.start_point || routeName,
      transporter: tk.vendor_name || '', driver: plan.driver_name || '', vehicle_no: tk.tanker_number,
      lr_no: '', lr_date: '', po_date: '', address: '',
      // Default parties = the paper template's (yellow) values; a plant's saved
      // Bill-to / Ship-to wins field by field; every field stays editable (owner, 2026-10-15).
      bill_to: Object.fromEntries(PARTY_KEYS.map(k => [k, dp?.bill_to?.[k] || DEFAULT_BILL_TO[k] || ''])),
      ship_to: Object.fromEntries(PARTY_KEYS.map(k => [k, dp?.ship_to?.[k] || DEFAULT_SHIP_TO[k] || ''])),
      compartments,
      item: { description: mtWord[milkType] || 'RAW COW MILK', hsn: '0401', batch: '', quantity: litres ? r2(litres) : '', uom: 'Ltrs', value: '',
              cgst_rate: '-', cgst_amt: '-', sgst_rate: '-', sgst_amt: '-', igst_rate: '-', igst_amt: '-', total: '' },
      milk_type: milkType || 'Cow',
      coa: { ...COA_DEFAULTS, appearance: milkType === 'Buffalo' ? 'White to cream colour, odour typical of fresh milk' : 'Cream to slight yellowish colour, odour typical of fresh cow milk',
             fat: fat ?? '', snf: snf ?? '', mbrt: mbrt != null ? `${mbrt} Minutes` : '' },
      totals: { litres: r2(litres), kgs: r2(kgs), fat, snf },
    },
    delivery_point_name: dp?.name || null,
  };
}

// Template defaults of the COA's "Actual Observation" column.
const COA_DEFAULTS = { seal: 'Ok', appearance: '', cleanliness: 'Ok', temperature: '4°C', foreign_matter: 'Absent', fat: '', snf: '', taste: 'Normal',
  acidity: '', mbrt: '', cob: 'Negative', alcohol: 'Negative', neutralizer: 'Negative', urea: 'Negative', ammonium: 'Negative', starch: 'Negative',
  salts: 'Negative', sucrose: 'Negative', glucose: 'Negative', formalin: 'Negative', h2o2: 'Negative', detergent: 'Negative', maltodextrin: 'Negative',
  qac: 'Negative', br_reading: '', nitrates: 'Negative', boric_acid: 'Negative' };

router.get('/docs', ...gate, async (req, res) => {
  const { date, tanker_id } = req.query;
  if (!ISO.test(date || '') || !tanker_id) return res.status(400).json({ error: 'date and tanker_id required' });
  try {
    const saved = (await query(`SELECT d.*, dp.name AS delivery_point_name FROM qa_trip_documents d
      LEFT JOIN delivery_points dp ON dp.id = d.delivery_point_id WHERE d.lifting_date = $1 AND d.tanker_id = $2`, [date, tanker_id])).rows[0];
    const delivery_points = (await query('SELECT id, name, bill_to, ship_to FROM delivery_points WHERE is_active = TRUE ORDER BY name')).rows;
    if (saved) return res.json({ ...saved, saved: true, delivery_points });
    const pre = await docPrefill(date, tanker_id);
    if (!pre) return res.status(404).json({ error: 'Tanker not found' });
    res.json({ ...pre, saved: false, delivery_points });
  } catch (err) { console.error('[quality] docs get error:', err); res.status(500).json({ error: 'Failed to load the documents' }); }
});

router.post('/docs', ...gate, async (req, res) => {
  const b = req.body || {};
  if (!ISO.test(b.lifting_date || '') || !b.tanker_id) return res.status(400).json({ error: 'lifting_date and tanker_id required' });
  if (!b.data || typeof b.data !== 'object') return res.status(400).json({ error: 'data required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tk = (await client.query('SELECT id, tanker_number FROM tankers WHERE id = $1', [b.tanker_id])).rows[0];
    if (!tk) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tanker not found' }); }
    const ex = (await client.query('SELECT id, challan_no FROM qa_trip_documents WHERE lifting_date = $1 AND tanker_id = $2 FOR UPDATE', [b.lifting_date, b.tanker_id])).rows[0];
    let challan = String(b.challan_no || '').trim() || ex?.challan_no;
    if (!challan) {
      const fy = fyStart(b.lifting_date);
      const c = (await client.query(`INSERT INTO qa_challan_counters (fy_start_year, last_no) VALUES ($1, 1)
        ON CONFLICT (fy_start_year) DO UPDATE SET last_no = qa_challan_counters.last_no + 1 RETURNING last_no`, [fy])).rows[0];
      challan = `DC/${fyLabel(fy)}/${String(c.last_no).padStart(4, '0')}`;
    }
    const dpId = b.delivery_point_id ? parseInt(b.delivery_point_id, 10) : null;
    const who = req.user.full_name || req.user.user_id;
    let row;
    if (ex) {
      row = (await client.query(`UPDATE qa_trip_documents SET challan_no=$1, data=$2, delivery_point_id=$3, route_name=$4, updated_by_name=$5, updated_at=NOW()
        WHERE id=$6 RETURNING *`, [challan, b.data, dpId, b.data.route_name || null, who, ex.id])).rows[0];
    } else {
      row = (await client.query(`INSERT INTO qa_trip_documents (lifting_date, tanker_id, tanker_number, route_name, delivery_point_id, challan_no, data, created_by, created_by_name, updated_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`, [b.lifting_date, tk.id, tk.tanker_number, b.data.route_name || null, dpId, challan, b.data, req.user.id, who])).rows[0];
    }
    // "Save as default for this plant": party blocks go back to the delivery point.
    if (b.save_party_defaults && dpId) {
      await client.query('UPDATE delivery_points SET bill_to=$1, ship_to=$2 WHERE id=$3', [b.data.bill_to || null, b.data.ship_to || null, dpId]);
    }
    await client.query('COMMIT');
    res.json({ ...row, saved: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'That challan number is already used on another tanker' });
    console.error('[quality] docs save error:', err); res.status(500).json({ error: 'Failed to save the documents' });
  } finally { client.release(); }
});

// Count prints; the second and later prints carry a DUPLICATE banner.
router.post('/docs/:id/printed', ...gate, async (req, res) => {
  const col = req.query.doc === 'coa' ? 'print_count_coa' : req.query.doc === 'dispatch' ? 'print_count_dispatch' : null;
  if (!col) return res.status(400).json({ error: 'doc must be dispatch or coa' });
  try {
    const r = await query(`UPDATE qa_trip_documents SET ${col} = ${col} + 1 WHERE id = $1 RETURNING ${col} AS count`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Document not found' });
    res.json({ count: r.rows[0].count });
  } catch (err) { console.error('[quality] docs printed error:', err); res.status(500).json({ error: 'Failed to record the print' }); }
});

module.exports = router;
