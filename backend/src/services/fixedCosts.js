// backend/src/services/fixedCosts.js
// Minimum-km guarantee (approval note 04-06-2026, May–Oct 2026; migration 067):
// every vendor tanker is paid at least 9,000 km a month; the shortfall is paid
// at a fixed ₹/km by capacity. Finance's approved monthly workbook ("Fixed Cost
// Consolidated Report on <Mon-YY>") is the source: its sheet titled
// "9000 Kms Transporter Wise Difference Fixed Cost On <Mon-YY>" lists, per
// tanker, run km, maintenance days / km, balance km, ₹/km and the amount.
// Used by the upload endpoint (routes/reports.js) and scripts/import_fixed_costs.js.
const ExcelJS = require('exceljs');
const { query, pool } = require('../config/db');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const TITLE = /9000\s*kms?\s*transporter\s*wise\s*difference\s*fixed\s*cost\s*on\s*([a-z]+)\W*(\d{2,4})/i;
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const raw = v => (v && typeof v === 'object' && !(v instanceof Date) ? (v.result !== undefined ? v.result : v.richText ? v.richText.map(t => t.text).join('') : v.text ?? null) : v);
const str = v => { v = raw(v); return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); };
const num = v => { v = raw(v); if (v == null || v === '') return null; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const r2 = v => (v == null ? null : Math.round(v * 100) / 100);
const pad = n => String(n).padStart(2, '0');

// → { month_start, sheet, rows: [...], sheet_total, warnings }
async function parseFixedCostWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  // The workbooks keep earlier months' sheets too (e.g. "… On Sep-25"): take
  // the matching sheet with the LATEST month.
  let ws = null, month_start = null;
  for (const s of wb.worksheets) {
    for (let r = 1; r <= Math.min(3, s.rowCount); r++) {
      const hit = s.getRow(r).values.map(str).join(' ').match(TITLE);
      if (!hit) continue;
      const mi = MONTHS.indexOf(hit[1].slice(0, 3).toLowerCase());
      if (mi < 0) break;
      const year = hit[2].length === 2 ? 2000 + parseInt(hit[2], 10) : parseInt(hit[2], 10);
      const ms = `${year}-${pad(mi + 1)}-01`;
      if (!month_start || ms > month_start) { ws = s; month_start = ms; }
      break;
    }
  }
  if (!ws) throw Object.assign(new Error('No sheet titled "9000 Kms Transporter Wise Difference Fixed Cost On <Mon-YY>" found'), { status: 400 });

  // Header row: the first row carrying "Tanker Numubers" / "Tanker Number".
  let hr = 0;
  for (let r = 1; r <= Math.min(6, ws.rowCount); r++) if (ws.getRow(r).values.map(str).some(v => /^tanker\s*num/i.test(v))) { hr = r; break; }
  if (!hr) throw Object.assign(new Error(`Sheet "${ws.name}": header row with "Tanker Numbers" not found`), { status: 400 });
  const cols = {}; const seen = {};
  ws.getRow(hr).eachCell((c, i) => {
    const h = str(c.value).toLowerCase();
    const add = k => { (seen[k] ||= []).push(i); };
    if (/^transporter\s*name/.test(h)) add('vendor');
    else if (/^po\s*number/.test(h)) add('po');
    else if (/^service\s*sheet/.test(h)) add('ss');
    else if (/^vendor\s*code/.test(h)) add('code');
    else if (/^tanker\s*num/.test(h)) add('tanker');
    else if (/^capacity/.test(h)) add('cap');
    else if (/^total\s*km/.test(h)) add('km');                 // 1st = run km, 2nd = run + maintenance
    else if (/maintenance\s*\(days\)/.test(h)) add('mdays');
    else if (/maintenance\s*\(km\)/.test(h)) add('mkm');
    else if (/^monthly\s*km/.test(h)) add('min');
    else if (/^balance\s*km/.test(h)) add('bal');
    else if (/^fixed\s*cost$/.test(h)) add('rate');
    else if (/difference\s*fixed\s*cost/.test(h)) add('amt');
  });
  for (const k of Object.keys(seen)) cols[k] = seen[k];
  if (!cols.tanker || !cols.amt) throw Object.assign(new Error(`Sheet "${ws.name}": tanker / amount columns not found`), { status: 400 });

  const rows = []; const warnings = []; let vendor = null, code = null, po = null, ss = null, sheetTotal = null;
  for (let r = hr + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const g = (k, n = 0) => (cols[k] && cols[k][n] ? row.getCell(cols[k][n]).value : null);
    const tanker = str(g('tanker')).toUpperCase();
    if (str(g('vendor'))) { vendor = str(g('vendor')); po = str(g('po')) || null; ss = str(g('ss')) || null; }
    if (str(g('code'))) code = str(g('code')).replace(/\.0$/, '');
    if (!tanker) {
      // The grand-total row carries the run-km total; its last amount cell is the sheet total.
      if (num(g('km')) != null && num(g('km')) > 50000) {
        const amts = (cols.amt || []).map(i => num(row.getCell(i).value)).filter(v => v != null);
        const last = row.values.map(num).filter(v => v != null).pop();
        sheetTotal = last ?? amts.pop() ?? null;
      }
      continue;
    }
    if (/^#ref/i.test(tanker)) { warnings.push(`row ${r}: #REF! — skipped`); continue; }
    const amts = cols.amt.map(i => num(row.getCell(i).value)).filter(v => v != null);
    const amount = amts.length ? amts[amts.length - 1] : 0;
    rows.push({
      tanker_number: tanker, vendor_name: vendor, vendor_code: code, po_number: po, service_sheet_no: ss,
      capacity_litres: num(g('cap')), run_km: num(g('km', 0)), maintenance_days: num(g('mdays')), maintenance_km: num(g('mkm')),
      total_km: num(g('km', 1)), min_km: num(g('min')) || 9000, balance_km: num(g('bal')), rate_per_km: num(g('rate')),
      amount: r2(amount),
    });
  }
  const total = r2(rows.reduce((s, x) => s + (x.amount || 0), 0));
  if (sheetTotal != null && Math.abs(sheetTotal - total) > 1) warnings.push(`sum of tanker amounts ₹${total} differs from the sheet total ₹${r2(sheetTotal)}`);
  return { month_start, sheet: ws.name, rows, total, sheet_total: sheetTotal == null ? null : r2(sheetTotal), warnings };
}

// Match tankers / vendors to the masters; returns rows with ids + unmatched lists.
async function matchMasters(rows) {
  const tankers = new Map((await query('SELECT id, tanker_number FROM tankers')).rows.map(t => [norm(t.tanker_number), t.id]));
  const vendors = new Map((await query('SELECT id, vendor_code FROM vendors WHERE vendor_code IS NOT NULL')).rows.map(v => [String(v.vendor_code).trim(), v.id]));
  const out = rows.map(r => ({ ...r, tanker_id: tankers.get(norm(r.tanker_number)) || null, vendor_id: r.vendor_code ? vendors.get(r.vendor_code) || null : null }));
  return {
    rows: out,
    unmatched_tankers: [...new Set(out.filter(r => !r.tanker_id).map(r => r.tanker_number))],
    unmatched_vendors: [...new Set(out.filter(r => !r.vendor_id).map(r => `${r.vendor_code || '-'} ${r.vendor_name || ''}`.trim()))],
  };
}

// Replace one month with the approved rows (one transaction).
async function saveMonth(month_start, rows, { file, user } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM tanker_fixed_costs WHERE month_start = $1', [month_start]);
    for (const r of rows) {
      await client.query(`INSERT INTO tanker_fixed_costs (month_start, tanker_number, tanker_id, vendor_code, vendor_id, vendor_name, capacity_litres,
          run_km, maintenance_days, maintenance_km, total_km, min_km, balance_km, rate_per_km, amount, po_number, service_sheet_no,
          source_file, uploaded_by, uploaded_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        ON CONFLICT (month_start, tanker_number) DO UPDATE SET amount = tanker_fixed_costs.amount + EXCLUDED.amount`,
        [month_start, r.tanker_number, r.tanker_id, r.vendor_code, r.vendor_id, r.vendor_name, r.capacity_litres, r.run_km, r.maintenance_days,
         r.maintenance_km, r.total_km, r.min_km, r.balance_km, r.rate_per_km, r.amount, r.po_number, r.service_sheet_no,
         file || null, user?.id || null, user ? (user.full_name || user.user_id || null) : null]);
    }
    await client.query('COMMIT');
    return { month_start, saved: rows.length };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

// Fixed cost per month (whole months) → Map 'YYYY-M' → amount.
async function fixedCostByMonth() {
  const r = await query(`SELECT EXTRACT(YEAR FROM month_start)::int AS y, EXTRACT(MONTH FROM month_start)::int AS m, SUM(amount) AS amount
    FROM tanker_fixed_costs GROUP BY 1, 2`);
  return new Map(r.rows.map(x => [`${x.y}-${x.m}`, parseFloat(x.amount)]));
}
// Per tanker / per month rows for the whole months inside [from, to].
async function fixedCostsInPeriod(from, to) {
  return (await query(`SELECT month_start::text AS month_start, tanker_number, vendor_name, vendor_code, amount, balance_km, rate_per_km
    FROM tanker_fixed_costs WHERE month_start >= $1 AND (month_start + INTERVAL '1 month' - INTERVAL '1 day')::date <= $2
    ORDER BY month_start, tanker_number`, [from, to])).rows.map(r => ({ ...r, amount: parseFloat(r.amount) }));
}

module.exports = { parseFixedCostWorkbook, matchMasters, saveMonth, fixedCostByMonth, fixedCostsInPeriod, normTanker: norm };
