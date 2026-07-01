// backend/src/routes/documents.js
// Tanker statutory documents + expiry-alert recipient config.
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { runAlertCheck } = require('../jobs/docAlerts');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const DOC_TYPES = ['RC', 'Fitness Certificate', 'Pollution (PUC)', 'Insurance', 'Permit', 'Agreement', 'Other'];

// ─── Schema (runs once at startup) ────────────────────────────────────────────
(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS vendors (
        id             SERIAL PRIMARY KEY,
        vendor_code    TEXT UNIQUE NOT NULL,
        vendor_name    TEXT NOT NULL,
        contact_person TEXT,
        phone          TEXT,
        email          TEXT,
        gst_number     TEXT,
        pan_number     TEXT,
        address        TEXT,
        is_active      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`ALTER TABLE tankers ADD COLUMN IF NOT EXISTS vendor_id INTEGER REFERENCES vendors(id)`);
    await query(`
      CREATE TABLE IF NOT EXISTS tanker_documents (
        id          SERIAL PRIMARY KEY,
        tanker_id   INTEGER NOT NULL REFERENCES tankers(id) ON DELETE CASCADE,
        doc_type    TEXT NOT NULL,
        doc_name    TEXT,              -- custom label when doc_type = 'Other'
        doc_number  TEXT,
        issue_date  DATE,             -- for Agreement: start date
        expiry_date DATE,             -- for Agreement: end date
        remarks     TEXT,
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS tanker_documents_tanker_idx ON tanker_documents (tanker_id)`);
    await query(`CREATE INDEX IF NOT EXISTS tanker_documents_expiry_idx ON tanker_documents (expiry_date)`);
    // Attached scan/file (stored in DB so it survives ephemeral containers).
    await query(`ALTER TABLE tanker_documents ADD COLUMN IF NOT EXISTS file_data BYTEA`);
    await query(`ALTER TABLE tanker_documents ADD COLUMN IF NOT EXISTS file_name TEXT`);
    await query(`ALTER TABLE tanker_documents ADD COLUMN IF NOT EXISTS file_mime TEXT`);
    await query(`ALTER TABLE tanker_documents ADD COLUMN IF NOT EXISTS file_size INTEGER`);
    await query(`
      CREATE TABLE IF NOT EXISTS document_alert_recipients (
        id         SERIAL PRIMARY KEY,
        name       TEXT,
        email      TEXT NOT NULL,
        is_active  BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS document_alert_log (
        id             SERIAL PRIMARY KEY,
        document_id    INTEGER NOT NULL REFERENCES tanker_documents(id) ON DELETE CASCADE,
        threshold_days INTEGER NOT NULL,
        sent_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (document_id, threshold_days)
      )
    `);
  } catch (err) {
    console.error('Migration error (documents):', err.message);
  }
})();

// Compute a human status from an expiry date.
function statusOf(expiry) {
  if (!expiry) return 'no_expiry';
  const days = Math.floor((new Date(expiry) - new Date(new Date().toISOString().slice(0,10))) / 86400000);
  if (days < 0)  return 'expired';
  if (days <= 30) return 'expiring';
  return 'valid';
}

// ─── Documents ────────────────────────────────────────────────────────────────
// GET /api/documents?tanker_id=&doc_type=&status=&vendor_id=&q=
router.get('/', authenticate, async (req, res) => {
  try {
    const { tanker_id, doc_type, vendor_id, q } = req.query;
    const params = [];
    let sql = `
      SELECT d.id, d.tanker_id, d.doc_type, d.doc_name, d.doc_number,
             d.issue_date, d.expiry_date, d.remarks, d.is_active,
             d.created_at, d.updated_at,
             (d.file_name IS NOT NULL) AS has_file, d.file_name, d.file_mime, d.file_size,
             t.tanker_number, t.vendor_id, v.vendor_name,
             (d.expiry_date - CURRENT_DATE) AS days_left
      FROM tanker_documents d
      JOIN tankers t ON t.id = d.tanker_id
      LEFT JOIN vendors v ON v.id = t.vendor_id
      WHERE d.is_active = TRUE`;
    if (tanker_id) { params.push(tanker_id); sql += ` AND d.tanker_id=$${params.length}`; }
    if (doc_type)  { params.push(doc_type);  sql += ` AND d.doc_type=$${params.length}`; }
    if (vendor_id) { params.push(vendor_id); sql += ` AND t.vendor_id=$${params.length}`; }
    if (q)         { params.push(`%${q}%`);  sql += ` AND (t.tanker_number ILIKE $${params.length} OR d.doc_number ILIKE $${params.length})`; }
    sql += ' ORDER BY d.expiry_date NULLS LAST, t.tanker_number';
    const r = await query(sql, params);
    const rows = r.rows.map(d => ({ ...d, status: statusOf(d.expiry_date) }));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/documents/expiring?within=30
router.get('/expiring', authenticate, async (req, res) => {
  try {
    const within = parseInt(req.query.within || '30', 10);
    const r = await query(`
      SELECT d.*, t.tanker_number, v.vendor_name,
             (d.expiry_date - CURRENT_DATE) AS days_left
      FROM tanker_documents d
      JOIN tankers t ON t.id = d.tanker_id
      LEFT JOIN vendors v ON v.id = t.vendor_id
      WHERE d.is_active = TRUE AND t.is_active = TRUE AND d.expiry_date IS NOT NULL
        AND (d.expiry_date - CURRENT_DATE) <= $1
      ORDER BY d.expiry_date`, [within]);
    res.json(r.rows.map(d => ({ ...d, status: statusOf(d.expiry_date) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/documents
router.post('/', authenticate, authorize('admin','planner'), async (req, res) => {
  const { tanker_id, doc_type, doc_name, doc_number, issue_date, expiry_date, remarks } = req.body;
  if (!tanker_id || !doc_type) return res.status(400).json({ error: 'tanker_id and doc_type required' });
  if (!DOC_TYPES.includes(doc_type)) return res.status(400).json({ error: 'Invalid doc_type' });
  try {
    const r = await query(
      `INSERT INTO tanker_documents (tanker_id, doc_type, doc_name, doc_number, issue_date, expiry_date, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, tanker_id, doc_type, doc_name, doc_number, issue_date, expiry_date, remarks, is_active`,
      [tanker_id, doc_type, doc_name||null, doc_number||null, issue_date||null, expiry_date||null, remarks||null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/documents/:id
router.put('/:id', authenticate, authorize('admin','planner'), async (req, res) => {
  const { doc_type, doc_name, doc_number, issue_date, expiry_date, remarks } = req.body;
  if (doc_type && !DOC_TYPES.includes(doc_type)) return res.status(400).json({ error: 'Invalid doc_type' });
  try {
    const r = await query(
      `UPDATE tanker_documents SET
         doc_type=COALESCE($1,doc_type), doc_name=$2, doc_number=$3,
         issue_date=$4, expiry_date=$5, remarks=$6, updated_at=NOW()
       WHERE id=$7
       RETURNING id, tanker_id, doc_type, doc_name, doc_number, issue_date, expiry_date, remarks, is_active`,
      [doc_type||null, doc_name||null, doc_number||null, issue_date||null, expiry_date||null, remarks||null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    // Reset alert log so future thresholds re-evaluate against the new expiry date.
    await query('DELETE FROM document_alert_log WHERE document_id=$1', [req.params.id]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/documents/:id  (soft delete)
router.delete('/:id', authenticate, authorize('admin','planner'), async (req, res) => {
  try {
    const r = await query('UPDATE tanker_documents SET is_active=FALSE WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── File attachment (stored in DB) ───────────────────────────────────────────
// POST /api/documents/:id/file  — upload/replace the scanned document
router.post('/:id/file', authenticate, authorize('admin','planner'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const r = await query(
      `UPDATE tanker_documents SET file_data=$1, file_name=$2, file_mime=$3, file_size=$4, updated_at=NOW()
       WHERE id=$5 AND is_active=TRUE
       RETURNING id, (file_name IS NOT NULL) AS has_file, file_name, file_mime, file_size`,
      [req.file.buffer, req.file.originalname, req.file.mimetype, req.file.size, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Document not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/documents/:id/file  — download the scanned document
router.get('/:id/file', authenticate, async (req, res) => {
  try {
    const r = await query(
      'SELECT file_data, file_name, file_mime FROM tanker_documents WHERE id=$1', [req.params.id]
    );
    if (!r.rows.length || !r.rows[0].file_data) return res.status(404).json({ error: 'No file' });
    const { file_data, file_name, file_mime } = r.rows[0];
    res.setHeader('Content-Type', file_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(file_name || 'document').replace(/"/g, '')}"`);
    res.send(file_data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/documents/:id/file  — remove the attachment only
router.delete('/:id/file', authenticate, authorize('admin','planner'), async (req, res) => {
  try {
    await query(
      'UPDATE tanker_documents SET file_data=NULL, file_name=NULL, file_mime=NULL, file_size=NULL, updated_at=NOW() WHERE id=$1',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Alert recipients ─────────────────────────────────────────────────────────
router.get('/alerts/recipients', authenticate, authorize('admin'), async (_req, res) => {
  try {
    const r = await query('SELECT * FROM document_alert_recipients ORDER BY name NULLS LAST, email');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/alerts/recipients', authenticate, authorize('admin'), async (req, res) => {
  const { name, email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const r = await query(
      'INSERT INTO document_alert_recipients (name, email) VALUES ($1,$2) RETURNING *',
      [name||null, email]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/alerts/recipients/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await query('DELETE FROM document_alert_recipients WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/documents/alerts/run  — manual trigger (admin)
router.post('/alerts/run', authenticate, authorize('admin'), async (req, res) => {
  try {
    const result = await runAlertCheck({ force: req.body?.force === true });
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
