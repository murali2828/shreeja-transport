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
           ${saleTankerSql('tp', 't')} AS is_sale_tanker, (tp.trip_kind = 'material') AS is_material,
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
    GROUP BY tp.id, tp.trip_kind, tp.trip_no, tp.plan_for_date, t.tanker_number, t.capacity_litres, tp.is_sale_tanker,
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
    // Material (bought-and-sold milk) trips carry no BMCU milk either, so
    // they stay out of utilisation like sale tankers (owner, 2026-10-16).
    const isMaterial = !!x.is_material;
    // Sale tankers (milk sold, not delivered) carry no utilisation figure —
    // the row stays for the litres, the % is blank and it is kept out of
    // the fleet total on the page.
    const util   = cap && !isSale && !isMaterial ? rN(litres / cap * 100) : null;
    return {
      s_no: i + 1,
      execution_id: x.execution_id,
      user_remark: x.user_remark || '',
      reason: x.reason || '',
      reason_label: REASON_LABELS[x.reason] || '',
      reason_detail: x.reason_detail || '',
      is_sale_tanker: isSale, is_material: isMaterial,
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
        isMaterial ? 'MATERIAL trip — not in utilisation' : '',
        util == null ? '' : util >= threshold ? `ABOVE ${threshold}` : `BELOW ${threshold}`,
        !isSale && !isMaterial && parseInt(x.ack_count) === 0 ? '(dispatch qty — no ack, e.g. sold at BMCU)' : '',
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

// Natural list "A, B, and C" (logistics' mail style).
const andList = a => a.length <= 1 ? (a[0] || '') : a.length === 2 ? `${a[0]} and ${a[1]}`
  : `${a.slice(0, -1).join(', ')}, and ${a[a.length - 1]}`;
const avgOf = a => a.length ? rN(a.reduce((s, r) => s + r.utilization, 0) / a.length, 1) : null;
const minOf = a => a.length ? rN(Math.min(...a.map(r => r.utilization)), 1) : null;
// Fixed reason sentences of logistics' fortnightly mail; plants are filled in.
const REASON_TEXT = {
  batch_preparation: {
    sentence: p => `Tankers were used for batch preparation and lifting buffalo, mixed, or cow milk for the ${p} plants.`,
    at: 'Batch preparation at',
    note: 'Note: Due to batch preparation (cow/buffalo separation), selected cow milk routes were underutilized based on available tanker capacity.',
    short: 'Cow / buffalo batch preparation and plant-specific milk requirements.',
  },
  operational_delays: {
    sentence: p => `Higher-capacity vehicles were deployed to ensure timely milk lifting from BMCUs to avoid milk accumulation across shifts, despite facing slow unloading, RMT movement issues, or unscheduled maintenance at ${p} plants.`,
    at: 'Trips at',
    note: '',
    short: 'Slow unloading, RMT movement or plant maintenance; higher-capacity tankers kept BMCU lifting on time.',
  },
};

// Approval note for a billing run's under-utilised trips (owner, 2026-10-16),
// generated from data in exactly the structure of logistics' fortnightly mail
// to the approvers. Sale tankers are left out; below = utilisation <
// threshold. Plants are delivery points, routes are the trips' route names
// (route_name). Logistics may edit the text before submitting it
// (utilisation_approvals.note_text, migration 074).
async function utilisationNote(runId, threshold = UTILISATION_THRESHOLD) {
  const rr = await query('SELECT id, from_date, to_date, status FROM billing_runs WHERE id=$1', [runId]);
  const run = rr.rows[0];
  if (!run) return null;
  const rows = (await buildDayUtilisation(null, null, threshold, { runId })).filter(r => !r.is_sale_tanker && !r.is_material);
  const below = rows.filter(r => r.utilization != null && r.utilization < threshold);
  const above = rows.filter(r => r.utilization != null && r.utilization >= threshold);
  const [y, m, d] = String(run.from_date).split('-').map(Number);
  const dTo = Number(String(run.to_date).slice(8, 10));
  const period = `${d <= 15 ? 'First' : 'Second'} fortnight of ${MONTHS[m - 1]} ${y} (${MONTHS[m - 1]} ${d}–${dTo})`;

  const plantsOf = g => {
    const m2 = new Map();
    for (const r of g) {
      const p = r.delivery_point || '(no delivery point)';
      if (!m2.has(p)) m2.set(p, { rows: [], routes: new Set() });
      m2.get(p).rows.push(r);
      if (r.route_name) m2.get(p).routes.add(r.route_name);
    }
    return [...m2].map(([plant, v]) => ({
      plant, count: v.rows.length, avg: avgOf(v.rows), routes: [...v.routes].sort(),
      details: [...new Set(v.rows.map(r => r.reason_detail).filter(Boolean))],
    })).sort((a, b) => b.count - a.count || a.plant.localeCompare(b.plant));
  };
  const groups = Object.keys(REASON_LABELS).map(reason => {
    const g = below.filter(r => r.reason === reason);
    return {
      reason, label: REASON_LABELS[reason], count: g.length,
      min: minOf(g), avg: avgOf(g), over94: g.filter(r => r.utilization > 94).length,
      details: [...new Set(g.map(r => r.reason_detail).filter(Boolean))],
      plants: plantsOf(g),
    };
  }).filter(g => g.count > 0);
  const untagged = below.filter(r => !REASON_LABELS[r.reason]).length;
  // Near-target trips (owner, 2026-10-17): below the threshold but above 94 %.
  const nearRows = below.filter(r => r.utilization > 94);
  const nearGroup = nearRows.length ? { count: nearRows.length, avg: avgOf(nearRows), plants: plantsOf(nearRows) } : null;
  const plantSummary = plantsOf(below).map(p => ({ plant: p.plant, count: p.count, avg: p.avg }));
  // Utilisation bands for the mail charts (owner, 2026-10-17).
  const BANDS = [['Below 80%', 0, 80], ['80–90%', 80, 90], ['90–94%', 90, 94], [`94–${threshold}%`, 94, threshold], [`${threshold}% and above`, threshold, Infinity]];
  const bands = BANDS.map(([label, lo, hi]) => ({ label, count: rows.filter(r => r.utilization != null && r.utilization >= lo && r.utilization < hi).length }));

  const tripsAvg = p => `(${p.count} trip${p.count === 1 ? '' : 's'}, avg util ${p.avg}%)`;
  const pct = n => rows.length ? `${Math.round(n / rows.length * 1000) / 10}%` : '—';
  const plantsShort = g => g.plants.map(p => `${p.plant} ${p.count}`).join(' · ');
  // Compact text (owner, 2026-10-17): the mail leads with the charts; routes
  // per plant live in the attached Excel ("By plant").
  const lines = [
    'Dear Sir/Madam,',
    `Please find the tanker utilization summary for the ${period} for your approval.`,
    `Of ${rows.length} total movements, ${above.length} trips (${pct(above.length)}) were above ${threshold}% and ${below.length} trips (${pct(below.length)}) under ${threshold}% utilization.`,
  ];
  if (groups.length || nearGroup) lines.push('Reasons for the under-utilized trips:');
  groups.forEach((g, i) => {
    lines.push(`${i + 1}. ${g.label} (${g.count} Trips): ${REASON_TEXT[g.reason].short} Avg utilization ${g.avg}%.`);
    lines.push(`   - Plants: ${plantsShort(g)}`);
    if (g.reason === 'operational_delays' && g.over94) lines.push(`   - ${g.over94} of these trips were above 94% utilization.`);
    g.details.forEach(dt => lines.push(`   - ${dt}`));
  });
  if (nearGroup) {
    lines.push(`${groups.length + 1}. Near-target, 94% to ${threshold}% (${nearGroup.count} Trips): missed the target by less than one percentage point.`);
    lines.push(`   - Plants: ${plantsShort(nearGroup)}`);
  }
  lines.push('Route-wise details are in the attached Excel.',
    'We continue to work closely with the plants and our transport partners to improve tanker utilization.',
    'Kindly review and approve.');
  return {
    run, period, threshold, total: rows.length, above: above.length, below: below.length,
    untagged, near: nearGroup ? nearGroup.count : 0, bands, groups, nearGroup, plantSummary, text: lines.join('\n'),
  };
}

// Plant summary table (plant, trips below threshold, avg utilisation).
function plantSummaryHtml(n) {
  if (!n?.plantSummary?.length) return '';
  const td = 'style="border:1px solid #d1d5db;padding:4px 10px;font-family:Verdana,Geneva,sans-serif;font-size:12px;"';
  return `<p style="font-family:Verdana,Geneva,sans-serif;font-size:13px;font-weight:bold;color:#003a6b;margin:14px 0 4px;">Plant summary (under ${n.threshold}%)</p>
  <table style="border-collapse:collapse;margin:0 0 8px;">
    <tr style="background:#f3f4f6;"><th ${td}>Plant</th><th ${td}>Trips below ${n.threshold}%</th><th ${td}>Avg util %</th></tr>
    ${n.plantSummary.map(p => `<tr><td ${td}>${esc(p.plant)}</td><td ${td} align="right">${p.count}</td><td ${td} align="right">${p.avg ?? '—'}</td></tr>`).join('')}
  </table>`;
}
// The note text (generated or as edited by logistics) with line breaks.
// Lines are laid out like logistics' mail: "N. Heading (x Trips): text" as a
// numbered paragraph with a bold heading, " - " as bullets, "   - " as indented
// bullets, deeper-indented lines as italic detail; Verdana throughout.
const FONT = 'font-family:Verdana,Geneva,sans-serif;font-size:13px;line-height:1.6;color:#1f2937;';
function noteTextHtml(text) {
  const out = [];
  let list = null; // 1 = top bullets, 2 = indented bullets
  const close = () => { if (list) { out.push('</ul>'); list = null; } };
  const open = lvl => {
    if (list === lvl) return;
    close();
    out.push(`<ul style="margin:4px 0 8px ${lvl === 1 ? 18 : 40}px;padding:0;">`);
    list = lvl;
  };
  const boldCounts = s => esc(s)
    .replace(/(\(\d[\d,]* trips?, avg util [\d.]+%\))/gi, '<b>$1</b>')
    .replace(/(?<!\()(\b\d[\d,]*\s*(?:trips|Trips|total movements)\b)(?![^<]*<\/b>)/g, '<b>$1</b>');
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { close(); continue; }
    let m;
    if ((m = /^(\d+)\.\s+([^:]*?\([\d,]+ Trips?\)):?\s*(.*)$/i.exec(line))) {
      close();
      out.push(`<p style="margin:12px 0 4px;"><b>${m[1]}. ${esc(m[2])}:</b> ${boldCounts(m[3])}</p>`);
    } else if ((m = /^\s{3,}-\s+(.*)$/.exec(line))) {
      open(2);
      const t = m[1];
      const k = /^([^:]{2,60}):\s(.*)$/.exec(t);
      out.push(`<li style="margin:2px 0;">${k && !/^(Note|Of these|Utilization)/i.test(t) ? `<b>${esc(k[1])}:</b> ${boldCounts(k[2])}` : /^Note:/i.test(t) ? `<b>Note:</b> ${esc(t.slice(5).trim())}` : boldCounts(t)}</li>`);
    } else if ((m = /^\s{1,2}-\s+(.*)$/.exec(line))) {
      open(1);
      out.push(`<li style="margin:2px 0;">${boldCounts(m[1]).replace(/^([^:]+):/, '<b>$1</b>:')}</li>`);
    } else if (/^\s{4,}\S/.test(line)) {
      if (list === 2) out.push(`<li style="list-style:none;margin:0 0 2px;color:#4b5563;"><i>${esc(line.trim())}</i></li>`);
      else { close(); out.push(`<p style="margin:0 0 4px 40px;color:#4b5563;"><i>${esc(line.trim())}</i></p>`); }
    } else {
      close();
      out.push(`<p style="margin:0 0 8px;">${boldCounts(line)}</p>`);
    }
  }
  close();
  return `<div style="${FONT}">${out.join('\n')}</div>`;
}

// HTML section for the billing run approval mails; opts.text = the edited
// note when logistics saved one, opts.status = utilisation approval status line.
function utilisationNoteHtml(n, { text, status } = {}) {
  if (!n) return '';
  return `
      <p style="font-size:13px;font-weight:700;margin:16px 0 6px;">Tanker utilisation — under-utilised trips</p>
      ${status ? `<p style="font-size:12px;margin:0 0 6px;"><b>Utilisation approval:</b> ${esc(status)}</p>` : ''}
      ${n.untagged ? `<p style="font-size:12px;color:#b45309;margin:0 0 6px;">${n.untagged} under-utilised trip(s) without a reason</p>` : ''}
      ${noteTextHtml(text || n.text)}
      ${plantSummaryHtml(n)}
      <p style="font-size:11px;color:#6b7280;margin:6px 0 0;">The under-utilised trips are approved in their own L1–L3 utilisation approval raised by logistics (Tanker Utilisation sheet attached).</p>`;
}

// Summary charts for the approval mails (owner, 2026-10-17): bars drawn with
// table cells so they render in Gmail, Outlook and on phones without images,
// scripts or SVG. Built from the note snapshot (counts at submission).
function chartsHtml(n) {
  if (!n || !n.total) return '';
  const F = 'font-family:Verdana,Geneva,sans-serif;font-size:12px;color:#1f2937;';
  const title = t => `<p style="${F}font-size:13px;font-weight:bold;color:#003a6b;margin:16px 0 6px;">${esc(t)}</p>`;
  const bars = (items, color, max) => {
    const m = max || Math.max(1, ...items.map(i => i.value));
    return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;${F}">${items.map(i => {
      const w = Math.max(i.value ? 2 : 0, Math.round(i.value / m * 260));
      return `<tr><td style="${F}padding:3px 10px 3px 0;white-space:nowrap;">${esc(i.label)}</td>
        <td style="padding:3px 0;"><table cellpadding="0" cellspacing="0"><tr>${w ? `<td style="background:${i.color || color};width:${w}px;height:14px;font-size:1px;line-height:1px;">&nbsp;</td>` : ''}
        <td style="${F}padding-left:6px;font-weight:bold;">${i.value}${i.note ? ` <span style="font-weight:normal;color:#6b7280;">${esc(i.note)}</span>` : ''}</td></tr></table></td></tr>`;
    }).join('')}</table>`;
  };
  const pct = v => n.total ? `(${Math.round(v / n.total * 1000) / 10}%)` : '';
  const aw = Math.round(n.above / n.total * 520), bw = 520 - aw;
  const split = `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
    ${aw ? `<td style="background:#16a34a;width:${aw}px;height:22px;color:#fff;${F}color:#fff;font-weight:bold;text-align:center;">${n.above}</td>` : ''}
    ${bw ? `<td style="background:#dc2626;width:${bw}px;height:22px;${F}color:#fff;font-weight:bold;text-align:center;">${n.below}</td>` : ''}
  </tr></table>
  <p style="${F}margin:4px 0 0;"><span style="color:#16a34a;">&#9632;</span> Above ${n.threshold}%: <b>${n.above}</b> ${pct(n.above)} &nbsp; <span style="color:#dc2626;">&#9632;</span> Under ${n.threshold}%: <b>${n.below}</b> ${pct(n.below)}</p>`;
  const reasons = (n.groups || []).map(g => ({ label: g.label, value: g.count, note: `avg ${g.avg}%` }));
  if (n.untagged) reasons.push({ label: 'Not tagged', value: n.untagged, color: '#9ca3af' });
  const plants = (n.plantSummary || []).map(p => ({ label: p.plant, value: p.count, note: `avg ${p.avg}%` }));
  const bandColors = ['#b91c1c', '#ea580c', '#f59e0b', '#84cc16', '#16a34a'];
  const bands = (n.bands || []).map((b, i) => ({ label: b.label, value: b.count, color: bandColors[i] }));
  return `<div style="border-top:1px solid #e5e7eb;margin-top:14px;padding-top:4px;">
    ${title(`Summary — ${n.total} movements`)}${split}
    ${reasons.length ? title(`Under-${n.threshold}% trips by reason`) + bars(reasons, '#2563eb') : ''}
    ${plants.length ? title(`Under-${n.threshold}% trips by plant`) + bars(plants, '#0ea5e9') : ''}
    ${bands.length ? title('Trips by utilisation band') + bars(bands, '#16a34a') : ''}
  </div>`;
}

// Replace the note's first "Dear …," line with the recipient's salutation.
function withSalutation(text, title) {
  const t = String(text || '');
  const greet = `Dear ${title || 'Sir/Madam'},`;
  return /^\s*Dear\b[^\n]*/i.test(t) ? t.replace(/^\s*Dear\b[^\n]*/i, greet) : `${greet}\n${t}`;
}

// Mail body (owner, 2026-10-17): greeting, charts first, then the compact note.
function approvalBodyHtml(text, snapshot, title) {
  const t = withSalutation(text || '', title);
  // Greeting and the first two sentences, then the charts, then the reasons.
  const ls = t.split('\n');
  const head = ls.slice(0, 3).join('\n');
  const rest = ls.slice(3).join('\n');
  return noteTextHtml(head) + chartsHtml(snapshot) + '<div style="height:12px"></div>' + noteTextHtml(rest);
}

module.exports = { approvalBodyHtml, chartsHtml, withSalutation, buildDayUtilisation, UTIL_HEADERS, UTILISATION_THRESHOLD, REASON_LABELS, utilisationNote, utilisationNoteHtml, plantSummaryHtml, noteTextHtml };
