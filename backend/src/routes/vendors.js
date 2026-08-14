// backend/src/routes/vendors.js
// Vendor master for tanker onboarding. Tables are created by documents.js.
const express = require('express');
const router  = express.Router();
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/vendors?all=true
router.get('/', authenticate, async (req, res) => {
  try {
    const includeAll = req.query.all === 'true';
    const r = await query(`
      SELECT v.*,
        (SELECT COUNT(*) FROM tankers t WHERE t.vendor_id = v.id) AS tanker_count
      FROM vendors v
      ${includeAll ? '' : 'WHERE v.is_active = TRUE'}
      ORDER BY v.vendor_name`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/vendors
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  const { vendor_code, vendor_name, contact_person, phone, email, gst_number, pan_number, address } = req.body;
  if (!vendor_code || !vendor_name) return res.status(400).json({ error: 'vendor_code and vendor_name required' });
  try {
    const r = await query(
      `INSERT INTO vendors (vendor_code, vendor_name, contact_person, phone, email, gst_number, pan_number, address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [vendor_code, vendor_name, contact_person||null, phone||null, email||null, gst_number||null, pan_number||null, address||null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Vendor code already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/vendors/:id
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  const { vendor_name, contact_person, phone, email, gst_number, pan_number, address, is_active } = req.body;
  try {
    const r = await query(
      `UPDATE vendors SET
         vendor_name=$1, contact_person=$2, phone=$3, email=$4,
         gst_number=$5, pan_number=$6, address=$7, is_active=$8, updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [vendor_name, contact_person||null, phone||null, email||null,
       gst_number||null, pan_number||null, address||null, is_active ?? true, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
