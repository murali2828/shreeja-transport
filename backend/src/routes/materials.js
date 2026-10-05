// backend/src/routes/materials.js
// Material master for material (pasteurised milk) trips — migration 049.
// The SAP material code is the key finance uses; the portal only mirrors it.
const express = require('express');
const router  = express.Router();
const { query } = require('../config/db');
const { authenticate, authorizeOrModule } = require('../middleware/auth');

// GET /api/materials?all=true
router.get('/', authenticate, async (req, res) => {
  try {
    const includeAll = req.query.all === 'true';
    const r = await query(`
      SELECT m.*,
        (SELECT COUNT(*) FROM trip_plans tp WHERE tp.material_id = m.id) AS trip_count
      FROM materials m
      ${includeAll ? '' : 'WHERE m.is_active = TRUE'}
      ORDER BY m.name`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/materials
router.post('/', authenticate, authorizeOrModule('masters', 'admin'), async (req, res) => {
  const { sap_code, name, unit } = req.body;
  if (!sap_code || !name) return res.status(400).json({ error: 'sap_code and name required' });
  try {
    const r = await query(
      `INSERT INTO materials (sap_code, name, unit) VALUES ($1,$2,$3) RETURNING *`,
      [String(sap_code).trim(), String(name).trim(), (unit || 'Ltrs').trim()]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'SAP material code already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/materials/:id
router.put('/:id', authenticate, authorizeOrModule('masters', 'admin'), async (req, res) => {
  const { sap_code, name, unit, is_active } = req.body;
  if (!sap_code || !name) return res.status(400).json({ error: 'sap_code and name required' });
  try {
    const r = await query(
      `UPDATE materials SET sap_code=$1, name=$2, unit=$3, is_active=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [String(sap_code).trim(), String(name).trim(), (unit || 'Ltrs').trim(), is_active ?? true, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'SAP material code already exists' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
