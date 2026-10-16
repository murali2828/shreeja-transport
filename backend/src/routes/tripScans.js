// backend/src/routes/tripScans.js
// Scanned documents per trip (migration 071, ADR-025): the BMCU dispatch
// challan (DC) of each BMCU line (kind 'bmcu_dc', teb_id = trip_execution_bmcus.id)
// and the plant acknowledgement slip of the trip (kind 'ack'). Several files
// per line / ack. Uploads are allowed on any non-cancelled execution, closed
// and billed ones included: a scan never changes trip data, so the billing
// freeze and change-request rules do not apply. Bytes live on the uploads
// volume (services/scanStore.js); JSON carries metadata only. Pending is
// computed: DC pending = live BMCU row without a DC scan, ack pending =
// acknowledged trip without an ack scan.
// Adding files is free; replacing or deleting an uploaded scan goes through
// trip_scan_change_requests (approver by single-use email link or portal);
// only an admin deletes directly (owner, 2026-10-16).
const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const ExcelJS  = require('exceljs');
const crypto   = require('crypto');
const { pool, query } = require('../config/db');
const { authenticate, authorize, authorizeOrModule, hasRole, accessFor, rolesOf } = require('../middleware/auth');
const { createTransport } = require('../config/mailer');
const scanStore = require('../services/scanStore');
const { autoWidth, stylePortalWorkbook } = require('../services/portalExcel');

try { scanStore.ensureDirs(); }
catch (e) { console.error('[trip-scans] failed to create upload dir:', e.message); }

const READ  = authorizeOrModule('execution', 'admin', 'planner', 'executor', 'biller', 'viewer');
const WRITE = authorizeOrModule('execution', 'admin', 'planner', 'executor', 'biller');
// Scan Status report (Reports → Scan Status): the reports module or the execution scope.
async function REPORT_READ(req, res, next) {
  try {
    if (hasRole(req.user, 'admin', 'planner', 'executor', 'biller', 'viewer')) return next();
    const lv = await accessFor(rolesOf(req.user));
    if ((lv.reports && lv.reports !== 'none') || (lv.execution && lv.execution !== 'none')) return next();
    res.status(403).json({ error: 'Insufficient permissions' });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
// Viewing one trip's scans (GET only): the execution scope, or the billing
// module so custom finance / billing roles can open "📎 Scans" on a run's Trip Wise line.
async function VIEW_READ(req, res, next) {
  try {
    if (hasRole(req.user, 'admin', 'planner', 'executor', 'biller', 'viewer')) return next();
    const lv = await accessFor(rolesOf(req.user));
    if ((lv.execution && lv.execution !== 'none') || (lv.billing && lv.billing !== 'none')) return next();
    res.status(403).json({ error: 'Insufficient permissions' });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
const MAX_MB = 10, MAX_FILES = 10;
const DELETE_WINDOW_MS = 24 * 3600 * 1000;

const uploader = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, scanStore.TMP_DIR()),
    filename: (_req, _file, cb) => cb(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}.part`),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: MAX_FILES * 2 },
});
const scanUpload = (req, res, next) => uploader.fields([{ name: 'files', maxCount: MAX_FILES }, { name: 'thumbs', maxCount: MAX_FILES }])(req, res, err => {
  if (!err) return next();
  cleanup(req);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File is larger than ${MAX_MB} MB — scan at lower resolution and try again` });
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: `At most ${MAX_FILES} files per upload` });
  return res.status(400).json({ error: err.message || 'Upload failed' });
});
function cleanup(req) {
  const f = req.files || {};
  for (const k of Object.keys(f)) for (const x of f[k]) scanStore.removeQuiet(x.path);
}

const COLS = `s.id, s.execution_id, s.kind, s.teb_id, s.bmcu_id, s.mime, s.bytes, s.original_name,
  (SELECT bm.bmcu_code FROM bmcus bm WHERE bm.id = s.bmcu_id) AS bmcu_code,
  (SELECT bm.bmcu_name FROM bmcus bm WHERE bm.id = s.bmcu_id) AS bmcu_name,
  (s.thumb_path IS NOT NULL) AS has_thumb, s.uploaded_by, s.uploaded_by_name, s.uploaded_at,
  (SELECT json_build_object('id', cr.id, 'action', cr.action, 'reason', cr.reason, 'requested_by_name', cr.requested_by_name, 'requested_at', cr.requested_at)
     FROM trip_scan_change_requests cr WHERE cr.scan_id = s.id AND cr.status = 'pending') AS pending_change`;

// Grouped aggregate per execution — also used by the executions list (one LEFT JOIN, no N+1).
const SUMMARY_SQL = `
  SELECT te.id AS execution_id,
    (SELECT COUNT(*)::int FROM trip_execution_bmcus b WHERE b.execution_id = te.id AND b.is_deleted = FALSE) AS dc_total,
    (SELECT COUNT(DISTINCT s.teb_id)::int FROM trip_scans s
       JOIN trip_execution_bmcus b ON b.id = s.teb_id AND b.is_deleted = FALSE
      WHERE s.execution_id = te.id AND s.kind = 'bmcu_dc' AND s.deleted_at IS NULL AND s.is_proposed = FALSE) AS dc_done,
    (SELECT COUNT(*)::int FROM trip_scans s WHERE s.execution_id = te.id AND s.kind = 'ack' AND s.deleted_at IS NULL AND s.is_proposed = FALSE) AS ack_scans,
    EXISTS (SELECT 1 FROM trip_acknowledgements a WHERE a.execution_id = te.id) AS acknowledged
  FROM trip_executions te`;

// GET /api/trip-scans?execution_id=  — metadata only
router.get('/', authenticate, VIEW_READ, async (req, res) => {
  const id = parseInt(req.query.execution_id, 10);
  if (!id) return res.status(400).json({ error: 'execution_id required' });
  try {
    const r = await query(`SELECT ${COLS} FROM trip_scans s WHERE s.execution_id=$1 AND s.deleted_at IS NULL AND s.is_proposed = FALSE ORDER BY s.kind, s.teb_id, s.id`, [id]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/trip-scans/summary?execution_ids=1,2,3
router.get('/summary', authenticate, READ, async (req, res) => {
  const ids = String(req.query.execution_ids || '').split(',').map(x => parseInt(x, 10)).filter(Boolean).slice(0, 2000);
  if (!ids.length) return res.json([]);
  try {
    const r = await query(`${SUMMARY_SQL} WHERE te.id = ANY($1::int[])`, [ids]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Per-trip scan status for live executions whose plan date is in [from, to].
async function pendingRows(from, to, pendingOnly) {
  const r = await query(`
    WITH ex AS (
      SELECT te.id, te.status, tp.plan_for_date, tp.trip_no, t.tanker_number,
             rm.route_name, dp.name AS delivery_point_name, u.full_name AS executor_name
        FROM trip_executions te
        JOIN trip_plans tp ON tp.id = te.trip_plan_id
        LEFT JOIN tankers t ON t.id = tp.tanker_id
        LEFT JOIN route_masters rm ON rm.id = tp.route_id
        LEFT JOIN delivery_points dp ON dp.id = tp.delivery_point_id
        LEFT JOIN users u ON u.id = te.executed_by
       WHERE te.status <> 'cancelled' AND tp.plan_for_date BETWEEN $1 AND $2
    ),
    bm AS (
      SELECT b.execution_id, COUNT(*)::int AS dc_total,
             COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM trip_scans s WHERE s.teb_id = b.id AND s.kind='bmcu_dc' AND s.deleted_at IS NULL AND s.is_proposed = FALSE))::int AS dc_done
        FROM trip_execution_bmcus b JOIN ex ON ex.id = b.execution_id
       WHERE b.is_deleted = FALSE GROUP BY b.execution_id
    ),
    ak AS (SELECT DISTINCT a.execution_id FROM trip_acknowledgements a JOIN ex ON ex.id = a.execution_id),
    sk AS (SELECT s.execution_id, COUNT(*)::int AS ack_scans FROM trip_scans s JOIN ex ON ex.id = s.execution_id
            WHERE s.kind='ack' AND s.deleted_at IS NULL AND s.is_proposed = FALSE GROUP BY s.execution_id)
    SELECT ex.id AS execution_id, ex.status, ex.plan_for_date, ex.trip_no, ex.tanker_number, ex.route_name,
           ex.delivery_point_name, ex.executor_name,
           COALESCE(bm.dc_total,0) AS dc_total, COALESCE(bm.dc_done,0) AS dc_done,
           (ak.execution_id IS NOT NULL) AS acknowledged,
           COALESCE(sk.ack_scans,0) AS ack_scans, (COALESCE(sk.ack_scans,0) > 0) AS ack_scanned
      FROM ex LEFT JOIN bm ON bm.execution_id = ex.id LEFT JOIN ak ON ak.execution_id = ex.id
      LEFT JOIN sk ON sk.execution_id = ex.id
     ORDER BY ex.plan_for_date DESC, ex.tanker_number, ex.trip_no`, [from, to]);
  const rows = r.rows.map(x => ({ ...x,
    dc_pending: x.dc_total - x.dc_done,
    ack_pending: x.acknowledged && !x.ack_scanned }));
  return pendingOnly ? rows.filter(x => x.dc_pending > 0 || x.ack_pending) : rows;
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function range(req, res) {
  const { from, to } = req.query;
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) { res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' }); return null; }
  return { from, to, pendingOnly: req.query.pending_only === 'true' || req.query.pending_only === '1' };
}

// GET /api/trip-scans/pending?from&to[&pending_only=true]
router.get('/pending', authenticate, REPORT_READ, async (req, res) => {
  const q = range(req, res); if (!q) return;
  try { res.json(await pendingRows(q.from, q.to, q.pendingOnly)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/trip-scans/pending/excel?from&to[&pending_only=true]
router.get('/pending/excel', authenticate, REPORT_READ, async (req, res) => {
  const q = range(req, res); if (!q) return;
  try {
    const rows = await pendingRows(q.from, q.to, q.pendingOnly);
    const d = s => s.split('-').reverse().join('-');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Scan Status');
    ws.addRow([`Scan Status — ${d(q.from)} to ${d(q.to)}${q.pendingOnly ? ' (pending only)' : ''}`]);
    ws.addRow([]);
    ws.addRow(['Lifting Date', 'Tanker', 'Trip No', 'Route', 'Delivery Point', 'Executor', 'Status',
      'DC Scanned', 'DC Total', 'DC Pending', 'Acknowledged', 'Ack Scans', 'Ack Scan Pending']);
    for (const x of rows) ws.addRow([d(x.plan_for_date), x.tanker_number, x.trip_no, x.route_name, x.delivery_point_name,
      x.executor_name, x.status, x.dc_done, x.dc_total, x.dc_pending, x.acknowledged ? 'Yes' : 'No', x.ack_scans, x.ack_pending ? 'Yes' : 'No']);
    stylePortalWorkbook(wb, 'Scan Status');
    autoWidth(ws, { skipRows: 1 });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Scan_Status_${q.from}_${q.to}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stores the uploaded files (and thumbnails, matched by index) as trip_scans
// rows. `proposed` rows are a replace request's files: invisible as live scans
// until the request is approved. Temp files are always cleaned up.
async function saveUploads(req, meta, proposed) {
  const files = (req.files && req.files.files) || [];
  const thumbs = (req.files && req.files.thumbs) || [];
  const done = new Set();
  try {
    const out = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const stored = await scanStore.storeTemp(f.path); done.add(f.path);
      let thumbRel = null;
      const th = thumbs[i];
      if (th) {
        try {
          const ts = await scanStore.storeTemp(th.path);
          if (ts.mime !== 'application/pdf') thumbRel = ts.rel;
        } catch (e) { console.warn('[trip-scans] thumbnail ignored:', e.message); }
        done.add(th.path);
      }
      const r = await query(
        `INSERT INTO trip_scans (execution_id, kind, teb_id, bmcu_id, file_path, thumb_path, mime, bytes, sha256, original_name, uploaded_by, uploaded_by_name, is_proposed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id, execution_id, kind, teb_id, bmcu_id, mime, bytes, original_name, (thumb_path IS NOT NULL) AS has_thumb, uploaded_by, uploaded_by_name, uploaded_at`,
        [meta.execution_id, meta.kind, meta.teb_id, meta.bmcu_id, stored.rel, thumbRel, stored.mime, stored.bytes, stored.sha256,
         String(f.originalname || '').slice(0, 200) || null, req.user.id, req.user.full_name || req.user.user_id || null, !!proposed]);
      out.push(r.rows[0]);
    }
    return out;
  } finally {
    for (const x of [...files, ...thumbs]) if (!done.has(x.path)) scanStore.removeQuiet(x.path);
  }
}

// POST /api/trip-scans  (multipart: execution_id, kind, teb_id; files[], thumbs[] by index)
// Adding files is free on any non-cancelled trip, closed and billed ones included.
router.post('/', authenticate, WRITE, scanUpload, async (req, res) => {
  try {
    const b = req.body || {};
    const execId = parseInt(b.execution_id, 10);
    const kind = b.kind;
    const files = (req.files && req.files.files) || [];
    if (!execId) { cleanup(req); return res.status(400).json({ error: 'execution_id required' }); }
    if (!['bmcu_dc', 'ack'].includes(kind)) { cleanup(req); return res.status(400).json({ error: 'kind must be bmcu_dc or ack' }); }
    if (!files.length) { cleanup(req); return res.status(400).json({ error: 'No files attached' }); }
    const ex = await query('SELECT id, status FROM trip_executions WHERE id=$1', [execId]);
    if (!ex.rows.length) { cleanup(req); return res.status(404).json({ error: 'Execution not found' }); }
    if (ex.rows[0].status === 'cancelled') { cleanup(req); return res.status(400).json({ error: 'Execution is cancelled — scans cannot be attached' }); }
    let tebId = null, bmcuId = null;
    if (kind === 'bmcu_dc') {
      tebId = parseInt(b.teb_id, 10);
      if (!tebId) { cleanup(req); return res.status(400).json({ error: 'teb_id required for a BMCU dispatch challan' }); }
      const t = await query('SELECT id, bmcu_id FROM trip_execution_bmcus WHERE id=$1 AND execution_id=$2 AND is_deleted=FALSE', [tebId, execId]);
      if (!t.rows.length) { cleanup(req); return res.status(400).json({ error: 'BMCU line not found on this trip' }); }
      bmcuId = t.rows[0].bmcu_id;
    }
    const out = await saveUploads(req, { execution_id: execId, kind, teb_id: tebId, bmcu_id: bmcuId }, false);
    res.status(201).json(out);
  } catch (err) {
    cleanup(req);
    res.status(err.status === 400 ? 400 : 500).json({ error: err.message });
  }
});

// ── Change requests: replace / delete an uploaded scan (owner, 2026-10-16) ──
// Mirrors billingTollChanges.js: request with reason → email to the approver
// (CHANGE_APPROVER_ID, cc CHANGE_APPROVER_CC) with single-use links → POST
// decide (GET decision-info never mutates) or a portal decision. Only the
// SHA-256 of the token is stored.
const APPROVER_ID = () => process.env.CHANGE_APPROVER_ID || 'PP01';
const APPROVER_CC = () => (process.env.CHANGE_APPROVER_CC
  || 'billing1@shreejamilk.com,billing2@shreejamilk.com,rajesh.k@shreejamilk.com')
  .split(',').map(x => x.trim()).filter(Boolean);
const BASE_URL = () => (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://tms.shreejamilk.com').replace(/\/$/, '');
const TOKEN_DAYS = 14;
const esc = x => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const ddmmyyyy = d => (d ? String(d).slice(0, 10).split('-').reverse().join('-') : '—');

async function getApprover() {
  const r = await query('SELECT id, user_id, full_name, email FROM users WHERE LOWER(user_id)=LOWER($1) AND is_active=TRUE', [APPROVER_ID()]);
  return r.rows[0] || null;
}

async function crDetails(id) {
  const r = await query(`
    SELECT cr.id, cr.scan_id, cr.execution_id, cr.action, cr.reason, cr.proposed_scan_ids, cr.status,
           cr.requested_by, cr.requested_by_name, cr.requested_at, cr.decided_by_name, cr.decided_at, cr.decision_note,
           s.kind, s.original_name, s.uploaded_by_name, s.uploaded_at,
           tp.plan_for_date, tp.trip_no, t.tanker_number, b.bmcu_code, b.bmcu_name
      FROM trip_scan_change_requests cr
      JOIN trip_scans s ON s.id = cr.scan_id
      JOIN trip_executions te ON te.id = cr.execution_id
      JOIN trip_plans tp ON tp.id = te.trip_plan_id
      LEFT JOIN tankers t ON t.id = tp.tanker_id
      LEFT JOIN bmcus b ON b.id = s.bmcu_id
     WHERE cr.id = $1`, [id]);
  return r.rows[0] || null;
}

function crTableHtml(d) {
  const row = (k, v) => `<tr><td style="padding:4px 10px;border:1px solid #e5e7eb;font-weight:600;background:#f8fafc;">${esc(k)}</td><td style="padding:4px 10px;border:1px solid #e5e7eb;">${v}</td></tr>`;
  return `<table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;margin:8px 0;">
    ${row('Trip', `#${esc(d.trip_no)} · <b>${esc(d.tanker_number || '—')}</b> · lifting ${esc(ddmmyyyy(d.plan_for_date))}`)}
    ${row('Document', d.kind === 'ack' ? 'Plant acknowledgement slip' : `BMCU dispatch challan — ${esc(d.bmcu_code || '')} ${esc(d.bmcu_name || '')}`)}
    ${row('Current file', `${esc(d.original_name || `scan #${d.scan_id}`)} (uploaded by ${esc(d.uploaded_by_name || '—')})`)}
    ${row('Requested change', d.action === 'replace' ? `<b>Replace</b> with ${d.proposed_scan_ids.length} file(s)` : '<b>Delete</b>')}
    ${row('Requested by', esc(d.requested_by_name || '—'))}
    ${row('Reason', `<i>${esc(d.reason)}</i>`)}
  </table>`;
}

async function sendCrEmail(d, token, approver) {
  const approveUrl = `${BASE_URL()}/scan-change-decision?token=${token}&decision=approve`;
  const rejectUrl  = `${BASE_URL()}/scan-change-decision?token=${token}&decision=reject`;
  // Current and proposed files attached (thumbnail when present, else the file), capped at ~15 MB.
  const ids = [d.scan_id, ...(d.proposed_scan_ids || [])];
  const rows = (await query('SELECT id, file_path, thumb_path, mime, bytes FROM trip_scans WHERE id = ANY($1::int[])', [ids])).rows;
  const attachments = []; let total = 0;
  for (const id of ids) {
    const x = rows.find(r => r.id === id); if (!x) continue;
    const useThumb = !!x.thumb_path;
    const full = scanStore.resolve(useThumb ? x.thumb_path : x.file_path);
    const size = useThumb ? 0 : (x.bytes || 0);
    if (!full || total + size > 15 * 1024 * 1024) continue;
    total += size;
    const ext = (useThumb ? x.thumb_path : x.file_path).split('.').pop();
    attachments.push({ filename: `${id === d.scan_id ? 'current' : 'proposed'}-${id}.${ext}`, path: full });
  }
  const html = `
    <p style="font-family:sans-serif;font-size:14px;">Dear ${esc(approver.full_name)},</p>
    <p style="font-family:sans-serif;font-size:13px;"><b>${esc(d.requested_by_name)}</b> has requested a change to an uploaded trip scan.</p>
    ${crTableHtml(d)}
    <p style="font-family:sans-serif;font-size:12px;color:#374151;">The current and proposed files are attached (thumbnails for photos).</p>
    <p style="margin:20px 0;">
      <a href="${approveUrl}" style="font-family:sans-serif;background:#16a34a;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;">✔ APPROVE</a>
      &nbsp;&nbsp;
      <a href="${rejectUrl}" style="font-family:sans-serif;background:#dc2626;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;">✘ REJECT</a>
    </p>
    <p style="font-family:sans-serif;font-size:12px;color:#6b7280;">Until you approve, the current scan stays. The link works once and expires in ${TOKEN_DAYS} days.</p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;"/>
    <p style="font-family:sans-serif;font-size:12px;color:#9ca3af;">Shreeja TMS · scan change request #${d.id}</p>`;
  await createTransport().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: approver.email, cc: APPROVER_CC().join(', ') || undefined,
    subject: `Approval needed — scan ${d.action}, ${d.tanker_number || ''} trip #${d.trip_no} (${ddmmyyyy(d.plan_for_date)})`,
    html, attachments,
  });
}

// POST /api/trip-scans/change-requests  (multipart: scan_id, action replace|delete, reason; files[] + thumbs[] for replace)
router.post('/change-requests', authenticate, WRITE, scanUpload, async (req, res) => {
  try {
    const b = req.body || {};
    const scanId = parseInt(b.scan_id, 10);
    const action = b.action;
    const reason = String(b.reason || '').trim();
    const files = (req.files && req.files.files) || [];
    if (!scanId) { cleanup(req); return res.status(400).json({ error: 'scan_id required' }); }
    if (!['replace', 'delete'].includes(action)) { cleanup(req); return res.status(400).json({ error: 'action must be replace or delete' }); }
    if (reason.length < 3) { cleanup(req); return res.status(400).json({ error: 'reason required' }); }
    if (action === 'replace' && !files.length) { cleanup(req); return res.status(400).json({ error: 'Attach the replacement file(s)' }); }
    if (action === 'delete' && files.length) cleanup(req);
    const sr = await query(`SELECT s.*, te.status AS exec_status FROM trip_scans s JOIN trip_executions te ON te.id = s.execution_id
                             WHERE s.id=$1 AND s.deleted_at IS NULL AND s.is_proposed = FALSE`, [scanId]);
    if (!sr.rows.length) { cleanup(req); return res.status(404).json({ error: 'Scan not found' }); }
    const scan = sr.rows[0];
    if (scan.exec_status === 'cancelled') { cleanup(req); return res.status(400).json({ error: 'Execution is cancelled' }); }
    const open = await query("SELECT id FROM trip_scan_change_requests WHERE scan_id=$1 AND status='pending'", [scanId]);
    if (open.rows.length) { cleanup(req); return res.status(409).json({ error: 'A change request for this scan is already pending approval' }); }
    const proposed = action === 'replace'
      ? await saveUploads(req, { execution_id: scan.execution_id, kind: scan.kind, teb_id: scan.teb_id, bmcu_id: scan.bmcu_id }, true)
      : [];
    const token = crypto.randomBytes(24).toString('hex');
    let ins;
    try {
      ins = await query(
        `INSERT INTO trip_scan_change_requests (scan_id, execution_id, action, reason, proposed_scan_ids, requested_by, requested_by_name, token_hash, token_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW() + ($9 || ' days')::interval) RETURNING id`,
        [scanId, scan.execution_id, action, reason, proposed.map(x => x.id), req.user.id, req.user.full_name || req.user.user_id || null, hashToken(token), String(TOKEN_DAYS)]);
    } catch (e) {
      if (proposed.length) await query('UPDATE trip_scans SET deleted_at=NOW(), deleted_by=$2 WHERE id = ANY($1::int[])', [proposed.map(x => x.id), req.user.id]);
      if (e.code === '23505') return res.status(409).json({ error: 'A change request for this scan is already pending approval' });
      throw e;
    }
    const d = await crDetails(ins.rows[0].id);
    let emailed = false;
    try {
      const approver = await getApprover();
      if (approver?.email) { await sendCrEmail(d, token, approver); emailed = true; }
      else console.warn(`[trip-scans] approver ${APPROVER_ID()} has no active account / email — decide in the portal`);
    } catch (e) { console.error('[trip-scans] change-request mail failed:', e.message); }
    res.status(201).json({ id: d.id, status: d.status, emailed });
  } catch (err) {
    cleanup(req);
    res.status(err.status === 400 ? 400 : 500).json({ error: err.message });
  }
});

// GET /api/trip-scans/change-requests?status=pending|all[&execution_id=]
router.get('/change-requests', authenticate, READ, async (req, res) => {
  try {
    const params = []; let where = 'WHERE 1=1';
    if ((req.query.status || 'pending') !== 'all') { params.push(req.query.status || 'pending'); where += ` AND cr.status=$${params.length}`; }
    if (req.query.execution_id) { params.push(parseInt(req.query.execution_id, 10) || 0); where += ` AND cr.execution_id=$${params.length}`; }
    const r = await query(`
      SELECT cr.id, cr.scan_id, cr.execution_id, cr.action, cr.reason, cr.proposed_scan_ids, cr.status,
             cr.requested_by_name, cr.requested_at, cr.decided_by_name, cr.decided_at, cr.decision_note,
             s.kind, s.original_name, tp.plan_for_date, tp.trip_no, t.tanker_number, b.bmcu_code, b.bmcu_name
        FROM trip_scan_change_requests cr
        JOIN trip_scans s ON s.id = cr.scan_id
        JOIN trip_executions te ON te.id = cr.execution_id
        JOIN trip_plans tp ON tp.id = te.trip_plan_id
        LEFT JOIN tankers t ON t.id = tp.tanker_id
        LEFT JOIN bmcus b ON b.id = s.bmcu_id
        ${where} ORDER BY cr.requested_at DESC LIMIT 500`, params);
    const approver = await getApprover();
    res.json({ rows: r.rows, can_decide: hasRole(req.user, 'admin') || (!!approver && approver.id === req.user.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function decideCr(id, decision, decider, note) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query("SELECT * FROM trip_scan_change_requests WHERE id=$1 AND status='pending' FOR UPDATE", [id]);
    if (!r.rows.length) throw Object.assign(new Error('Request not found or already decided'), { http: 404 });
    const cr = r.rows[0];
    if (decision === 'approve') {
      await client.query('UPDATE trip_scans SET deleted_at=NOW(), deleted_by=$2 WHERE id=$1 AND deleted_at IS NULL', [cr.scan_id, decider.id]);
      if (cr.action === 'replace' && cr.proposed_scan_ids.length)
        await client.query('UPDATE trip_scans SET is_proposed=FALSE WHERE id = ANY($1::int[]) AND deleted_at IS NULL', [cr.proposed_scan_ids]);
    } else if (cr.proposed_scan_ids.length) {
      await client.query('UPDATE trip_scans SET deleted_at=NOW(), deleted_by=$2 WHERE id = ANY($1::int[]) AND deleted_at IS NULL', [cr.proposed_scan_ids, decider.id]);
    }
    await client.query(`UPDATE trip_scan_change_requests SET status=$2, decided_by=$3, decided_by_name=$4, decided_at=NOW(), decision_note=$5,
                          token_hash=NULL, token_expires_at=NULL WHERE id=$1`,
      [id, decision === 'approve' ? 'approved' : 'rejected', decider.id, decider.full_name, note]);
    await client.query('COMMIT');
    console.log(`[trip-scans] change #${id} (${cr.action} scan ${cr.scan_id}) ${decision}d by ${decider.full_name}`);
    return cr;
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
  finally { client.release(); }
}

async function crByToken(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const r = await query(`SELECT id FROM trip_scan_change_requests
                          WHERE token_hash=$1 AND status='pending' AND token_expires_at > NOW()`, [hashToken(token)]);
  return r.rows[0] ? r.rows[0].id : null;
}

// GET /api/trip-scans/change-requests/decision-info?token=  (public, read-only)
router.get('/change-requests/decision-info', async (req, res) => {
  try {
    const id = await crByToken(req.query.token);
    if (!id) return res.status(404).json({ error: 'This request was already decided, or the link is no longer valid.' });
    const d = await crDetails(id);
    res.json({ id: d.id, status: d.status, action: d.action, html: crTableHtml(d) });
  } catch (err) { res.status(500).json({ error: 'Failed to load the request' }); }
});

// POST /api/trip-scans/change-requests/decide {token, decision, remarks}  (public, single-use token)
router.post('/change-requests/decide', async (req, res) => {
  const { token, decision, remarks } = req.body || {};
  if (!token || !['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Invalid request' });
  try {
    const id = await crByToken(token);
    if (!id) return res.status(400).json({ error: 'This request was already decided, or the link is no longer valid.' });
    const approver = await getApprover();
    const decider = approver ? { id: approver.id, full_name: `${approver.full_name} (via email)` } : { id: null, full_name: 'via email' };
    const cr = await decideCr(id, decision, decider, String(remarks || '').trim().slice(0, 500) || 'Decided via email link');
    query(`INSERT INTO audit_logs (user_id, user_name, method, path, module, action, entity_id, status_code, success, details)
           VALUES ($1,$2,'POST','/api/trip-scans/change-requests/decide','Execution',$3,$4,200,TRUE,$5)`,
      [decider.id, decider.full_name, decision === 'approve' ? 'approve' : 'cancel', String(cr.id),
       JSON.stringify({ scan_id: cr.scan_id, execution_id: cr.execution_id, action: cr.action, via: 'email' })]).catch(() => {});
    res.json({ ok: true, message: decision === 'approve'
      ? `Request #${cr.id} approved — the scan was ${cr.action === 'replace' ? 'replaced' : 'deleted'}.`
      : `Request #${cr.id} rejected — the scan is unchanged.` });
  } catch (err) { res.status(err.http === 404 ? 404 : 500).json({ error: err.message }); }
});

// Portal decision by the approver / admin
async function portalDecision(req, res, decision) {
  try {
    const approver = await getApprover();
    if (!(hasRole(req.user, 'admin') || (approver && approver.id === req.user.id)))
      return res.status(403).json({ error: `Only ${approver?.full_name || APPROVER_ID()} or an admin can decide scan change requests` });
    const cr = await decideCr(req.params.id, decision, { id: req.user.id, full_name: req.user.full_name }, String(req.body?.remarks || '').trim() || null);
    res.json({ ok: true, id: cr.id, status: decision === 'approve' ? 'approved' : 'rejected' });
  } catch (err) { res.status(err.http === 404 ? 404 : 500).json({ error: err.message }); }
}
router.post('/change-requests/:id/approve', authenticate, WRITE, (req, res) => portalDecision(req, res, 'approve'));
router.post('/change-requests/:id/reject',  authenticate, WRITE, (req, res) => portalDecision(req, res, 'reject'));

async function serve(req, res, which) {
  try {
    const r = await query(`SELECT file_path, thumb_path, mime, original_name FROM trip_scans WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Scan not found' });
    const row = r.rows[0];
    const rel = which === 'thumb' ? row.thumb_path : row.file_path;
    if (!rel) return res.status(404).json({ error: 'No thumbnail' });
    const full = scanStore.resolve(rel);
    if (!full) return res.status(404).json({ error: 'File missing' });
    const mime = which === 'thumb' ? (rel.endsWith('.png') ? 'image/png' : 'image/jpeg') : row.mime;
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    const safeName = String(row.original_name || `scan-${req.params.id}`).replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.sendFile(full, { headers: { 'Cache-Control': 'private, max-age=31536000, immutable' } }, err => {
      if (err && !res.headersSent) res.status(err.status === 404 ? 404 : 500).json({ error: 'File missing on disk' });
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
router.get('/:id/file',  authenticate, VIEW_READ, (req, res) => serve(req, res, 'file'));
router.get('/:id/thumb', authenticate, VIEW_READ, (req, res) => serve(req, res, 'thumb'));

// DELETE /api/trip-scans/:id — admin only, soft delete. Everyone else asks
// through POST /change-requests (approver decides).
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const r = await query('UPDATE trip_scans SET deleted_at=NOW(), deleted_by=$2 WHERE id=$1 AND deleted_at IS NULL AND is_proposed=FALSE RETURNING id', [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Scan not found' });
    // An open change request on the scan has nothing left to change.
    await query(`UPDATE trip_scan_change_requests SET status='rejected', decided_by=$2, decided_by_name=$3, decided_at=NOW(),
                   decision_note='Scan deleted by admin', token_hash=NULL WHERE scan_id=$1 AND status='pending'`, [r.rows[0].id, req.user.id, req.user.full_name || null]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
