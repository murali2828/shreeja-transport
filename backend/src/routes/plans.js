// backend/src/routes/plans.js
const express      = require('express');
const router       = express.Router();
const multer       = require('multer');
const XLSX         = require('xlsx');
const ExcelJS      = require('exceljs');
const nodemailer   = require('nodemailer');
const { pool, query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const { createTransport } = require('../config/mailer');

const XL_FILTER = (req, file, cb) => {
  const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname || '');
  cb(ok ? null : new Error('Only .xlsx / .xls / .csv files are allowed'), ok);
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: XL_FILTER });

// ─── Helper: maintenance guard ───────────────────────────────────────────────
// A tanker out on an unreturned Maintainance gate pass cannot be planned.
async function assertTankerAvailable(tankerId) {
  if (!tankerId) return;
  const r = await query(`
    SELECT t.tanker_number FROM tankers t
    WHERE t.id=$1 AND EXISTS (SELECT 1 FROM non_trip_gate_passes g
      WHERE g.tanker_id=t.id AND g.reason='Maintainance' AND g.returned_at IS NULL)`,
    [tankerId]);
  if (r.rows.length)
    throw Object.assign(new Error(`Tanker ${r.rows[0].tanker_number} is under maintenance — not available for planning until it reports back`), { code: 400 });
}

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
      WHERE 1=1`;
    const params = [];
    if (plan_for_date) { params.push(plan_for_date); sql += ` AND tp.plan_for_date=$${params.length}`; }
    // Explicit status (e.g. 'deleted' for the Deleted Plans report) wins;
    // otherwise hide cancelled/deleted as before.
    if (status) { params.push(status); sql += ` AND tp.status=$${params.length}`; }
    else        { sql += ` AND tp.status NOT IN ('cancelled','deleted')`; }
    sql += ' ORDER BY tp.plan_for_date, tp.trip_no';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/plans/coverage?plan_for_date=YYYY-MM-DD
router.get('/coverage', authenticate, async (req, res) => {
  try {
    const { plan_for_date } = req.query;
    if (!plan_for_date) return res.status(400).json({ error: 'plan_for_date required' });

    // Total non-deleted plans for date
    const plansRes = await query(
      `SELECT COUNT(*) AS total_plans FROM trip_plans WHERE plan_for_date=$1 AND status != 'deleted'`,
      [plan_for_date]
    );

    // Active BMCUs covered by at least one plan that day
    const coveredRes = await query(
      `SELECT COUNT(DISTINCT tpb.bmcu_id) AS covered_count
       FROM trip_plan_bmcus tpb
       JOIN trip_plans tp ON tp.id = tpb.trip_plan_id
       JOIN bmcus b ON b.id = tpb.bmcu_id
       WHERE tp.plan_for_date=$1 AND tp.status != 'deleted' AND b.is_active = TRUE`,
      [plan_for_date]
    );

    // Active BMCUs NOT covered that day (missed)
    const missedRes = await query(
      `SELECT b.id, b.bmcu_code, b.bmcu_name, b.district
       FROM bmcus b
       WHERE b.is_active = TRUE
         AND b.id NOT IN (
           SELECT DISTINCT tpb.bmcu_id
           FROM trip_plan_bmcus tpb
           JOIN trip_plans tp ON tp.id = tpb.trip_plan_id
           WHERE tp.plan_for_date=$1 AND tp.status != 'deleted'
         )
       ORDER BY b.bmcu_code`,
      [plan_for_date]
    );

    const totalActiveBmcus = parseInt(coveredRes.rows[0].covered_count) + missedRes.rows.length;

    res.json({
      total_plans: parseInt(plansRes.rows[0].total_plans),
      bmcus_covered: parseInt(coveredRes.rows[0].covered_count),
      bmcus_missed: missedRes.rows.length,
      total_active_bmcus: totalActiveBmcus,
      missed_list: missedRes.rows,
    });
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

  try { await assertTankerAvailable(tanker_id); }
  catch (err) { return res.status(err.code === 400 ? 400 : 500).json({ error: err.message }); }

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
          'INSERT INTO trip_plan_bmcus (trip_plan_id,seq_no,bmcu_id,shift_code,expected_qty,description) VALUES ($1,$2,$3,$4,$5,$6)',
          [planId, bm.seq_no, bm.bmcu_id, bm.shift_code||null, bm.expected_qty||0, bm.description||'RMRD']
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

  try { await assertTankerAvailable(tanker_id); }
  catch (err) { return res.status(err.code === 400 ? 400 : 500).json({ error: err.message }); }

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
        start_point_id || null,
        testing_point_id || null,
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
          'INSERT INTO trip_plan_bmcus (trip_plan_id,seq_no,bmcu_id,shift_code,expected_qty,description) VALUES ($1,$2,$3,$4,$5,$6)',
          [req.params.id, bm.seq_no, bm.bmcu_id, bm.shift_code||null, bm.expected_qty||0, bm.description||'RMRD']
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

// DELETE /api/plans/:id  — soft-delete (status=deleted); warn if execution data exists
router.delete('/:id', authenticate, authorize('admin','planner'), async (req, res) => {
  try {
    const plan = await query('SELECT * FROM trip_plans WHERE id=$1', [req.params.id]);
    if (!plan.rows.length) return res.status(404).json({ error: 'Plan not found' });

    // Check for execution data
    const execs = await query(
      "SELECT id, status FROM trip_executions WHERE trip_plan_id=$1 AND status NOT IN ('cancelled')",
      [req.params.id]
    );
    const hasExecution = execs.rows.length > 0;
    const { force } = req.query;

    if (hasExecution && force !== 'true') {
      return res.status(409).json({
        error: 'This plan has execution data',
        hasExecution: true,
        executions: execs.rows.map(e => ({ id: e.id, status: e.status }))
      });
    }

    await query("UPDATE trip_plans SET status='deleted',updated_at=NOW() WHERE id=$1", [req.params.id]);
    res.json({ deleted: true, hadExecution: hasExecution });
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

    // Send email to plan email config recipients
    try {
      const recipients = await query("SELECT email, name FROM plan_email_configs WHERE is_active=TRUE");
      if (recipients.rows.length > 0) {
        const plans = await query(`
          SELECT tp.trip_no, t.tanker_number, rm.route_name, tp.shifts_milk, tp.expected_total_qty
          FROM trip_plans tp
          LEFT JOIN tankers t       ON t.id = tp.tanker_id
          LEFT JOIN route_masters rm ON rm.id = tp.route_id
          WHERE tp.plan_for_date = $1 AND tp.status = 'published'
          ORDER BY tp.trip_no`, [plan_for_date]);

        const rows = plans.rows.map(p =>
          `<tr>
            <td style="padding:6px 12px;border:1px solid #e5e7eb;">${p.trip_no || '—'}</td>
            <td style="padding:6px 12px;border:1px solid #e5e7eb;">${p.tanker_number || '—'}</td>
            <td style="padding:6px 12px;border:1px solid #e5e7eb;">${p.route_name || '—'}</td>
            <td style="padding:6px 12px;border:1px solid #e5e7eb;">${p.shifts_milk || '—'}</td>
            <td style="padding:6px 12px;border:1px solid #e5e7eb;text-align:right;">${parseFloat(p.expected_total_qty||0).toLocaleString()}</td>
          </tr>`
        ).join('');

        const html = `
          <h2 style="font-family:sans-serif;color:#0078d4;">Shreeja TMS — Trip Plans for ${plan_for_date}</h2>
          <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
            <thead>
              <tr style="background:#f3f4f6;">
                <th style="padding:6px 12px;border:1px solid #e5e7eb;text-align:left;">Trip No</th>
                <th style="padding:6px 12px;border:1px solid #e5e7eb;text-align:left;">Tanker</th>
                <th style="padding:6px 12px;border:1px solid #e5e7eb;text-align:left;">Route</th>
                <th style="padding:6px 12px;border:1px solid #e5e7eb;text-align:left;">Shifts Milk</th>
                <th style="padding:6px 12px;border:1px solid #e5e7eb;text-align:right;">Expected Qty (L)</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;"/>
          <p style="font-family:sans-serif;font-size:12px;color:#9ca3af;">This is an automated message from Shreeja TMS · Developed &amp; maintained by <strong style="color:#6b7280;">Shreeja IT Team</strong>.</p>`;

        const transporter = createTransport();
        await transporter.sendMail({
          from:    process.env.SMTP_FROM || process.env.SMTP_USER,
          to:      recipients.rows.map(r => r.email).join(', '),
          subject: `Shreeja TMS — Trip Plans for ${plan_for_date}`,
          html,
        });
      }
    } catch (mailErr) {
      console.error('Plan publish email error:', mailErr.message);
      // Don't fail the publish response due to email error
    }

    res.json({ published: r.rows.length, ids: r.rows.map(r => r.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Plan Email Config CRUD ────────────────────────────────────────────────────

// GET /api/plans/email-config
router.get('/email-config', authenticate, authorize('admin'), async (req, res) => {
  try {
    const r = await query('SELECT * FROM plan_email_configs ORDER BY created_at');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/plans/email-config
router.post('/email-config', authenticate, authorize('admin'), async (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const r = await query(
      'INSERT INTO plan_email_configs (email, name) VALUES ($1, $2) RETURNING *',
      [email, name || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/plans/email-config/:id
router.put('/email-config/:id', authenticate, authorize('admin'), async (req, res) => {
  const { email, name, is_active } = req.body;
  try {
    const r = await query(
      'UPDATE plan_email_configs SET email=$1, name=$2, is_active=$3 WHERE id=$4 RETURNING *',
      [email, name || null, is_active !== undefined ? is_active : true, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/plans/email-config/:id
router.delete('/email-config/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await query('DELETE FROM plan_email_configs WHERE id=$1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/plans/template/download
router.get('/template/download', authenticate, async (req, res) => {
  try {
    const tankers    = await query('SELECT tanker_number, capacity_litres FROM tankers WHERE is_active=TRUE ORDER BY tanker_number');
    // Sorted by NAME — required for the prefix-search dropdown (OFFSET over a
    // contiguous block of names sharing the typed prefix).
    const bmcus      = await query('SELECT bmcu_code, bmcu_name FROM bmcus WHERE is_active=TRUE ORDER BY bmcu_name');
    const routes     = await query('SELECT route_name FROM route_masters WHERE is_active=TRUE ORDER BY route_name');
    const startPts   = await query('SELECT name FROM starting_points WHERE is_active=TRUE ORDER BY name');
    const delivPts   = await query('SELECT name FROM delivery_points ORDER BY name');

    const wb = new ExcelJS.Workbook();

    // ── Reference sheets (added first so named ranges work) ──────────────────

    const wsTankers = wb.addWorksheet('Tankers');
    wsTankers.addRow(['tanker_number','capacity_litres']).font = { bold: true };
    tankers.rows.forEach(t => wsTankers.addRow([t.tanker_number, t.capacity_litres]));

    const wsBmcus = wb.addWorksheet('BMCUs');
    wsBmcus.addRow(['bmcu_code','bmcu_name']).font = { bold: true };
    bmcus.rows.forEach(b => wsBmcus.addRow([b.bmcu_code, b.bmcu_name]));

    const wsRoutes = wb.addWorksheet('Routes');
    wsRoutes.addRow(['route_name']).font = { bold: true };
    routes.rows.forEach(r => wsRoutes.addRow([r.route_name]));

    const wsStartPts = wb.addWorksheet('StartingPoints');
    wsStartPts.addRow(['name']).font = { bold: true };
    startPts.rows.forEach(r => wsStartPts.addRow([r.name]));

    const wsDelivPts = wb.addWorksheet('DeliveryPoints');
    wsDelivPts.addRow(['name']).font = { bold: true };
    delivPts.rows.forEach(r => wsDelivPts.addRow([r.name]));

    // ── Sheet 1: Trip Plans ──────────────────────────────────────────────────
    // A=plan_for_date B=trip_no C=tanker_number D=route_name E=starting_point F=delivery_point
    // G=bmcu_name(user selects name→searchable) H=bmcu_code(auto VLOOKUP)
    // I=shifts_milk J=expected_qty K=description L=expected_km M=driver_name N=loader_name O=remarks
    const ws = wb.addWorksheet('Trip Plans');

    const colWidths = [14,8,18,20,20,20,28,14,12,13,18,11,18,18,18];
    ws.columns = [
      'plan_for_date','trip_no','tanker_number','route_name','starting_point','delivery_point',
      'bmcu_name','bmcu_code','shifts_milk','expected_qty','description',
      'expected_km','driver_name','loader_name','remarks'
    ].map((key, i) => ({ key, width: colWidths[i] }));

    // Row 1: merged title
    ws.mergeCells('A1:O1');
    const titleCell = ws.getCell('A1');
    titleCell.value = 'SHREEJA SECONDARY TRANSPORT — Trip Plan Upload Template';
    titleCell.font  = { bold: true, size: 13 };
    titleCell.alignment = { horizontal: 'center' };

    // Row 2: instruction
    ws.mergeCells('A2:O2');
    const instrCell = ws.getCell('A2');
    instrCell.value = 'TRIP HEADER: fill A–F and L–O. BMCU rows (col G): TYPE the first letters of the plant name, then open the dropdown — only matching plants are listed (empty cell shows all). Code auto-fills in col H. Fill cols I–K. Delete sample rows 4–8 before uploading.';
    instrCell.font  = { italic: true, size: 9, color: { argb: 'FF595959' } };
    instrCell.alignment = { wrapText: true };
    ws.getRow(2).height = 28;

    // Row 3: column headers — MUST match ws.columns keys exactly (parser uses these as row keys)
    const headerRow = ws.addRow([
      'plan_for_date','trip_no','tanker_number','route_name','starting_point','delivery_point',
      'bmcu_name','bmcu_code','shifts_milk','expected_qty','description',
      'expected_km','driver_name','loader_name','remarks'
    ]);
    headerRow.eachCell(cell => {
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E75B6' } };
      cell.alignment = { horizontal: 'center' };
    });
    // Green for user-input BMCU name col, gray for auto-filled code col
    ws.getCell('G3').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E7E34' } };
    ws.getCell('H3').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5A6268' } };

    // Sample data rows (yellow)
    const sampleRows = [
      ['25-05-2026',1,'AP03TF4985','MB Cross','Balaji Dairy','Balaji Dairy Plant','Penumuru','3001','18E19M',2000,'Balance Milk',620,'Sample Driver','Sample Loader','Sample trip'],
      ['','','','','','','Pakala','3002','18E19M',5820,'RMRD','','','',''],
      ['','','','','','','Damalacheruvu','3003','18E19M',3750,'RMRD','','','',''],
      ['25-05-2026',2,'AP03TF2538','B Kothakota','Balaji Dairy','Balaji Dairy Plant','Y S Gate','3004','17E18M',2806,'RMRD',331,'Sample Driver 2','Sample Loader 2',''],
      ['','','','','','','Komireddygari Palli','3005','17E18M',3310,'RMRD','','','',''],
    ];
    const yellowFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    sampleRows.forEach(data => {
      const r = ws.addRow(data);
      r.eachCell({ includeEmpty: true }, cell => { cell.fill = yellowFill; });
    });

    // VLOOKUP formula for bmcu_code (col H) based on bmcu_name (col G) — rows 4–2000
    const bmcuCount = bmcus.rows.length;
    const grayFill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
    for (let r = 4; r <= 500; r++) {
      const cell = ws.getCell(`H${r}`);
      cell.value = { formula: `IFERROR(INDEX(BMCUs!$A:$A,MATCH(G${r},BMCUs!$B:$B,0)),"")` };
      cell.fill  = grayFill;
      cell.font  = { color: { argb: 'FF444444' }, italic: true };
    }

    // Data validation dropdowns (rows 4–2000)
    const tankerCount = tankers.rows.length;
    const routeCount  = routes.rows.length;
    const startCount  = startPts.rows.length;
    const delivCount  = delivPts.rows.length;

    if (tankerCount > 0) {
      ws.dataValidations.add('C4:C2000', {
        type: 'list', allowBlank: true,
        formulae: [`Tankers!$A$2:$A$${tankerCount + 1}`],
        showErrorMessage: true, errorStyle: 'warning',
        errorTitle: 'Tanker not found', error: 'Select a tanker from the list.'
      });
    }
    if (routeCount > 0) {
      ws.dataValidations.add('D4:D2000', {
        type: 'list', allowBlank: true,
        formulae: [`Routes!$A$2:$A$${routeCount + 1}`],
        showErrorMessage: false
      });
    }
    if (startCount > 0) {
      ws.dataValidations.add('E4:E2000', {
        type: 'list', allowBlank: true,
        formulae: [`StartingPoints!$A$2:$A$${startCount + 1}`],
        showErrorMessage: false
      });
    }
    if (delivCount > 0) {
      ws.dataValidations.add('F4:F2000', {
        type: 'list', allowBlank: true,
        formulae: [`DeliveryPoints!$A$2:$A$${delivCount + 1}`],
        showErrorMessage: true, errorStyle: 'warning',
        errorTitle: 'Delivery point not found', error: 'Select a delivery point from the list.'
      });
    }
    // Col G: BMCU name dropdown with PREFIX SEARCH — type the first letters in
    // the cell, then open the dropdown: only plants starting with those letters
    // are listed (empty cell → full list). Relies on BMCUs!$B being sorted by
    // name; relative G4 adjusts per row across the applied range.
    if (bmcuCount > 0) {
      const nameCol = `BMCUs!$B$2:$B$${bmcuCount + 1}`;
      ws.dataValidations.add('G4:G2000', {
        type: 'list', allowBlank: true,
        formulae: [`OFFSET(BMCUs!$B$2,MATCH(G4&"*",${nameCol},0)-1,0,COUNTIF(${nameCol},G4&"*"),1)`],
        showErrorMessage: false
      });
    }
    // Col K: description
    ws.dataValidations.add('K4:K2000', {
      type: 'list', allowBlank: true,
      formulae: ['"RMRD,Balance Milk,Internal Shifting"'],
      showErrorMessage: true, errorStyle: 'stop',
      errorTitle: 'Invalid description', error: 'Select RMRD, Balance Milk, or Internal Shifting.'
    });

    const buf = await wb.xlsx.writeBuffer();
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
  // Find the Trip Plans sheet by name; fall back to first sheet for plain uploads
  const sheetName = wb.SheetNames.find(n => n.toLowerCase().includes('trip')) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { range: 2, raw: false });

  // Parse multi-row format: group rows into trips
  const trips = [];
  let currentTrip = null;
  for (const row of rows) {
    const hasTripHeader = row['plan_for_date'] && row['trip_no'] !== undefined && row['trip_no'] !== null && row['trip_no'] !== '' && row['tanker_number'];
    if (hasTripHeader) {
      if (currentTrip) trips.push(currentTrip);
      // Normalise date: DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, or Excel locale string
      let pfd = String(row['plan_for_date']).trim();
      if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(pfd)) {
        // DD-MM-YYYY or DD/MM/YYYY
        const [d, m, y] = pfd.split(/[-/]/);
        pfd = `${y}-${m}-${d}`;
      } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(pfd)) {
        // M/D/YYYY (US Excel format)
        const [m, d, y] = pfd.split('/');
        pfd = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
      } else if (/^\d{4}-\d{2}-\d{2}/.test(pfd)) {
        pfd = pfd.slice(0, 10); // YYYY-MM-DD already
      }
      currentTrip = {
        plan_for_date:   pfd,
        trip_no:         row['trip_no'],
        tanker_number:   String(row['tanker_number'] || '').trim(),
        route_name:      String(row['route_name'] || '').trim(),
        starting_point:  String(row['starting_point'] || '').trim() || null,
        delivery_point:  String(row['delivery_point'] || '').trim() || null,
        shifts_milk:     String(row['shifts_milk'] || '').trim(),
        expected_km:     row['expected_km'] || null,
        driver_name:     String(row['driver_name'] || '').trim() || null,
        loader_name:     String(row['loader_name'] || '').trim() || null,
        remarks:         String(row['remarks'] || '').trim() || null,
        bmcus: []
      };
    }
    const bmcuCode = String(row['bmcu_code'] || '').trim();
    const bmcuName = String(row['bmcu_name'] || '').trim();
    if (currentTrip && (bmcuCode || bmcuName)) {
      const desc = String(row['description'] || '').trim();
      const VALID_DESCS = ['RMRD', 'Balance Milk', 'Internal Shifting'];
      currentTrip.bmcus.push({
        bmcu_code:    bmcuCode || null,
        bmcu_name:    bmcuName || null,
        shift_code:   String(row['shifts_milk'] || row['shift_code'] || '').trim() || null,
        expected_qty: row['expected_qty'] ? parseFloat(row['expected_qty']) : null,
        description:  VALID_DESCS.includes(desc) ? desc : 'RMRD'
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

        let deliveryPointId = null;
        if (trip.delivery_point) {
          const dpr = await client.query(
            'SELECT id FROM delivery_points WHERE name ILIKE $1', [trip.delivery_point]
          );
          if (dpr.rows[0]) deliveryPointId = dpr.rows[0].id;
        }

        let startPointId = null;
        if (trip.starting_point) {
          const spr = await client.query(
            'SELECT id FROM starting_points WHERE name ILIKE $1', [trip.starting_point]
          );
          if (spr.rows[0]) startPointId = spr.rows[0].id;
        }

        const expKm  = parseFloat(trip.expected_km) || 0;
        const expQty = 0; // will sum from BMCUs below
        const totalCost = expKm * parseFloat(tr.rows[0].per_km_rate);

        const pr = await client.query(
          `INSERT INTO trip_plans
             (plan_date,plan_for_date,trip_no,route_id,tanker_id,start_point_id,delivery_point_id,
              shifts_milk,expected_km,expected_total_qty,total_cost,per_liter_cost,
              driver_name,loader_name,remarks,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
          [plan_date, plan_for_date, trip.trip_no||null, routeId, tr.rows[0].id, startPointId, deliveryPointId,
           trip.shifts_milk||null, expKm, expQty, totalCost, 0,
           trip.driver_name||null, trip.loader_name||null, trip.remarks||null, req.user.id]
        );
        const planId = pr.rows[0].id;

        let seq = 1; let totalExpQty = 0;
        for (const bm of trip.bmcus) {
          let br = bm.bmcu_code
            ? await client.query('SELECT id FROM bmcus WHERE bmcu_code=$1 AND is_active=TRUE', [bm.bmcu_code])
            : { rows: [] };
          if (!br.rows[0] && bm.bmcu_name) {
            br = await client.query('SELECT id FROM bmcus WHERE bmcu_name ILIKE $1 AND is_active=TRUE', [bm.bmcu_name]);
          }
          if (!br.rows[0]) { errors.push(`Trip ${rowNum}: BMCU "${bm.bmcu_code || bm.bmcu_name}" not found`); continue; }
          const qty = bm.expected_qty || 0;
          totalExpQty += qty;
          await client.query(
            'INSERT INTO trip_plan_bmcus (trip_plan_id,seq_no,bmcu_id,shift_code,expected_qty,description) VALUES ($1,$2,$3,$4,$5,$6)',
            [planId, seq++, br.rows[0].id, bm.shift_code||null, qty, bm.description||'RMRD']
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
