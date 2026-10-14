// backend/src/services/transportCumulative.js
// Month / Year Cumulative of transport cost and milk (Reports → Tanker
// Utilisation; moved from the Payment Report, owner 2026-10-14). Months up to
// ANALYTICS_HISTORY_UNTIL come from the FY workbook (historical_trips /
// historical_month_tolls), later months from approved billing runs, earlier
// financial years from the keyed monthly history (transport_monthly_history).
const ExcelJS = require('exceljs');
const { query } = require('../config/db');
const { autoWidth, stylePortalWorkbook } = require('./portalExcel');

const rN = (v, d = 2) => v == null ? null : Math.round(parseFloat(v) * 10 ** d) / 10 ** d;
// Trips up to this date come from the FY workbook (historical_trips, migration
// 065); portal billing lines on or before it are left out (owner, 2026-10-13).
const HISTORY_UNTIL = /^\d{4}-\d{2}-\d{2}$/.test(process.env.ANALYTICS_HISTORY_UNTIL || '') ? process.env.ANALYTICS_HISTORY_UNTIL : '2026-08-31';

// ── Month / year cumulative (finance format sheets) ─────────────────────────
// Month Cumulative: every month of the financial year of `from` (April → March)
// from billing lines (same run-status / tanker / vendor filters) with the
// plant's acknowledged milk, plus the average diesel ₹/L of the month from the
// Diesel Rates master. Year Cumulative: month × financial year matrix with YTD;
// years before the portal come from transport_monthly_history (migration 059);
// a month present in the portal always wins over the keyed history.
const FY_MONTHS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const fyOf = iso => { const [y, m] = iso.split('-').map(Number); return m >= 4 ? y : y - 1; };
const fyLabel = y => `${y}-${String(y + 1).slice(2)}`;
const monthMetrics = r => {
  const kgs = parseFloat(r.milk_kgs) || 0, l = parseFloat(r.milk_litres) || 0, amt = parseFloat(r.amount) || 0;
  const km = parseFloat(r.total_km) || 0, cap = parseFloat(r.capacity_litres) || 0, trips = parseInt(r.trips) || 0;
  const y = r.year, m = r.month, days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    year: y, month: m, month_name: MONTH_NAMES[m - 1], fy_start_year: r.fy_start_year, source: r.source,
    capacity_litres: rN(cap), milk_litres: rN(l), milk_kgs: rN(kgs),
    fat_pct: kgs > 0 ? rN(parseFloat(r.kg_fat) / kgs * 100, 3) : null,
    snf_pct: kgs > 0 ? rN(parseFloat(r.kg_snf) / kgs * 100, 3) : null,
    ts_pct:  kgs > 0 ? rN((parseFloat(r.kg_fat) + parseFloat(r.kg_snf)) / kgs * 100, 3) : null,
    kg_fat: rN(r.kg_fat, 3), kg_snf: rN(r.kg_snf, 3),
    total_km: rN(km), rate_per_km: km > 0 ? rN(amt / km) : null, amount: rN(amt),
    // Toll of the month: FY-workbook monthly total up to ANALYTICS_HISTORY_UNTIL,
    // else the toll challans of that month's billing runs (by run start).
    toll_amount: r.toll_amount == null ? null : rN(r.toll_amount),
    total_cost: r.toll_amount == null ? rN(amt) : rN(amt + (parseFloat(r.toll_amount) || 0)),
    cost_per_litre: l > 0 ? rN(amt / l, 4) : null,
    utilisation_pct: cap > 0 && l > 0 ? rN(l / cap * 100) : null,
    trips, avg_km: trips > 0 ? rN(km / trips) : null, milk_per_day: rN(l / days),
    diesel_price: r.diesel_price == null ? null : rN(r.diesel_price),
    diesel_sum: r.diesel_sum == null ? null : rN(r.diesel_sum),
  };
};
async function cumulativeData(q) {
  const fy = fyOf(q.from);
  const params = [HISTORY_UNTIL];
  const cond = ['t.excluded = FALSE', 't.plan_for_date > $1'];
  if ((q.status || 'approved') !== 'all') { params.push('approved'); cond.push(`br.status = $${params.length}`); }
  const portal = await query(`
    SELECT EXTRACT(YEAR FROM t.plan_for_date)::int AS year, EXTRACT(MONTH FROM t.plan_for_date)::int AS month,
           COUNT(*)::int AS trips, SUM(t.capacity_litres) AS capacity_litres, SUM(t.billed_km) AS total_km, SUM(t.amount) AS amount,
           SUM(ack.litres) AS milk_litres, SUM(ack.kgs) AS milk_kgs, SUM(ack.kg_fat) AS kg_fat, SUM(ack.kg_snf) AS kg_snf
    FROM billing_run_trips t JOIN billing_runs br ON br.id = t.run_id
    LEFT JOIN LATERAL (
      SELECT SUM(a.qty_litres) AS litres, SUM(a.qty_kgs) AS kgs, SUM(a.kg_fat) AS kg_fat, SUM(a.kg_snf) AS kg_snf
      FROM trip_acknowledgements a WHERE a.execution_id = t.execution_id) ack ON TRUE
    WHERE ${cond.join(' AND ')}
    GROUP BY 1, 2 ORDER BY 1, 2`, params);
  // Diesel per month as finance shows it: "Disel Price" = sum of the
  // fortnightly prices (each fortnight = average across states), "Diesl
  // Rate" = their average.
  const diesel = await query(`
    SELECT EXTRACT(YEAR FROM effective_from)::int AS year, EXTRACT(MONTH FROM effective_from)::int AS month,
           SUM(p) AS diesel_sum, AVG(p) AS diesel_price
    FROM (SELECT effective_from, AVG(price_per_litre) AS p FROM diesel_rates GROUP BY effective_from) f
    GROUP BY 1, 2`);
  const dieselMap = new Map(diesel.rows.map(x => [`${x.year}-${x.month}`, parseFloat(x.diesel_price)]));
  const dieselSumMap = new Map(diesel.rows.map(x => [`${x.year}-${x.month}`, parseFloat(x.diesel_sum)]));
  const history = await query(`SELECT * FROM transport_monthly_history ORDER BY fy_start_year, month`);
  // Toll per month: FY workbook (historical_month_tolls, migration 066) up to the
  // cutoff; afterwards the challans of billing runs starting in the month (same
  // run-status filter), toll carried in from earlier cycles included.
  const histToll = await query(`SELECT EXTRACT(YEAR FROM month_start)::int AS year, EXTRACT(MONTH FROM month_start)::int AS month, toll_amount
    FROM historical_month_tolls WHERE month_start <= $1`, [HISTORY_UNTIL]);
  const portalToll = await query(`
    SELECT EXTRACT(YEAR FROM br.from_date)::int AS year, EXTRACT(MONTH FROM br.from_date)::int AS month, SUM(tl.amount) AS toll_amount
    FROM billing_run_tolls tl JOIN billing_runs br ON br.id = tl.run_id
    WHERE br.from_date > $1 ${(q.status || 'approved') !== 'all' ? "AND br.status = 'approved'" : ''}
    GROUP BY 1, 2`, [HISTORY_UNTIL]);
  const tollMap = new Map([...histToll.rows, ...portalToll.rows].map(x => [`${x.year}-${x.month}`, parseFloat(x.toll_amount)]));
  // Months up to ANALYTICS_HISTORY_UNTIL: the trip-level FY workbook (historical_trips).
  const tripHist = await query(`
    SELECT EXTRACT(YEAR FROM report_date)::int AS year, EXTRACT(MONTH FROM report_date)::int AS month,
           COUNT(*)::int AS trips, SUM(capacity_litres) AS capacity_litres, SUM(billed_km) AS total_km, SUM(amount) AS amount,
           SUM(milk_litres) AS milk_litres, SUM(milk_kgs) AS milk_kgs, SUM(kg_fat) AS kg_fat, SUM(kg_snf) AS kg_snf
    FROM historical_trips WHERE report_date <= $1 GROUP BY 1, 2`, [HISTORY_UNTIL]);

  const portalMap = new Map(portal.rows.map(x => [`${x.year}-${x.month}`, { ...x, fy_start_year: x.month >= 4 ? x.year : x.year - 1, source: 'portal',
    diesel_price: dieselMap.get(`${x.year}-${x.month}`) ?? null, diesel_sum: dieselSumMap.get(`${x.year}-${x.month}`) ?? null }]));
  const tripHistMap = new Map(tripHist.rows.map(x => [`${x.year}-${x.month}`, { ...x, fy_start_year: x.month >= 4 ? x.year : x.year - 1, source: 'FY workbook',
    diesel_price: dieselMap.get(`${x.year}-${x.month}`) ?? null, diesel_sum: dieselSumMap.get(`${x.year}-${x.month}`) ?? null }]));
  const histMap = new Map(history.rows.map(h => {
    const year = h.month >= 4 ? h.fy_start_year : h.fy_start_year + 1;
    return [`${year}-${h.month}`, { ...h, year, source: h.source ? `history (${h.source})` : 'history', total_km: h.total_km,
      diesel_sum: h.diesel_price == null ? null : parseFloat(h.diesel_price) * 2 }];
  }));
  const monthRow = (fyYear, m) => {
    const year = m >= 4 ? fyYear : fyYear + 1;
    const key = `${year}-${m}`;
    const r = portalMap.get(key) || tripHistMap.get(key) || histMap.get(key);
    const toll = tollMap.has(key) ? tollMap.get(key) : null;
    return monthMetrics({ ...(r || { year, month: m, fy_start_year: fyYear, source: null, trips: 0 }), toll_amount: toll });
  };
  const months = FY_MONTHS.map(m => monthRow(fy, m));
  const fys = [...new Set([fy, ...portal.rows.map(x => x.month >= 4 ? x.year : x.year - 1), ...tripHist.rows.map(x => x.month >= 4 ? x.year : x.year - 1),
    ...history.rows.map(h => h.fy_start_year)])].sort();
  const years = fys.map(y => {
    const rows = FY_MONTHS.map(m => monthRow(y, m));
    const sum = k => rows.reduce((s, r) => s + (parseFloat(r[k]) || 0), 0);
    const ytd = monthMetrics({ year: y, month: 4, fy_start_year: y, source: 'ytd', trips: sum('trips'),
      capacity_litres: sum('capacity_litres'), milk_litres: sum('milk_litres'), milk_kgs: sum('milk_kgs'), kg_fat: sum('kg_fat'), kg_snf: sum('kg_snf'),
      total_km: sum('total_km'), amount: sum('amount'),
      toll_amount: rows.some(r => r.toll_amount != null) ? sum('toll_amount') : null,
      diesel_price: (() => { const d = rows.filter(r => r.diesel_price != null); return d.length ? d.reduce((s, r) => s + r.diesel_price, 0) / d.length : null; })(),
      diesel_sum: (() => { const d = rows.filter(r => r.diesel_sum != null); return d.length ? d.reduce((s, r) => s + r.diesel_sum, 0) : null; })() });
    ytd.month_name = 'YTD';
    ytd.milk_per_day = rN(sum('milk_litres') / rows.filter(r => r.trips > 0).reduce((s, r) => s + new Date(Date.UTC(r.year, r.month, 0)).getUTCDate(), 0) || 0);
    return { fy_start_year: y, fy_label: fyLabel(y), months: rows, ytd };
  });
  const fyMonths = months; // alias
  const total = years.find(x => x.fy_start_year === fy)?.ytd || null;
  return { fy_start_year: fy, fy_label: fyLabel(fy), months: fyMonths, months_total: total, years };
}

const HIST_COLS = [['fy_start_year', 'FY start year (2023 for 2023-24)'], ['month', 'Month (1-12)'],
  ['tanker_capacity_litres', 'Tanker capacity (L)'], ['milk_litres', 'Milk received (L)'], ['milk_kgs', 'Milk received (kg)'],
  ['kg_fat', 'Kg fat'], ['kg_snf', 'Kg SNF'], ['total_km', 'Total KM'], ['amount', 'Amount (₹)'], ['trips', 'Trips'],
  ['diesel_price', 'Diesel ₹/L (avg)'], ['source', 'Source / note']];

async function historyTemplateBuffer() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Monthly History');
  ws.addRow(HIST_COLS.map(c => c[1])).font = { bold: true };
  ws.addRow([2023, 4, 15580000, 14767718.04, 15147415.5, 611327.62, 1252492.6, 270623, 13611779.32, 789, 99.66, 'example — replace']);
  ws.columns.forEach(c => { c.width = 22; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function listHistory() {
  return (await query(`SELECT * FROM transport_monthly_history ORDER BY fy_start_year, month`)).rows;
}
// Upload of earlier years' monthly figures (replaces the same FY × month).
async function uploadHistory(buffer, user) {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buffer); } catch { const e = new Error('Invalid or corrupted Excel file'); e.status = 400; throw e; }
    const ws = wb.worksheets[0];
    const num = v => { if (v && typeof v === 'object') v = v.result ?? v.text ?? null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    const txt = v => { if (v && typeof v === 'object') v = v.result ?? v.text ?? (v.richText ? v.richText.map(t => t.text).join('') : ''); return v == null ? null : String(v).trim() || null; };
    let saved = 0; const errors = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const vals = HIST_COLS.map((_, i) => row.getCell(i + 1).value);
      if (vals.every(v => v == null || v === '')) continue;
      const fyY = num(vals[0]), m = num(vals[1]);
      if (!fyY || fyY < 2000 || fyY > 2100 || !m || m < 1 || m > 12) { errors.push(`Row ${r}: FY start year / month invalid`); continue; }
      if (txt(vals[11]) === 'example — replace') continue;
      await query(`
        INSERT INTO transport_monthly_history (fy_start_year, month, tanker_capacity_litres, milk_litres, milk_kgs, kg_fat, kg_snf,
          total_km, amount, trips, diesel_price, source, created_by, created_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (fy_start_year, month) DO UPDATE SET tanker_capacity_litres=EXCLUDED.tanker_capacity_litres, milk_litres=EXCLUDED.milk_litres,
          milk_kgs=EXCLUDED.milk_kgs, kg_fat=EXCLUDED.kg_fat, kg_snf=EXCLUDED.kg_snf, total_km=EXCLUDED.total_km, amount=EXCLUDED.amount,
          trips=EXCLUDED.trips, diesel_price=EXCLUDED.diesel_price, source=EXCLUDED.source, updated_at=NOW()`,
        [fyY, m, num(vals[2]), num(vals[3]), num(vals[4]), num(vals[5]), num(vals[6]), num(vals[7]), num(vals[8]),
         num(vals[9]) == null ? null : Math.round(num(vals[9])), num(vals[10]), txt(vals[11]), user.id, user.user_id || user.full_name || null]);
      saved++;
    }
  return { saved, errors: errors.slice(0, 30) };
}

// Month Cumulative + Year Cumulative sheets in the portal styling.
async function buildCumulativeWorkbook(d, statusLabel) {
  const wb = new ExcelJS.Workbook();
    // Month Cumulative — the financial year of the From date
    const MC_HEADS = ['S.NO', 'Month Wise', 'Tankers Capacity in Lits', 'Milk Received From Tankers in Lits', 'Milk Received From Tankers in Kgs',
      'Fat %', 'Snf%', 'TS %', 'Fat Kgs', 'Snf Kgs', 'Total KM', 'Rate Per KM', 'Amount in RS', 'Toll in RS', 'Total Cost in RS', 'Cost Per Liter Rs', 'Utilization %',
      'Total Trips', 'AVG KM', 'Disel Price', 'Diesl Rate'];
    const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mcRow = (i, m, label) => [i, label, m.capacity_litres, m.milk_litres, m.milk_kgs, m.fat_pct, m.snf_pct, m.ts_pct, m.kg_fat, m.kg_snf,
      m.total_km, m.rate_per_km, m.amount, m.toll_amount, m.total_cost, m.cost_per_litre, m.utilisation_pct, m.trips || null, m.avg_km, m.diesel_sum, m.diesel_price];
    const ws5 = wb.addWorksheet('Month Cumulative');
    ws5.addRow([`Tanker Utilisation · Month Cumulative FY ${d.fy_label} · ${statusLabel}`]).font = { bold: true, size: 13 };
    ws5.addRow([]);
    ws5.addRow(MC_HEADS);
    d.months.forEach((m, i) => ws5.addRow(mcRow(i + 1, m, `${MON3[m.month - 1]}-${String(m.year).slice(2)}`)));
    if (d.months_total) ws5.addRow(mcRow('TOTAL', d.months_total, '')).font = { bold: true };
    const MC_DEC2 = ['Fat %', 'Snf%', 'TS %', 'Rate Per KM', 'Cost Per Liter Rs', 'Utilization %', 'AVG KM', 'Disel Price', 'Diesl Rate'];
    for (let c = 3; c <= MC_HEADS.length; c++) ws5.getColumn(c).numFmt = MC_DEC2.includes(MC_HEADS[c - 1]) ? '0.00' : '#,##0.00';
    ws5.getColumn(2).alignment = { horizontal: 'center' };

    // Year Cumulative — metric rows × (month × FY) columns, YTD at the end
    const ws6 = wb.addWorksheet('Year Cumulative');
    const fyLabels = d.years.map(y => y.fy_label);
    const groups = [...FY_MONTHS.map((m, i) => ({ label: d.years[0] ? `${MONTH_NAMES[m - 1]}'${m >= 4 ? '' : ''}` : MONTH_NAMES[m - 1], idx: i })), { label: 'YTD', idx: 'ytd' }];
    const r2 = ['MONTH'], r3 = ['YEAR'];
    groups.forEach(g => { fyLabels.forEach(fl => { r2.push(g.label); r3.push(fl); }); });
    ws6.addRow([`Tanker Utilisation · Year Cumulative · ${statusLabel} · portal months from billing runs, earlier years from the keyed monthly history`]).font = { bold: true, size: 12 };
    ws6.addRow(r2).font = { bold: true };
    ws6.addRow(r3).font = { bold: true };
    groups.forEach((g, gi) => { const c1 = 2 + gi * fyLabels.length; if (fyLabels.length > 1) ws6.mergeCells(2, c1, 2, c1 + fyLabels.length - 1); ws6.getCell(2, c1).alignment = { horizontal: 'center' }; });
    const METRICS = [['Tanker Capacities in Ltrs', 'capacity_litres'], ['Milk Received In Litres', 'milk_litres'], ["Milk Received In KG's", 'milk_kgs'],
      ['FAT%', 'fat_pct'], ['SNF%', 'snf_pct'], ['TS%', 'ts_pct'], ['KG FAT', 'kg_fat'], ['KG SNF', 'kg_snf'], ['Milk Received per day in litres', 'milk_per_day'],
      ['Total KM', 'total_km'], ['Rate Per KM', 'rate_per_km'], ['Amount in RS', 'amount'], ['Toll in RS', 'toll_amount'], ['Total Cost in RS', 'total_cost'],
      ['Cost Per Liter Rs', 'cost_per_litre'],
      ['Utilization %', 'utilisation_pct'], ['Diesel Prices', 'diesel_price'], ['Number Of Trips', 'trips'], ['Average KMs', 'avg_km']];
    METRICS.forEach(([label, k]) => {
      const row = [label];
      groups.forEach(g => d.years.forEach(y => { const m = g.idx === 'ytd' ? y.ytd : y.months[g.idx]; row.push(m.trips || m.source ? m[k] : null); }));
      ws6.addRow(row).getCell(1).font = { bold: true };
    });
    // Portal palette: blue title band, light-blue two-row header, borders,
    // zebra rows, YTD columns in the TOTAL yellow (same look as the other sheets).
    const FILL6 = c => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: c } });
    const thin6 = { style: 'thin', color: { argb: 'FFBFC7D1' } }, BOX6 = { top: thin6, bottom: thin6, left: thin6, right: thin6 };
    const lastRow = 3 + METRICS.length, lastCol = 1 + groups.length * fyLabels.length;
    ws6.mergeCells(1, 1, 1, lastCol);
    ws6.getCell(1, 1).fill = FILL6('FF005BA3'); ws6.getCell(1, 1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 }; ws6.getRow(1).height = 22;
    for (let r = 2; r <= lastRow; r++) for (let c = 1; c <= lastCol; c++) {
      const cell = ws6.getCell(r, c);
      cell.border = BOX6;
      const isYtd = c > 1 && groups[Math.floor((c - 2) / fyLabels.length)].idx === 'ytd';
      if (r <= 3) { cell.fill = FILL6('FFDCE9F7'); cell.font = { bold: true, size: 10, color: { argb: 'FF1F2937' } }; cell.alignment = { horizontal: 'center', vertical: 'middle' }; }
      else if (isYtd) { cell.fill = FILL6('FFFFF9C4'); cell.font = { bold: true }; }
      else if ((r - 3) % 2 === 0) cell.fill = FILL6('FFF5F8FC');
      if (c > 1 && r > 3) cell.numFmt = ['fat_pct', 'snf_pct', 'ts_pct', 'rate_per_km', 'cost_per_litre', 'utilisation_pct', 'diesel_price', 'avg_km'].includes(METRICS[r - 4][1]) ? '0.00' : '#,##0';
    }
    ws6.getColumn(1).width = 30;
    ws6.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }];

    stylePortalWorkbook(wb, 'Tanker Utilisation', ['Year Cumulative']);
    autoWidth(ws6, { skipRows: 1 });
    ws6.getColumn(1).width = 30;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = {
  HISTORY_UNTIL, FY_MONTHS, MONTH_NAMES, fyOf, fyLabel,
  cumulativeData, historyTemplateBuffer, listHistory, uploadHistory, buildCumulativeWorkbook,
};
