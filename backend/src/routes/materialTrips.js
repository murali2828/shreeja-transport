// backend/src/routes/materialTrips.js
// Execution data of material (pasteurised milk) trips — migration 049.
// A material trip is a normal plan → execution → acknowledgement → billing
// trip whose plan has trip_kind = 'material' and no BMCU chain. This router
// owns the material-specific part of the execution: the supplier's document
// (purchased qty / fat / SNF + scan), the km keyed by the executor (Google
// reference alongside, from the start → delivery pair), and the customer's
// acknowledgement (qty / fat / SNF + scan). The acknowledgement quantities
// are written as a single FC chamber in trip_acknowledgements through
// applyExecutionData so billing, change requests and reports treat the trip
// like any other; the execution's milk totals stay 0 so TS / BMCU reports
// never count purchased milk as collection.
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { pool, query } = require('../config/db');
const { authenticate, authorizeOrModule } = require('../middleware/auth');
const { applyExecutionData, computeExecutionDistance } = require('../services/executionData');

const UPLOAD_DIR = path.join(process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads/documents'), 'material');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); }
catch (e) { console.error('[material] failed to create upload dir:', e.message); }

const MAX_MB = parseInt(process.env.MATERIAL_DOC_MAX_MB || '10', 10) || 10;
const FILTER = (req, file, cb) => {
  const ok = /\.(pdf|jpg|jpeg|png|webp)$/i.test(file.originalname || '');
  cb(ok ? null : new Error('File type not allowed — PDF or image scans only'), ok);
};
const uploader = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024 }, fileFilter: FILTER });
const docUpload = (req, res, next) => uploader.fields([{ name: 'purchase_doc', maxCount: 1 }, { name: 'ack_doc', maxCount: 1 }])(req, res, err => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File is larger than ${MAX_MB} MB — scan at lower resolution and try again` });
  return res.status(400).json({ error: err.message || 'Upload failed' });
});

const EXEC_ROLES = ['execution', 'admin', 'planner', 'executor', 'biller'];
const KG_FACTOR = 1.0285; // litres → kg, shared with Assure (ADR-006)
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000, r4 = v => Math.round(v * 10000) / 10000;
const num = v => (v === undefined || v === null || v === '' ? null : (Number.isFinite(parseFloat(v)) ? parseFloat(v) : NaN));

function storeFile(file) {
  const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.bin';
  const name = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), file.buffer);
  return name;
}

// PUT /api/material-trips/:executionId  (multipart)
// fields: material_id, supplier_doc_no, purchase_qty_litres, purchase_qty_kgs,
//         purchase_fat_pct, purchase_snf_pct, manual_km, remarks,
//         ack_qty_litres, ack_qty_kgs, ack_fat_pct, ack_snf_pct, ack_date,
//         start_point_id, delivery_point_id, close ('true' to acknowledge & close)
// files:  purchase_doc, ack_doc
router.put('/:id', authenticate, authorizeOrModule(...EXEC_ROLES), docUpload, async (req, res) => {
  const b = req.body || {};
  const f = req.files || {};
  const client = await pool.connect();
  try {
    const head = await client.query(`
      SELECT te.id, te.status, tp.id AS plan_id, tp.trip_kind, tp.material_id
      FROM trip_executions te JOIN trip_plans tp ON tp.id = te.trip_plan_id
      WHERE te.id = $1`, [req.params.id]);
    if (!head.rows.length) return res.status(404).json({ error: 'Execution not found' });
    const ex = head.rows[0];
    if (ex.trip_kind !== 'material') return res.status(400).json({ error: 'Not a material trip' });
    if (ex.status === 'closed') return res.status(400).json({ error: 'Trip is closed — use Request Changes for corrections' });
    const inRun = await client.query(
      `SELECT br.id, br.status FROM billing_run_trips brt JOIN billing_runs br ON br.id = brt.run_id WHERE brt.execution_id = $1 LIMIT 1`, [ex.id]);
    if (inRun.rows.length)
      return res.status(400).json({ error: `This trip is part of Billing Run #${inRun.rows[0].id} (${inRun.rows[0].status}) — it can't be edited directly.` });

    // Documents state kgs + kg fat + kg SNF (owner, 2026-10-06); litres and
    // percentages are accepted too and whichever is missing is derived.
    const side = (prefix) => {
      let kgs = num(b[`${prefix}_qty_kgs`]), ltrs = num(b[`${prefix}_qty_litres`]);
      let kgFat = num(b[`${prefix}_kg_fat`]), kgSnf = num(b[`${prefix}_kg_snf`]);
      let fat = num(b[`${prefix}_fat_pct`]), snf = num(b[`${prefix}_snf_pct`]);
      if (kgs == null && ltrs != null) kgs = r4(ltrs * KG_FACTOR);
      if (ltrs == null && kgs != null) ltrs = r2(kgs / KG_FACTOR);
      if (kgs) {
        if (fat == null && kgFat != null) fat = r3(kgFat / kgs * 100);
        if (snf == null && kgSnf != null) snf = r3(kgSnf / kgs * 100);
        if (kgFat == null && fat != null) kgFat = r4(kgs * fat / 100);
        if (kgSnf == null && snf != null) kgSnf = r4(kgs * snf / 100);
      }
      return { kgs, ltrs, kgFat, kgSnf, fat, snf };
    };
    const P = side('purchase'), A = side('ack');
    const pq = P.ltrs, pf = P.fat, ps = P.snf, aq = A.ltrs, af = A.fat, as = A.snf;
    const km = num(b.manual_km);
    for (const [label, v] of [['Purchased kgs', P.kgs], ['Purchased kg fat', P.kgFat], ['Purchased kg SNF', P.kgSnf], ['Km', km], ['Acknowledged kgs', A.kgs], ['Acknowledged kg fat', A.kgFat], ['Acknowledged kg SNF', A.kgSnf]])
      if (Number.isNaN(v) || (v != null && v < 0)) return res.status(400).json({ error: `${label} must be a number` });
    const close = b.close === 'true' || b.close === true;
    if (close) {
      const missing = [];
      if (!pq) missing.push('purchased quantity');
      if (!km) missing.push('km to the customer');
      if (!aq) missing.push('acknowledged quantity');
      if (!b.start_point_id) missing.push('supplier (starting point)');
      if (!b.delivery_point_id) missing.push('customer (delivery point)');
      if (missing.length) return res.status(400).json({ error: `Cannot close the trip: ${missing.join(', ')} required` });
    }

    await client.query('BEGIN');
    const prev = (await client.query('SELECT * FROM trip_material_data WHERE execution_id = $1', [ex.id])).rows[0] || {};
    const purchaseFile = f.purchase_doc?.[0] ? storeFile(f.purchase_doc[0]) : prev.purchase_doc_file || null;
    const ackFile      = f.ack_doc?.[0]      ? storeFile(f.ack_doc[0])      : prev.ack_doc_file || null;
    const pkgs = P.kgs;
    await client.query(`
      INSERT INTO trip_material_data
        (execution_id, material_id, supplier_doc_no, purchase_qty_litres, purchase_qty_kgs, purchase_fat_pct, purchase_snf_pct,
         purchase_doc_file, purchase_doc_name, manual_km, ack_doc_file, ack_doc_name, remarks, updated_by, updated_at, purchase_kg_fat, purchase_kg_snf)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15,$16)
      ON CONFLICT (execution_id) DO UPDATE SET
        material_id=$2, supplier_doc_no=$3, purchase_qty_litres=$4, purchase_qty_kgs=$5, purchase_fat_pct=$6, purchase_snf_pct=$7,
        purchase_doc_file=$8, purchase_doc_name=$9, manual_km=$10, ack_doc_file=$11, ack_doc_name=$12, remarks=$13, updated_by=$14, updated_at=NOW(),
        purchase_kg_fat=$15, purchase_kg_snf=$16`,
      [ex.id, num(b.material_id) || ex.material_id || null, (b.supplier_doc_no || '').trim() || null, pq, pkgs, pf, ps,
       purchaseFile, f.purchase_doc?.[0] ? f.purchase_doc[0].originalname : prev.purchase_doc_name || null,
       km, ackFile, f.ack_doc?.[0] ? f.ack_doc[0].originalname : prev.ack_doc_name || null,
       (b.remarks || '').trim() || null, req.user.id, P.kgFat, P.kgSnf]);
    if (num(b.material_id)) await client.query('UPDATE trip_plans SET material_id=$1 WHERE id=$2', [num(b.material_id), ex.plan_id]);

    // Acknowledgement as one FC chamber (customer's figures); km as actual_km.
    // applyExecutionData recomputes the distance chain (start → delivery) so
    // the Google reference is refreshed every save.
    const acknowledgements = aq != null
      ? [{ chamber: 'FC', ack_date: b.ack_date || null, qty_litres: aq, qty_kgs: A.kgs || null, fat_pct: af, snf_pct: as, description: 'Customer acknowledgement' }]
      : [];
    const { execution, dist } = await applyExecutionData(client, ex.id, {
      actual_km: km, start_point_id: num(b.start_point_id) || null, delivery_point_id: num(b.delivery_point_id) || null,
      acknowledgements,
    }, req.user.id, { setSavedStatus: !close });
    if (close) await client.query(`UPDATE trip_executions SET status='closed', updated_at=NOW() WHERE id=$1`, [ex.id]);
    await client.query('COMMIT');
    res.json({ ...execution, status: close ? 'closed' : execution.status, calculated_km: dist.total_km, legs: dist.legs,
               google_km: dist.legs.reduce((s, l) => s + (l.google_km || 0), 0) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(err.code === 400 ? 400 : 500).json({ error: err.message });
  } finally { client.release(); }
});

// GET /api/material-trips/:executionId/doc/:which   (purchase | ack)
router.get('/:id/doc/:which', authenticate, async (req, res) => {
  try {
    const which = req.params.which === 'ack' ? 'ack' : 'purchase';
    const r = await query(`SELECT ${which}_doc_file AS file, ${which}_doc_name AS name FROM trip_material_data WHERE execution_id=$1`, [req.params.id]);
    if (!r.rows.length || !r.rows[0].file) return res.status(404).json({ error: 'No document uploaded' });
    const full = path.join(UPLOAD_DIR, path.basename(r.rows[0].file));
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'File missing on disk' });
    const ext = path.extname(full).toLowerCase();
    const mime = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
    const safeName = String(r.rows[0].name || `document${ext}`).replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `${mime === 'application/octet-stream' ? 'attachment' : 'inline'}; filename="${safeName}"`);
    fs.createReadStream(full).pipe(res);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/material-trips/:executionId/distance — Google / master reference
// for the start → customer pair without saving anything.
router.get('/:id/distance', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dist = await computeExecutionDistance(client, req.params.id, req.user.id);
    await client.query('COMMIT'); // caches Google results into distance_master
    res.json({ system_km: dist.total_km, google_km: Math.round(dist.legs.reduce((s, l) => s + (l.google_km || 0), 0) * 100) / 100, legs: dist.legs, incomplete: dist.incomplete });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

module.exports = router;
