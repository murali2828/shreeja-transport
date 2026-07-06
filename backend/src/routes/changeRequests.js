// backend/src/routes/changeRequests.js
// Post-closure correction workflow for trip executions.
//
// The execution team proposes edits to a CLOSED trip (BMCU data + acknowledgements).
// Nothing is applied directly: the request is staged with a snapshot of current data
// and the proposed data, and the approver (user PP01 / CHANGE_APPROVER_ID) is emailed
// a side-by-side diff with Approve/Reject links. Until approval, every report keeps
// showing the original data. Approval (email link or portal) applies the changes via
// the same write path as normal saves (services/executionData.applyExecutionData).

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const nodemailer = require('nodemailer');
const { pool, query } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { applyExecutionData } = require('../services/executionData');
const { executionSnapshot, diffSnapshots, logChanges } = require('../services/changeTracker');

const APPROVER_ID = () => process.env.CHANGE_APPROVER_ID || 'PP01';

function createTransport() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function getApprover() {
  const r = await query(
    'SELECT id, user_id, full_name, email FROM users WHERE LOWER(user_id)=LOWER($1) AND is_active=TRUE',
    [APPROVER_ID()]
  );
  return r.rows[0] || null;
}

function isApprover(reqUser, approver) {
  return !!approver && reqUser.id === approver.id;
}

// ─── Snapshot of the execution's current data (same shape as the save payload) ─
async function snapshotExecution(db, execId) {
  const exec = await db.query('SELECT id, actual_km, dc_number, total_qty_litres, total_qty_kgs FROM trip_executions WHERE id=$1', [execId]);
  const bmcus = await db.query(`
    SELECT teb.*, b.bmcu_code, b.bmcu_name
    FROM trip_execution_bmcus teb JOIN bmcus b ON b.id=teb.bmcu_id
    WHERE teb.execution_id=$1 AND teb.is_deleted=FALSE ORDER BY teb.seq_no`, [execId]);
  const shifts = await db.query(
    'SELECT * FROM trip_execution_bmcu_shifts WHERE execution_id=$1 ORDER BY bmcu_seq_no, id', [execId]);
  const entries = await db.query(
    'SELECT * FROM trip_execution_bmcu_entries WHERE execution_id=$1 ORDER BY bmcu_seq_no, id', [execId]);
  const acks = await db.query(
    'SELECT * FROM trip_acknowledgements WHERE execution_id=$1 ORDER BY chamber', [execId]);
  return {
    actual_km: exec.rows[0]?.actual_km,
    bmcus: bmcus.rows, shift_rows: shifts.rows,
    entries: entries.rows, acknowledgements: acks.rows,
  };
}

// ─── Diff email (side-by-side old → new) ──────────────────────────────────────
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
const cell = (v) => v === null || v === undefined || v === '' ? '—' : esc(v);

function diffRowsHtml(title, oldRows, newRows, keyFn, labelFn, fields) {
  const oldBy = new Map((oldRows || []).map(r => [keyFn(r), r]));
  const newBy = new Map((newRows || []).map(r => [keyFn(r), r]));
  const keys = [...new Set([...oldBy.keys(), ...newBy.keys()])];
  let rows = '';
  for (const k of keys) {
    const o = oldBy.get(k), n = newBy.get(k);
    for (const f of fields) {
      const ov = o ? o[f.key] : undefined;
      const nv = n ? n[f.key] : undefined;
      const oNum = parseFloat(ov), nNum = parseFloat(nv);
      const same = (ov ?? '') === (nv ?? '') || (Number.isFinite(oNum) && Number.isFinite(nNum) && oNum === nNum);
      if (same) continue;
      rows += `<tr>
        <td style="padding:4px 8px;border:1px solid #e5e7eb;">${esc(labelFn(o || n))}</td>
        <td style="padding:4px 8px;border:1px solid #e5e7eb;">${esc(f.label)}</td>
        <td style="padding:4px 8px;border:1px solid #e5e7eb;color:#6b7280;">${cell(ov)}</td>
        <td style="padding:4px 8px;border:1px solid #e5e7eb;background:#fef3c7;font-weight:600;">${cell(nv)}</td>
      </tr>`;
    }
  }
  if (!rows) return '';
  return `<h3 style="font-family:sans-serif;font-size:14px;margin:16px 0 6px;">${esc(title)}</h3>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:12px;">
      <tr style="background:#f3f4f6;">
        <th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:left;">Row</th>
        <th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:left;">Field</th>
        <th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:left;">Current</th>
        <th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:left;">Proposed</th>
      </tr>${rows}</table>`;
}

function buildDiffHtml(snapshot, changes) {
  const bmcuFields = [
    { key: 'milk_date', label: 'Date' }, { key: 'shift', label: 'Shift' },
    { key: 'qty_litres', label: 'Dispatch Qty L' }, { key: 'fat_pct', label: 'Fat%' },
    { key: 'snf_pct', label: 'SNF%' }, { key: 'chamber', label: 'Chamber' },
    { key: 'description', label: 'Description' },
  ];
  const shiftFields = [
    { key: 'milk_date', label: 'Date' }, { key: 'shift', label: 'Shift' },
    { key: 'rmrd_qty', label: 'RMRD Qty' }, { key: 'rmrd_fat_pct', label: 'RMRD Fat%' },
    { key: 'rmrd_snf_pct', label: 'RMRD SNF%' },
  ];
  const entryFields = [
    { key: 'category', label: 'Category' }, { key: 'qty_litres', label: 'Qty L' },
    { key: 'fat_pct', label: 'Fat%' }, { key: 'snf_pct', label: 'SNF%' },
    { key: 'remarks', label: 'Remarks' },
  ];
  const ackFields = [
    { key: 'qty_litres', label: 'Qty Litres' }, { key: 'fat_pct', label: 'Fat%' },
    { key: 'snf_pct', label: 'SNF%' }, { key: 'temperature', label: 'Temp' },
    { key: 'description', label: 'Description' },
  ];

  const kmDiff = (parseFloat(snapshot.actual_km) || 0) !== (parseFloat(changes.actual_km) || 0)
    ? `<p style="font-family:sans-serif;font-size:13px;">Actual KM: <s>${cell(snapshot.actual_km)}</s> → <b style="background:#fef3c7;">${cell(changes.actual_km)}</b></p>` : '';

  return kmDiff
    + diffRowsHtml('BMCU Data Entry', snapshot.bmcus, changes.bmcus,
        r => `${r.seq_no}`, r => `#${r?.seq_no} ${r?.bmcu_code || r?.bmcu_id || ''}`, bmcuFields)
    + diffRowsHtml('Shift Rows', snapshot.shift_rows, changes.shift_rows,
        r => `${r.bmcu_seq_no}|${r.milk_date || ''}|${r.shift || ''}`, r => `BMCU #${r?.bmcu_seq_no} ${r?.shift || ''}`, shiftFields)
    + diffRowsHtml('Balance / MPP / Shifting Entries', snapshot.entries, changes.entries,
        (r, i) => `${r.bmcu_seq_no}|${r.kind}|${r.category || ''}`, r => `BMCU #${r?.bmcu_seq_no} ${r?.kind || ''}`, entryFields)
    + diffRowsHtml('Acknowledgement', snapshot.acknowledgements, changes.acknowledgements,
        r => r.chamber, r => `Chamber ${r?.chamber}`, ackFields)
    || '<p style="font-family:sans-serif;font-size:13px;color:#6b7280;">(No field-level differences detected — review in the portal.)</p>';
}

async function sendApprovalEmail(cr, execInfo, approver) {
  const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
  const approveUrl = `${base}/api/change-requests/decide?token=${cr.approval_token}&decision=approve`;
  const rejectUrl  = `${base}/api/change-requests/decide?token=${cr.approval_token}&decision=reject`;

  const html = `
    <p style="font-family:sans-serif;font-size:14px;">Dear ${esc(approver.full_name)},</p>
    <p style="font-family:sans-serif;font-size:13px;">
      <b>${esc(cr.requested_by_name)}</b> has requested changes to the CLOSED trip
      <b>Trip #${esc(execInfo.trip_no)} — ${esc(execInfo.tanker_number || '')}</b>
      (${esc(String(execInfo.execution_date).slice(0, 10))}).<br/>
      Reason: <i>${esc(cr.reason || '—')}</i>
    </p>
    ${buildDiffHtml(cr.snapshot, cr.changes)}
    <p style="margin:20px 0;">
      <a href="${approveUrl}" style="font-family:sans-serif;background:#16a34a;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;">✔ APPROVE</a>
      &nbsp;&nbsp;
      <a href="${rejectUrl}" style="font-family:sans-serif;background:#dc2626;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;">✘ REJECT</a>
    </p>
    <p style="font-family:sans-serif;font-size:12px;color:#6b7280;">
      You can also review this request in the portal under <b>Execution → Approvals</b>.
      Until you approve, all reports continue to show the current (unchanged) data.
    </p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;"/>
    <p style="font-family:sans-serif;font-size:12px;color:#9ca3af;">Shreeja TMS · change request #${cr.id}</p>`;

  const transporter = createTransport();
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: approver.email,
    subject: `Approval needed — changes to closed Trip #${execInfo.trip_no} (${String(execInfo.execution_date).slice(0, 10)})`,
    html,
  });
}

// ─── Apply / decide helpers ───────────────────────────────────────────────────
async function decideRequest(crId, decision, decider, note) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const crRes = await client.query(
      "SELECT * FROM execution_change_requests WHERE id=$1 AND status='pending' FOR UPDATE", [crId]);
    if (!crRes.rows.length) throw Object.assign(new Error('Request not found or already decided'), { code: 404 });
    const cr = crRes.rows[0];

    if (decision === 'approve') {
      // Apply via the shared write path; closed status stays closed.
      // Snapshot before/after inside the transaction for the field-level change log.
      let beforeSnap = null;
      try { beforeSnap = await executionSnapshot(client, cr.execution_id); } catch {}
      await applyExecutionData(client, cr.execution_id, cr.changes, decider.id || null);
      try {
        const afterSnap = await executionSnapshot(client, cr.execution_id);
        logChanges({
          module: 'Executions', entityId: cr.execution_id, action: 'update',
          userId: decider.id || null, userName: decider.full_name || null,
          userLogin: null, path: `/api/change-requests/${crId}/approve`,
        }, diffSnapshots(beforeSnap, afterSnap));
      } catch {}
    }

    await client.query(
      `UPDATE execution_change_requests
       SET status=$1, decided_by=$2, decided_by_name=$3, decided_at=NOW(),
           decision_note=$4, approval_token=NULL
       WHERE id=$5`,
      [decision === 'approve' ? 'approved' : 'rejected',
       decider.id || null, decider.full_name || decider.name || 'via email',
       note || null, crId]
    );
    await client.query('COMMIT');
    return cr;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

// ─── POST /api/executions/:id/change-request (mounted under /api/change-requests too) ─
// Body: { reason, changes: { actual_km, bmcus, shift_rows, entries, acknowledgements, ack_date } }
router.post('/executions/:id', authenticate, async (req, res) => {
  const { reason, changes } = req.body;
  if (!changes || typeof changes !== 'object')
    return res.status(400).json({ error: 'changes payload required' });
  if (!reason || !String(reason).trim())
    return res.status(400).json({ error: 'A reason for the change is required' });

  try {
    const execRes = await query(`
      SELECT te.id, te.status, te.execution_date, tp.trip_no, t.tanker_number
      FROM trip_executions te
      JOIN trip_plans tp ON tp.id=te.trip_plan_id
      LEFT JOIN tankers t ON t.id=tp.tanker_id
      WHERE te.id=$1`, [req.params.id]);
    if (!execRes.rows.length) return res.status(404).json({ error: 'Execution not found' });
    const execInfo = execRes.rows[0];
    if (execInfo.status !== 'closed')
      return res.status(400).json({ error: 'Change requests are only for CLOSED trips — open trips can be edited directly' });

    const pending = await query(
      "SELECT id FROM execution_change_requests WHERE execution_id=$1 AND status='pending'", [req.params.id]);
    if (pending.rows.length)
      return res.status(409).json({ error: `A change request (#${pending.rows[0].id}) is already pending approval for this trip` });

    const approver = await getApprover();
    if (!approver)
      return res.status(400).json({ error: `Approver user "${APPROVER_ID()}" not found or inactive — create the user with a valid email first` });
    if (!approver.email)
      return res.status(400).json({ error: `Approver "${APPROVER_ID()}" has no email address configured` });

    const snapshot = await snapshotExecution({ query }, req.params.id);
    const token = crypto.randomBytes(24).toString('hex');

    const ins = await query(
      `INSERT INTO execution_change_requests
         (execution_id, requested_by, requested_by_name, reason, snapshot, changes, approval_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, req.user.id, req.user.full_name, String(reason).trim(),
       JSON.stringify(snapshot), JSON.stringify(changes), token]
    );
    const cr = ins.rows[0];

    let emailed = true;
    try { await sendApprovalEmail(cr, execInfo, approver); }
    catch (e) { emailed = false; console.error('[changeRequests] email failed:', e.message); }

    res.status(201).json({
      id: cr.id, status: cr.status, emailed,
      approver: { name: approver.full_name, user_id: approver.user_id },
      message: emailed
        ? `Sent to ${approver.full_name} (${approver.user_id}) for approval`
        : `Request staged, but the approval email failed to send — ${approver.full_name} can still approve in the portal`,
    });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'A change request is already pending for this trip' });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/change-requests?status=&execution_id=
router.get('/', authenticate, async (req, res) => {
  try {
    const approver = await getApprover();
    const canSeeAll = req.user.role === 'admin' || isApprover(req.user, approver);

    const where = [];
    const params = [];
    if (req.query.status)       { params.push(req.query.status);       where.push(`cr.status=$${params.length}`); }
    if (req.query.execution_id) { params.push(req.query.execution_id); where.push(`cr.execution_id=$${params.length}`); }
    if (!canSeeAll)             { params.push(req.user.id);            where.push(`cr.requested_by=$${params.length}`); }

    const r = await query(`
      SELECT cr.id, cr.execution_id, cr.requested_by, cr.requested_by_name, cr.reason,
             cr.status, cr.decided_by_name, cr.decided_at, cr.decision_note, cr.created_at,
             tp.trip_no, te.execution_date, t.tanker_number
      FROM execution_change_requests cr
      JOIN trip_executions te ON te.id=cr.execution_id
      JOIN trip_plans tp      ON tp.id=te.trip_plan_id
      LEFT JOIN tankers t     ON t.id=tp.tanker_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (cr.status='pending') DESC, cr.created_at DESC
      LIMIT 200`, params);
    res.json({
      rows: r.rows,
      is_approver: isApprover(req.user, approver) || req.user.role === 'admin',
      approver_name: approver?.full_name || APPROVER_ID(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/change-requests/decide?token=&decision=  — EMAIL LINK (token-authenticated)
router.get('/decide', async (req, res) => {
  const { token, decision } = req.query;
  const page = (title, body, color) => res.send(`<!doctype html>
    <html><body style="font-family:sans-serif;background:#f0f7ff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
      <div style="background:#fff;border-radius:14px;padding:36px 44px;box-shadow:0 8px 30px rgba(0,60,120,0.12);max-width:460px;text-align:center;">
        <div style="font-size:40px;">${color === '#16a34a' ? '✅' : color === '#dc2626' ? '🚫' : 'ℹ️'}</div>
        <h2 style="color:${color};margin:12px 0 8px;">${title}</h2>
        <p style="color:#4b5563;font-size:14px;">${body}</p>
      </div></body></html>`);

  try {
    if (!token || !['approve', 'reject'].includes(decision))
      return page('Invalid link', 'This approval link is malformed.', '#dc2626');

    const crRes = await query('SELECT * FROM execution_change_requests WHERE approval_token=$1', [token]);
    if (!crRes.rows.length)
      return page('Link expired', 'This request was already decided, or the link is no longer valid.', '#6b7280');
    const cr = crRes.rows[0];

    const approver = await getApprover();
    const decider = approver
      ? { id: approver.id, full_name: `${approver.full_name} (via email)` }
      : { id: null, full_name: 'via email' };

    await decideRequest(cr.id, decision, decider, 'Decided via email link');

    // Manual audit entry (GETs are skipped by the audit middleware).
    query(
      `INSERT INTO audit_logs (user_id, user_name, method, path, module, action, entity_id, status_code, success, details)
       VALUES ($1,$2,'GET','/api/change-requests/decide','Change Requests',$3,$4,200,TRUE,$5)`,
      [decider.id, decider.full_name, decision === 'approve' ? 'approve' : 'cancel',
       String(cr.id), JSON.stringify({ execution_id: cr.execution_id, via: 'email' })]
    ).catch(() => {});

    return decision === 'approve'
      ? page('Change request approved', `Request #${cr.id} has been approved and the changes are now applied to Trip data and all reports.`, '#16a34a')
      : page('Change request rejected', `Request #${cr.id} has been rejected. The original data remains unchanged.`, '#dc2626');
  } catch (err) {
    return page('Something went wrong', esc(err.message), '#dc2626');
  }
});

// GET /api/change-requests/:id — detail (snapshot + changes)
router.get('/:id', authenticate, async (req, res) => {
  try {
    const r = await query(`
      SELECT cr.*, tp.trip_no, te.execution_date, t.tanker_number
      FROM execution_change_requests cr
      JOIN trip_executions te ON te.id=cr.execution_id
      JOIN trip_plans tp      ON tp.id=te.trip_plan_id
      LEFT JOIN tankers t     ON t.id=tp.tanker_id
      WHERE cr.id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const cr = r.rows[0];
    const approver = await getApprover();
    const canSee = req.user.role === 'admin' || isApprover(req.user, approver) || cr.requested_by === req.user.id;
    if (!canSee) return res.status(403).json({ error: 'Not allowed' });
    delete cr.approval_token;
    res.json({ ...cr, is_approver: isApprover(req.user, approver) || req.user.role === 'admin' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/change-requests/:id/approve | /reject  — PORTAL decision
async function portalDecision(req, res, decision) {
  try {
    const approver = await getApprover();
    if (!(req.user.role === 'admin' || isApprover(req.user, approver)))
      return res.status(403).json({ error: `Only ${approver?.full_name || APPROVER_ID()} or an admin can decide change requests` });

    const cr = await decideRequest(
      req.params.id, decision,
      { id: req.user.id, full_name: req.user.full_name },
      req.body?.note
    );
    res.json({ ok: true, id: parseInt(req.params.id), decision, execution_id: cr.execution_id });
  } catch (err) {
    res.status(err.code === 404 ? 404 : 500).json({ error: err.message });
  }
}
router.post('/:id/approve', authenticate, (req, res) => portalDecision(req, res, 'approve'));
router.post('/:id/reject',  authenticate, (req, res) => portalDecision(req, res, 'reject'));

module.exports = router;
