const router = require('express').Router();
const multer = require('multer');
const XLSX = require('xlsx');
const { query, pool } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// List plans
router.get('/', authenticate, async (req, res) => {
  const { plan_for_date, status } = req.query;
  let sql = `
    SELECT tp.*,
      t.tanker_number, t.capacity_litres, t.compartments, t.per_km_rate,
      rm.route_name,
      sp.name AS start_point_name,
      dp.name AS delivery_point_name,
      u.full_name AS planner_name
    FROM trip_plans tp
    LEFT JOIN tankers t ON tp.tanker_id=t.id
    LEFT JOIN route_masters rm ON tp.route_id=rm.id
    LEFT JOIN starting_points sp ON tp.start_point_id=sp.id
    LEFT JOIN delivery_points dp ON tp.delivery_point_id=dp.id
    LEFT JOIN users u ON tp.created_by=u.id
    WHERE 1=1`;
  const params = [];
  if (plan_for_date) { params.push(plan_for_date); sql += ` AND tp.plan_for_date=$${params.length}`; }
  if (status) { params.push(status); sql += ` AND tp.status=$${params.length}`; }
  sql += ' ORDER BY tp.plan_for_date, tp.trip_no';
  const r = await query(sql, params);
  res.json(r.rows);
});

// Get single plan with BMCUs
router.get('/:id', authenticate, async (req, res) => {
  const plan = await query(`
    SELECT tp.*,
      t.tanker_number,t.capacity_litres,t.compartments,t.per_km_rate,
      rm.route_name,sp.name AS start_point_name,tp_pt.name AS testing_point_name,dp.name AS delivery_point_name
    FROM trip_plans tp
    LEFT JOIN tankers t ON tp.tanker_id=t.id
    LEFT JOIN route_masters rm ON tp.route_id=rm.id
    LEFT JOIN starting_points sp ON tp.start_point_id=sp.id
    LEFT JOIN testing_points tp_pt ON tp.testing_point_id=tp_pt.id
    LEFT JOIN delivery_points dp ON tp.delivery_point_id=dp.id
    WHERE tp.id=$1`,[req.params.id]);
  if (!plan.rows[0]) return res.status(404).json({ error: 'Not found' });
  const bmcus = await query(`
    SELECT tpb.*,b.bmcu_code,b.bmcu_name
    FROM trip_plan_bmcus tpb JOIN bmcus b ON tpb.bmcu_id=b.id
    WHERE tpb.trip_plan_id=$1 ORDER BY tpb.seq_no`,[req.params.id]);
  res.json({ ...plan.rows[0], bmcus: bmcus.rows });
});

// Create plan
router.post('/', authenticate, authorize('admin','planner'), async (req, res) => {
  const {
    plan_date, plan_for_date, trip_no, route_id, tanker_id,
    start_point_id, testing_point_id, delivery_point_id,
    shifts_milk, expected_km, expected_utilization_pct, expected_total_qty,
    driver_name, loader_name, remarks, bmcus
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Calculate cost
    let total_cost = 0, per_liter_cost = 0;
    if (expected_km) {
      const tanker = await client.query('SELECT per_km_rate FROM tankers WHERE id=$1',[tanker_id]);
      if (tanker.rows[0]) {
        total_cost = parseFloat(expected_km) * parseFloat(tanker.rows[0].per_km_rate);
        if (expected_total_qty && parseFloat(expected_total_qty) > 0)
          per_liter_cost = total_cost / parseFloat(expected_total_qty);
      }
    }

    const r = await client.query(`
      INSERT INTO trip_plans(plan_date,plan_for_date,trip_no,route_id,tanker_id,start_point_id,testing_point_id,
        delivery_point_id,shifts_milk,expected_km,expected_utilization_pct,expected_total_qty,total_cost,
        per_liter_cost,driver_name,loader_name,remarks,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [plan_date,plan_for_date,trip_no,route_id,tanker_id,start_point_id,testing_point_id,
       delivery_point_id,shifts_milk,expected_km,expected_utilization_pct,expected_total_qty,
       total_cost,per_liter_cost,driver_name,loader_name,remarks,req.user.id]);

    const planId = r.rows[0].id;
    for (const b of (bmcus || [])) {
      await client.query('INSERT INTO trip_plan_bmcus(trip_plan_id,seq_no,bmcu_id,shift_code,expected_qty) VALUES($1,$2,$3,$4,$5)',
        [planId, b.seq_no, b.bmcu_id, b.shift_code, b.expected_qty]);
    }
    await client.query('COMMIT');
    res.status(201).json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally { client.release(); }
});

// Update plan
router.put('/:id', authenticate, authorize('admin','planner'), async (req, res) => {
  const {
    trip_no, route_id, tanker_id, start_point_id, testing_point_id, delivery_point_id,
    shifts_milk, expected_km, expected_utilization_pct, expected_total_qty,
    driver_name, loader_name, remarks, status, bmcus
  } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let total_cost = 0, per_liter_cost = 0;
    if (expected_km && tanker_id) {
      const tanker = await client.query('SELECT per_km_rate FROM tankers WHERE id=$1',[tanker_id]);
      if (tanker.rows[0]) {
        total_cost = parseFloat(expected_km) * parseFloat(tanker.rows[0].per_km_rate);
        if (expected_total_qty && parseFloat(expected_total_qty) > 0)
          per_liter_cost = total_cost / parseFloat(expected_total_qty);
      }
    }
    await client.query(`
      UPDATE trip_plans SET trip_no=$1,route_id=$2,tanker_id=$3,start_point_id=$4,testing_point_id=$5,
        delivery_point_id=$6,shifts_milk=$7,expected_km=$8,expected_utilization_pct=$9,expected_total_qty=$10,
        total_cost=$11,per_liter_cost=$12,driver_name=$13,loader_name=$14,remarks=$15,status=$16,updated_at=NOW()
      WHERE id=$17`,
      [trip_no,route_id,tanker_id,start_point_id,testing_point_id,delivery_point_id,
       shifts_milk,expected_km,expected_utilization_pct,expected_total_qty,total_cost,per_liter_cost,
       driver_name,loader_name,remarks,status,req.params.id]);
    if (bmcus) {
      await client.query('DELETE FROM trip_plan_bmcus WHERE trip_plan_id=$1',[req.params.id]);
      for (const b of bmcus) {
        await client.query('INSERT INTO trip_plan_bmcus(trip_plan_id,seq_no,bmcu_id,shift_code,expected_qty) VALUES($1,$2,$3,$4,$5)',
          [req.params.id, b.seq_no, b.bmcu_id, b.shift_code, b.expected_qty]);
      }
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally { client.release(); }
});

// Publish plans for a date
router.post('/publish', authenticate, authorize('admin','planner'), async (req, res) => {
  const { plan_for_date } = req.body;
  await query('UPDATE trip_plans SET status=$1 WHERE plan_for_date=$2 AND status=$3',
    ['published', plan_for_date, 'draft']);
  res.json({ success: true });
});

// Delete plan
router.delete('/:id', authenticate, authorize('admin','planner'), async (req, res) => {
  await query('UPDATE trip_plans SET status=$1 WHERE id=$2', ['cancelled', req.params.id]);
  res.json({ success: true });
});

// Excel bulk upload template download
router.get('/template/download', authenticate, (req, res) => {
  const wb = XLSX.utils.book_new();
  const headers = ['trip_no','route_name','tanker_number','start_point','testing_point','delivery_point',
    'shifts_milk','expected_km','expected_utilization_pct','expected_total_qty',
    'driver_name','loader_name','remarks',
    'bmcu_code_1','shift_1','expected_qty_1',
    'bmcu_code_2','shift_2','expected_qty_2',
    'bmcu_code_3','shift_3','expected_qty_3',
    'bmcu_code_4','shift_4','expected_qty_4',
    'bmcu_code_5','shift_5','expected_qty_5',
    'bmcu_code_6','shift_6','expected_qty_6',
    'bmcu_code_7','shift_7','expected_qty_7',
    'bmcu_code_8','shift_8','expected_qty_8'];
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  XLSX.utils.book_append_sheet(wb, ws, 'Trip Plans');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=trip_plan_template.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Excel bulk upload
router.post('/upload', authenticate, authorize('admin','planner'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { plan_date, plan_for_date } = req.body;
  const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);

  const client = await pool.connect();
  const errors = [], created = [];
  try {
    await client.query('BEGIN');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        // Look up tanker
        const tankerRes = await client.query('SELECT id,per_km_rate FROM tankers WHERE tanker_number=$1 AND is_active=TRUE',[row.tanker_number]);
        if (!tankerRes.rows[0]) { errors.push(`Row ${i+2}: Tanker ${row.tanker_number} not found`); continue; }
        // Look up route
        let routeId = null;
        if (row.route_name) {
          const rr = await client.query('SELECT id FROM route_masters WHERE route_name ILIKE $1 AND is_active=TRUE',[row.route_name]);
          if (rr.rows[0]) routeId = rr.rows[0].id;
        }
        const total_cost = (row.expected_km || 0) * parseFloat(tankerRes.rows[0].per_km_rate);
        const per_liter_cost = row.expected_total_qty > 0 ? total_cost / row.expected_total_qty : 0;

        const pr = await client.query(`
          INSERT INTO trip_plans(plan_date,plan_for_date,trip_no,route_id,tanker_id,shifts_milk,expected_km,
            expected_utilization_pct,expected_total_qty,total_cost,per_liter_cost,driver_name,loader_name,remarks,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
          [plan_date,plan_for_date,row.trip_no,routeId,tankerRes.rows[0].id,row.shifts_milk,row.expected_km,
           row.expected_utilization_pct,row.expected_total_qty,total_cost,per_liter_cost,
           row.driver_name,row.loader_name,row.remarks,req.user.id]);

        const planId = pr.rows[0].id;
        let seq = 1;
        for (let n = 1; n <= 8; n++) {
          const code = row[`bmcu_code_${n}`];
          if (!code) break;
          const br = await client.query('SELECT id FROM bmcus WHERE bmcu_code=$1 AND is_active=TRUE',[code]);
          if (br.rows[0]) {
            await client.query('INSERT INTO trip_plan_bmcus(trip_plan_id,seq_no,bmcu_id,shift_code,expected_qty) VALUES($1,$2,$3,$4,$5)',
              [planId,seq++,br.rows[0].id,row[`shift_${n}`],row[`expected_qty_${n}`]]);
          }
        }
        created.push(planId);
      } catch (rowErr) { errors.push(`Row ${i+2}: ${rowErr.message}`); }
    }
    await client.query('COMMIT');
    res.json({ created: created.length, errors });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

module.exports = router;
