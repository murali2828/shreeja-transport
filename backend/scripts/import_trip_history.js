// backend/scripts/import_trip_history.js
// Load the logistics team's "Tanker Utilization consolidation" workbook (one
// sheet per month, one row per trip) into historical_trips (migration 065) so
// the Payment Report and the Month / Year Cumulative sheets cover the months
// before the portal was complete (owner, 2026-10-13). Nothing here touches
// plans, executions, billing or the Assure feed.
//
//   node scripts/import_trip_history.js <workbook.xlsx>                     # dry run: checks + per-month totals, writes <workbook>_history.csv
//   node scripts/import_trip_history.js <workbook.xlsx> --apply             # load (re-running replaces the same sheet rows)
//   node scripts/import_trip_history.js <workbook.xlsx> --sheets "April'26,May'26"
//   node scripts/import_trip_history.js <workbook.xlsx> --compare "September'26"   # sheet vs portal billing for that month, no load
//
// Default sheets: April'26 … August'26. Rules (owner, 2026-10-13):
//   - rows without a vehicle number are skipped (sheet totals / blanks);
//   - a date whose year differs from the sheet's year is a typo: the year is set
//     to the sheet's year (noted on the row);
//   - a date before the sheet's month (e.g. 31-03 on the April sheet) is counted
//     in the sheet's month: report_date = the 1st of that month (noted);
//   - plants are normalised (MDFVPL = Balaji Dairy, SKA / S K A Dairy, …);
//   - tankers match Tanker Master by number (spaces / case ignored), vendors by
//     the transporter vendor code; unmatched ones are reported, not rejected.
const path    = require('path');
const fs      = require('fs');
const ExcelJS = require('exceljs');
const { pool } = require('../src/config/db');

const args = process.argv.slice(2);
const FILE = args.find(a => !a.startsWith('--'));
const APPLY = args.includes('--apply');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const COMPARE = opt('--compare', null);
const SHEETS = (opt('--sheets', "April'26,May'26,June'26,July'26,August'26")).split(',').map(s => s.trim()).filter(Boolean);
if (!FILE) { console.error('usage: node scripts/import_trip_history.js <workbook.xlsx> [--apply] [--sheets "April\'26,…"] [--compare "September\'26"]'); process.exit(2); }

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const str = v => (v == null ? '' : (typeof v === 'object' && v.richText ? v.richText.map(t => t.text).join('')
  : typeof v === 'object' && v.result !== undefined ? String(v.result) : v instanceof Date ? v.toISOString() : String(v))).trim();
const raw = v => (v && typeof v === 'object' && !(v instanceof Date) && v.result !== undefined ? v.result : v);
const num = v => { v = raw(v); if (v == null || v === '') return null; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const r2 = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

// Sheet name → { year, month }: "April'26", "August'26", "December 26", "February 2027".
function sheetMonth(name) {
  const m = name.toLowerCase().match(/([a-z]+)\W*(\d{2,4})/);
  if (!m) return null;
  const month = MONTHS.findIndex(x => x.startsWith(m[1].slice(0, 3))) + 1;
  if (!month) return null;
  const year = m[2].length === 2 ? 2000 + parseInt(m[2], 10) : parseInt(m[2], 10);
  return { year, month };
}
// Cell → { y, m, d }: Excel date (exceljs gives UTC midnight) or "31.03.2026".
function cellDate(v) {
  v = raw(v);
  if (v instanceof Date) return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate() };
  const s = String(v ?? '').trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  return s ? { y: +s[3], m: +s[2], d: +s[1] } : null;
}
// Receiving plant → one name per plant (the sheets spell them many ways).
const PLANTS = [
  [/mdfvpl|mdvfpl|balaji/, 'Balaji Dairy (MDFVPL)'],
  [/kmf|kanakapura|shivanahalli/, 'KMF Kanakapura'],
  [/^ska|^s\s*k\s*a/, 'SKA Dairy'],
  [/bathalapalli/, 'Bathalapalli'],
  [/mukund/, 'Mukunda Dairy'],
  [/arvai|arvie/, 'Arvais Dairy (HYD)'],
  [/narmul/, 'NARMUL'],
  [/calvinkare|cavinkare/, 'CavinKare'],
  [/atchay/, 'Atchayam Agro Products'],
  [/jersey.*madanapal/, 'Jersey, Madanapalli'],
  [/jersey.*chennai/, 'Jersey, Chennai'],
  [/farmgate/, 'Farmgate, Palamaner'],
  [/hindustan unilever|\bhul\b/, 'Hindustan Unilever'],
];
const plantName = s => { const t = String(s || '').replace(/\s+/g, ' ').trim(); const l = t.toLowerCase(); const hit = PLANTS.find(([re]) => re.test(l)); return hit ? hit[1] : t || null; };

// Header row 2 (row 1 is the title); columns found by their label so the
// optional "Loader" column on some sheets does not shift anything.
const COLS = {
  plant: /^receiving plant/, date: /^date$/, vehicle: /^vehicle no/, capacity: /^tanker capacity/, vendor: /^transporter name/,
  vendorCode: /^transporter vendor code/, km: /^total km/, rate: /^rate per km/, amount: /^amount/, route: /^route name/,
  litres: /^qty in lts/, kgs: /^qtty in kgs|^qty in kgs/, fat: /^fat %/, snf: /^snf %/, kgFat: /^fat kgs/, kgSnf: /^snf kgs/, bmcus: /^bmcu/,
};
function readSheet(ws) {
  const sm = sheetMonth(ws.name);
  if (!sm) throw new Error(`cannot read the month from sheet name "${ws.name}"`);
  const hdr = ws.getRow(2);
  const col = {};
  hdr.eachCell((c, i) => { const h = str(c.value).replace(/\s+/g, ' ').toLowerCase(); for (const [k, re] of Object.entries(COLS)) if (!col[k] && re.test(h)) col[k] = i; });
  const missing = ['date', 'vehicle', 'km', 'amount', 'litres'].filter(k => !col[k]);
  if (missing.length) throw new Error(`sheet "${ws.name}": columns not found: ${missing.join(', ')}`);
  const monthStart = iso(sm.year, sm.month, 1);
  const out = [], skipped = [];
  let toll = null;
  for (let r = 3; r <= ws.rowCount; r++) {
    const row = ws.getRow(r); const g = k => (col[k] ? row.getCell(col[k]).value : null);
    const vehicle = str(g('vehicle'));
    if (!vehicle) {
      // The month's toll: one "Toll cost" row below the trips, amount in the
      // Amount column ("9K KM Fixed cost" rows are left out — owner, later).
      const label = [1, 2, 3, 4].map(c => str(row.getCell(c).value)).join(' ').toLowerCase();
      if (/toll\s*cost/.test(label) && num(g('amount')) != null) toll = r2(num(g('amount')));
      continue;                                               // blanks and total rows
    }
    const d = cellDate(g('date'));
    if (!d) { skipped.push({ sheet: ws.name, row: r, reason: `unreadable date "${str(g('date'))}"` }); continue; }
    const notes = [];
    if (d.y !== sm.year && !(sm.month === 1 && d.m === 12 && d.y === sm.year - 1)) { notes.push(`year ${d.y} corrected to ${sm.year}`); d.y = sm.year; }
    const tripDate = iso(d.y, d.m, d.d);
    let reportDate = tripDate;
    if (tripDate < monthStart) { reportDate = monthStart; notes.push(`dated ${tripDate}, counted in ${ws.name}`); }
    const kgs = num(g('kgs')), fat = num(g('fat')), snf = num(g('snf'));
    out.push({
      source_sheet: ws.name, source_row: r, trip_date: tripDate, report_date: reportDate,
      plant_raw: str(g('plant')) || null, plant: plantName(str(g('plant'))),
      tanker_number: vehicle.replace(/\s+/g, ' ').toUpperCase(), capacity_litres: num(g('capacity')),
      vendor_name: str(g('vendor')) || null, vendor_code: str(g('vendorCode')).replace(/\.0$/, '') || null,
      route_name: str(g('route')) || null,
      billed_km: num(g('km')), rate_per_km: num(g('rate')), amount: r2(num(g('amount'))),
      milk_litres: r2(num(g('litres'))), milk_kgs: r2(kgs), fat_pct: r2(fat, 3), snf_pct: r2(snf, 3),
      kg_fat: r2(num(g('kgFat')) ?? (kgs != null && fat != null ? kgs * fat / 100 : null), 3),
      kg_snf: r2(num(g('kgSnf')) ?? (kgs != null && snf != null ? kgs * snf / 100 : null), 3),
      bmcu_coverage: str(g('bmcus')) || null, notes: notes.join('; ') || null,
    });
  }
  return { rows: out, skipped, toll: toll == null ? null : { month_start: monthStart, toll_amount: toll, source_sheet: ws.name } };
}

const totals = rows => rows.reduce((t, r) => ({ trips: t.trips + 1, km: t.km + (r.billed_km || 0), amount: t.amount + (r.amount || 0), litres: t.litres + (r.milk_litres || 0) }),
  { trips: 0, km: 0, amount: 0, litres: 0 });
const fmt = n => Math.round(n).toLocaleString('en-IN');

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);

  if (COMPARE) {
    const ws = wb.getWorksheet(COMPARE); if (!ws) throw new Error(`sheet "${COMPARE}" not found`);
    const { rows } = readSheet(ws); const t = totals(rows); const sm = sheetMonth(COMPARE);
    const from = iso(sm.year, sm.month, 1), to = iso(sm.year, sm.month, new Date(Date.UTC(sm.year, sm.month, 0)).getUTCDate());
    const p = (await pool.query(`
      SELECT COUNT(*)::int AS trips, COALESCE(SUM(t.billed_km),0) AS km, COALESCE(SUM(t.amount),0) AS amount,
             COALESCE(SUM((SELECT SUM(a.qty_litres) FROM trip_acknowledgements a WHERE a.execution_id = t.execution_id)),0) AS litres
      FROM billing_run_trips t JOIN billing_runs br ON br.id = t.run_id
      WHERE t.excluded = FALSE AND t.plan_for_date BETWEEN $1 AND $2`, [from, to])).rows[0];
    console.log(`${COMPARE} sheet : ${t.trips} trips, ${fmt(t.km)} km, ₹${fmt(t.amount)}, ${fmt(t.litres)} L`);
    console.log(`portal billing  : ${p.trips} trips, ${fmt(+p.km)} km, ₹${fmt(+p.amount)}, ${fmt(+p.litres)} L  (billing lines, lifting dates ${from} – ${to}, any run status)`);
    await pool.end(); return;
  }

  const all = [], skipped = [], tolls = [];
  for (const name of SHEETS) {
    const ws = wb.getWorksheet(name); if (!ws) throw new Error(`sheet "${name}" not found (sheets: ${wb.worksheets.map(w => w.name).join(', ')})`);
    const r = readSheet(ws); all.push(...r.rows); skipped.push(...r.skipped); if (r.toll) tolls.push(r.toll);
  }
  // Masters: tanker by normalised number, vendor by vendor code.
  const tankers = new Map((await pool.query('SELECT id, tanker_number FROM tankers')).rows.map(t => [norm(t.tanker_number), t.id]));
  const vendors = new Map((await pool.query("SELECT id, vendor_code FROM vendors WHERE vendor_code IS NOT NULL")).rows.map(v => [String(v.vendor_code).trim(), v.id]));
  const noTanker = new Map(), noVendor = new Map(), plants = new Map();
  for (const r of all) {
    r.tanker_id = tankers.get(norm(r.tanker_number)) || null;
    r.vendor_id = r.vendor_code ? vendors.get(r.vendor_code) || null : null;
    if (!r.tanker_id) noTanker.set(r.tanker_number, (noTanker.get(r.tanker_number) || 0) + 1);
    if (!r.vendor_id) { const k = `${r.vendor_code || '-'} ${r.vendor_name || ''}`; noVendor.set(k, (noVendor.get(k) || 0) + 1); }
    const pk = `${r.plant} ← ${r.plant_raw}`; plants.set(pk, (plants.get(pk) || 0) + 1);
  }

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${path.basename(FILE)}`);
  for (const name of SHEETS) { const t = totals(all.filter(r => r.source_sheet === name)); console.log(`  ${name.padEnd(14)} ${String(t.trips).padStart(5)} trips  ${fmt(t.km).padStart(10)} km  ₹${fmt(t.amount).padStart(13)}  ${fmt(t.litres).padStart(12)} L`); }
  console.log(`\nMonthly toll (${tolls.length}):`); tolls.forEach(t => console.log(`  ${t.source_sheet.padEnd(14)} ₹${fmt(t.toll_amount)}`));
  const missingToll = SHEETS.filter(n => !tolls.some(t => t.source_sheet === n));
  if (missingToll.length) console.log(`  no "Toll cost" row on: ${missingToll.join(', ')}`);
  const corrected = all.filter(r => r.notes);
  console.log(`\nCorrections (${corrected.length}):`); corrected.slice(0, 50).forEach(r => console.log(`  ${r.source_sheet} row ${r.source_row} ${r.tanker_number}: ${r.notes}`));
  if (corrected.length > 50) console.log(`  … ${corrected.length - 50} more in the CSV`);
  console.log(`\nSkipped (${skipped.length}):`); skipped.forEach(s => console.log(`  ${s.sheet} row ${s.row}: ${s.reason}`));
  console.log(`\nPlants (normalised ← as typed):`); [...plants].sort().forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}  ${k}`));
  console.log(`\nTankers not in Tanker Master (${noTanker.size}, loaded anyway):`); [...noTanker].forEach(([k, n]) => console.log(`  ${k} (${n})`));
  console.log(`\nVendor codes not in the Vendor master (${noVendor.size}, loaded anyway):`); [...noVendor].forEach(([k, n]) => console.log(`  ${k} (${n})`));

  const csv = FILE.replace(/\.xlsx$/i, '') + '_history.csv';
  const keys = ['source_sheet', 'source_row', 'trip_date', 'report_date', 'plant', 'plant_raw', 'tanker_number', 'tanker_id', 'vendor_code', 'vendor_id', 'billed_km', 'amount', 'milk_litres', 'notes'];
  fs.writeFileSync(csv, [keys.join(','), ...all.map(r => keys.map(k => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n'));
  console.log(`\nRow-by-row report: ${csv}`);

  if (!APPLY) { console.log('\nDry run only — nothing written. Re-run with --apply to load.'); await pool.end(); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Re-running a sheet replaces its rows, so a corrected workbook can be loaded again.
    await client.query('DELETE FROM historical_trips WHERE source_sheet = ANY($1)', [SHEETS]);
    const cols = ['source_sheet', 'source_row', 'trip_date', 'report_date', 'plant_raw', 'plant', 'tanker_number', 'tanker_id', 'capacity_litres',
      'vendor_name', 'vendor_code', 'vendor_id', 'route_name', 'billed_km', 'rate_per_km', 'amount', 'milk_litres', 'milk_kgs', 'fat_pct', 'snf_pct',
      'kg_fat', 'kg_snf', 'bmcu_coverage', 'notes'];
    for (const r of all) {
      await client.query(`INSERT INTO historical_trips (${cols.join(',')}, batch) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}, $${cols.length + 1})`,
        [...cols.map(c => r[c] ?? null), path.basename(FILE)]);
    }
    for (const t of tolls) {
      await client.query(`INSERT INTO historical_month_tolls (month_start, toll_amount, source_sheet, batch) VALUES ($1,$2,$3,$4)
        ON CONFLICT (month_start) DO UPDATE SET toll_amount = EXCLUDED.toll_amount, source_sheet = EXCLUDED.source_sheet, batch = EXCLUDED.batch, created_at = NOW()`,
        [t.month_start, t.toll_amount, t.source_sheet, path.basename(FILE)]);
    }
    await client.query('COMMIT');
    console.log(`\nLoaded ${all.length} trips into historical_trips and ${tolls.length} monthly tolls into historical_month_tolls.`);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); await pool.end(); }
})().catch(e => { console.error('[history] failed:', e.message); process.exit(1); });
