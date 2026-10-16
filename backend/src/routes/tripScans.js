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
const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const ExcelJS  = require('exceljs');
const { query } = require('../config/db');
const { authenticate, authorizeOrModule, hasRole } = require('../middleware/auth');
const scanStore = require('../services/scanStore');
const { autoWidth, stylePortalWorkbook } = require('../services/portalExcel');

try { scanStore.ensureDirs(); }
catch (e) { console.error('[trip-scans] failed to create upload dir:', e.message); }

const READ  = authorizeOrModule('execution', 'admin', 'planner', 'executor', 'biller', 'viewer');
const WRITE = authorizeOrModule('execution', 'admin', 'planner', 'executor', 'biller');
const MAX_MB = 10, MAX_FILES = 10;
const DELETE_WINDOW_MS = 24 * 3600 * 1000;

const uploader = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, scanStore.TMP_DIR()),
    filename: (_req, _file, cb) => cb(null, `${Date.now()}_${require('crypto').randomBytes(8).toString('hex')}.part`),
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
  (s.thumb_path IS NOT NULL) AS has_thumb, s.uploaded_by, s.uploaded_by_name, s.uploaded_at`;

// Grouped aggregate per execution — also used by the executions list (one LEFT JOIN, no N+1).
const SUMMARY_SQL = `
  SELECT te.id AS execution_id,
    (SELECT COUNT(*)::int FROM trip_execution_bmcus b WHERE b.execution_id = te.id AND b.is_deleted = FALSE) AS dc_total,
    (SELECT COUNT(DISTINCT s.teb_id)::int FROM trip_scans s
       JOIN trip_execution_bmcus b ON b.id = s.teb_id AND b.is_deleted = FALSE
      WHERE s.execution_id = te.id AND s.kind = 'bmcu_dc' AND s.deleted_at IS NULL) AS dc_done,
    (SELECT COUNT(*)::int FROM trip_scans s WHERE s.execution_id = te.id AND s.kind = 'ack' AND s.deleted_at IS NULL) AS ack_scans,
    EXISTS (SELECT 1 FROM trip_acknowledgements a WHERE a.execution_id = te.id) AS acknowledged
  FROM trip_executions te`;

// GET /api/trip-scans?execution_id=  — metadata only
router.get('/', authenticate, READ, async (req, res) => {
  const id = parseInt(req.query.execution_id, 10);
  if (!id) return res.status(400).json({ error: 'execution_id required' });
  try {
    const r = await query(`SELECT ${COLS} FROM trip_scans s WHERE s.execution_id=$1 AND s.deleted_at IS NULL ORDER BY s.kind, s.teb_id, s.id`, [id]);
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
             COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM trip_scans s WHERE s.teb_id = b.id AND s.kind='bmcu_dc' AND s.deleted_at IS NULL))::int AS dc_done
        FROM trip_execution_bmcus b JOIN ex ON ex.id = b.execution_id
       WHERE b.is_deleted = FALSE GROUP BY b.execution_id
    ),
    ak AS (SELECT DISTINCT a.execution_id FROM trip_acknowledgements a JOIN ex ON ex.id = a.execution_id),
    sk AS (SELECT s.execution_id, COUNT(*)::int AS ack_scans FROM trip_scans s JOIN ex ON ex.id = s.execution_id
            WHERE s.kind='ack' AND s.deleted_at IS NULL GROUP BY s.execution_id)
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
router.get('/pending', authenticate, READ, async (req, res) => {
  const q = range(req, res); if (!q) return;
  try { res.json(await pendingRows(q.from, q.to, q.pendingOnly)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/trip-scans/pending/excel?from&to[&pending_only=true]
router.get('/pending/excel', authenticate, READ, async (req, res) => {
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

// POST /api/trip-scans  (multipart: execution_id, kind, teb_id; files[], thumbs[] by index)
router.post('/', authenticate, WRITE, scanUpload, async (req, res) => {
  const files = (req.files && req.files.files) || [];
  const thumbs = (req.files && req.files.thumbs) || [];
  const done = new Set();
  try {
    const b = req.body || {};
    const execId = parseInt(b.execution_id, 10);
    const kind = b.kind;
    if (!execId) return res.status(400).json({ error: 'execution_id required' });
    if (!['bmcu_dc', 'ack'].includes(kind)) return res.status(400).json({ error: 'kind must be bmcu_dc or ack' });
    if (!files.length) return res.status(400).json({ error: 'No files attached' });
    const ex = await query('SELECT id, status FROM trip_executions WHERE id=$1', [execId]);
    if (!ex.rows.length) return res.status(404).json({ error: 'Execution not found' });
    if (ex.rows[0].status === 'cancelled') return res.status(400).json({ error: 'Execution is cancelled — scans cannot be attached' });
    let tebId = null, bmcuId = null;
    if (kind === 'bmcu_dc') {
      tebId = parseInt(b.teb_id, 10);
      if (!tebId) return res.status(400).json({ error: 'teb_id required for a BMCU dispatch challan' });
      const t = await query('SELECT id, bmcu_id FROM trip_execution_bmcus WHERE id=$1 AND execution_id=$2 AND is_deleted=FALSE', [tebId, execId]);
      if (!t.rows.length) return res.status(400).json({ error: 'BMCU line not found on this trip' });
      bmcuId = t.rows[0].bmcu_id;
    }
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
        `INSERT INTO trip_scans (execution_id, kind, teb_id, bmcu_id, file_path, thumb_path, mime, bytes, sha256, original_name, uploaded_by, uploaded_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id, execution_id, kind, teb_id, bmcu_id, mime, bytes, original_name, (thumb_path IS NOT NULL) AS has_thumb, uploaded_by, uploaded_by_name, uploaded_at`,
        [execId, kind, tebId, bmcuId, stored.rel, thumbRel, stored.mime, stored.bytes, stored.sha256,
         String(f.originalname || '').slice(0, 200) || null, req.user.id, req.user.full_name || req.user.user_id || null]);
      out.push(r.rows[0]);
    }
    res.status(201).json(out);
  } catch (err) {
    res.status(err.status === 400 ? 400 : 500).json({ error: err.message });
  } finally {
    for (const x of [...files, ...thumbs]) if (!done.has(x.path)) scanStore.removeQuiet(x.path);
  }
});

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
router.get('/:id/file',  authenticate, READ, (req, res) => serve(req, res, 'file'));
router.get('/:id/thumb', authenticate, READ, (req, res) => serve(req, res, 'thumb'));

// DELETE /api/trip-scans/:id — soft delete; uploader within 24 h, otherwise admin.
router.delete('/:id', authenticate, WRITE, async (req, res) => {
  try {
    const r = await query('SELECT id, uploaded_by, uploaded_at FROM trip_scans WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Scan not found' });
    const s = r.rows[0];
    const own = s.uploaded_by === req.user.id && (Date.now() - new Date(s.uploaded_at).getTime()) < DELETE_WINDOW_MS;
    if (!own && !hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Only the uploader (within 24 hours) or an admin can delete a scan' });
    await query('UPDATE trip_scans SET deleted_at=NOW(), deleted_by=$2 WHERE id=$1', [s.id, req.user.id]);
    res.json({ ok: true, id: s.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
module.exports.SUMMARY_SQL = SUMMARY_SQL;
