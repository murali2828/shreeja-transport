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
    const tankers = await query('SELECT tanker_number, capacity_litres FROM tankers WHERE is_active=TRUE ORDER BY tanker_number');
    const bmcus   = await query('SELECT bmcu_code, bmcu_name FROM bmcus WHERE is_active=TRUE ORDER BY bmcu_code');
    const routes  = await query('SELECT route_name FROM route_masters WHERE is_active=TRUE ORDER BY route_name');

    const wb = XLSX.utils.book_new();
    const colHeaders = [
      'plan_for_date','trip_no','tanker_number','route_name',
      'shifts_milk','expected_km','driver_name','loader_name','remarks',
      'bmcu_code','shift_code','expected_qty'
    ];

    // Build sheet data: title row, instruction row, header row, sample rows
    const aoa = [
      ['SHREEJA SECONDARY TRANSPORT — Trip Plan Upload Template'],
      ['Multi-row format: One TRIP HEADER row per trip, then one row per BMCU below it. Columns A–I on BMCU rows must be blank. Delete rows 4–12 before uploading.'],
      colHeaders,
      // Trip 1 header + BMCUs
      ['25-05-2026',1,'AP03TF4985','MB Cross','18E19M',620,'Sample Driver','Sample Loader','Sample','3001','18E19M',5820],
      ['','','','','','','','','','3002','18E19M',3750],
      ['','','','','','','','','','3003','18E19M',4150],
      // Trip 2 header + BMCUs
      ['25-05-2026',2,'AP03TF2538','B Kothakota','17E18M',331,'Sample Driver 2','Sample Loader 2','','3004','17E18M',2806],
      ['','','','','','','','','','3005','17E18M',3310],
      ['','','','','','','','','','3006','18M18E',2821],
    ];

    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // Merge title across all 12 columns (row 1, A1:L1)
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 11 } }];

    // Column widths
    ws['!cols'] = [16,8,18,20,14,13,20,20,18,16,14,16].map(w => ({ wch: w }));

    // Style title cell
    if (ws['A1']) {
      ws['A1'].s = {
        font: { bold: true, sz: 13 },
        alignment: { horizontal: 'center' }
      };
    }

    // Style header row (row 3 = index 2)
    colHeaders.forEach((_, ci) => {
      const cellAddr = XLSX.utils.encode_cell({ r: 2, c: ci });
      if (ws[cellAddr]) {
        ws[cellAddr].s = {
          font: { bold: true, color: { rgb: 'FFFFFF' } },
          fill: { fgColor: { rgb: '2E75B6' } },
          alignment: { horizontal: 'center' }
        };
      }
    });

    // Style sample rows (rows 4–9 = index 3–8) yellow background
    for (let ri = 3; ri <= 8; ri++) {
      for (let ci = 0; ci < 12; ci++) {
        const cellAddr = XLSX.utils.encode_cell({ r: ri, c: ci });
        if (ws[cellAddr]) {
          ws[cellAddr].s = { fill: { fgColor: { rgb: 'FFF2CC' } } };
        }
      }
    }

    XLSX.utils.book_append_sheet(wb, ws, 'Trip Plans');

    // Reference sheets
    const wsTankers = XLSX.utils.aoa_to_sheet([['tanker_number','capacity_litres'], ...tankers.rows.map(t => [t.tanker_number, t.capacity_litres])]);
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

  // Parse multi-row format: group rows into trips
  const trips = [];
  let currentTrip = null;
  for (const row of rows) {
    const hasTripHeader = row['plan_for_date'] && row['trip_no'] !== undefined && row['trip_no'] !== null && row['trip_no'] !== '';
    if (hasTripHeader) {
      if (currentTrip) trips.push(currentTrip);
      currentTrip = {
        plan_for_date: row['plan_for_date'],
        trip_no:       row['trip_no'],
        tanker_number: String(row['tanker_number'] || '').trim(),
        route_name:    String(row['route_name'] || '').trim(),
        shifts_milk:   String(row['shifts_milk'] || '').trim(),
        expected_km:   row['expected_km'] || null,
        driver_name:   String(row['driver_name'] || '').trim() || null,
        loader_name:   String(row['loader_name'] || '').trim() || null,
        remarks:       String(row['remarks'] || '').trim() || null,
        bmcus: []
      };
    }
    if (currentTrip && row['bmcu_code'] !== undefined && row['bmcu_code'] !== null && row['bmcu_code'] !== '') {
      currentTrip.bmcus.push({
        bmcu_code:    String(row['bmcu_code']).trim(),
        shift_code:   String(row['shift_code'] || '').trim() || null,
        expected_qty: row['expected_qty'] ? parseFloat(row['expected_qty']) : null
      });
    }
  }
  if (currentTrip) trips.push(currentTrip);

  const client = await pool.connect();
  const errors = [], created = [];

  try {
    await client.query('BEGIN');
    for (let i = 0; i < trips.length; i++) {
      const trip = trips[i];
      const rowNum = i + 2;
      try {
        const tr = await client.query(
          'SELECT id,per_km_rate,capacity_litres FROM tankers WHERE tanker_number=$1 AND is_active=TRUE',
          [trip.tanker_number]
        );
        if (!tr.rows[0]) { errors.push(`Trip ${rowNum}: tanker "${trip.tanker_number}" not found`); continue; }

        let routeId = null;
        if (trip.route_name) {
          const rr = await client.query(
            'SELECT id FROM route_masters WHERE route_name ILIKE $1 AND is_active=TRUE', [trip.route_name]
          );
          if (rr.rows[0]) routeId = rr.rows[0].id;
        }

        const expKm  = parseFloat(trip.expected_km) || 0;
        const expQty = 0; // will sum from BMCUs below
        const totalCost = expKm * parseFloat(tr.rows[0].per_km_rate);

        const pr = await client.query(
          `INSERT INTO trip_plans
             (plan_date,plan_for_date,trip_no,route_id,tanker_id,
              shifts_milk,expected_km,expected_total_qty,total_cost,per_liter_cost,
              driver_name,loader_name,remarks,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [plan_date, plan_for_date, trip.trip_no||null, routeId, tr.rows[0].id,
           trip.shifts_milk||null, expKm, expQty, totalCost, 0,
           trip.driver_name||null, trip.loader_name||null, trip.remarks||null, req.user.id]
        );
        const planId = pr.rows[0].id;

        let seq = 1; let totalExpQty = 0;
        for (const bm of trip.bmcus) {
          const br = await client.query(
            'SELECT id FROM bmcus WHERE bmcu_code=$1 AND is_active=TRUE', [bm.bmcu_code]
          );
          if (!br.rows[0]) { errors.push(`Trip ${rowNum}: BMCU "${bm.bmcu_code}" not found`); continue; }
          const qty = bm.expected_qty || 0;
          totalExpQty += qty;
          await client.query(
            'INSERT INTO trip_plan_bmcus (trip_plan_id,seq_no,bmcu_id,shift_code,expected_qty) VALUES ($1,$2,$3,$4,$5)',
            [planId, seq++, br.rows[0].id, bm.shift_code||null, qty]
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
        errors.push(`Trip ${rowNum}: ${rowErr.message}`);
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
