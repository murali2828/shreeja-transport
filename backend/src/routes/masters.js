// backend/src/routes/masters.js
const express = require('express');
const router  = express.Router();
const { pool, query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// ─── Tankers ──────────────────────────────────────────────────────────────────
router.get('/tankers', authenticate, async (req, res) => {
  try {
    const includeAll = req.query.all === 'true';
    const r = await query(
      `SELECT t.id, t.tanker_number, t.compartments, t.capacity_litres, t.per_km_rate,
              t.vendor_code, t.vendor_name, t.rate_per_km_bmcu, t.rate_per_km_p2p,
              t.vendor_id, v.vendor_name AS vendor_master_name,
              t.induction_type, t.validity_start, t.validity_end,
              EXISTS (SELECT 1 FROM non_trip_gate_passes g
                WHERE g.tanker_id=t.id AND g.reason='Maintainance'
                  AND g.returned_at IS NULL) AS in_maintenance,
              t.is_active, t.created_at, t.updated_at
       FROM tankers t
       LEFT JOIN vendors v ON v.id = t.vendor_id
       ${includeAll ? '' : 'WHERE t.is_active=TRUE '}ORDER BY t.tanker_number`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/tankers', authenticate, authorize('admin'), async (req, res) => {
  const { tanker_number, compartments, capacity_litres, per_km_rate,
          vendor_code, vendor_name, rate_per_km_bmcu, rate_per_km_p2p, vendor_id,
          induction_type, validity_start, validity_end } = req.body;
  if (!tanker_number || !capacity_litres)
    return res.status(400).json({ error: 'tanker_number and capacity_litres required' });
  if (induction_type && (!validity_start || !validity_end))
    return res.status(400).json({ error: 'Validity start and end dates are required for the selected induction type' });
  try {
    const r = await query(
      `INSERT INTO tankers (tanker_number,compartments,capacity_litres,per_km_rate,
                            vendor_code,vendor_name,rate_per_km_bmcu,rate_per_km_p2p,vendor_id,
                            induction_type,validity_start,validity_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [tanker_number.trim().toUpperCase(), compartments||null, capacity_litres, per_km_rate||0,
       vendor_code||null, vendor_name||null, rate_per_km_bmcu||null, rate_per_km_p2p||null, vendor_id||null,
       induction_type||null, validity_start||null, validity_end||null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Tanker number already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/tankers/:id', authenticate, authorize('admin'), async (req, res) => {
  const { tanker_number, compartments, capacity_litres, per_km_rate, is_active,
          vendor_code, vendor_name, rate_per_km_bmcu, rate_per_km_p2p, vendor_id,
          induction_type, validity_start, validity_end } = req.body;
  if (induction_type && (!validity_start || !validity_end))
    return res.status(400).json({ error: 'Validity start and end dates are required for the selected induction type' });
  try {
    const r = await query(
      `UPDATE tankers SET tanker_number=$1,compartments=$2,capacity_litres=$3,
        per_km_rate=$4,is_active=$5,vendor_code=$6,vendor_name=$7,
        rate_per_km_bmcu=$8,rate_per_km_p2p=$9,vendor_id=$10,
        induction_type=$11,validity_start=$12,validity_end=$13,updated_at=NOW() WHERE id=$14 RETURNING *`,
      [tanker_number?.trim().toUpperCase(), compartments||null, capacity_litres,
       per_km_rate||0, is_active ?? true, vendor_code||null, vendor_name||null,
       rate_per_km_bmcu||null, rate_per_km_p2p||null, vendor_id||null,
       induction_type||null, validity_start||null, validity_end||null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/tankers/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await query('UPDATE tankers SET is_active=FALSE,updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── BMCUs ────────────────────────────────────────────────────────────────────
router.get('/bmcus', authenticate, async (req, res) => {
  try {
    const includeAll = req.query.all === 'true';
    const r = await query(
      `SELECT id, bmcu_code, bmcu_name, address, district, state, contact,
              latitude, longitude, is_active, created_at, updated_at
       FROM bmcus ${includeAll ? '' : 'WHERE is_active=TRUE '}ORDER BY bmcu_code`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/bmcus', authenticate, authorize('admin'), async (req, res) => {
  const { bmcu_code, bmcu_name, address, district, state, contact, latitude, longitude } = req.body;
  if (!bmcu_code || !bmcu_name) return res.status(400).json({ error: 'bmcu_code and bmcu_name required' });
  try {
    const r = await query(
      `INSERT INTO bmcus (bmcu_code,bmcu_name,address,district,state,contact,latitude,longitude)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [bmcu_code.trim(), bmcu_name.trim(), address||null, district||null, state||null,
       contact||null, latitude||null, longitude||null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'BMCU code already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/bmcus/:id', authenticate, authorize('admin'), async (req, res) => {
  const { bmcu_name, address, district, state, contact, is_active, latitude, longitude } = req.body;
  try {
    const r = await query(
      `UPDATE bmcus SET bmcu_name=$1,address=$2,district=$3,state=$4,contact=$5,
        is_active=$6,latitude=$7,longitude=$8,updated_at=NOW() WHERE id=$9 RETURNING *`,
      [bmcu_name, address||null, district||null, state||null, contact||null,
       is_active ?? true, latitude||null, longitude||null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/bmcus/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await query('UPDATE bmcus SET is_active=FALSE,updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Starting Points ──────────────────────────────────────────────────────────
router.get('/starting-points', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT * FROM starting_points WHERE is_active=TRUE ORDER BY name');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/starting-points', authenticate, authorize('admin'), async (req, res) => {
  const { name, location, description, latitude, longitude } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const r = await query(
      'INSERT INTO starting_points (name,location,description,latitude,longitude) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name.trim(), location||null, description||null, latitude||null, longitude||null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.put('/starting-points/:id', authenticate, authorize('admin'), async (req, res) => {
  const { name, location, description, is_active, latitude, longitude } = req.body;
  try {
    const r = await query(
      'UPDATE starting_points SET name=$1,location=$2,description=$3,is_active=$4,latitude=$5,longitude=$6 WHERE id=$7 RETURNING *',
      [name, location||null, description||null, is_active ?? true, latitude||null, longitude||null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete('/starting-points/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await query('UPDATE starting_points SET is_active=FALSE WHERE id=$1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Testing Points ───────────────────────────────────────────────────────────
router.get('/testing-points', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT * FROM testing_points WHERE is_active=TRUE ORDER BY name');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/testing-points', authenticate, authorize('admin'), async (req, res) => {
  const { name, location, latitude, longitude } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const r = await query(
      'INSERT INTO testing_points (name,location,latitude,longitude) VALUES ($1,$2,$3,$4) RETURNING *',
      [name.trim(), location||null, latitude||null, longitude||null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.put('/testing-points/:id', authenticate, authorize('admin'), async (req, res) => {
  const { name, location, is_active, latitude, longitude } = req.body;
  try {
    const r = await query(
      'UPDATE testing_points SET name=$1,location=$2,is_active=$3,latitude=$4,longitude=$5 WHERE id=$6 RETURNING *',
      [name, location||null, is_active ?? true, latitude||null, longitude||null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete('/testing-points/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await query('UPDATE testing_points SET is_active=FALSE WHERE id=$1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Delivery Points ──────────────────────────────────────────────────────────
router.get('/delivery-points', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT * FROM delivery_points WHERE is_active=TRUE ORDER BY name');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/delivery-points', authenticate, authorize('admin'), async (req, res) => {
  const { name, receiver_name, location, latitude, longitude } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const r = await query(
      'INSERT INTO delivery_points (name,receiver_name,location,latitude,longitude) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name.trim(), receiver_name||null, location||null, latitude||null, longitude||null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.put('/delivery-points/:id', authenticate, authorize('admin'), async (req, res) => {
  const { name, receiver_name, location, is_active, latitude, longitude } = req.body;
  try {
    const r = await query(
      'UPDATE delivery_points SET name=$1,receiver_name=$2,location=$3,is_active=$4,latitude=$5,longitude=$6 WHERE id=$7 RETURNING *',
      [name, receiver_name||null, location||null, is_active ?? true, latitude||null, longitude||null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete('/delivery-points/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await query('UPDATE delivery_points SET is_active=FALSE WHERE id=$1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Routes ───────────────────────────────────────────────────────────────────
router.get('/routes', authenticate, async (req, res) => {
  try {
    const includeAll = req.query.all === 'true';
    const r = await query(`
      SELECT rm.*,
        sp.name AS start_point_name, tp.name AS testing_point_name, dp.name AS delivery_point_name,
        (SELECT COUNT(*) FROM route_bmcus rb WHERE rb.route_id=rm.id) AS bmcu_count
      FROM route_masters rm
      LEFT JOIN starting_points sp ON sp.id=rm.start_point_id
      LEFT JOIN testing_points  tp ON tp.id=rm.testing_point_id
      LEFT JOIN delivery_points dp ON dp.id=rm.delivery_point_id
      ${includeAll ? '' : 'WHERE rm.is_active=TRUE '}ORDER BY rm.route_name`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/routes/:id', authenticate, async (req, res) => {
  try {
    const route = await query(`
      SELECT rm.*,
        sp.name AS start_point_name, tp.name AS testing_point_name, dp.name AS delivery_point_name
      FROM route_masters rm
      LEFT JOIN starting_points sp ON sp.id=rm.start_point_id
      LEFT JOIN testing_points  tp ON tp.id=rm.testing_point_id
      LEFT JOIN delivery_points dp ON dp.id=rm.delivery_point_id
      WHERE rm.id=$1`, [req.params.id]
    );
    if (!route.rows.length) return res.status(404).json({ error: 'Not found' });
    const bmcus = await query(`
      SELECT rb.seq_no, rb.bmcu_id, b.bmcu_code, b.bmcu_name
      FROM route_bmcus rb JOIN bmcus b ON b.id=rb.bmcu_id
      WHERE rb.route_id=$1 ORDER BY rb.seq_no`, [req.params.id]
    );
    res.json({ ...route.rows[0], bmcus: bmcus.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/routes', authenticate, authorize('admin'), async (req, res) => {
  const { route_name, route_no, start_point_id, testing_point_id, delivery_point_id, distance_km, bmcus } = req.body;
  if (!route_name) return res.status(400).json({ error: 'route_name required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO route_masters (route_name,route_no,start_point_id,testing_point_id,delivery_point_id,distance_km)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [route_name.trim(), route_no||null, start_point_id||null, testing_point_id||null, delivery_point_id||null, distance_km||null]
    );
    const routeId = r.rows[0].id;
    if (bmcus?.length) {
      for (const bm of bmcus) {
        await client.query(
          'INSERT INTO route_bmcus (route_id,seq_no,bmcu_id) VALUES ($1,$2,$3)',
          [routeId, bm.seq_no, bm.bmcu_id]
        );
      }
    }
    await client.query('COMMIT');
    res.status(201).json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

router.put('/routes/:id', authenticate, authorize('admin'), async (req, res) => {
  const { route_name, route_no, start_point_id, testing_point_id, delivery_point_id, distance_km, is_active, bmcus } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE route_masters SET route_name=$1,route_no=$2,start_point_id=$3,testing_point_id=$4,
        delivery_point_id=$5,distance_km=$6,is_active=$7,updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [route_name, route_no||null, start_point_id||null, testing_point_id||null, delivery_point_id||null,
       distance_km||null, is_active ?? true, req.params.id]
    );
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    if (bmcus !== undefined) {
      await client.query('DELETE FROM route_bmcus WHERE route_id=$1', [req.params.id]);
      for (const bm of bmcus) {
        await client.query(
          'INSERT INTO route_bmcus (route_id,seq_no,bmcu_id) VALUES ($1,$2,$3)',
          [req.params.id, bm.seq_no, bm.bmcu_id]
        );
      }
    }
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── Email Config ─────────────────────────────────────────────────────────────
router.get('/email-config', authenticate, authorize('admin'), async (req, res) => {
  try {
    const r = await query('SELECT * FROM report_email_config ORDER BY full_name');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/email-config', authenticate, authorize('admin'), async (req, res) => {
  const { full_name, email } = req.body;
  if (!full_name || !email) return res.status(400).json({ error: 'full_name and email required' });
  try {
    const r = await query(
      'INSERT INTO report_email_config (full_name,email) VALUES ($1,$2) RETURNING *',
      [full_name.trim(), email.trim().toLowerCase()]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: err.message });
  }
});
router.put('/email-config/:id', authenticate, authorize('admin'), async (req, res) => {
  const { full_name, email, is_active } = req.body;
  try {
    const r = await query(
      'UPDATE report_email_config SET full_name=$1,email=$2,is_active=$3 WHERE id=$4 RETURNING *',
      [full_name, email?.trim().toLowerCase(), is_active ?? true, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete('/email-config/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await query('DELETE FROM report_email_config WHERE id=$1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
