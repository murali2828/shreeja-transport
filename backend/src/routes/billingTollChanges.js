// backend/src/routes/billingTollChanges.js
// Change requests for toll challan rows of a billing run (migration 051).
//
// While a run is editable (draft / rejected / pending_vendor) the biller keys
// challans directly on the Toll Challans tab. Once the run is submitted for
// approval, any change to a tanker-period's toll (amount, attachment, "No
// toll") is staged here, the approver (user PP01 / CHANGE_APPROVER_ID, same as
// execution change requests) gets an email with the old and new values and
// single-use Approve / Reject links, and only approval writes billing_run_tolls
// and refreshes the run total. Mounted at /api/billing/toll-changes.
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const multer  = require('multer');
const { pool, query } = require('../config/db');
const { authenticate, authorizeOrModule } = require('../middleware/auth');
const { createTransport } = require('../config/mailer');
const { fmtDateDisplay } = require('../utils/date');

const canBill = ['admin', 'biller'];
const APPROVER_ID = () => process.env.CHANGE_APPROVER_ID || 'PP01';
const APPROVER_CC = () => (process.env.CHANGE_APPROVER_CC
  || 'billing1@shreejamilk.com,billing2@shreejamilk.com,rajesh.k@shreejamilk.com')
  .split(',').map(s => s.trim()).filter(Boolean);
const BASE_URL = () => process.env.APP_BASE_URL || 'https://tms.shreejamilk.com';
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
const nf  = v => (v == null ? '—' : parseFloat(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const rN  = v => (v == null || v === '' ? null : Math.round(parseFloat(v) * 100) / 100);

const CHALLAN_MAX_MB = parseInt(process.env.CHALLAN_MAX_MB || '15', 10) || 15;
const uploader = multer({ storage: multer.memoryStorage(), limits: { fileSize: CHALLAN_MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => { const ok = /\.(pdf|jpg|jpeg|png)$/i.test(file.originalname || ''); cb(ok ? null : new Error('Challan must be a PDF, JPG or PNG'), ok); } });
const challanUpload = (req, res, next) => uploader.single('file')(req, res, err => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File is larger than ${CHALLAN_MAX_MB} MB — compress the PDF and try again` });
  return res.status(400).json({ error: err.message || 'Upload failed' });
});

async function getApprover() {
  const r = await query('SELECT id, user_id, full_name, email FROM users WHERE LOWER(user_id)=LOWER($1) AND is_active=TRUE', [APPROVER_ID()]);
  return r.rows[0] || null;
}
const isApprover = (u, a) => !!a && u.id === a.id;

async function refreshRunTotal(runId) {
  await query(`UPDATE billing_runs SET total_amount =
      COALESCE((SELECT SUM(amount) FROM billing_run_trips WHERE run_id=$1 AND excluded=FALSE), 0)
    + COALESCE((SELECT SUM(amount) FROM billing_run_tolls WHERE run_id=$1), 0),
    updated_at=NOW() WHERE id=$1`, [runId]);
}

async function requestDetails(id) {
  const r = await query(`
    SELECT cr.*, br.from_date::text AS from_date, br.to_date::text AS to_date, br.status AS run_status, br.total_amount AS run_total,
           fr.from_date::text AS for_from_date, fr.to_date::text AS for_to_date,
           (SELECT t.vendor_name FROM billing_run_trips t WHERE t.run_id = cr.run_id AND t.tanker_number = cr.tanker_number LIMIT 1) AS vendor_name,
           (cr.new_file_data IS NOT NULL) AS has_new_file
    FROM billing_toll_change_requests cr
    JOIN billing_runs br ON br.id = cr.run_id
    LEFT JOIN billing_runs fr ON fr.id = cr.for_run_id
    WHERE cr.id = $1`, [id]);
  const d = r.rows[0]; if (d) delete d.new_file_data;
  return d || null;
}

function detailTableHtml(d) {
  const row = (k, v) => `<tr><td style="padding:4px 10px;border:1px solid #e5e7eb;font-weight:600;background:#f8fafc;">${esc(k)}</td><td style="padding:4px 10px;border:1px solid #e5e7eb;">${v}</td></tr>`;
  const diff = (k, o, n) => `<tr><td style="padding:4px 10px;border:1px solid #e5e7eb;font-weight:600;background:#f8fafc;">${esc(k)}</td><td style="padding:4px 10px;border:1px solid #e5e7eb;color:#6b7280;">${o}</td><td style="padding:4px 10px;border:1px solid #e5e7eb;font-weight:600;color:#065f46;">${n}</td></tr>`;
  const period = d.for_run_id ? `Run #${d.for_run_id} · ${fmtDateDisplay(d.for_from_date)} → ${fmtDateDisplay(d.for_to_date)} (paid in run #${d.run_id})` : `Run #${d.run_id} · ${fmtDateDisplay(d.from_date)} → ${fmtDateDisplay(d.to_date)}`;
  const oldAmt = d.old_not_applicable ? 'No toll (₹ 0.00)' : (d.old_amount == null ? 'no challan yet' : `₹ ${nf(d.old_amount)}`);
  const newAmt = d.new_not_applicable ? 'No toll (₹ 0.00)' : `₹ ${nf(d.new_amount)}`;
  const delta = (d.new_not_applicable ? 0 : parseFloat(d.new_amount || 0)) - (parseFloat(d.old_amount || 0));
  return `
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;margin:8px 0;">
      ${row('Billing run', esc(period))}
      ${row('Run status', esc(String(d.run_status || '').replace(/_/g, ' ')))}
      ${row('Tanker', `<b>${esc(d.tanker_number)}</b>`)}
      ${row('Vendor', esc(d.vendor_name || '—'))}
      ${row('Requested by', esc(d.requested_by_name || '—'))}
      ${row('Reason', `<i>${esc(d.reason)}</i>`)}
    </table>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;margin:8px 0;">
      <tr><th style="padding:4px 10px;border:1px solid #e5e7eb;background:#e6f3fb;text-align:left;">Field</th><th style="padding:4px 10px;border:1px solid #e5e7eb;background:#e6f3fb;text-align:left;">Current</th><th style="padding:4px 10px;border:1px solid #e5e7eb;background:#e6f3fb;text-align:left;">Proposed</th></tr>
      ${diff('Toll amount', esc(oldAmt), esc(newAmt))}
      ${diff('Challan attachment', esc(d.old_file_name || (d.old_not_applicable ? 'none (no toll)' : 'none')), esc(d.new_file_name || (d.new_not_applicable ? 'none (no toll)' : 'unchanged')))}
      ${diff('Remarks', esc(d.old_remarks || '—'), esc(d.new_remarks || '—'))}
      ${diff('Effect on run total', `₹ ${nf(d.run_total)}`, `₹ ${nf(parseFloat(d.run_total || 0) + delta)} (${delta >= 0 ? '+' : '−'} ₹ ${nf(Math.abs(delta))})`)}
    </table>`;
}

async function sendApprovalEmail(d, approver) {
  const base = (process.env.FRONTEND_URL || BASE_URL()).replace(/\/$/, '');
  const approveUrl = `${base}/toll-change-decision?token=${d.approval_token}&decision=approve`;
  const rejectUrl  = `${base}/toll-change-decision?token=${d.approval_token}&decision=reject`;
  const fileUrl    = `${BASE_URL().replace(/\/$/, '')}/billing?run=${d.run_id}`;
  const html = `
    <p style="font-family:sans-serif;font-size:14px;">Dear ${esc(approver.full_name)},</p>
    <p style="font-family:sans-serif;font-size:13px;"><b>${esc(d.requested_by_name)}</b> has requested a change to a toll challan on a billing run that is already under approval.</p>
    ${detailTableHtml(d)}
    ${d.has_new_file ? `<p style="font-family:sans-serif;font-size:12px;color:#374151;">The proposed challan file is attached to this email and viewable in the portal under Billing → run #${d.run_id} → Toll Challans → Change requests.</p>` : ''}
    <p style="margin:20px 0;">
      <a href="${approveUrl}" style="font-family:sans-serif;background:#16a34a;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;">✔ APPROVE</a>
      &nbsp;&nbsp;
      <a href="${rejectUrl}" style="font-family:sans-serif;background:#dc2626;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;">✘ REJECT</a>
    </p>
    <p style="font-family:sans-serif;font-size:12px;color:#6b7280;">Until you approve, the run keeps the current value. Portal: <a href="${fileUrl}">${fileUrl}</a></p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;"/>
    <p style="font-family:sans-serif;font-size:12px;color:#9ca3af;">Shreeja TMS · toll challan change request #${d.id}</p>`;
  const attachments = [];
  if (d.has_new_file) {
    const f = (await query('SELECT new_file_name, new_file_mime, new_file_data FROM billing_toll_change_requests WHERE id=$1', [d.id])).rows[0];
    if (f?.new_file_data) attachments.push({ filename: f.new_file_name || 'challan', content: f.new_file_data, contentType: f.new_file_mime || undefined });
  }
  await createTransport().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: approver.email, cc: APPROVER_CC().join(', ') || undefined,
    subject: `Approval needed — toll challan change, ${d.tanker_number}, run #${d.run_id} (${fmtDateDisplay(d.from_date)} → ${fmtDateDisplay(d.to_date)})`,
    html, attachments,
  });
}

// POST /api/billing/toll-changes/runs/:runId  (multipart)
// fields: tanker_number, for_run_id?, amount, not_applicable ('true'), remarks, reason; file: file
router.post('/runs/:runId', authenticate, authorizeOrModule('billing', ...canBill), challanUpload, async (req, res) => {
  try {
    const runId = parseInt(req.params.runId, 10);
    const b = req.body || {};
    const tn = String(b.tanker_number || '').trim();
    const forRunId = b.for_run_id ? parseInt(b.for_run_id, 10) : null;
    const noToll = b.not_applicable === 'true' || b.not_applicable === true;
    const amt = noToll ? 0 : rN(b.amount);
    const reason = String(b.reason || '').trim();
    if (!tn) return res.status(400).json({ error: 'tanker_number required' });
    if (!reason) return res.status(400).json({ error: 'A reason for the change is required' });
    if (!noToll && (amt == null || amt < 0)) return res.status(400).json({ error: 'Enter the new toll amount, or mark No toll' });
    const run = (await query('SELECT id, status FROM billing_runs WHERE id=$1', [runId])).rows[0];
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (['draft', 'rejected', 'pending_vendor'].includes(run.status))
      return res.status(400).json({ error: 'This run is still editable — change the challan directly on the Toll Challans tab' });
    const inRun = (await query('SELECT 1 FROM billing_run_trips WHERE run_id=$1 AND tanker_number=$2 LIMIT 1', [forRunId || runId, tn])).rows.length;
    if (!inRun) return res.status(400).json({ error: `${tn} has no trips in run #${forRunId || runId}` });
    const existing = (await query('SELECT * FROM billing_run_tolls WHERE run_id=$1 AND tanker_number=$2 AND for_run_id IS NOT DISTINCT FROM $3', [runId, tn, forRunId])).rows[0];
    if (!noToll && !req.file && !existing?.file_data)
      return res.status(400).json({ error: 'Attach the challan (PDF / JPG / PNG) — a toll amount cannot stand without one' });
    const approver = await getApprover();
    if (!approver?.email) return res.status(400).json({ error: `Approver "${APPROVER_ID()}" not found, inactive or without email` });
    const token = crypto.randomBytes(24).toString('hex');
    const ins = await query(`
      INSERT INTO billing_toll_change_requests
        (run_id, toll_id, tanker_number, for_run_id, requested_by, requested_by_name, reason,
         old_amount, old_file_name, old_not_applicable, old_remarks,
         new_amount, new_file_name, new_file_mime, new_file_data, new_not_applicable, new_remarks, approval_token)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [runId, existing?.id || null, tn, forRunId, req.user.id, req.user.full_name || req.user.user_id, reason,
       existing ? existing.amount : null, existing?.file_name || null, existing ? !!existing.not_applicable : null, existing?.remarks || null,
       amt, req.file ? req.file.originalname : null, req.file ? req.file.mimetype : null, req.file ? req.file.buffer : null, noToll,
       String(b.remarks || '').trim() || null, token]);
    const d = await requestDetails(ins.rows[0].id);
    let emailed = true;
    try { await sendApprovalEmail(d, approver); } catch (e) { emailed = false; console.error('[billing] toll change email failed:', e.message); }
    res.status(201).json({ id: d.id, emailed, approver: approver.full_name,
      message: emailed ? `Sent to ${approver.full_name} (${approver.user_id}) for approval` : `Request staged but the approval email failed — ${approver.full_name} can decide in the portal` });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A change request is already pending for this tanker and period' });
    console.error('[billing] toll change request error:', err);
    res.status(500).json({ error: 'Failed to create the change request' });
  }
});

// GET /api/billing/toll-changes?run_id=
router.get('/', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  try {
    const approver = await getApprover();
    const params = []; let where = '';
    if (req.query.run_id) { params.push(req.query.run_id); where = 'WHERE cr.run_id = $1'; }
    const r = await query(`
      SELECT cr.id, cr.run_id, cr.tanker_number, cr.for_run_id, cr.requested_by_name, cr.reason, cr.status,
             cr.old_amount, cr.old_file_name, cr.old_not_applicable, cr.new_amount, cr.new_file_name, cr.new_not_applicable, cr.new_remarks,
             (cr.new_file_data IS NOT NULL) AS has_new_file, cr.decided_by_name, cr.decided_at, cr.decision_note, cr.created_at
      FROM billing_toll_change_requests cr ${where}
      ORDER BY (cr.status='pending') DESC, cr.created_at DESC LIMIT 200`, params);
    res.json({ rows: r.rows, is_approver: isApprover(req.user, approver) || req.user.role === 'admin', approver_name: approver?.full_name || APPROVER_ID() });
  } catch (err) { res.status(500).json({ error: 'Failed to load toll change requests' }); }
});

// GET /api/billing/toll-changes/decision-info?token=  (public, read-only)
router.get('/decision-info', async (req, res) => {
  try {
    const r = await query("SELECT id FROM billing_toll_change_requests WHERE approval_token=$1 AND status='pending'", [req.query.token]);
    if (!r.rows.length) return res.status(404).json({ error: 'This request was already decided, or the link is no longer valid.' });
    const d = await requestDetails(r.rows[0].id);
    delete d.approval_token;
    res.json({ ...d, html: detailTableHtml(d) });
  } catch (err) { res.status(500).json({ error: 'Failed to load the request' }); }
});

async function decide(id, decision, decider, note) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query("SELECT * FROM billing_toll_change_requests WHERE id=$1 AND status='pending' FOR UPDATE", [id]);
    if (!r.rows.length) throw Object.assign(new Error('Request not found or already decided'), { code: 404 });
    const cr = r.rows[0];
    if (decision === 'approve') {
      await client.query(`
        INSERT INTO billing_run_tolls (run_id, tanker_number, amount, remarks, file_name, file_mime, file_data, created_by, for_run_id, not_applicable)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (run_id, tanker_number, COALESCE(for_run_id, 0)) DO UPDATE SET
          amount=$3, remarks=COALESCE($4, billing_run_tolls.remarks),
          file_name=CASE WHEN $10 THEN NULL ELSE COALESCE($5, billing_run_tolls.file_name) END,
          file_mime=CASE WHEN $10 THEN NULL ELSE COALESCE($6, billing_run_tolls.file_mime) END,
          file_data=CASE WHEN $10 THEN NULL ELSE COALESCE($7, billing_run_tolls.file_data) END,
          not_applicable=$10, updated_at=NOW()`,
        [cr.run_id, cr.tanker_number, cr.new_not_applicable ? 0 : cr.new_amount, cr.new_remarks, cr.new_file_name, cr.new_file_mime, cr.new_file_data,
         cr.requested_by, cr.for_run_id, cr.new_not_applicable]);
    }
    await client.query(`UPDATE billing_toll_change_requests SET status=$2, decided_by=$3, decided_by_name=$4, decided_at=NOW(), decision_note=$5, approval_token=NULL,
                        new_file_data = CASE WHEN $2 = 'approved' THEN NULL ELSE new_file_data END WHERE id=$1`,
      [id, decision === 'approve' ? 'approved' : 'rejected', decider.id, decider.full_name, note]);
    await client.query('COMMIT');
    if (decision === 'approve') await refreshRunTotal(cr.run_id);
    console.log(`[billing] toll change #${id} ${decision}d by ${decider.full_name} (run ${cr.run_id}, ${cr.tanker_number})`);
    return cr;
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
  finally { client.release(); }
}

// POST /api/billing/toll-changes/decide {token, decision, remarks}  (public, token = single use)
router.post('/decide', async (req, res) => {
  const { token, decision, remarks } = req.body || {};
  if (!token || !['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Invalid request' });
  try {
    const r = await query("SELECT id, run_id FROM billing_toll_change_requests WHERE approval_token=$1 AND status='pending'", [token]);
    if (!r.rows.length) return res.status(400).json({ error: 'This request was already decided, or the link is no longer valid.' });
    const approver = await getApprover();
    const decider = approver ? { id: approver.id, full_name: `${approver.full_name} (via email)` } : { id: null, full_name: 'via email' };
    const cr = await decide(r.rows[0].id, decision, decider, String(remarks || '').trim() || 'Decided via email link');
    query(`INSERT INTO audit_logs (user_id, user_name, method, path, module, action, entity_id, status_code, success, details)
           VALUES ($1,$2,'POST','/api/billing/toll-changes/decide','Billing',$3,$4,200,TRUE,$5)`,
      [decider.id, decider.full_name, decision === 'approve' ? 'approve' : 'cancel', String(cr.id), JSON.stringify({ run_id: cr.run_id, tanker_number: cr.tanker_number, via: 'email' })]).catch(() => {});
    res.json({ ok: true, message: decision === 'approve'
      ? `Request #${cr.id} approved — the toll challan of ${cr.tanker_number} on run #${cr.run_id} is updated and the run total refreshed.`
      : `Request #${cr.id} rejected — the challan of ${cr.tanker_number} on run #${cr.run_id} is unchanged.` });
  } catch (err) { res.status(err.code === 404 ? 404 : 500).json({ error: err.message }); }
});

// Portal decision by the approver / admin
async function portalDecision(req, res, decision) {
  try {
    const approver = await getApprover();
    if (!(req.user.role === 'admin' || isApprover(req.user, approver)))
      return res.status(403).json({ error: `Only ${approver?.full_name || APPROVER_ID()} or an admin can decide toll change requests` });
    const cr = await decide(req.params.id, decision, { id: req.user.id, full_name: req.user.full_name }, String(req.body?.remarks || '').trim() || null);
    res.json({ ok: true, id: cr.id, status: decision === 'approve' ? 'approved' : 'rejected' });
  } catch (err) { res.status(err.code === 404 ? 404 : 500).json({ error: err.message }); }
}
router.post('/:id/approve', authenticate, authorizeOrModule('billing', ...canBill), (req, res) => portalDecision(req, res, 'approve'));
router.post('/:id/reject',  authenticate, authorizeOrModule('billing', ...canBill), (req, res) => portalDecision(req, res, 'reject'));

// GET /api/billing/toll-changes/:id/file — the proposed challan (pending requests)
router.get('/:id/file', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  try {
    const r = await query('SELECT new_file_name, new_file_mime, new_file_data FROM billing_toll_change_requests WHERE id=$1', [req.params.id]);
    if (!r.rows.length || !r.rows[0].new_file_data) return res.status(404).json({ error: 'No proposed file on this request' });
    const { new_file_name, new_file_mime, new_file_data } = r.rows[0];
    const SAFE = ['application/pdf', 'image/jpeg', 'image/png'];
    res.setHeader('Content-Type', SAFE.includes(new_file_mime) ? new_file_mime : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${String(new_file_name || 'challan').replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.send(new_file_data);
  } catch (err) { res.status(500).json({ error: 'Failed to download the proposed challan' }); }
});

module.exports = router;
