// backend/src/routes/tankerRates.js
// Tanker Rate Master — fortnightly ₹/KM rates per state × capacity (KL) ×
// transport type. Screen CRUD + Excel template download/upload.
// Duplicate protection (both paths):
//   1. exact duplicate: same effective_from + state + capacity + type (DB unique)
//   2. overlapping period: a new row whose [from,to] overlaps an existing row
//      for the same state + capacity + type is rejected.
const express = require('express');
const router  = express.Router();
const XLSX    = require('xlsx');
const multer  = require('multer');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const STATES = ['Andhra Pradesh', 'Tamil Nadu', 'Karnataka', 'Telangana'];
const TYPES  = ['BMCU/CC to Dairy/CC', 'Point to Point'];

const normState = s => {
  const t = String(s || '').trim().toLowerCase();
  const hit = STATES.find(x => x.toLowerCase() === t);
  if (hit) return hit;
  if (t === 'ap') return 'Andhra Pradesh';
  if (t === 'tn') return 'Tamil Nadu';
  if (t === 'ka') return 'Karnataka';
  if (t === 'ts' || t === 'tg') return 'Telangana';
  return null;
};
const normType = s => {
  const t = String(s || '').trim().toLowerCase();
  if (t.includes('point')) return 'Point to Point';
  if (t.includes('bmcu') || t.includes('dairy')) return 'BMCU/CC to Dairy/CC';
  return null;
};
const toDate = v => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);                 // YYYY-MM-DD
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);        // DD.MM.YYYY / DD-MM-YYYY
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  if (!isNaN(v)) {                                             // Excel serial date
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  return null;
};
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

// Validate one rate row; returns { error } or { row }.
function validateRow(r) {
  const effective_from = toDate(r.effective_from);
  const effective_to   = toDate(r.effective_to);
  const state          = normState(r.state);
  const capacity_kl    = num(r.capacity_kl);
  const transport_type = normType(r.transport_type);
  const rate_per_km    = num(r.rate_per_km);
  if (!effective_from || !effective_to) return { error: 'effective from/to dates are required (DD.MM.YYYY or YYYY-MM-DD)' };
  if (effective_to < effective_from)    return { error: 'effective to is before effective from' };
  if (!state)          return { error: `state must be one of: ${STATES.join(', ')} (or AP/TN/KA/TS)` };
  if (!capacity_kl || capacity_kl <= 0) return { error: 'capacity (KL) must be a positive number' };
  if (!transport_type) return { error: `transport type must be one of: ${TYPES.join(' / ')}` };
  if (rate_per_km == null || rate_per_km <= 0) return { error: 'rate per KM must be a positive number' };
  return { row: {
    effective_from, effective_to, state, capacity_kl, transport_type, rate_per_km,
    mileage_km_per_litre: num(r.mileage_km_per_litre),
    diesel_price: num(r.diesel_price),
  } };
}

// Overlap check for the same state + capacity + type (excluding a row id on edit)
async function findOverlap(row, excludeId = null) {
  const r = await query(`
    SELECT id, effective_from::text AS effective_from, effective_to::text AS effective_to
    FROM tanker_rates
    WHERE state=$1 AND capacity_kl=$2 AND transport_type=$3
      AND effective_from <= $5::date AND effective_to >= $4::date
      AND ($6::int IS NULL OR id != $6::int)
    LIMIT 1`,
    [row.state, row.capacity_kl, row.transport_type, row.effective_from, row.effective_to, excludeId]);
  return r.rows[0] || null;
}

// ── GET /api/tanker-rates?state=&transport_type=&on_date=&capacity_kl= ───────
router.get('/', authenticate, async (req, res) => {
  try {
    const cond = []; const params = [];
    if (req.query.state)          { params.push(req.query.state);          cond.push(`state = $${params.length}`); }
    if (req.query.transport_type) { params.push(req.query.transport_type); cond.push(`transport_type = $${params.length}`); }
    if (req.query.capacity_kl)    { params.push(parseFloat(req.query.capacity_kl)); cond.push(`capacity_kl = $${params.length}`); }
    if (req.query.on_date)        { params.push(req.query.on_date);        cond.push(`$${params.length}::date BETWEEN effective_from AND effective_to`); }
    const r = await query(`
      SELECT id, effective_from::text AS effective_from, effective_to::text AS effective_to,
             state, capacity_kl, transport_type, mileage_km_per_litre, rate_per_km,
             diesel_price, created_by_name, created_at
      FROM tanker_rates
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY effective_from DESC, state, capacity_kl, transport_type`, params);
    res.json(r.rows);
  } catch (err) {
    console.error('Tanker rates list error:', err);
    res.status(500).json({ error: 'Failed to load tanker rates' });
  }
});

// ── POST /api/tanker-rates ───────────────────────────────────────────────────
router.post('/', authenticate, authorize('admin', 'planner'), async (req, res) => {
  const v = validateRow(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const dup = await findOverlap(v.row);
    if (dup) return res.status(409).json({
      error: `Duplicate: a rate for ${v.row.state} / ${v.row.capacity_kl} KL / ${v.row.transport_type} already covers ${dup.effective_from} → ${dup.effective_to}` });
    const r = await query(`
      INSERT INTO tanker_rates
        (effective_from, effective_to, state, capacity_kl, transport_type,
         mileage_km_per_litre, rate_per_km, diesel_price, created_by, created_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [v.row.effective_from, v.row.effective_to, v.row.state, v.row.capacity_kl,
       v.row.transport_type, v.row.mileage_km_per_litre, v.row.rate_per_km,
       v.row.diesel_price, req.user.id, req.user.user_id || req.user.full_name || null]);
    res.json({ id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Duplicate: this date/state/capacity/transport-type combination already exists' });
    console.error('Tanker rate create error:', err);
    res.status(500).json({ error: 'Failed to save rate' });
  }
});

// ── PUT /api/tanker-rates/:id ────────────────────────────────────────────────
router.put('/:id', authenticate, authorize('admin', 'planner'), async (req, res) => {
  const v = validateRow(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const dup = await findOverlap(v.row, parseInt(req.params.id));
    if (dup) return res.status(409).json({
      error: `Duplicate: a rate for ${v.row.state} / ${v.row.capacity_kl} KL / ${v.row.transport_type} already covers ${dup.effective_from} → ${dup.effective_to}` });
    const r = await query(`
      UPDATE tanker_rates SET
        effective_from=$1, effective_to=$2, state=$3, capacity_kl=$4, transport_type=$5,
        mileage_km_per_litre=$6, rate_per_km=$7, diesel_price=$8, updated_at=NOW()
      WHERE id=$9 RETURNING id`,
      [v.row.effective_from, v.row.effective_to, v.row.state, v.row.capacity_kl,
       v.row.transport_type, v.row.mileage_km_per_litre, v.row.rate_per_km,
       v.row.diesel_price, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Rate not found' });
    res.json({ id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Duplicate: this date/state/capacity/transport-type combination already exists' });
    console.error('Tanker rate update error:', err);
    res.status(500).json({ error: 'Failed to update rate' });
  }
});

// ── DELETE /api/tanker-rates/:id ─────────────────────────────────────────────
router.delete('/:id', authenticate, authorize('admin', 'planner'), async (req, res) => {
  try {
    const r = await query('DELETE FROM tanker_rates WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Rate not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Tanker rate delete error:', err);
    res.status(500).json({ error: 'Failed to delete rate' });
  }
});

// ── GET /api/tanker-rates/template ───────────────────────────────────────────
// Matrix layout matching the fortnightly rate circular: one row per tanker
// capacity, mileage norms, then per-state column pairs (BMCU/CC to Dairy/CC |
// Point to Point). Effective dates + per-state diesel prices at the top.
const CAPACITIES = [6, 9, 10, 11, 12, 13, 15, 17.4, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
const MILEAGE = { 6: [6.4, 7], 9: [5.5, 6], 10: [5.5, 6], 11: [5, 5.5], 12: [5, 5.5], 13: [5, 5.5],
  15: [3.5, 4], 17.4: [3, 3.6], 18: [3, 3.6], 19: [3, 3.6], 20: [3, 3.6], 21: [3, 3.6], 22: [3, 3.6],
  23: [3, 3.6], 24: [3, 3.6], 25: [3, 3.6], 26: [3, 3.6], 27: [3, 3.6], 28: [3, 3.6], 29: [3, 3.6], 30: [2.9, 3.2] };

router.get('/template', authenticate, (req, res) => {
  const aoa = [
    ['Tanker Rates — Fortnightly Upload (fill rates, leave blanks to skip)'],
    ['Effective From (DD.MM.YYYY)', '', 'Effective To (DD.MM.YYYY)', ''],
    ['Diesel Price (Rs/Ltr)', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', 'Andhra Pradesh', '', 'Tamil Nadu', '', 'Karnataka', '', 'Telangana', ''],
    ['S.No', 'Tanker Capacity (KL)', 'Mileage KM/Ltr (BMCU/CC to Dairy/CC)', 'Mileage KM/Ltr (Point to Point)',
     'BMCU/CC to Dairy/CC', 'Point to Point', 'BMCU/CC to Dairy/CC', 'Point to Point',
     'BMCU/CC to Dairy/CC', 'Point to Point', 'BMCU/CC to Dairy/CC', 'Point to Point'],
    ...CAPACITIES.map((c, i) => [i + 1, c, MILEAGE[c]?.[0] ?? '', MILEAGE[c]?.[1] ?? '',
      '', '', '', '', '', '', '', '']),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 6 }, { wch: 18 }, { wch: 28 }, { wch: 26 },
    ...Array(8).fill({ wch: 18 })];
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 11 } },   // title
    { s: { r: 3, c: 4 }, e: { r: 3, c: 5 } },    // AP
    { s: { r: 3, c: 6 }, e: { r: 3, c: 7 } },    // TN
    { s: { r: 3, c: 8 }, e: { r: 3, c: 9 } },    // KA
    { s: { r: 3, c: 10 }, e: { r: 3, c: 11 } },  // TS
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Tanker Rates');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=tanker_rates_template.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── POST /api/tanker-rates/upload ────────────────────────────────────────────
// Parses the matrix template above: effective dates + diesel prices from the
// header block, then per capacity-row × state-pair × transport-type one rate
// row each. Blank rate cells are skipped; duplicates/overlaps rejected.
router.post('/upload', authenticate, authorize('admin', 'planner'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Locate the header block by content (robust to added/removed rows)
    const findRow = pred => raw.findIndex(r => r.some(c => pred(String(c || ''))));
    const effRowI    = findRow(t => t.toLowerCase().includes('effective from'));
    const dieselRowI = findRow(t => t.toLowerCase().includes('diesel price'));
    const headRowI   = findRow(t => t.trim().toLowerCase() === 's.no');
    if (effRowI < 0 || headRowI < 0)
      return res.status(400).json({ error: 'Template layout not recognised — download a fresh template' });

    const effRow = raw[effRowI];
    const fromI = effRow.findIndex(c => String(c || '').toLowerCase().includes('effective from'));
    const toI   = effRow.findIndex(c => String(c || '').toLowerCase().includes('effective to'));
    const effective_from = toDate(effRow[fromI + 1]);
    const effective_to   = toDate(effRow[toI + 1]);
    if (!effective_from || !effective_to)
      return res.status(400).json({ error: 'Fill Effective From / Effective To next to their labels (DD.MM.YYYY)' });
    if (effective_to < effective_from)
      return res.status(400).json({ error: 'Effective To is before Effective From' });

    // State column pairs: [stateName, bmcuRateCol, p2pRateCol]
    const statePairs = [
      ['Andhra Pradesh', 4, 5], ['Tamil Nadu', 6, 7], ['Karnataka', 8, 9], ['Telangana', 10, 11],
    ];
    const diesel = {};
    if (dieselRowI >= 0) for (const [st, c] of statePairs.map(p => [p[0], p[1]]))
      diesel[st] = num(raw[dieselRowI][c]);

    let inserted = 0;
    const errors = [];
    for (let i = headRowI + 1; i < raw.length; i++) {
      const row = raw[i];
      const capacity_kl = num(row[1]);
      if (!capacity_kl || capacity_kl <= 0) continue;   // blank / note row
      const mileage = { 'BMCU/CC to Dairy/CC': num(row[2]), 'Point to Point': num(row[3]) };
      for (const [state, bmcuCol, p2pCol] of statePairs) {
        for (const [type, col] of [['BMCU/CC to Dairy/CC', bmcuCol], ['Point to Point', p2pCol]]) {
          const rate = num(row[col]);
          if (rate == null || rate === 0) continue;     // blank cell = skip
          const cand = { effective_from, effective_to, state, capacity_kl,
            transport_type: type, rate_per_km: rate,
            mileage_km_per_litre: mileage[type], diesel_price: diesel[state] ?? null };
          const dup = await findOverlap(cand);
          if (dup) {
            errors.push(`${state} / ${capacity_kl} KL / ${type}: duplicate — already covered ${dup.effective_from} → ${dup.effective_to}`);
            continue;
          }
          try {
            await query(`
              INSERT INTO tanker_rates
                (effective_from, effective_to, state, capacity_kl, transport_type,
                 mileage_km_per_litre, rate_per_km, diesel_price, created_by, created_by_name)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [cand.effective_from, cand.effective_to, cand.state, cand.capacity_kl,
               cand.transport_type, cand.mileage_km_per_litre, cand.rate_per_km,
               cand.diesel_price, req.user.id, req.user.user_id || req.user.full_name || null]);
            inserted++;
          } catch (err) {
            if (err.code === '23505') errors.push(`${state} / ${capacity_kl} KL / ${type}: duplicate`);
            else errors.push(`${state} / ${capacity_kl} KL / ${type}: ${err.message}`);
          }
        }
      }
    }
    res.json({ inserted, skipped: errors.length, errors: errors.slice(0, 30) });
  } catch (err) {
    console.error('Tanker rates upload error:', err);
    res.status(500).json({ error: 'Failed to process the uploaded file' });
  }
});

module.exports = router;
