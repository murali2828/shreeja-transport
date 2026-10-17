// backend/src/routes/vendors.js
// Vendor master for tanker onboarding. Tables are created by documents.js.
const express = require('express');
const router  = express.Router();
const { query } = require('../config/db');
const { authenticate, authorizeOrModule } = require('../middleware/auth');

// Additional email ids (migration 076): trimmed, de-duplicated, valid only.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function cleanExtra(list, primary) {
  if (!Array.isArray(list)) return { emails: [] };
  const out = [];
  for (const raw of list) {
    const e = String(raw || '').trim();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) return { error: `Invalid email id: ${e}` };
    if (e.toLowerCase() !== String(primary || '').trim().toLowerCase() && !out.some(x => x.toLowerCase() === e.toLowerCase())) out.push(e);
  }
  return { emails: out.slice(0, 10) };
}

// GET /api/vendors?all=true
router.get('/', authenticate, authorizeOrModule('masters', 'admin', 'planner', 'biller'), async (req, res) => {
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
router.post('/', authenticate, authorizeOrModule('masters', 'admin'), async (req, res) => {
  const { vendor_code, vendor_name, contact_person, phone, email, gst_number, pan_number, address } = req.body;
  if (!vendor_code || !vendor_name) return res.status(400).json({ error: 'vendor_code and vendor_name required' });
  const extra = cleanExtra(req.body.extra_emails, email);
  if (extra.error) return res.status(400).json({ error: extra.error });
  try {
    const r = await query(
      `INSERT INTO vendors (vendor_code, vendor_name, contact_person, phone, email, gst_number, pan_number, address, extra_emails)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [vendor_code, vendor_name, contact_person||null, phone||null, email||null, gst_number||null, pan_number||null, address||null, extra.emails]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Vendor code already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/vendors/:id
router.put('/:id', authenticate, authorizeOrModule('masters', 'admin'), async (req, res) => {
  const { vendor_name, contact_person, phone, email, gst_number, pan_number, address, is_active } = req.body;
  const extra = cleanExtra(req.body.extra_emails, email);
  if (extra.error) return res.status(400).json({ error: extra.error });
  try {
    const r = await query(
      `UPDATE vendors SET
         vendor_name=$1, contact_person=$2, phone=$3, email=$4,
         gst_number=$5, pan_number=$6, address=$7, is_active=$8, extra_emails=$10, updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [vendor_name, contact_person||null, phone||null, email||null,
       gst_number||null, pan_number||null, address||null, is_active ?? true, req.params.id, extra.emails]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
