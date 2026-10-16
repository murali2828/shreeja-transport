// services/dayUtilisation.js
// Day wise Tanker Utilisation rows (Reports → Tanker Utilisation → Day wise),
// shared by routes/reports.js and the billing run Excel's "Tanker Utilisation"
// sheet (owner, 2026-10-16). Utilization % = Ack Qty Ltrs / capacity × 100;
// user approval remarks from utilisation_remarks (migration 072).
const { query } = require('../config/db');
const { fmtDateDisplay } = require('../utils/date');
const { saleTankerSql } = require('../utils/saleTanker');

const rN = (v, d = 2) => v == null ? null : Math.round(parseFloat(v) * 10 ** d) / 10 ** d;
// Under-utilisation reasons (migration 073, owner 2026-10-16): two fixed
// reasons plus optional detail; the tagged trips form the approval note.
const REASON_LABELS = {
  batch_preparation:  'Batch Preparation and Specific Plant Requirements',
  operational_delays: 'Operational Delays and Plant Maintenance',
};
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
           tp.plan_for_date AS billing_date, te.id AS execution_id, ur.remark AS user_remark,
           ur.reason AS reason, ur.reason_detail AS reason_detail${byRun ? `,
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
             rm.route_name, sp.name, dp.name, te.id, disp.litres, disp.kgs, disp.kg_fat, disp.kg_snf, ur.remark, ur.reason, ur.reason_detail${byRun ? ', brt.id' : ''}
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
      reason: x.reason || '',
      reason_label: REASON_LABELS[x.reason] || '',
      reason_detail: x.reason_detail || '',
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
  { title: 'Reason', key: 'reason_label', width: 28 },
  { title: 'Reason detail', key: 'reason_detail', width: 30 },
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Approval note for a billing run's under-utilised trips (owner, 2026-10-16),
// in the style of logistics' fortnightly mail to the approver. Sale tankers
// are left out; below = utilisation < threshold. Plants are delivery points,
// BMCUs come from the trips' live execution BMCU lines.
async function utilisationNote(runId, threshold = UTILISATION_THRESHOLD) {
  const rr = await query('SELECT id, from_date, to_date, status FROM billing_runs WHERE id=$1', [runId]);
  const run = rr.rows[0];
  if (!run) return null;
  const rows = (await buildDayUtilisation(null, null, threshold, { runId })).filter(r => !r.is_sale_tanker);
  const below = rows.filter(r => r.utilization != null && r.utilization < threshold);
  const above = rows.filter(r => r.utilization != null && r.utilization >= threshold);
  const [y, m, d] = String(run.from_date).split('-').map(Number);
  const period = `${d <= 15 ? 'First' : 'Second'} fortnight of ${MONTHS[m - 1]} ${y} (${fmtDateDisplay(run.from_date)} to ${fmtDateDisplay(run.to_date)})`;

  const ids = below.map(r => r.execution_id);
  const bm = ids.length ? (await query(`
    SELECT teb.execution_id, b.bmcu_name
    FROM trip_execution_bmcus teb JOIN bmcus b ON b.id=teb.bmcu_id
    WHERE teb.execution_id = ANY($1) AND teb.is_deleted=FALSE
    ORDER BY teb.execution_id, teb.id`, [ids])).rows : [];
  const bmByExec = {};
  for (const x of bm) (bmByExec[x.execution_id] ||= []).push(x.bmcu_name);

  const groups = Object.keys(REASON_LABELS).map(reason => {
    const g = below.filter(r => r.reason === reason);
    const plants = new Map();
    for (const r of g) {
      const p = r.delivery_point || '(no delivery point)';
      if (!plants.has(p)) plants.set(p, new Set());
      for (const n of bmByExec[r.execution_id] || []) plants.get(p).add(n);
    }
    return {
      reason, label: REASON_LABELS[reason], count: g.length,
      over94: g.filter(r => r.utilization > 94).length,
      details: [...new Set(g.map(r => r.reason_detail).filter(Boolean))],
      plants: [...plants].map(([plant, s]) => ({ plant, bmcus: [...s].sort() })),
    };
  }).filter(g => g.count > 0);
  const untagged = below.filter(r => !REASON_LABELS[r.reason]).length;

  const lines = [
    'Dear Madam,', '',
    `Please find below the tanker utilization details for the ${period}.`, '',
    `During this period we executed ${rows.length} total movements.`,
    `Above ${threshold}%: ${above.length} trips.`,
    `Under ${threshold}%: ${below.length} trips.`,
  ];
  if (groups.length) {
    lines.push('', 'The reasons for under-utilization are:');
    groups.forEach((g, i) => {
      lines.push('', `${i + 1}. ${g.label} (${g.count} trips):`);
      g.plants.forEach(p => lines.push(`   ${p.plant} – ${p.bmcus.join(', ') || '—'}`));
      g.details.forEach(dt => lines.push(`   ${dt}`));
      if (g.reason === 'operational_delays') lines.push(`   Of these ${g.count} trips, ${g.over94} route tankers achieved over 94% utilization.`);
    });
  }
  if (untagged) lines.push('', `Note: ${untagged} under-utilized trip(s) have no reason tagged yet.`);
  lines.push('', 'Please review and approve the under-utilized trips.');
  return { run, period, threshold, total: rows.length, above: above.length, below: below.length, untagged, groups, text: lines.join('\n') };
}

// HTML section for the billing run approval mails.
function utilisationNoteHtml(n) {
  if (!n) return '';
  const groups = n.groups.map((g, i) => `
    <p style="font-size:12px;margin:8px 0 2px;"><b>${i + 1}. ${esc(g.label)} (${g.count} trips)</b></p>
    <ul style="font-size:12px;margin:0 0 0 18px;padding:0;">
      ${g.plants.map(p => `<li><b>${esc(p.plant)}</b> – ${esc(p.bmcus.join(', ') || '—')}</li>`).join('')}
    </ul>
    ${g.details.map(dt => `<p style="font-size:12px;margin:2px 0 0 18px;">${esc(dt)}</p>`).join('')}
    ${g.reason === 'operational_delays' ? `<p style="font-size:12px;margin:2px 0 0 18px;">Of these ${g.count} trips, ${g.over94} route tankers achieved over 94% utilization.</p>` : ''}`).join('');
  return `
      <p style="font-size:13px;font-weight:700;margin:16px 0 6px;">Tanker utilisation — under-utilised trips for approval</p>
      <p style="font-size:12px;margin:0;">${esc(n.period)}: ${n.total} movements · above ${n.threshold}%: <b>${n.above}</b> ·
        under ${n.threshold}%: <b>${n.below}</b>${n.untagged ? ` · <span style="color:#b45309;">${n.untagged} without a reason</span>` : ''}</p>
      ${groups}
      <p style="font-size:11px;color:#6b7280;margin:6px 0 0;">Your approval of this run approves these under-utilised trips (Tanker Utilisation sheet attached).</p>`;
}

module.exports = { buildDayUtilisation, UTIL_HEADERS, UTILISATION_THRESHOLD, REASON_LABELS, utilisationNote, utilisationNoteHtml };
