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
const { authenticate, authorizeOrModule } = require('../middleware/auth');

const XL_FILTER = (req, file, cb) => {
  const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname || '');
  cb(ok ? null : new Error('Only .xlsx / .xls / .csv files are allowed'), ok);
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: XL_FILTER });

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
router.post('/', authenticate, authorizeOrModule('masters', 'admin'), async (req, res) => {
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
router.put('/:id', authenticate, authorizeOrModule('masters', 'admin'), async (req, res) => {
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
router.delete('/:id', authenticate, authorizeOrModule('masters', 'admin'), async (req, res) => {
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

router.get('/template', authenticate, async (req, res) => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tanker Rates');

  const thin   = { style: 'thin',   color: { argb: 'FF9CA3AF' } };
  const medium = { style: 'medium', color: { argb: 'FF374151' } };
  const box    = { top: thin, bottom: thin, left: thin, right: thin };
  const FILL_TITLE  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF005BA3' } };
  const FILL_STATE  = ['FFDCE9F7', 'FFE7F6E7', 'FFFDF0DC', 'FFF3E8F7']
    .map(c => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: c } }));
  const FILL_HEAD   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
  const FILL_INPUT  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } }; // fill-me yellow

  ws.columns = [{ width: 6 }, { width: 18 }, { width: 30 }, { width: 26 },
    ...Array(8).fill({ width: 19 })];

  // Row 1 — title
  ws.mergeCells('A1:L1');
  const t = ws.getCell('A1');
  t.value = 'Tanker Rates — Fortnightly Upload (fill the yellow cells; blank rate cells are skipped)';
  t.fill = FILL_TITLE; t.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
  t.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(1).height = 22;

  // Row 2 — effective dates
  ws.getCell('A2').value = 'Effective From (DD.MM.YYYY)';
  ws.getCell('C2').value = 'Effective To (DD.MM.YYYY)';
  ['A2', 'C2'].forEach(c => { ws.getCell(c).font = { bold: true }; ws.getCell(c).border = box; });
  ['B2', 'D2'].forEach(c => { ws.getCell(c).fill = FILL_INPUT; ws.getCell(c).border = box; });

  // Row 3 — diesel prices (one per state, at each state section start)
  ws.getCell('A3').value = 'Diesel Price (Rs/Ltr)';
  ws.getCell('A3').font = { bold: true };
  ws.getCell('A3').border = box;
  const stateCols = [[5, 6], [7, 8], [9, 10], [11, 12]]; // E:F G:H I:J K:L (1-based)
  stateCols.forEach(([c1, c2], i) => {
    ws.mergeCells(3, c1, 3, c2);
    const cell = ws.getCell(3, c1);
    cell.fill = FILL_INPUT; cell.border = box;
    cell.alignment = { horizontal: 'center' };
  });

  // Row 4 — state group headers
  const stateNames = ['Andhra Pradesh', 'Tamil Nadu', 'Karnataka', 'Telangana'];
  stateCols.forEach(([c1, c2], i) => {
    ws.mergeCells(4, c1, 4, c2);
    const cell = ws.getCell(4, c1);
    cell.value = stateNames[i];
    cell.fill = FILL_STATE[i]; cell.font = { bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  // Row 5 — column headers
  const heads = ['S.No', 'Tanker Capacity (KL)', 'Mileage KM/Ltr (BMCU/CC to Dairy/CC)',
    'Mileage KM/Ltr (Point to Point)',
    'BMCU/CC to Dairy/CC', 'Point to Point', 'BMCU/CC to Dairy/CC', 'Point to Point',
    'BMCU/CC to Dairy/CC', 'Point to Point', 'BMCU/CC to Dairy/CC', 'Point to Point'];
  heads.forEach((h, i) => {
    const cell = ws.getCell(5, i + 1);
    cell.value = h; cell.font = { bold: true, size: 9 };
    cell.fill = i >= 4 ? FILL_STATE[Math.floor((i - 4) / 2)] : FILL_HEAD;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  ws.getRow(5).height = 30;

  // Data rows — capacities with mileage norms; rate cells are inputs
  CAPACITIES.forEach((c, i) => {
    const r = 6 + i;
    ws.getCell(r, 1).value = i + 1;
    ws.getCell(r, 2).value = c;
    ws.getCell(r, 3).value = MILEAGE[c]?.[0] ?? null;
    ws.getCell(r, 4).value = MILEAGE[c]?.[1] ?? null;
    for (let col = 5; col <= 12; col++) ws.getCell(r, col).fill = FILL_INPUT;
    ws.getCell(r, 1).alignment = { horizontal: 'center' };
  });

  // Borders: thin grid over the whole table, medium boxes around each section
  const lastRow = 5 + CAPACITIES.length;
  for (let r = 4; r <= lastRow; r++)
    for (let c = 1; c <= 12; c++) ws.getCell(r, c).border = box;
  const boxRegion = (r1, c1, r2, c2) => {
    for (let r = r1; r <= r2; r++) {
      const l = ws.getCell(r, c1), rr = ws.getCell(r, c2);
      l.border  = { ...l.border,  left:  medium };
      rr.border = { ...rr.border, right: medium };
    }
    for (let c = c1; c <= c2; c++) {
      const tp = ws.getCell(r1, c), bt = ws.getCell(r2, c);
      tp.border = { ...tp.border, top: medium };
      bt.border = { ...bt.border, bottom: medium };
    }
  };
  boxRegion(4, 1, lastRow, 4);                                   // info section
  stateCols.forEach(([c1, c2]) => boxRegion(4, c1, lastRow, c2)); // each state section
  ws.views = [{ state: 'frozen', ySplit: 5, xSplit: 2 }];

  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Disposition', 'attachment; filename=tanker_rates_template.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(Buffer.from(buf));
});

// ── POST /api/tanker-rates/upload ────────────────────────────────────────────
// Parses the matrix template above: effective dates + diesel prices from the
// header block, then per capacity-row × state-pair × transport-type one rate
// row each. Blank rate cells are skipped; duplicates/overlaps rejected.
router.post('/upload', authenticate, authorizeOrModule('masters', 'admin'), upload.single('file'), async (req, res) => {
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
