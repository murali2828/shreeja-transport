// routes/utilisationApprovals.js — /api/utilisation-approvals (migration 074)
// Tanker utilisation approval (owner, 2026-10-16): logistics drafts the
// under-utilisation note of a billing run (generated from the tagged reasons,
// editable), submits it, and it goes L1 → L2 → L3 to the billing run's
// approvers (services/billingApprovers.js), independent of the run's payment
// approval. Each level decides by single-use email link (only the token's
// SHA-256 is stored, 14-day expiry; GET decision-info never mutates, POST
// decide does) or in the portal. Approval at L3 → approved; a rejection at
// any level → rejected, and a new approval may be submitted for the run.
// Mails go through the billing transport (BILLING_EMAIL_REDIRECT on QA).
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const ExcelJS = require('exceljs');
const { pool, query } = require('../config/db');
const { authenticate, hasRole, rolesOf, accessFor, isReadOnlyUser } = require('../middleware/auth');
const { APPROVERS, approverFor, approverUser, billingTransport } = require('../services/billingApprovers');
const { approvalBodyHtml, chartsHtml, withSalutation, utilisationNote, plantSummaryHtml, noteTextHtml, buildDayUtilisation, UTIL_HEADERS, UTILISATION_THRESHOLD } = require('../services/dayUtilisation');
const { fmtDateDisplay } = require('../utils/date');
const { stylePortalWorkbook } = require('../services/portalExcel');

// Same base as the scan-change links: FRONTEND_URL is set on every tier
// (required in production), so QA mails never point at the PROD portal.
const BASE_URL = () => (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://tms.shreejamilk.com').replace(/\/$/, '');
const TOKEN_DAYS = 14;
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const esc = x => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const STATUS_LABEL = {
  draft: 'Draft', pending_l1: 'Awaiting L1', pending_l2: 'Awaiting L2', pending_l3: 'Awaiting L3',
  approved: 'Approved', rejected: 'Rejected',
};
const pendingLevel = st => (/^pending_l([123])$/.exec(st || '') || [])[1] | 0;
const httpErr = (code, msg) => Object.assign(new Error(msg), { http: code });

// Initiating / editing: admin, or Edit on the Reports or Execution module
// (logistics, planners). View-only and read-only users are refused.
async function canInitiate(u) {
  if (hasRole(u, 'admin')) return true;
  if (await isReadOnlyUser(u)) return false;
  const lv = await accessFor(rolesOf(u));
  return lv.reports === 'edit' || lv.execution === 'edit';
}
const requireInitiator = async (req, res, next) => {
  try {
    if (await canInitiate(req.user)) return next();
    res.status(403).json({ error: 'Only logistics / planners with Edit on Reports or Execution can prepare or submit the utilisation approval' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
// Reading: any module that shows the run (reports / execution / billing) or an approver.
const requireReader = async (req, res, next) => {
  try {
    if (hasRole(req.user, 'admin', 'planner', 'biller')) return next();
    const lv = await accessFor(rolesOf(req.user));
    if (['reports', 'execution', 'billing'].some(k => lv[k] && lv[k] !== 'none')) return next();
    // An L1–L3 approver (matched by the user's email) may read without a module.
    const email = String((await query('SELECT email FROM users WHERE id=$1', [req.user.id])).rows[0]?.email || '').toLowerCase();
    if (email && APPROVERS.some(a => a.email.toLowerCase() === email)) return next();
    res.status(403).json({ error: 'Insufficient permissions' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

const parseRunId = v => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };

async function loadApproval(id) {
  const a = (await query(`SELECT ua.*, br.from_date, br.to_date, br.status AS run_status
                            FROM utilisation_approvals ua JOIN billing_runs br ON br.id=ua.run_id
                           WHERE ua.id=$1`, [id])).rows[0];
  if (!a) return null;
  a.steps = (await query(`SELECT id, level, approver_user_id, approver_email, approver_name, decision, remarks,
                                 decided_by, decided_at, token_expires_at
                            FROM utilisation_approval_steps WHERE approval_id=$1 ORDER BY level`, [id])).rows;
  return a;
}
// The live approval of a run, else its latest (rejected) one.
async function currentForRun(runId) {
  const r = await query(`SELECT id FROM utilisation_approvals WHERE run_id=$1
                          ORDER BY (status <> 'rejected') DESC, id DESC LIMIT 1`, [runId]);
  return r.rows[0] ? loadApproval(r.rows[0].id) : null;
}
const periodOf = a => `${fmtDateDisplay(a.from_date)} → ${fmtDateDisplay(a.to_date)}`;

// ── Mail ─────────────────────────────────────────────────────────────────────
// Approval workbook attached to every level's mail (owner, 2026-10-16): the
// summary in the note's structure, the under-utilised trips with their
// reason, the plant summary, every trip of the run, and the note text.
async function runExcel(a) {
  const T = UTILISATION_THRESHOLD;
  const note = await utilisationNote(a.run_id, T);
  // Sale tankers and material (buy-and-sell) trips are left out everywhere.
  const all = (await buildDayUtilisation(null, null, T, { runId: a.run_id }))
    .filter(r => !r.is_sale_tanker && !r.is_material).map((r, i) => ({ ...r, s_no: i + 1 }));
  const fleet = all;
  const below = fleet.filter(r => r.utilization != null && r.utilization < T)
    .sort((x, y) => (x.reason_label || 'zz').localeCompare(y.reason_label || 'zz')
      || String(x.delivery_point || '').localeCompare(String(y.delivery_point || '')) || x.utilization - y.utilization);
  const title = `Tanker utilisation approval — Billing run #${a.run_id} (${periodOf(a)})`;
  const wb = new ExcelJS.Workbook();
  const num = v => (v == null || v === '' ? null : parseFloat(v));

  const sum = wb.addWorksheet('Summary');
  sum.addRow([title]); sum.addRow([]);
  sum.addRow(['Item', 'Trips', 'Lowest util %', 'Average util %', 'Over 94 %', 'Plants']);
  sum.addRow(['Total movements (sale tankers and material trips excluded)', note.total]);
  sum.addRow([`Above ${T}% utilisation`, note.above]);
  sum.addRow([`Under ${T}% utilisation`, note.below]);
  for (const g of note.groups) sum.addRow([`  ${g.label}`, g.count, num(g.min), num(g.avg), g.over94, g.plants.map(p => p.plant).join(', ')]);
  if (note.nearGroup) sum.addRow([`  Near-target (94% to ${T}%)`, note.nearGroup.count, null, num(note.nearGroup.avg), null, note.nearGroup.plants.map(p => p.plant).join(', ')]);
  sum.addRow(['Approval status', STATUS_LABEL[a.status] || a.status]);
  sum.addRow(['Submitted by', a.submitted_by_name || '']);

  const rh = wb.addWorksheet(`Below ${T}%`);
  rh.addRow([`${title} — trips under ${T}%`]); rh.addRow([]);
  rh.addRow(['S.No', 'Reason', 'Reason detail', 'Delivery Point', 'Started Point', 'Billing Date', 'Ack date', 'Tanker Number',
    'Route Name', 'Tanker Capacity', 'Ack Qty Ltrs', 'Ack Qty Kgs', 'Utilization %', 'Approval Remarks']);
  below.forEach((r, i) => rh.addRow([i + 1, r.reason_label || 'Not yet categorised', r.reason_detail || '', r.delivery_point || '',
    r.starting_point || '', r.billing_date ? fmtDateDisplay(r.billing_date) : '', r.ack_date || '', r.tanker_number || '',
    r.route_name || '', num(r.capacity), num(r.ack_litres), num(r.ack_kgs), num(r.utilization), r.user_remark || '']));

  const ps = wb.addWorksheet('By plant');
  ps.addRow([`${title} — under ${T}% by plant and reason`]); ps.addRow([]);
  ps.addRow(['Reason', 'Plant', 'Trips', 'Avg util %', 'Routes', 'Details']);
  for (const g of note.groups) for (const p of g.plants) ps.addRow([g.label, p.plant, p.count, num(p.avg), p.routes.join(', '), p.details.join('; ')]);
  if (note.nearGroup) for (const p of note.nearGroup.plants) ps.addRow([`Near-target (94% to ${T}%)`, p.plant, p.count, num(p.avg), p.routes.join(', '), '']);

  const at = wb.addWorksheet('All trips');
  at.addRow([`${title} — all trips of the run`]); at.addRow([]);
  const H = [...UTIL_HEADERS.slice(0, 3), { title: 'Billing Date', key: 'billing_date' }, ...UTIL_HEADERS.slice(3)];
  at.addRow(H.map(h => h.title));
  all.forEach(r => at.addRow(H.map(h => h.num ? num(r[h.key]) : (h.key === 'billing_date' && r[h.key] ? fmtDateDisplay(r[h.key]) : (r[h.key] ?? '')))));

  stylePortalWorkbook(wb, title);
  wb.eachSheet(ws => ws.eachRow((row, ri) => { if (ri > 3) row.eachCell(c => { if (typeof c.value === 'number' && !Number.isInteger(c.value)) c.numFmt = '#,##0.00'; }); }));

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function approvalMailHtml(a, level, token) {
  const link = d => `${BASE_URL()}/utilisation-decision?token=${encodeURIComponent(token)}&decision=${d}`;
  const btn = (d, label, color) => `<a href="${link(d)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:700;font-size:14px;margin-right:8px;">${label}</a>`;
  const done = a.steps.filter(s => s.decision).map(s =>
    `<li>L${s.level} ${esc(s.approver_name || s.approver_email)} — ${esc(s.decision)}${s.remarks ? `: ${esc(s.remarks)}` : ''}</li>`).join('');
  return `<div style="font-family:Verdana,Geneva,sans-serif;max-width:780px;color:#1f2937;">
    <h2 style="color:#003a6b;font-size:17px;margin:0 0 6px;">Tanker utilisation approval — L${level}</h2>
    <p style="font-size:12px;color:#4b5563;margin:0 0 10px;">Billing run #${a.run_id} (${esc(periodOf(a))}) · submitted by ${esc(a.submitted_by_name || '—')}</p>
    ${done ? `<ul style="font-size:12px;margin:0 0 10px 18px;padding:0;">${done}</ul>` : ''}
    ${approvalBodyHtml(a.note_text, a.note_snapshot, approverFor(level)?.title)}
    <div style="margin:18px 0;">${btn('approve', 'Approve', '#16a34a')}${btn('reject', 'Reject', '#dc2626')}</div>
    <p style="font-size:11px;color:#9ca3af;">No login needed — the button opens a confirmation page; confirm there. The link works once and expires in ${TOKEN_DAYS} days. The attached Excel holds the summary, the under-utilised trips with their reasons, the plant summary and all trips of the run.</p>
  </div>`;
}

async function mailLevel(approvalId, level, token) {
  const a = await loadApproval(approvalId);
  const ap = a.steps.find(s => s.level === level);
  if (!ap?.approver_email) throw new Error(`No approver for L${level}`);
  let attachments = [];
  try { attachments = [{ filename: `tanker_utilisation_run_${a.run_id}.xlsx`, content: await runExcel(a) }]; }
  catch (e) { console.warn('[utilisation-approval] excel skipped:', e.message); }
  await billingTransport().sendMail({
    from: process.env.SMTP_FROM, to: ap.approver_email,
    subject: `Tanker utilisation approval — Billing run #${a.run_id} (${periodOf(a)}) — L${level}`,
    html: approvalMailHtml(a, level, token), attachments,
  });
}

async function mailInitiator(approvalId) {
  const a = await loadApproval(approvalId);
  const u = a.submitted_by ? (await query('SELECT email FROM users WHERE id=$1', [a.submitted_by])).rows[0] : null;
  if (!u?.email) return;
  const rej = a.steps.find(s => s.decision === 'rejected');
  const subject = `Tanker utilisation ${a.status === 'approved' ? 'approved' : 'rejected'} — Billing run #${a.run_id} (${periodOf(a)})`;
  const title = APPROVERS.find(x => x.email.toLowerCase() === String(u.email).toLowerCase())?.title || 'Sir/Madam';
  const html = `<div style="font-family:Verdana,Geneva,sans-serif;font-size:13px;color:#1f2937;">
    <p style="font-size:13px;">Dear ${esc(title)},</p>
    <p style="font-size:13px;">The tanker utilisation approval of billing run #${a.run_id} (${esc(periodOf(a))}) was
      <b>${a.status === 'approved' ? 'approved at L3' : `rejected at L${rej?.level} by ${esc(rej?.decided_by || rej?.approver_name || '')}`}</b>.</p>
    ${rej?.remarks ? `<p style="font-size:13px;"><b>Remarks:</b> ${esc(rej.remarks)}</p>` : ''}
    ${a.status === 'rejected' ? '<p style="font-size:12px;color:#6b7280;">Correct the note in Reports → Tanker Utilisation → By billing run and submit again.</p>' : ''}
  </div>`;
  await billingTransport().sendMail({ from: process.env.SMTP_FROM, to: u.email, subject, html });
}

// ── Decision (shared by email token and portal) ──────────────────────────────
// Returns { approval, nextToken } after commit; the caller sends the mails.
async function decide(approvalId, level, decision, deciderName, remarks) {
  const client = await pool.connect();
  let nextToken = null;
  try {
    await client.query('BEGIN');
    const a = (await client.query('SELECT * FROM utilisation_approvals WHERE id=$1 FOR UPDATE', [approvalId])).rows[0];
    if (!a) throw httpErr(404, 'Approval not found');
    if (a.status !== `pending_l${level}`) throw httpErr(409, `This approval is ${STATUS_LABEL[a.status] || a.status} — L${level} cannot decide it now`);
    const dec = decision === 'approve' ? 'approved' : 'rejected';
    await client.query(`UPDATE utilisation_approval_steps
                           SET decision=$3, remarks=$4, decided_by=$5, decided_at=NOW(), token_hash=NULL
                         WHERE approval_id=$1 AND level=$2`, [approvalId, level, dec, remarks || null, deciderName]);
    let status;
    if (dec === 'rejected') status = 'rejected';
    else if (level < 3) {
      status = `pending_l${level + 1}`;
      nextToken = crypto.randomBytes(32).toString('hex');
      await client.query(`UPDATE utilisation_approval_steps SET token_hash=$3, token_expires_at=NOW() + INTERVAL '${TOKEN_DAYS} days'
                           WHERE approval_id=$1 AND level=$2`, [approvalId, level + 1, hashToken(nextToken)]);
    } else status = 'approved';
    await client.query(`UPDATE utilisation_approvals SET status=$2, updated_at=NOW(),
                               decided_at=CASE WHEN $3::boolean THEN NOW() ELSE decided_at END
                         WHERE id=$1`, [approvalId, status, status === 'approved' || status === 'rejected']);
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
  finally { client.release(); }
  const approval = await loadApproval(approvalId);
  // Mails after commit, never failing the decision.
  if (nextToken) mailLevel(approvalId, level + 1, nextToken).catch(e => console.error('[utilisation-approval] mail L' + (level + 1), e.message));
  else mailInitiator(approvalId).catch(e => console.error('[utilisation-approval] initiator mail', e.message));
  return approval;
}

async function stepByToken(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const r = await query(`SELECT s.approval_id, s.level FROM utilisation_approval_steps s
                           JOIN utilisation_approvals a ON a.id=s.approval_id
                          WHERE s.token_hash=$1 AND s.decision IS NULL AND s.token_expires_at > NOW()
                            AND a.status = 'pending_l' || s.level`, [hashToken(token)]);
  return r.rows[0] || null;
}

// ── Public token endpoints (registered before authenticate) ─────────────────
// GET /decision-info?token= — shows only, never mutates.
router.get('/decision-info', async (req, res) => {
  try {
    const st = await stepByToken(req.query.token);
    if (!st) return res.status(404).json({ error: 'This approval was already decided, or the link is no longer valid.' });
    const a = await loadApproval(st.approval_id);
    res.json({
      id: a.id, run_id: a.run_id, period: periodOf(a), level: st.level, status: a.status,
      submitted_by_name: a.submitted_by_name, note_text: a.note_text,
      html: approvalBodyHtml(a.note_text, a.note_snapshot, approverFor(st.level)?.title),
      steps: a.steps.map(s => ({ level: s.level, approver_name: s.approver_name, decision: s.decision, remarks: s.remarks, decided_at: s.decided_at })),
    });
  } catch (err) { res.status(500).json({ error: 'Failed to load the approval' }); }
});

// POST /decide {token, decision: approve|reject, remarks} — single-use token.
router.post('/decide', async (req, res) => {
  const { token, decision, remarks } = req.body || {};
  if (!token || !['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Invalid request' });
  const rem = String(remarks || '').trim().slice(0, 1000);
  if (decision === 'reject' && !rem) return res.status(400).json({ error: 'Remarks are required to reject' });
  try {
    const st = await stepByToken(token);
    if (!st) return res.status(400).json({ error: 'This approval was already decided, or the link is no longer valid.' });
    const ap = approverFor(st.level);
    const a = await decide(st.approval_id, st.level, decision, `${ap?.name || 'Approver'} (via email)`, rem);
    query(`INSERT INTO audit_logs (user_id, user_name, method, path, module, action, entity_id, status_code, success, details)
           VALUES (NULL,$1,'POST','/api/utilisation-approvals/decide','Reports',$2,$3,200,TRUE,$4)`,
      [`${ap?.name || 'Approver'} (via email)`, decision === 'approve' ? 'approve' : 'cancel', String(a.id),
       JSON.stringify({ run_id: a.run_id, level: st.level, via: 'email' })]).catch(() => {});
    res.json({ ok: true, status: a.status, message: decision === 'approve'
      ? `L${st.level} approved${a.status === 'approved' ? ' — the utilisation approval is complete.' : ` — sent to L${st.level + 1}.`}`
      : `L${st.level} rejected — logistics has been informed.` });
  } catch (err) { res.status(err.http || 500).json({ error: err.message }); }
});

// ── Portal endpoints ─────────────────────────────────────────────────────────
// GET /?run_id= — current approval (live, else latest rejected) with steps.
router.get('/', authenticate, requireReader, async (req, res) => {
  const runId = parseRunId(req.query.run_id);
  if (!runId) return res.status(400).json({ error: 'run_id required' });
  try {
    const a = await currentForRun(runId);
    const lvl = a ? pendingLevel(a.status) : 0;
    let canDecide = false;
    if (lvl) {
      const u = await approverUser(lvl);
      canDecide = hasRole(req.user, 'admin') || (u && u.id === req.user.id);
    }
    const history = (await query(`SELECT COUNT(*)::int AS n FROM utilisation_approvals WHERE run_id=$1 AND status='rejected'`, [runId])).rows[0].n;
    res.json({
      approval: a, status_label: a ? STATUS_LABEL[a.status] : null, rejected_count: history,
      can_initiate: await canInitiate(req.user), can_decide: !!canDecide, pending_level: lvl,
      approvers: APPROVERS.map(x => ({ level: x.level, name: x.name, email: x.email })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get or create the run's live draft inside a transaction.
async function liveDraft(client, runId) {
  const run = (await client.query('SELECT id FROM billing_runs WHERE id=$1', [runId])).rows[0];
  if (!run) throw httpErr(404, 'Billing run not found');
  let a = (await client.query(`SELECT * FROM utilisation_approvals WHERE run_id=$1 AND status <> 'rejected' FOR UPDATE`, [runId])).rows[0];
  if (!a) a = (await client.query(`INSERT INTO utilisation_approvals (run_id, status) VALUES ($1,'draft') RETURNING *`, [runId])).rows[0];
  if (a.status !== 'draft') throw httpErr(409, `The utilisation approval is ${STATUS_LABEL[a.status]} — the note can no longer be changed`);
  return a;
}

// PUT /draft {run_id, note_text} — save logistics' edited note (blank = use the generated one).
router.put('/draft', authenticate, requireInitiator, async (req, res) => {
  const runId = parseRunId(req.body?.run_id);
  if (!runId) return res.status(400).json({ error: 'run_id required' });
  const text = req.body?.note_text == null ? null : String(req.body.note_text).slice(0, 20000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = await liveDraft(client, runId);
    await client.query('UPDATE utilisation_approvals SET note_text=$2, updated_at=NOW() WHERE id=$1', [a.id, text && text.trim() ? text : null]);
    await client.query('COMMIT');
    res.json(await loadApproval(a.id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(err.http || (err.code === '23505' ? 409 : 500)).json({ error: err.code === '23505' ? 'Another draft was just created — reload' : err.message });
  } finally { client.release(); }
});

// POST /submit {run_id} — freeze the note and send it to L1. Untagged
// below-threshold trips only warn (the count goes into the mail).
router.post('/submit', authenticate, requireInitiator, async (req, res) => {
  const runId = parseRunId(req.body?.run_id);
  if (!runId) return res.status(400).json({ error: 'run_id required' });
  let note;
  try { note = await utilisationNote(runId); } catch (err) { return res.status(500).json({ error: err.message }); }
  if (!note) return res.status(404).json({ error: 'Billing run not found' });
  const token = crypto.randomBytes(32).toString('hex');
  const client = await pool.connect();
  let id;
  try {
    await client.query('BEGIN');
    const a = await liveDraft(client, runId);
    id = a.id;
    const text = a.note_text || note.text;
    const { run, text: _t, ...snapshot } = note;
    await client.query(`UPDATE utilisation_approvals SET status='pending_l1', note_text=$2, note_snapshot=$3,
                               submitted_by=$4, submitted_by_name=$5, submitted_at=NOW(), decided_at=NULL, updated_at=NOW()
                         WHERE id=$1`, [id, text, JSON.stringify(snapshot), req.user.id, req.user.full_name || req.user.user_id || null]);
    await client.query('DELETE FROM utilisation_approval_steps WHERE approval_id=$1', [id]);
    for (const ap of APPROVERS) {
      const u = await client.query('SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND is_active=TRUE ORDER BY id LIMIT 1', [ap.email]);
      await client.query(`INSERT INTO utilisation_approval_steps (approval_id, level, approver_user_id, approver_email, approver_name, token_hash, token_expires_at)
                          VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::boolean THEN NOW() + INTERVAL '${TOKEN_DAYS} days' END)`,
        [id, ap.level, u.rows[0]?.id || null, ap.email, ap.name, ap.level === 1 ? hashToken(token) : null, ap.level === 1]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    return res.status(err.http || 500).json({ error: err.message });
  }
  client.release();
  let mailError = null;
  try { await mailLevel(id, 1, token); } catch (e) { mailError = e.message; console.error('[utilisation-approval] mail L1', e.message); }
  res.json({ approval: await loadApproval(id), untagged: note.untagged, mail_error: mailError });
});

// POST /:id/withdraw — an undecided Awaiting-L1 approval back to draft (L1 link dies).
router.post('/:id/withdraw', authenticate, requireInitiator, async (req, res) => {
  try {
    const r = await query(`UPDATE utilisation_approvals SET status='draft', submitted_at=NULL, updated_at=NOW()
                            WHERE id=$1 AND status='pending_l1'
                              AND NOT EXISTS (SELECT 1 FROM utilisation_approval_steps WHERE approval_id=$1 AND decision IS NOT NULL)
                            RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(409).json({ error: 'Only an approval awaiting L1 with no decision can be withdrawn' });
    await query('DELETE FROM utilisation_approval_steps WHERE approval_id=$1', [req.params.id]);
    res.json(await loadApproval(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /:id/approve|reject {remarks} — the logged-in approver of the pending level, or admin.
async function portalDecision(req, res, decision) {
  try {
    if (await isReadOnlyUser(req.user)) return res.status(403).json({ error: 'Your role is read-only' });
    const a = await loadApproval(req.params.id);
    if (!a) return res.status(404).json({ error: 'Approval not found' });
    const lvl = pendingLevel(a.status);
    if (!lvl) return res.status(409).json({ error: `This approval is ${STATUS_LABEL[a.status]}` });
    const u = await approverUser(lvl);
    const ap = approverFor(lvl);
    const mine = !!(u && u.id === req.user.id);
    if (!hasRole(req.user, 'admin') && !mine) return res.status(403).json({ error: `Only ${ap?.name || `the L${lvl} approver`} or an admin can decide L${lvl}` });
    const rem = String(req.body?.remarks || '').trim().slice(0, 1000);
    if (decision === 'reject' && !rem) return res.status(400).json({ error: 'Remarks are required to reject' });
    const who = req.user.full_name || req.user.user_id || 'user';
    const out = await decide(a.id, lvl, decision, mine ? who : `${who} (admin)`, rem);
    res.json(out);
  } catch (err) { res.status(err.http || 500).json({ error: err.message }); }
}
router.post('/:id/approve', authenticate, (req, res) => portalDecision(req, res, 'approve'));
router.post('/:id/reject',  authenticate, (req, res) => portalDecision(req, res, 'reject'));

// Status line for the billing run approval mails.
async function statusLineForRun(runId) {
  const a = await currentForRun(runId);
  if (!a) return 'not yet submitted by logistics';
  const rej = a.steps.find(s => s.decision === 'rejected');
  return `${STATUS_LABEL[a.status]}${rej ? ` at L${rej.level}${rej.remarks ? ` — ${rej.remarks}` : ''}` : ''}`;
}

module.exports = router;
module.exports.statusLineForRun = statusLineForRun;
module.exports.currentForRun = currentForRun;
module.exports.canInitiate = canInitiate;
