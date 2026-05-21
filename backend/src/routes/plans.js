// backend/src/routes/plans.js
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const XLSX    = require('xlsx');
const { pool, query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ─── Helper: calculate cost fields ───────────────────────────────────────────
async function calcCost(client, tankerId, expectedKm, expectedTotalQty) {
  if (!tankerId || !expectedKm) return { total_cost: 0, per_liter_cost: 0, utilization_pct: 0 };
  const tr = await client.query('SELECT per_km_rate, capacity_litres FROM tankers WHERE id=$1', [tankerId]);
  if (!tr.rows.length) return { total_cost: 0, per_liter_cost: 0, utilization_pct: 0 };
  const { per_km_rate, capacity_litres } = tr.rows[0];
  const total_cost    = parseFloat(expectedKm) * parseFloat(per_km_rate);
  const qty           = parseFloat(expectedTotalQty) || 0;
  const per_liter_cost = qty > 0 ? total_cost / qty : 0;
  const utilization_pct = capacity_litres > 0 ? (qty / capacity_litres) * 100 : 0;
  return {
    total_cost: Math.round(total_cost * 100) / 100,
    per_liter_cost: Math.round(per_liter_cost * 10000) / 10000,
    utilization_pct: Math.round(utilization_pct * 10) / 10
  };
}

// GET /api/plans
router.get('/', authenticate, async (req, res) => {
  try {
    const { plan_for_date, status } = req.query;
    let sql = `
      SELECT tp.*,
        t.tanker_number, t.capacity_litres, t.per_km_rate,
        sp.name AS start_point_name,
        dp.name AS delivery_point_name,
        rm.route_name,
        u.full_name AS planner_name
      FROM trip_plans tp
      LEFT JOIN tankers t         ON t.id=tp.tanker_id
      LEFT JOIN starting_points sp ON sp.id=tp.start_point_id
      LEFT JOIN delivery_points dp ON dp.id=tp.delivery_point_id
      LEFT JOIN route_masters rm   ON rm.id=tp.route_id
      LEFT JOIN users u            ON u.id=tp.created_by
      WHERE tp.status != 'cancelled'`;
    const params = [];
    if (plan_for_date) { params.push(plan_for_date); sql += ` AND tp.plan_for_date=$${params.length}`; }
    if (status)        { params.push(status);        sql += ` AND tp.status=$${params.length}`; }
    sql += ' ORDER BY tp.plan_for_date, tp.trip_no';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/plans/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const plan = await query(`
      SELECT tp.*,
        t.tanker_number, t.capacity_litres, t.compartments, t.per_km_rate,
        sp.name AS start_point_name, tpt.name AS testing_point_name,
        dp.name AS delivery_point_name, rm.route_name
      FROM trip_plans tp
      LEFT JOIN tankers t         ON t.id=tp.tanker_id
      LEFT JOIN starting_points sp ON sp.id=tp.start_point_id
      LEFT JOIN testing_points tpt ON tpt.id=tp.testing_point_id
      LEFT JOIN delivery_points dp ON dp.id=tp.delivery_point_id
      LEFT JOIN route_masters rm   ON rm.id=tp.route_id
      WHERE tp.id=$1`, [req.params.id]
    );
    if (!plan.rows.length) return res.status(404).json({ error: 'Not found' });
    const bmcus = await query(`
      SELECT tpb.*, b.bmcu_code, b.bmcu_name
      FROM trip_plan_bmcus tpb JOIN bmcus b ON b.id=tpb.bmcu_id
      WHERE tpb.trip_plan_id=$1 ORDER BY tpb.seq_no`, [req.params.id]
    );
    res.json({ ...plan.rows[0], bmcus: bmcus.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/plans
router.post('/', authenticate, authorize('admin','planner'), async (req, res) => {
  const {
    plan_date, plan_for_date, trip_no, route_id, tanker_id,
    start_point_id, testing_point_id, delivery_point_id,
    shifts_milk, expected_km, expected_total_qty,
    driver_name, loader_name, remarks, bmcus
  } = req.body;

  if (!plan_date || !plan_for_date || !tanker_id || !delivery_point_id)
    return res.status(400).json({ error: 'plan_date, plan_for_date, tanker_id, delivery_point_id required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const costs = await calcCost(client, tanker_id, expected_km, expected_total_qty);

    const r = await client.query(
      `INSERT INTO trip_plans
         (plan_date,plan_for_date,trip_no,route_id,tanker_id,
          start_point_id,testing_point_id,delivery_point_id,
          shifts_milk,expected_km,expected_utilization_pct,expected_total_qty,
          total_cost,per_liter_cost,driver_name,loader_name,remarks,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [plan_date, plan_for_date, trip_no||null, route_id||null, tanker_id,
       start_point_id||null, testing_point_id||null, delivery_point_id,
       shifts_milk||null, expected_km||null, costs.utilization_pct,
       expected_total_qty||0, costs.total_cost, costs.per_liter_cost,
       driver_name||null, loader_name||null, remarks||null, req.user.id]
    );
    const planId = r.rows[0].id;
    if (bmcus?.length) {
      for (const bm of bmcus) {
        await client.query(
          'INSERT INTO trip_plan_bmcus (trip_plan_id,seq_no,bmcu_id,shift_code,expected_qty) VALUES ($1,$2,$3,$4,$5)',
          [planId, bm.seq_no, bm.bmcu_id, bm.shift_code||null, bm.expected_qty||0]
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

// PUT /api/plans/:id
router.put('/:id', authenticate, authorize('admin','planner'), async (req, res) => {
  const {
    plan_for_date, trip_no, route_id, tanker_id,
    start_point_id, testing_point_id, delivery_point_id,
    shifts_milk, expected_km, expected_total_qty,
    driver_name, loader_name, remarks, status, bmcus
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM trip_plans WHERE id=$1', [req.params.id]);
    if (!existing.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }

    const costs = await calcCost(
      client,
      tanker_id || existing.rows[0].tanker_id,
      expected_km ?? existing.rows[0].expected_km,
      expected_total_qty ?? existing.rows[0].expected_total_qty
    );

    const r = await client.query(
      `UPDATE trip_plans SET
        plan_for_date=$1, trip_no=$2, route_id=$3, tanker_id=$4,
        start_point_id=$5, testing_point_id=$6, delivery_point_id=$7,
        shifts_milk=$8, expected_km=$9, expected_utilization_pct=$10, expected_total_qty=$11,
        total_cost=$12, per_liter_cost=$13, driver_name=$14, loader_name=$15,
        remarks=$16, status=$17, updated_at=NOW()
       WHERE id=$18 RETURNING *`,
      [
        plan_for_date || existing.rows[0].plan_for_date,
        trip_no ?? existing.rows[0].trip_no,
        route_id ?? existing.rows[0].route_id,
        tanker_id || existing.rows[0].tanker_id,
        start_point_id ?? existing.rows[0].start_point_id,
        testing_point_id ?? existing.rows[0].testing_point_id,
        delivery_point_id || existing.rows[0].delivery_point_id,
        shifts_milk ?? existing.rows[0].shifts_milk,
        expected_km ?? existing.rows[0].expected_km,
        costs.utilization_pct,
        expected_total_qty ?? existing.rows[0].expected_total_qty,
        costs.total_cost, costs.per_liter_cost,
        driver_name ?? existing.rows[0].driver_name,
        loader_name ?? existing.rows[0].loader_name,
        remarks ?? existing.rows[0].remarks,
        status || existing.rows[0].status,
        req.params.id
      ]
    );

    if (bmcus !== undefined) {
      await client.query('DELETE FROM trip_plan_bmcus WHERE trip_plan_id=$1', [req.params.id]);
      for (const bm of bmcus) {
        await client.query(
          'INSERT INTO trip_plan_bmcus (trip_plan_id,seq_no,bmcu_id,shift_code,expected_qty) VALUES ($1,$2,$3,$4,$5)',
          [req.params.id, bm.seq_no, bm.bmcu_id, bm.shift_code||null, bm.expected_qty||0]
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

// DELETE /api/plans/:id
router.delete('/:id', authenticate, authorize('admin','planner'), async (req, res) => {
  try {
    await query("UPDATE trip_plans SET status='cancelled',updated_at=NOW() WHERE id=$1", [req.params.id]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/plans/publish  — bulk publish drafts
router.post('/publish', authenticate, authorize('admin','planner'), async (req, res) => {
  const { plan_for_date } = req.body;
  if (!plan_for_date) return res.status(400).json({ error: 'plan_for_date required' });
  try {
    const r = await query(
      "UPDATE trip_plans SET status='published',updated_at=NOW() WHERE plan_for_date=$1 AND status='draft' RETURNING id",
      [plan_for_date]
    );
    res.json({ published: r.rows.length, ids: r.rows.map(r => r.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/plans/template/download
router.get('/template/download', authenticate, async (req, res) => {
  try {
    const tankers = await query('SELECT tanker_number FROM tankers WHERE is_active=TRUE ORDER BY tanker_number');
    const bmcus   = await query('SELECT bmcu_code, bmcu_name FROM bmcus WHERE is_active=TRUE ORDER BY bmcu_code');
    const routes  = await query('SELECT route_name FROM route_masters WHERE is_active=TRUE ORDER BY route_name');

    const wb = XLSX.utils.book_new();
    const headers = [
      'plan_for_date','trip_no','tanker_number','route_name',
      'shifts_milk','expected_km','driver_name','loader_name','remarks',
      'bmcu_code_1','shift_1','expected_qty_1',
      'bmcu_code_2','shift_2','expected_qty_2',
      'bmcu_code_3','shift_3','expected_qty_3',
      'bmcu_code_4','shift_4','expected_qty_4',
      'bmcu_code_5','shift_5','expected_qty_5',
      'bmcu_code_6','shift_6','expected_qty_6',
      'bmcu_code_7','shift_7','expected_qty_7',
      'bmcu_code_8','shift_8','expected_qty_8',
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers]);
    ws['!cols'] = headers.map((_, i) => ({ wch: i < 9 ? 16 : 12 }));
    XLSX.utils.book_append_sheet(wb, ws, 'Trip Plans');

    // Reference sheets
    const wsTankers = XLSX.utils.aoa_to_sheet([['tanker_number'], ...tankers.rows.map(t => [t.tanker_number])]);
    const wsBmcus   = XLSX.utils.aoa_to_sheet([['bmcu_code','bmcu_name'], ...bmcus.rows.map(b => [b.bmcu_code, b.bmcu_name])]);
    const wsRoutes  = XLSX.utils.aoa_to_sheet([['route_name'], ...routes.rows.map(r => [r.route_name])]);
    XLSX.utils.book_append_sheet(wb, wsTankers, 'Tankers');
    XLSX.utils.book_append_sheet(wb, wsBmcus,   'BMCUs');
    XLSX.utils.book_append_sheet(wb, wsRoutes,  'Routes');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=trip_plan_template.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/plans/upload
router.post('/upload', authenticate, authorize('admin','planner'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { plan_date, plan_for_date } = req.body;
  if (!plan_date || !plan_for_date)
    return res.status(400).json({ error: 'plan_date and plan_for_date required' });

  const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  const client = await pool.connect();
  const errors = [], created = [];

  try {
    await client.query('BEGIN');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;
      try {
        const tr = await client.query(
          'SELECT id,per_km_rate,capacity_litres FROM tankers WHERE tanker_number=$1 AND is_active=TRUE',
          [row.tanker_number]
        );
        if (!tr.rows[0]) { errors.push(`Row ${rowNum}: tanker "${row.tanker_number}" not found`); continue; }

        let routeId = null;
        if (row.route_name) {
          const rr = await client.query(
            'SELECT id FROM route_masters WHERE route_name ILIKE $1 AND is_active=TRUE', [row.route_name]
          );
          if (rr.rows[0]) routeId = rr.rows[0].id;
        }

        const expKm  = parseFloat(row.expected_km) || 0;
        const expQty = 0; // will sum from BMCUs below
        const totalCost = expKm * parseFloat(tr.rows[0].per_km_rate);

        const pr = await client.query(
          `INSERT INTO trip_plans
             (plan_date,plan_for_date,trip_no,route_id,tanker_id,
              shifts_milk,expected_km,expected_total_qty,total_cost,per_liter_cost,
              driver_name,loader_name,remarks,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [plan_date, plan_for_date, row.trip_no||null, routeId, tr.rows[0].id,
           row.shifts_milk||null, expKm, expQty, totalCost, 0,
           row.driver_name||null, row.loader_name||null, row.remarks||null, req.user.id]
        );
        const planId = pr.rows[0].id;

        let seq = 1; let totalExpQty = 0;
        for (let j = 1; j <= 8; j++) {
          const code = row[`bmcu_code_${j}`];
          if (!code) continue;
          const br = await client.query(
            'SELECT id FROM bmcus WHERE bmcu_code=$1 AND is_active=TRUE', [code]
          );
          if (!br.rows[0]) { errors.push(`Row ${rowNum}: BMCU "${code}" not found`); continue; }
          const qty = parseFloat(row[`expected_qty_${j}`]) || 0;
          totalExpQty += qty;
          await client.query(
            'INSERT INTO trip_plan_bmcus (trip_plan_id,seq_no,bmcu_id,shift_code,expected_qty) VALUES ($1,$2,$3,$4,$5)',
            [planId, seq++, br.rows[0].id, row[`shift_${j}`]||null, qty]
          );
        }
        // Update expected qty and costs
        const perL = totalExpQty > 0 ? totalCost / totalExpQty : 0;
        const util = tr.rows[0].capacity_litres > 0 ? (totalExpQty / tr.rows[0].capacity_litres) * 100 : 0;
        await client.query(
          'UPDATE trip_plans SET expected_total_qty=$1,per_liter_cost=$2,expected_utilization_pct=$3 WHERE id=$4',
          [totalExpQty, Math.round(perL * 10000) / 10000, Math.round(util * 10) / 10, planId]
        );
        created.push(planId);
      } catch (rowErr) {
        errors.push(`Row ${rowNum}: ${rowErr.message}`);
      }
    }
    await client.query('COMMIT');
    res.json({ created: created.length, errors });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

module.exports = router;
