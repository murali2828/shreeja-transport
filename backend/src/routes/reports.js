const router = require('express').Router();
const XLSX = require('xlsx');
const nodemailer = require('nodemailer');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// Daily TS Report data
router.get('/daily-ts', authenticate, async (req, res) => {
  const { from_date, to_date } = req.query;
  if (!from_date || !to_date) return res.status(400).json({ error: 'from_date and to_date required' });

  const r = await query(`
    SELECT
      te.id AS execution_id,
      te.execution_date,
      tp.plan_for_date AS milk_lifting_date,
      t.tanker_number,
      t.capacity_litres AS tanker_qty,
      rm.route_name,
      sp.name AS started_from,
      dp.name AS delivery_point,
      dp.receiver_name AS receiver,

      -- As per Scale (DPS)
      SUM(teb.dps_qty_litres) AS dps_qty_litres,
      SUM(teb.dps_qty_kgs) AS dps_qty_kgs,

      -- As per Truck Sheet (RMRD)
      te.total_qty_litres AS truck_qty_litres,
      te.total_qty_kgs AS truck_qty_kgs,
      te.avg_fat AS truck_fat,
      te.avg_snf AS truck_snf,
      te.total_kg_fat AS truck_kg_fat,
      te.total_kg_snf AS truck_kg_snf,

      -- Utilization
      CASE WHEN t.capacity_litres > 0
        THEN ROUND((te.total_qty_litres / t.capacity_litres * 100)::numeric, 2)
        ELSE 0 END AS utilization_pct,

      -- Acknowledgement
      (SELECT SUM(qty_litres) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_qty_litres,
      (SELECT SUM(qty_kgs) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_qty_kgs,
      (SELECT CASE WHEN SUM(qty_kgs)>0 THEN ROUND((SUM(kg_fat)/SUM(qty_kgs)*100)::numeric,4) ELSE 0 END FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_fat,
      (SELECT CASE WHEN SUM(qty_kgs)>0 THEN ROUND((SUM(kg_snf)/SUM(qty_kgs)*100)::numeric,4) ELSE 0 END FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_snf,
      (SELECT SUM(kg_fat) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_kg_fat,
      (SELECT SUM(kg_snf) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_kg_snf,
      (SELECT STRING_AGG(temperature, '/') FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS temperature,

      tp.trip_no,
      te.actual_km
    FROM trip_executions te
    JOIN trip_plans tp ON te.trip_plan_id=tp.id
    LEFT JOIN tankers t ON tp.tanker_id=t.id
    LEFT JOIN route_masters rm ON tp.route_id=rm.id
    LEFT JOIN starting_points sp ON tp.start_point_id=sp.id
    LEFT JOIN delivery_points dp ON tp.delivery_point_id=dp.id
    LEFT JOIN trip_execution_bmcus teb ON teb.execution_id=te.id AND teb.is_deleted=FALSE
    WHERE te.execution_date BETWEEN $1 AND $2
      AND te.status='closed'
    GROUP BY te.id, tp.id, t.id, rm.id, sp.id, dp.id
    ORDER BY te.execution_date, tp.trip_no
  `, [from_date, to_date]);

  res.json(r.rows);
});

// BMCU-wise report
router.get('/bmcu-wise', authenticate, async (req, res) => {
  const { from_date, to_date } = req.query;
  const r = await query(`
    SELECT
      b.bmcu_code, b.bmcu_name,
      te.execution_date,
      teb.milk_date, teb.shift,
      teb.qty_litres, teb.qty_kgs, teb.fat_pct, teb.snf_pct, teb.kg_fat, teb.kg_snf,
      teb.description, teb.chamber,
      t.tanker_number, rm.route_name,
      teb.dps_qty_litres, teb.dps_qty_kgs, teb.rmrd_qty
    FROM trip_execution_bmcus teb
    JOIN bmcus b ON teb.bmcu_id=b.id
    JOIN trip_executions te ON teb.execution_id=te.id
    JOIN trip_plans tp ON te.trip_plan_id=tp.id
    LEFT JOIN tankers t ON tp.tanker_id=t.id
    LEFT JOIN route_masters rm ON tp.route_id=rm.id
    WHERE te.execution_date BETWEEN $1 AND $2
      AND teb.is_deleted=FALSE
    ORDER BY b.bmcu_code, te.execution_date, teb.milk_date, teb.shift
  `, [from_date, to_date]);
  res.json(r.rows);
});

// Generate Excel report
router.get('/daily-ts/excel', authenticate, async (req, res) => {
  const { report_date } = req.query;
  if (!report_date) return res.status(400).json({ error: 'report_date required' });

  const r = await query(`
    SELECT
      ROW_NUMBER() OVER (ORDER BY te.execution_date, tp.trip_no) AS sno,
      sp.name AS started_from,
      dp.receiver_name AS receiver,
      tp.plan_for_date AS milk_lifting_date,
      te.execution_date AS ack_date,
      t.tanker_number,
      rm.route_name,
      '' AS temperature,
      SUM(teb.dps_qty_litres) AS dps_qty_ltrs,
      ROUND((SUM(teb.dps_qty_litres) * 1.0285)::numeric, 4) AS dps_qty_kgs,
      te.avg_fat AS truck_fat, te.avg_snf AS truck_snf,
      te.total_kg_fat AS truck_kg_fat, te.total_kg_snf AS truck_kg_snf,
      te.total_qty_litres AS truck_qty_ltrs, te.total_qty_kgs AS truck_qty_kgs,
      (SELECT SUM(qty_litres) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_qty_ltrs,
      (SELECT SUM(qty_kgs) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_qty_kgs,
      (SELECT CASE WHEN SUM(qty_kgs)>0 THEN ROUND((SUM(kg_fat)/SUM(qty_kgs)*100)::numeric,4) ELSE 0 END FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_fat,
      (SELECT CASE WHEN SUM(qty_kgs)>0 THEN ROUND((SUM(kg_snf)/SUM(qty_kgs)*100)::numeric,4) ELSE 0 END FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_snf,
      (SELECT SUM(kg_fat) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_kg_fat,
      (SELECT SUM(kg_snf) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_kg_snf,
      t.capacity_litres AS tanker_qty,
      CASE WHEN t.capacity_litres > 0 THEN ROUND((te.total_qty_litres / t.capacity_litres * 100)::numeric, 2) ELSE 0 END AS utilization_pct,
      -- Variations (Ack - Truck)
      (SELECT SUM(qty_litres) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) - te.total_qty_litres AS qty_variation,
      (SELECT SUM(kg_fat) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) - te.total_kg_fat AS kg_fat_variation,
      (SELECT SUM(kg_snf) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) - te.total_kg_snf AS kg_snf_variation,
      rm.route_name AS route_name_2
    FROM trip_executions te
    JOIN trip_plans tp ON te.trip_plan_id=tp.id
    LEFT JOIN tankers t ON tp.tanker_id=t.id
    LEFT JOIN route_masters rm ON tp.route_id=rm.id
    LEFT JOIN starting_points sp ON tp.start_point_id=sp.id
    LEFT JOIN delivery_points dp ON tp.delivery_point_id=dp.id
    LEFT JOIN trip_execution_bmcus teb ON teb.execution_id=te.id AND teb.is_deleted=FALSE
    WHERE te.execution_date=$1 AND te.status='closed'
    GROUP BY te.id, tp.id, t.id, rm.id, sp.id, dp.id
    ORDER BY tp.trip_no
  `, [report_date]);

  const wb = XLSX.utils.book_new();

  // Build headers matching TS Report format
  const headerRow1 = [`Daily Milk Procurement Total Solid variation Report On ${report_date}`];
  const headerRow2 = ['Unloading at Balaji Dairy'];
  const headerRow3 = ['','','','','','','','',
    'As per Scale Reading Quantity','','','','','',
    'As per Truck sheet','','','','','',
    'As per Balaji Dairy','','','','','',
    'Variation As per Ack-Trucksheet','','',''];
  const headerRow4 = ['S.NO','Started from','Receiver','Milk Lifting Date','Ack date',
    'Tanker Number','Route Name','Temperature',
    'Qty Ltrs','Qty Kgs','Fat','SNF','KG Fat','Kg SNF',
    'Qty Lts','Qty Kgs','Fat','SNF','KG Fat','Kg SNF',
    'Qty Ltrs','Qty Kgs','Fat','SNF','KG Fat','Kg SNF',
    'Qty Variation','Kg fat+/-','Kg SNF+/-','TS+/-',
    'Route Name','Tanker Qty','Utilization %'];

  const dataRows = r.rows.map(row => [
    row.sno, row.started_from, row.receiver,
    row.milk_lifting_date ? new Date(row.milk_lifting_date).toLocaleDateString('en-IN') : '',
    row.ack_date ? new Date(row.ack_date).toLocaleDateString('en-IN') : '',
    row.tanker_number, row.route_name, row.temperature || '',
    row.dps_qty_ltrs, row.dps_qty_kgs, '', '', '', '',
    row.truck_qty_ltrs, row.truck_qty_kgs, row.truck_fat, row.truck_snf, row.truck_kg_fat, row.truck_kg_snf,
    row.ack_qty_ltrs, row.ack_qty_kgs, row.ack_fat, row.ack_snf, row.ack_kg_fat, row.ack_kg_snf,
    row.qty_variation, row.kg_fat_variation, row.kg_snf_variation,
    parseFloat(row.kg_fat_variation||0) + parseFloat(row.kg_snf_variation||0),
    row.route_name_2, row.tanker_qty, row.utilization_pct
  ]);

  const ws = XLSX.utils.aoa_to_sheet([headerRow1, headerRow2, headerRow3, headerRow4, ...dataRows]);
  ws['!cols'] = Array(33).fill({ wch: 14 });
  XLSX.utils.book_append_sheet(wb, ws, report_date.replace(/-/g,'.').slice(5));

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename=TS_Report_${report_date}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Send daily report by email
router.post('/send-email', authenticate, async (req, res) => {
  const { report_date } = req.body;
  if (!report_date) return res.status(400).json({ error: 'report_date required' });

  try {
    // Get email recipients
    const emailRes = await query('SELECT email, full_name FROM report_email_config WHERE is_active=TRUE');
    if (!emailRes.rows.length) return res.status(400).json({ error: 'No active email recipients configured' });

    // Fetch data
    const r = await query(`
      SELECT
        ROW_NUMBER() OVER (ORDER BY tp.trip_no) AS sno,
        sp.name AS started_from, dp.receiver_name AS receiver,
        tp.plan_for_date AS milk_lifting_date, te.execution_date AS ack_date,
        t.tanker_number, rm.route_name,
        SUM(teb.dps_qty_litres) AS dps_qty_ltrs,
        ROUND((SUM(teb.dps_qty_litres)*1.0285)::numeric,4) AS dps_qty_kgs,
        te.avg_fat AS truck_fat, te.avg_snf AS truck_snf,
        te.total_kg_fat AS truck_kg_fat, te.total_kg_snf AS truck_kg_snf,
        te.total_qty_litres AS truck_qty_ltrs, te.total_qty_kgs AS truck_qty_kgs,
        (SELECT SUM(qty_litres) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_qty_ltrs,
        (SELECT SUM(qty_kgs) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_qty_kgs,
        (SELECT CASE WHEN SUM(qty_kgs)>0 THEN ROUND((SUM(kg_fat)/SUM(qty_kgs)*100)::numeric,4) ELSE 0 END FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_fat,
        (SELECT CASE WHEN SUM(qty_kgs)>0 THEN ROUND((SUM(kg_snf)/SUM(qty_kgs)*100)::numeric,4) ELSE 0 END FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_snf,
        (SELECT SUM(kg_fat) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_kg_fat,
        (SELECT SUM(kg_snf) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) AS ack_kg_snf,
        t.capacity_litres AS tanker_qty,
        CASE WHEN t.capacity_litres>0 THEN ROUND((te.total_qty_litres/t.capacity_litres*100)::numeric,2) ELSE 0 END AS utilization_pct,
        (SELECT SUM(qty_litres) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) - te.total_qty_litres AS qty_variation,
        (SELECT SUM(kg_fat) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) - te.total_kg_fat AS kg_fat_variation,
        (SELECT SUM(kg_snf) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id) - te.total_kg_snf AS kg_snf_variation
      FROM trip_executions te
      JOIN trip_plans tp ON te.trip_plan_id=tp.id
      LEFT JOIN tankers t ON tp.tanker_id=t.id
      LEFT JOIN route_masters rm ON tp.route_id=rm.id
      LEFT JOIN starting_points sp ON tp.start_point_id=sp.id
      LEFT JOIN delivery_points dp ON tp.delivery_point_id=dp.id
      LEFT JOIN trip_execution_bmcus teb ON teb.execution_id=te.id AND teb.is_deleted=FALSE
      WHERE te.execution_date=$1 AND te.status='closed'
      GROUP BY te.id, tp.id, t.id, rm.id, sp.id, dp.id
      ORDER BY tp.trip_no
    `, [report_date]);

    // Build Excel
    const wb = XLSX.utils.book_new();
    const headers = ['S.NO','Started from','Receiver','Milk Lifting Date','Ack date','Tanker Number','Route Name',
      'DPS Qty Ltrs','DPS Qty Kgs','Truck Qty Ltrs','Truck Qty Kgs','Truck Fat','Truck SNF','Truck KG Fat','Truck KG SNF',
      'Ack Qty Ltrs','Ack Qty Kgs','Ack Fat','Ack SNF','Ack KG Fat','Ack KG SNF',
      'Qty Variation','KG Fat +/-','KG SNF +/-','TS +/-','Tanker Qty','Utilization %'];

    const data = r.rows.map(row => [
      row.sno, row.started_from, row.receiver,
      row.milk_lifting_date ? new Date(row.milk_lifting_date).toLocaleDateString('en-IN') : '',
      row.ack_date ? new Date(row.ack_date).toLocaleDateString('en-IN') : '',
      row.tanker_number, row.route_name,
      row.dps_qty_ltrs, row.dps_qty_kgs,
      row.truck_qty_ltrs, row.truck_qty_kgs, row.truck_fat, row.truck_snf, row.truck_kg_fat, row.truck_kg_snf,
      row.ack_qty_ltrs, row.ack_qty_kgs, row.ack_fat, row.ack_snf, row.ack_kg_fat, row.ack_kg_snf,
      row.qty_variation, row.kg_fat_variation, row.kg_snf_variation,
      parseFloat(row.kg_fat_variation||0) + parseFloat(row.kg_snf_variation||0),
      row.tanker_qty, row.utilization_pct
    ]);

    const ws = XLSX.utils.aoa_to_sheet([
      [`Daily Milk Procurement TS Report - ${report_date}`],
      headers,
      ...data
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Daily TS Report');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    const toList = emailRes.rows.map(e => e.email).join(',');
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: toList,
      subject: `Daily Milk TS Report - ${report_date}`,
      text: `Please find attached the Daily Milk Procurement Total Solid Variation Report for ${report_date}.\n\nTotal trips: ${r.rows.length}`,
      attachments: [{
        filename: `TS_Report_${report_date}.xlsx`,
        content: buf,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }]
    });

    res.json({ success: true, sent_to: emailRes.rows.length, recipients: emailRes.rows.map(e => e.email) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
