const router = require('express').Router();
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// ─── TANKERS ────────────────────────────────────────────
router.get('/tankers', authenticate, async (req, res) => {
  const result = await query('SELECT * FROM tankers ORDER BY tanker_number');
  res.json(result.rows);
});

router.post('/tankers', authenticate, authorize('admin', 'planner'), async (req, res) => {
  const { tanker_number, compartments, capacity_litres, per_km_rate } = req.body;
  try {
    const r = await query(
      'INSERT INTO tankers(tanker_number,compartments,capacity_litres,per_km_rate) VALUES($1,$2,$3,$4) RETURNING *',
      [tanker_number.trim().toUpperCase(), compartments, capacity_litres, per_km_rate || 0]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/tankers/:id', authenticate, authorize('admin', 'planner'), async (req, res) => {
  const { tanker_number, compartments, capacity_litres, per_km_rate, is_active } = req.body;
  try {
    const r = await query(
      'UPDATE tankers SET tanker_number=$1,compartments=$2,capacity_litres=$3,per_km_rate=$4,is_active=$5,updated_at=NOW() WHERE id=$6 RETURNING *',
      [tanker_number.trim().toUpperCase(), compartments, capacity_litres, per_km_rate, is_active, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/tankers/:id', authenticate, authorize('admin'), async (req, res) => {
  await query('UPDATE tankers SET is_active=FALSE WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ─── BMCUs ────────────────────────────────────────────
router.get('/bmcus', authenticate, async (req, res) => {
  const result = await query('SELECT * FROM bmcus ORDER BY bmcu_code');
  res.json(result.rows);
});

router.post('/bmcus', authenticate, authorize('admin', 'planner'), async (req, res) => {
  const { bmcu_code, bmcu_name, address, district, state, contact } = req.body;
  try {
    const r = await query(
      'INSERT INTO bmcus(bmcu_code,bmcu_name,address,district,state,contact) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [bmcu_code, bmcu_name, address, district, state, contact]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/bmcus/:id', authenticate, authorize('admin', 'planner'), async (req, res) => {
  const { bmcu_code, bmcu_name, address, district, state, contact, is_active } = req.body;
  try {
    const r = await query(
      'UPDATE bmcus SET bmcu_code=$1,bmcu_name=$2,address=$3,district=$4,state=$5,contact=$6,is_active=$7,updated_at=NOW() WHERE id=$8 RETURNING *',
      [bmcu_code, bmcu_name, address, district, state, contact, is_active, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/bmcus/:id', authenticate, authorize('admin'), async (req, res) => {
  await query('UPDATE bmcus SET is_active=FALSE WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ─── STARTING POINTS ─────────────────────────────────
router.get('/starting-points', authenticate, async (req, res) => {
  const r = await query('SELECT * FROM starting_points WHERE is_active=TRUE ORDER BY name');
  res.json(r.rows);
});
router.post('/starting-points', authenticate, authorize('admin','planner'), async (req, res) => {
  const { name, location, description } = req.body;
  const r = await query('INSERT INTO starting_points(name,location,description) VALUES($1,$2,$3) RETURNING *', [name,location,description]);
  res.status(201).json(r.rows[0]);
});
router.put('/starting-points/:id', authenticate, authorize('admin','planner'), async (req, res) => {
  const { name, location, description, is_active } = req.body;
  const r = await query('UPDATE starting_points SET name=$1,location=$2,description=$3,is_active=$4 WHERE id=$5 RETURNING *',[name,location,description,is_active,req.params.id]);
  res.json(r.rows[0]);
});
router.delete('/starting-points/:id', authenticate, authorize('admin'), async (req, res) => {
  await query('UPDATE starting_points SET is_active=FALSE WHERE id=$1',[req.params.id]);
  res.json({success:true});
});

// ─── TESTING POINTS ───────────────────────────────────
router.get('/testing-points', authenticate, async (req, res) => {
  const r = await query('SELECT * FROM testing_points WHERE is_active=TRUE ORDER BY name');
  res.json(r.rows);
});
router.post('/testing-points', authenticate, authorize('admin','planner'), async (req, res) => {
  const { name, location } = req.body;
  const r = await query('INSERT INTO testing_points(name,location) VALUES($1,$2) RETURNING *',[name,location]);
  res.status(201).json(r.rows[0]);
});
router.put('/testing-points/:id', authenticate, authorize('admin','planner'), async (req, res) => {
  const { name, location, is_active } = req.body;
  const r = await query('UPDATE testing_points SET name=$1,location=$2,is_active=$3 WHERE id=$4 RETURNING *',[name,location,is_active,req.params.id]);
  res.json(r.rows[0]);
});
router.delete('/testing-points/:id', authenticate, authorize('admin'), async (req, res) => {
  await query('UPDATE testing_points SET is_active=FALSE WHERE id=$1',[req.params.id]);
  res.json({success:true});
});

// ─── DELIVERY POINTS ─────────────────────────────────
router.get('/delivery-points', authenticate, async (req, res) => {
  const r = await query('SELECT * FROM delivery_points WHERE is_active=TRUE ORDER BY name');
  res.json(r.rows);
});
router.post('/delivery-points', authenticate, authorize('admin','planner'), async (req, res) => {
  const { name, receiver_name, location } = req.body;
  const r = await query('INSERT INTO delivery_points(name,receiver_name,location) VALUES($1,$2,$3) RETURNING *',[name,receiver_name,location]);
  res.status(201).json(r.rows[0]);
});
router.put('/delivery-points/:id', authenticate, authorize('admin','planner'), async (req, res) => {
  const { name, receiver_name, location, is_active } = req.body;
  const r = await query('UPDATE delivery_points SET name=$1,receiver_name=$2,location=$3,is_active=$4 WHERE id=$5 RETURNING *',[name,receiver_name,location,is_active,req.params.id]);
  res.json(r.rows[0]);
});
router.delete('/delivery-points/:id', authenticate, authorize('admin'), async (req, res) => {
  await query('UPDATE delivery_points SET is_active=FALSE WHERE id=$1',[req.params.id]);
  res.json({success:true});
});

// ─── ROUTE MASTERS ────────────────────────────────────
router.get('/routes', authenticate, async (req, res) => {
  const r = await query(`
    SELECT rm.*,
      sp.name AS start_point_name,
      tp.name AS testing_point_name,
      dp.name AS delivery_point_name
    FROM route_masters rm
    LEFT JOIN starting_points sp ON rm.start_point_id=sp.id
    LEFT JOIN testing_points tp ON rm.testing_point_id=tp.id
    LEFT JOIN delivery_points dp ON rm.delivery_point_id=dp.id
    ORDER BY rm.route_name
  `);
  res.json(r.rows);
});

router.get('/routes/:id', authenticate, async (req, res) => {
  const rm = await query(`
    SELECT rm.*,sp.name AS start_point_name,tp.name AS testing_point_name,dp.name AS delivery_point_name
    FROM route_masters rm
    LEFT JOIN starting_points sp ON rm.start_point_id=sp.id
    LEFT JOIN testing_points tp ON rm.testing_point_id=tp.id
    LEFT JOIN delivery_points dp ON rm.delivery_point_id=dp.id
    WHERE rm.id=$1`,[req.params.id]);
  const bmcus = await query(`
    SELECT rb.*,b.bmcu_code,b.bmcu_name FROM route_bmcus rb
    JOIN bmcus b ON rb.bmcu_id=b.id
    WHERE rb.route_id=$1 ORDER BY rb.seq_no`,[req.params.id]);
  res.json({ ...rm.rows[0], bmcus: bmcus.rows });
});

router.post('/routes', authenticate, authorize('admin','planner'), async (req, res) => {
  const { route_name, start_point_id, testing_point_id, delivery_point_id, distance_km, bmcus } = req.body;
  const client = await require('../config/db').pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      'INSERT INTO route_masters(route_name,start_point_id,testing_point_id,delivery_point_id,distance_km) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [route_name,start_point_id,testing_point_id,delivery_point_id,distance_km]
    );
    const routeId = r.rows[0].id;
    for (const b of (bmcus || [])) {
      await client.query('INSERT INTO route_bmcus(route_id,seq_no,bmcu_id) VALUES($1,$2,$3)',[routeId,b.seq_no,b.bmcu_id]);
    }
    await client.query('COMMIT');
    res.status(201).json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally { client.release(); }
});

router.put('/routes/:id', authenticate, authorize('admin','planner'), async (req, res) => {
  const { route_name, start_point_id, testing_point_id, delivery_point_id, distance_km, is_active, bmcus } = req.body;
  const client = await require('../config/db').pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE route_masters SET route_name=$1,start_point_id=$2,testing_point_id=$3,delivery_point_id=$4,distance_km=$5,is_active=$6,updated_at=NOW() WHERE id=$7',
      [route_name,start_point_id,testing_point_id,delivery_point_id,distance_km,is_active,req.params.id]
    );
    await client.query('DELETE FROM route_bmcus WHERE route_id=$1',[req.params.id]);
    for (const b of (bmcus || [])) {
      await client.query('INSERT INTO route_bmcus(route_id,seq_no,bmcu_id) VALUES($1,$2,$3)',[req.params.id,b.seq_no,b.bmcu_id]);
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally { client.release(); }
});

// ─── EMAIL CONFIG ─────────────────────────────────────
router.get('/email-config', authenticate, authorize('admin'), async (req, res) => {
  const r = await query('SELECT * FROM report_email_config ORDER BY full_name');
  res.json(r.rows);
});
router.post('/email-config', authenticate, authorize('admin'), async (req, res) => {
  const { full_name, email } = req.body;
  const r = await query('INSERT INTO report_email_config(full_name,email) VALUES($1,$2) RETURNING *',[full_name,email]);
  res.status(201).json(r.rows[0]);
});
router.put('/email-config/:id', authenticate, authorize('admin'), async (req, res) => {
  const { full_name, email, is_active } = req.body;
  const r = await query('UPDATE report_email_config SET full_name=$1,email=$2,is_active=$3 WHERE id=$4 RETURNING *',[full_name,email,is_active,req.params.id]);
  res.json(r.rows[0]);
});
router.delete('/email-config/:id', authenticate, authorize('admin'), async (req, res) => {
  await query('DELETE FROM report_email_config WHERE id=$1',[req.params.id]);
  res.json({success:true});
});

module.exports = router;
