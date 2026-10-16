// services/dayUtilisation.js
// Day wise Tanker Utilisation rows (Reports → Tanker Utilisation → Day wise),
// shared by routes/reports.js and the billing run Excel's "Tanker Utilisation"
// sheet (owner, 2026-10-16). Utilization % = Ack Qty Ltrs / capacity × 100;
// user approval remarks from utilisation_remarks (migration 072).
const { query } = require('../config/db');
const { fmtDateDisplay } = require('../utils/date');
const { saleTankerSql } = require('../utils/saleTanker');

const rN = (v, d = 2) => v == null ? null : Math.round(parseFloat(v) * 10 ** d) / 10 ** d;
const UTILISATION_THRESHOLD = parseFloat(process.env.UTILISATION_THRESHOLD) || 95;

// opts.runId (owner, 2026-10-16): "By billing run" — exactly the lines of that
// run (excluded and sale-tanker lines too), no date filter, ordered by billing
// date (plan_for_date) then tanker; run-line facts go into the remarks.
async function buildDayUtilisation(fromDate, toDate, threshold, { runId, vendorIds } = {}) {
  const byRun = runId != null;
  const scoped = byRun && Array.isArray(vendorIds) && vendorIds.length > 0;
  // LEFT JOIN acknowledgements — trips sold directly at the BMCU (e.g. Milma
  // tankers) never get a delivery-point acknowledgement, so an INNER JOIN
  // dropped them from utilisation entirely. Dispatch quantity (already
  // collected, tanker-loaded) stands in whenever no ack exists, mirroring
  // the fallback Analytics → Utilisation already uses.
  const r = await query(`
    SELECT tp.trip_no, t.tanker_number, t.capacity_litres,
           ${saleTankerSql('tp', 't')} AS is_sale_tanker,
           rm.route_name, sp.name AS starting_point, dp.name AS delivery_point,
           COALESCE(MIN(ta.ack_date), te.execution_date) AS ack_date,
           COUNT(ta.id) AS ack_count,
           COALESCE(SUM(ta.qty_litres), disp.litres) AS ack_litres,
           COALESCE(SUM(ta.qty_kgs),    disp.kgs)    AS ack_kgs,
           COALESCE(SUM(ta.kg_fat),     disp.kg_fat) AS ack_kg_fat,
           COALESCE(SUM(ta.kg_snf),     disp.kg_snf) AS ack_kg_snf,
           tp.plan_for_date AS billing_date, te.id AS execution_id, ur.remark AS user_remark${byRun ? `,
           brt.carried_forward AS run_carried_forward, brt.excluded AS run_excluded,
           brt.remarks AS run_remarks` : ''}
    FROM trip_executions te
    JOIN trip_plans tp           ON tp.id=te.trip_plan_id
    LEFT JOIN trip_acknowledgements ta ON ta.execution_id=te.id
    LEFT JOIN tankers t          ON t.id=tp.tanker_id
    LEFT JOIN route_masters rm   ON rm.id=tp.route_id
    LEFT JOIN starting_points sp ON sp.id=tp.start_point_id
    LEFT JOIN delivery_points dp ON dp.id=tp.delivery_point_id
    LEFT JOIN LATERAL (
      SELECT SUM(teb.qty_litres) AS litres, SUM(teb.qty_kgs) AS kgs,
             SUM(teb.kg_fat) AS kg_fat, SUM(teb.kg_snf) AS kg_snf
      FROM trip_execution_bmcus teb WHERE teb.execution_id=te.id AND teb.is_deleted=FALSE
    ) disp ON TRUE
    LEFT JOIN utilisation_remarks ur ON ur.execution_id=te.id
    ${byRun ? `JOIN billing_run_trips brt ON brt.execution_id=te.id AND brt.run_id=$1
    WHERE ${scoped ? 'brt.vendor_id = ANY($2)' : 'TRUE'}` : `WHERE te.status != 'cancelled' AND tp.status NOT IN ('cancelled','deleted')`}
    GROUP BY tp.id, tp.trip_no, tp.plan_for_date, t.tanker_number, t.capacity_litres, tp.is_sale_tanker,
             rm.route_name, sp.name, dp.name, te.id, disp.litres, disp.kgs, disp.kg_fat, disp.kg_snf, ur.remark${byRun ? ', brt.id' : ''}
    ${byRun
      ? 'ORDER BY tp.plan_for_date, t.tanker_number, tp.trip_no'
      : `HAVING COALESCE(MIN(ta.ack_date), te.execution_date) BETWEEN $1 AND $2
    ORDER BY COALESCE(MIN(ta.ack_date), te.execution_date), tp.trip_no`}`,
    byRun ? (scoped ? [runId, vendorIds] : [runId]) : [fromDate, toDate]);

  return r.rows.map((x, i) => {
    const litres = parseFloat(x.ack_litres) || 0;
    const kgs    = parseFloat(x.ack_kgs) || 0;
    const cap    = parseFloat(x.capacity_litres) || 0;
    const isSale = !!x.is_sale_tanker;
    // Sale tankers (milk sold, not delivered) carry no utilisation figure —
    // the row stays for the litres, the % is blank and it is kept out of
    // the fleet total on the page.
    const util   = cap && !isSale ? rN(litres / cap * 100) : null;
    return {
      s_no: i + 1,
      execution_id: x.execution_id,
      user_remark: x.user_remark || '',
      is_sale_tanker: isSale,
      starting_point: x.starting_point, delivery_point: x.delivery_point,
      ack_date: fmtDateDisplay(x.ack_date),
      billing_date: fmtDateDisplay(x.billing_date),
      tanker_number: x.tanker_number, route_name: x.route_name, trip_no: x.trip_no,
      ack_litres: rN(litres), ack_kgs: rN(kgs),
      fat: kgs ? rN(parseFloat(x.ack_kg_fat) / kgs * 100) : null,
      snf: kgs ? rN(parseFloat(x.ack_kg_snf) / kgs * 100) : null,
      kg_fat: rN(x.ack_kg_fat), kg_snf: rN(x.ack_kg_snf),
      capacity: cap || null,
      utilization: util,
      remarks: [
        isSale ? 'SALE tanker — not in utilisation' : '',
        util == null ? '' : util >= threshold ? `ABOVE ${threshold}` : `BELOW ${threshold}`,
        !isSale && parseInt(x.ack_count) === 0 ? '(dispatch qty — no ack, e.g. sold at BMCU)' : '',
        byRun && x.run_carried_forward ? '· Carried forward' : '',
        byRun && x.run_excluded ? '· Excluded in run' : '',
        byRun && x.run_remarks ? `· ${x.run_remarks}` : '',
      ].filter(Boolean).join(' '),
    };
  });
}

const UTIL_HEADERS = [
  { title: 'S.NO', key: 's_no', width: 6 },
  { title: 'Started Point', key: 'starting_point', width: 16 },
  { title: 'Delivery Point', key: 'delivery_point', width: 16 },
  { title: 'Ack date', key: 'ack_date', width: 12 },
  { title: 'Tanker Number', key: 'tanker_number', width: 15 },
  { title: 'Route Name', key: 'route_name', width: 18 },
  { title: 'Ack Qty Ltrs', key: 'ack_litres', width: 12, num: true },
  { title: 'Ack Qty Kgs', key: 'ack_kgs', width: 12, num: true },
  { title: 'Fat', key: 'fat', width: 8, num: true },
  { title: 'SNF', key: 'snf', width: 8, num: true },
  { title: 'KG Fat', key: 'kg_fat', width: 10, num: true },
  { title: 'Kg SNF', key: 'kg_snf', width: 10, num: true },
  { title: 'Tanker Capacity', key: 'capacity', width: 13, num: true },
  { title: 'Utilization %', key: 'utilization', width: 12, num: true },
  { title: 'Remarks', key: 'remarks', width: 12 },
  { title: 'Approval Remarks', key: 'user_remark', width: 30 },
];


module.exports = { buildDayUtilisation, UTIL_HEADERS, UTILISATION_THRESHOLD };
