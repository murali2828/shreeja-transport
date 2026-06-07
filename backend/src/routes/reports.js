// backend/src/routes/reports.js
const express    = require('express');
const router     = express.Router();
const XLSX       = require('xlsx');
const nodemailer = require('nodemailer');
const { query }  = require('../config/db');
const { authenticate } = require('../middleware/auth');

// ─── Mailer factory ───────────────────────────────────────────────────────────
function createTransport() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/daily-ts?from_date=&to_date=
// ─────────────────────────────────────────────────────────────────────────────
router.get('/daily-ts', authenticate, async (req, res) => {
  const { from_date, to_date } = req.query;
  if (!from_date || !to_date)
    return res.status(400).json({ error: 'from_date and to_date required' });
  try {
    const r = await query(`
      SELECT
        te.execution_date,
        tp.trip_no,
        t.tanker_number,
        rm.route_name,
        sp.name AS start_point_name,
        dp.name AS delivery_point_name,
        te.dc_number,
        te.actual_km,

        -- DPS totals
        COALESCE(SUM(teb.dps_qty_litres) FILTER(WHERE teb.is_deleted=FALSE AND teb.description!='Balance Milk'),0) AS dps_litres,
        COALESCE(SUM(teb.dps_qty_kgs)    FILTER(WHERE teb.is_deleted=FALSE AND teb.description!='Balance Milk'),0) AS dps_kgs,

        -- Truck Sheet totals
        te.total_qty_litres  AS ts_litres,
        te.total_qty_kgs     AS ts_kgs,
        te.avg_fat           AS ts_fat,
        te.avg_snf           AS ts_snf,
        te.total_kg_fat      AS ts_kg_fat,
        te.total_kg_snf      AS ts_kg_snf,

        -- Acknowledgement totals
        COALESCE((SELECT SUM(ta.qty_litres) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id),0) AS ack_litres,
        COALESCE((SELECT SUM(ta.qty_kgs)    FROM trip_acknowledgements ta WHERE ta.execution_id=te.id),0) AS ack_kgs,
        COALESCE((SELECT SUM(ta.kg_fat)     FROM trip_acknowledgements ta WHERE ta.execution_id=te.id),0) AS ack_kg_fat,
        COALESCE((SELECT SUM(ta.kg_snf)     FROM trip_acknowledgements ta WHERE ta.execution_id=te.id),0) AS ack_kg_snf,
        (SELECT STRING_AGG(ta.temperature, ' / ') FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS temperature,

        tp.trip_no,
        tp.shifts_milk
      FROM trip_executions te
      JOIN trip_plans tp ON te.trip_plan_id=tp.id
      LEFT JOIN tankers t              ON t.id=tp.tanker_id
      LEFT JOIN route_masters rm       ON rm.id=tp.route_id
      LEFT JOIN starting_points sp     ON sp.id=tp.start_point_id
      LEFT JOIN delivery_points dp     ON dp.id=tp.delivery_point_id
      LEFT JOIN trip_execution_bmcus teb ON teb.execution_id=te.id
      WHERE te.execution_date BETWEEN $1 AND $2 AND te.status='closed'
      GROUP BY te.id, tp.id, t.id, rm.id, sp.id, dp.id
      ORDER BY te.execution_date, tp.trip_no`,
      [from_date, to_date]
    );

    // Fetch shift-level RMRD rows for all executions in range
    const execIds = r.rows.map(row => row.id);
    let shiftMap = {};
    if (execIds.length) {
      const sr = await query(`
        SELECT tebs.execution_id, tebs.bmcu_seq_no, tebs.milk_date, tebs.shift,
               tebs.rmrd_qty, tebs.rmrd_fat_pct, tebs.rmrd_snf_pct,
               b.bmcu_code, b.bmcu_name
        FROM trip_execution_bmcu_shifts tebs
        JOIN trip_execution_bmcus teb
          ON teb.execution_id = tebs.execution_id AND teb.seq_no = tebs.bmcu_seq_no AND teb.is_deleted=FALSE
        JOIN bmcus b ON b.id = teb.bmcu_id
        WHERE tebs.execution_id = ANY($1)
        ORDER BY tebs.execution_id, tebs.bmcu_seq_no, tebs.id`,
        [execIds]
      );
      for (const s of sr.rows) {
        if (!shiftMap[s.execution_id]) shiftMap[s.execution_id] = [];
        shiftMap[s.execution_id].push(s);
      }
    }

    // Compute variations and attach shift rows
    const rows = r.rows.map(row => ({
      ...row,
      var_litres: parseFloat(row.ack_litres) - parseFloat(row.ts_litres),
      var_kgs:    parseFloat(row.ack_kgs)    - parseFloat(row.ts_kgs),
      var_kg_fat: parseFloat(row.ack_kg_fat) - parseFloat(row.ts_kg_fat),
      var_kg_snf: parseFloat(row.ack_kg_snf) - parseFloat(row.ts_kg_snf),
      shift_rows: shiftMap[row.id] || [],
    }));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/bmcu-wise?from_date=&to_date=
// ─────────────────────────────────────────────────────────────────────────────
router.get('/bmcu-wise', authenticate, async (req, res) => {
  const { from_date, to_date } = req.query;
  if (!from_date || !to_date)
    return res.status(400).json({ error: 'from_date and to_date required' });
  try {
    const r = await query(`
      SELECT
        b.bmcu_code, b.bmcu_name, b.district, b.state,
        te.execution_date,
        teb.milk_date, teb.shift,
        teb.qty_litres, teb.qty_kgs,
        teb.fat_pct,   teb.snf_pct,
        teb.kg_fat,    teb.kg_snf,
        teb.description, teb.chamber,
        teb.dps_qty_litres, teb.dps_qty_kgs, teb.rmrd_qty,
        t.tanker_number, rm.route_name
      FROM trip_execution_bmcus teb
      JOIN bmcus b              ON b.id=teb.bmcu_id
      JOIN trip_executions te   ON te.id=teb.execution_id
      JOIN trip_plans tp        ON tp.id=te.trip_plan_id
      LEFT JOIN tankers t       ON t.id=tp.tanker_id
      LEFT JOIN route_masters rm ON rm.id=tp.route_id
      WHERE te.execution_date BETWEEN $1 AND $2
        AND teb.is_deleted=FALSE
      ORDER BY b.bmcu_code, te.execution_date, teb.milk_date, teb.shift`,
      [from_date, to_date]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/daily-ts/excel?report_date=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────
router.get('/daily-ts/excel', authenticate, async (req, res) => {
  const { report_date } = req.query;
  if (!report_date) return res.status(400).json({ error: 'report_date required' });

  try {
    const r = await query(`
      SELECT
        te.execution_date, tp.trip_no, t.tanker_number, rm.route_name,
        sp.name AS start_point, dp.name AS delivery_point,
        te.dc_number, te.actual_km, tp.shifts_milk,
        COALESCE(SUM(teb.dps_qty_litres) FILTER(WHERE teb.is_deleted=FALSE AND teb.description!='Balance Milk'),0) AS dps_litres,
        COALESCE(SUM(teb.dps_qty_kgs)    FILTER(WHERE teb.is_deleted=FALSE AND teb.description!='Balance Milk'),0) AS dps_kgs,
        te.total_qty_litres AS ts_litres, te.total_qty_kgs AS ts_kgs,
        te.avg_fat, te.avg_snf, te.total_kg_fat, te.total_kg_snf,
        COALESCE((SELECT SUM(ta.qty_litres) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id),0) AS ack_litres,
        COALESCE((SELECT SUM(ta.qty_kgs)    FROM trip_acknowledgements ta WHERE ta.execution_id=te.id),0) AS ack_kgs,
        COALESCE((SELECT SUM(ta.kg_fat)     FROM trip_acknowledgements ta WHERE ta.execution_id=te.id),0) AS ack_kg_fat,
        COALESCE((SELECT SUM(ta.kg_snf)     FROM trip_acknowledgements ta WHERE ta.execution_id=te.id),0) AS ack_kg_snf,
        (SELECT STRING_AGG(ta.temperature, ' / ') FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS temperature
      FROM trip_executions te
      JOIN trip_plans tp ON te.trip_plan_id=tp.id
      LEFT JOIN tankers t             ON t.id=tp.tanker_id
      LEFT JOIN route_masters rm      ON rm.id=tp.route_id
      LEFT JOIN starting_points sp    ON sp.id=tp.start_point_id
      LEFT JOIN delivery_points dp    ON dp.id=tp.delivery_point_id
      LEFT JOIN trip_execution_bmcus teb ON teb.execution_id=te.id
      WHERE te.execution_date=$1 AND te.status='closed'
      GROUP BY te.id, tp.id, t.id, rm.id, sp.id, dp.id
      ORDER BY tp.trip_no`, [report_date]
    );

    // Fetch shift detail rows for Excel sheet 2
    const execIds = r.rows.map(row => row.id);
    let shiftRows = [];
    if (execIds.length) {
      const sr = await query(`
        SELECT te.execution_date, tp.trip_no, t.tanker_number,
               tebs.bmcu_seq_no, b.bmcu_code, b.bmcu_name,
               tebs.milk_date, tebs.shift, tebs.rmrd_qty, tebs.rmrd_fat_pct, tebs.rmrd_snf_pct
        FROM trip_execution_bmcu_shifts tebs
        JOIN trip_executions te ON te.id = tebs.execution_id
        JOIN trip_plans tp ON tp.id = te.trip_plan_id
        LEFT JOIN tankers t ON t.id = tp.tanker_id
        JOIN trip_execution_bmcus teb
          ON teb.execution_id = tebs.execution_id AND teb.seq_no = tebs.bmcu_seq_no AND teb.is_deleted=FALSE
        JOIN bmcus b ON b.id = teb.bmcu_id
        WHERE tebs.execution_id = ANY($1)
        ORDER BY te.execution_date, tp.trip_no, tebs.bmcu_seq_no, tebs.id`,
        [execIds]
      );
      shiftRows = sr.rows;
    }

    const wb = XLSX.utils.book_new();

    // Sheet 1: TS Summary
    const headers = [
      'Date','Trip','Tanker','Route','Start Point','Delivery Point','Shift','DC No','Actual KM',
      'DPS Litres','DPS Kgs',
      'TS Litres','TS Kgs','TS Avg Fat%','TS Avg SNF%','TS Kg Fat','TS Kg SNF',
      'Ack Litres','Ack Kgs','Ack Kg Fat','Ack Kg SNF','Temperature',
      'Var Litres','Var Kgs','Var Kg Fat','Var Kg SNF'
    ];
    const dataRows = r.rows.map(row => {
      const vLit = parseFloat(row.ack_litres) - parseFloat(row.ts_litres);
      const vKgs = parseFloat(row.ack_kgs)    - parseFloat(row.ts_kgs);
      const vFat = parseFloat(row.ack_kg_fat) - parseFloat(row.total_kg_fat);
      const vSnf = parseFloat(row.ack_kg_snf) - parseFloat(row.total_kg_snf);
      return [
        row.execution_date?.toISOString?.().slice(0,10) || row.execution_date,
        row.trip_no, row.tanker_number, row.route_name,
        row.start_point, row.delivery_point, row.shifts_milk, row.dc_number, row.actual_km,
        row.dps_litres, row.dps_kgs,
        row.ts_litres, row.ts_kgs, row.avg_fat, row.avg_snf, row.total_kg_fat, row.total_kg_snf,
        row.ack_litres, row.ack_kgs, row.ack_kg_fat, row.ack_kg_snf, row.temperature,
        vLit.toFixed(2), vKgs.toFixed(4), vFat.toFixed(4), vSnf.toFixed(4)
      ];
    });
    const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
    ws['!cols'] = headers.map((_, i) => ({ wch: i < 9 ? 16 : 12 }));
    XLSX.utils.book_append_sheet(wb, ws, `TS Report ${report_date}`);

    // Sheet 2: RMRD Shift Detail
    const shiftHeaders = [
      'Date','Trip','Tanker','BMCU Code','BMCU Name','Milk Date','Shift',
      'RMRD Qty (L)','RMRD Fat%','RMRD SNF%'
    ];
    const shiftDataRows = shiftRows.map(s => [
      s.execution_date?.toISOString?.().slice(0,10) || s.execution_date,
      s.trip_no, s.tanker_number,
      s.bmcu_code, s.bmcu_name,
      s.milk_date?.toISOString?.().slice(0,10) || s.milk_date,
      s.shift,
      s.rmrd_qty, s.rmrd_fat_pct, s.rmrd_snf_pct
    ]);
    const ws2 = XLSX.utils.aoa_to_sheet([shiftHeaders, ...shiftDataRows]);
    ws2['!cols'] = shiftHeaders.map((_, i) => ({ wch: i < 5 ? 18 : 12 }));
    XLSX.utils.book_append_sheet(wb, ws2, 'RMRD Shift Detail');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename=ts_report_${report_date}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reports/send-email  { report_date }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/send-email', authenticate, async (req, res) => {
  const { report_date } = req.body;
  if (!report_date) return res.status(400).json({ error: 'report_date required' });

  try {
    const recipients = await query(
      'SELECT email, full_name FROM report_email_config WHERE is_active=TRUE'
    );
    if (!recipients.rows.length) return res.status(400).json({ error: 'No active email recipients configured' });

    // Build Excel buffer (reuse report query)
    const r = await query(`
      SELECT te.execution_date, tp.trip_no, t.tanker_number,
        te.total_qty_litres AS ts_litres, te.total_qty_kgs AS ts_kgs,
        te.avg_fat, te.avg_snf, te.total_kg_fat, te.total_kg_snf,
        COALESCE((SELECT SUM(ta.qty_litres) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id),0) AS ack_litres,
        COALESCE((SELECT SUM(ta.qty_kgs)    FROM trip_acknowledgements ta WHERE ta.execution_id=te.id),0) AS ack_kgs
      FROM trip_executions te
      JOIN trip_plans tp ON te.trip_plan_id=tp.id
      LEFT JOIN tankers t ON t.id=tp.tanker_id
      WHERE te.execution_date=$1 AND te.status='closed'
      ORDER BY tp.trip_no`, [report_date]
    );

    const wb   = XLSX.utils.book_new();
    const rows = [
      ['Date','Trip','Tanker','TS Litres','TS Kgs','Avg Fat%','Avg SNF%','Kg Fat','Kg SNF','Ack Litres','Ack Kgs'],
      ...r.rows.map(row => [
        row.execution_date?.toISOString?.().slice(0,10)||row.execution_date,
        row.trip_no, row.tanker_number,
        row.ts_litres, row.ts_kgs, row.avg_fat, row.avg_snf, row.total_kg_fat, row.total_kg_snf,
        row.ack_litres, row.ack_kgs
      ])
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'TS Report');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const transporter = createTransport();
    const toList = recipients.rows.map(r => `${r.full_name} <${r.email}>`).join(', ');

    await transporter.sendMail({
      from:    process.env.SMTP_FROM,
      to:      toList,
      subject: `TS Report — ${report_date}`,
      text:    `Please find attached the TS Variation Report for ${report_date}.`,
      html:    `<p>Dear Team,</p><p>Please find attached the TS Variation Report for <strong>${report_date}</strong>.</p><p>Trips closed: ${r.rows.length}</p>`,
      attachments: [{
        filename:    `ts_report_${report_date}.xlsx`,
        content:     buf,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }]
    });

    res.json({ sent: true, recipients: recipients.rows.length });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
