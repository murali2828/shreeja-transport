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

// ═════════════════════════════════════════════════════════════════════════════
// DAILY TS REPORT — reconciliation format (per Report_TMS.xlsx spec)
// One row per trip PLANNED for the report date. Column groups:
//   As per RMRD | As per Dispatch | As per Acknowledgement |
//   Difference RMRD Vs Ack (Ack−RMRD) | Difference Despatch Vs Ack (Ack−Dispatch)
// each with Qty Ltrs / Qty Kgs / Kg.Fat / Kg.SNF.
// ═════════════════════════════════════════════════════════════════════════════
const { calcKgs, calcKgFat, calcKgSnf } = require('../services/executionData');

const rN = (v, d = 2) => v == null ? null : Math.round(parseFloat(v) * 10 ** d) / 10 ** d;

async function buildTsReport(reportDate) {
  // One row per plan of the date; latest non-cancelled execution (if any).
  const r = await query(`
    SELECT
      tp.id AS plan_id, tp.trip_no, tp.shifts_milk,
      t.tanker_number, rm.route_name, dp.name AS unloading_point,
      te.id AS execution_id, te.status AS execution_status, te.dc_number, te.actual_km,

      (SELECT MIN(teb.milk_date) FROM trip_execution_bmcus teb
        WHERE teb.execution_id=te.id AND teb.is_deleted=FALSE)          AS lifting_date,
      (SELECT MIN(ta.ack_date) FROM trip_acknowledgements ta
        WHERE ta.execution_id=te.id)                                    AS ack_date,
      (SELECT COUNT(*) FROM trip_acknowledgements ta
        WHERE ta.execution_id=te.id)::int                               AS ack_count,

      -- Dispatch totals (existing TS convention: exclude Balance Milk / deleted)
      COALESCE((SELECT SUM(teb.qty_litres) FROM trip_execution_bmcus teb
        WHERE teb.execution_id=te.id AND teb.is_deleted=FALSE AND teb.description!='Balance Milk'),0) AS disp_litres,
      COALESCE((SELECT SUM(teb.qty_kgs) FROM trip_execution_bmcus teb
        WHERE teb.execution_id=te.id AND teb.is_deleted=FALSE AND teb.description!='Balance Milk'),0) AS disp_kgs,
      COALESCE((SELECT SUM(teb.kg_fat) FROM trip_execution_bmcus teb
        WHERE teb.execution_id=te.id AND teb.is_deleted=FALSE AND teb.description!='Balance Milk'),0) AS disp_kg_fat,
      COALESCE((SELECT SUM(teb.kg_snf) FROM trip_execution_bmcus teb
        WHERE teb.execution_id=te.id AND teb.is_deleted=FALSE AND teb.description!='Balance Milk'),0) AS disp_kg_snf,

      -- Acknowledgement totals
      COALESCE((SELECT SUM(ta.qty_litres) FROM trip_acknowledgements ta WHERE ta.execution_id=te.id),0) AS ack_litres,
      COALESCE((SELECT SUM(ta.qty_kgs)    FROM trip_acknowledgements ta WHERE ta.execution_id=te.id),0) AS ack_kgs,
      COALESCE((SELECT SUM(ta.kg_fat)     FROM trip_acknowledgements ta WHERE ta.execution_id=te.id),0) AS ack_kg_fat,
      COALESCE((SELECT SUM(ta.kg_snf)     FROM trip_acknowledgements ta WHERE ta.execution_id=te.id),0) AS ack_kg_snf
    FROM trip_plans tp
    LEFT JOIN LATERAL (
      SELECT * FROM trip_executions x
      WHERE x.trip_plan_id=tp.id AND x.status != 'cancelled'
      ORDER BY x.id DESC LIMIT 1
    ) te ON TRUE
    LEFT JOIN tankers t         ON t.id=tp.tanker_id
    LEFT JOIN route_masters rm  ON rm.id=tp.route_id
    LEFT JOIN delivery_points dp ON dp.id=tp.delivery_point_id
    WHERE tp.plan_for_date=$1 AND tp.status NOT IN ('cancelled','deleted')
    ORDER BY tp.trip_no`, [reportDate]);

  // RMRD totals per execution from shift rows (qty in litres; kgs/fat/snf derived).
  const execIds = r.rows.map(x => x.execution_id).filter(Boolean);
  const rmrdByExec = {};
  if (execIds.length) {
    const sr = await query(`
      SELECT tebs.execution_id, tebs.rmrd_qty, tebs.rmrd_fat_pct, tebs.rmrd_snf_pct
      FROM trip_execution_bmcu_shifts tebs
      JOIN trip_execution_bmcus teb
        ON teb.execution_id = tebs.execution_id AND teb.seq_no = tebs.bmcu_seq_no AND teb.is_deleted=FALSE
      WHERE tebs.execution_id = ANY($1)`, [execIds]);
    for (const s of sr.rows) {
      const acc = rmrdByExec[s.execution_id] ||= { litres: 0, kgs: 0, kg_fat: 0, kg_snf: 0 };
      const kgs = calcKgs(s.rmrd_qty);
      acc.litres += parseFloat(s.rmrd_qty) || 0;
      acc.kgs    += kgs;
      acc.kg_fat += calcKgFat(kgs, s.rmrd_fat_pct);
      acc.kg_snf += calcKgSnf(kgs, s.rmrd_snf_pct);
    }
  }

  return r.rows.map(row => {
    const rmrd = rmrdByExec[row.execution_id] || { litres: 0, kgs: 0, kg_fat: 0, kg_snf: 0 };
    const hasAck = row.ack_count > 0;
    const diff = (ack, other) => hasAck ? rN(parseFloat(ack) - parseFloat(other), 4) : null;
    return {
      trip_no: row.trip_no,
      tanker_number: row.tanker_number,
      lifting_date: row.lifting_date,
      ack_date: row.ack_date,
      route_name: row.route_name,
      unloading_point: row.unloading_point,
      execution_status: row.execution_status,
      shifts_milk: row.shifts_milk,
      has_ack: hasAck,
      rmrd_litres: rN(rmrd.litres), rmrd_kgs: rN(rmrd.kgs, 4),
      rmrd_kg_fat: rN(rmrd.kg_fat, 4), rmrd_kg_snf: rN(rmrd.kg_snf, 4),
      disp_litres: rN(row.disp_litres), disp_kgs: rN(row.disp_kgs, 4),
      disp_kg_fat: rN(row.disp_kg_fat, 4), disp_kg_snf: rN(row.disp_kg_snf, 4),
      ack_litres: hasAck ? rN(row.ack_litres) : null,
      ack_kgs: hasAck ? rN(row.ack_kgs, 4) : null,
      ack_kg_fat: hasAck ? rN(row.ack_kg_fat, 4) : null,
      ack_kg_snf: hasAck ? rN(row.ack_kg_snf, 4) : null,
      diff_rmrd_litres: diff(row.ack_litres, rmrd.litres),
      diff_rmrd_kgs:    diff(row.ack_kgs, rmrd.kgs),
      diff_rmrd_kg_fat: diff(row.ack_kg_fat, rmrd.kg_fat),
      diff_rmrd_kg_snf: diff(row.ack_kg_snf, rmrd.kg_snf),
      diff_disp_litres: diff(row.ack_litres, row.disp_litres),
      diff_disp_kgs:    diff(row.ack_kgs, row.disp_kgs),
      diff_disp_kg_fat: diff(row.ack_kg_fat, row.disp_kg_fat),
      diff_disp_kg_snf: diff(row.ack_kg_snf, row.disp_kg_snf),
    };
  });
}

const fmtDate = d => !d ? '' : (d.toISOString ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// Workbook in the exact Report_TMS.xlsx layout (grouped two-row header, 25 columns).
function buildTsWorkbook(rows, reportDate) {
  const groupHeader = [
    'Tanker Number', 'Milk Lifting Date', 'Ack.Date', 'Route Name', 'Unloading Point',
    'As per RMRD', null, null, null,
    'As per Dispatch', null, null, null,
    'As per Acknowledgement', null, null, null,
    'Difference RMRD Vs Ack', null, null, null,
    'Difference Despatch Vs Ack', null, null, null,
  ];
  const subHeader = [
    null, null, null, null, null,
    ...Array(5).fill(['Qty Ltrs', 'Qty Kgs', 'Kg.Fat', 'Kg.SNF']).flat(),
  ];
  const dataRows = rows.map(x => [
    x.tanker_number, fmtDate(x.lifting_date), fmtDate(x.ack_date), x.route_name, x.unloading_point,
    x.rmrd_litres, x.rmrd_kgs, x.rmrd_kg_fat, x.rmrd_kg_snf,
    x.disp_litres, x.disp_kgs, x.disp_kg_fat, x.disp_kg_snf,
    x.ack_litres, x.ack_kgs, x.ack_kg_fat, x.ack_kg_snf,
    x.diff_rmrd_litres, x.diff_rmrd_kgs, x.diff_rmrd_kg_fat, x.diff_rmrd_kg_snf,
    x.diff_disp_litres, x.diff_disp_kgs, x.diff_disp_kg_fat, x.diff_disp_kg_snf,
  ]);
  // Totals row
  const sumCol = key => rN(rows.reduce((s, x) => s + (parseFloat(x[key]) || 0), 0), 4);
  const totalRow = [
    'TOTAL', '', '', '', '',
    sumCol('rmrd_litres'), sumCol('rmrd_kgs'), sumCol('rmrd_kg_fat'), sumCol('rmrd_kg_snf'),
    sumCol('disp_litres'), sumCol('disp_kgs'), sumCol('disp_kg_fat'), sumCol('disp_kg_snf'),
    sumCol('ack_litres'), sumCol('ack_kgs'), sumCol('ack_kg_fat'), sumCol('ack_kg_snf'),
    sumCol('diff_rmrd_litres'), sumCol('diff_rmrd_kgs'), sumCol('diff_rmrd_kg_fat'), sumCol('diff_rmrd_kg_snf'),
    sumCol('diff_disp_litres'), sumCol('diff_disp_kgs'), sumCol('diff_disp_kg_fat'), sumCol('diff_disp_kg_snf'),
  ];

  const ws = XLSX.utils.aoa_to_sheet([groupHeader, subHeader, ...dataRows, totalRow]);
  // Merges: info columns span both header rows; each group title spans its 4 columns.
  ws['!merges'] = [
    ...[0, 1, 2, 3, 4].map(c => ({ s: { r: 0, c }, e: { r: 1, c } })),
    ...[5, 9, 13, 17, 21].map(c => ({ s: { r: 0, c }, e: { r: 0, c: c + 3 } })),
  ];
  ws['!cols'] = groupHeader.map((_, i) => ({ wch: i < 5 ? 16 : 11 }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `TS Report ${reportDate}`);
  return wb;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/daily-ts?report_date=YYYY-MM-DD   (planning date)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/daily-ts', authenticate, async (req, res) => {
  const reportDate = req.query.report_date || req.query.from_date;
  if (!reportDate) return res.status(400).json({ error: 'report_date required' });
  try {
    res.json(await buildTsReport(reportDate));
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
// GET /api/reports/daily-ts/excel?report_date=YYYY-MM-DD  (planning date)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/daily-ts/excel', authenticate, async (req, res) => {
  const { report_date } = req.query;
  if (!report_date) return res.status(400).json({ error: 'report_date required' });
  try {
    const rows = await buildTsReport(report_date);
    const wb   = buildTsWorkbook(rows, report_date);
    const buf  = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename=ts_report_${report_date}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reports/send-email  { report_date }  — same workbook as the download
// ─────────────────────────────────────────────────────────────────────────────
router.post('/send-email', authenticate, async (req, res) => {
  const { report_date } = req.body;
  if (!report_date) return res.status(400).json({ error: 'report_date required' });
  try {
    const recipients = await query(
      'SELECT email, full_name FROM report_email_config WHERE is_active=TRUE'
    );
    if (!recipients.rows.length)
      return res.status(400).json({ error: 'No active email recipients configured' });

    const rows = await buildTsReport(report_date);
    const wb   = buildTsWorkbook(rows, report_date);
    const buf  = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const acked = rows.filter(r => r.has_ack).length;
    const transporter = createTransport();
    await transporter.sendMail({
      from:    process.env.SMTP_FROM,
      to:      recipients.rows.map(r => `${r.full_name} <${r.email}>`).join(', '),
      subject: `Daily TS Report — ${report_date}`,
      html: `<p>Dear Team,</p>
             <p>Please find attached the Daily TS Report for <strong>${report_date}</strong> (planning date).</p>
             <p>Trips planned: ${rows.length} · Acknowledged: ${acked}</p>
             <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;"/>
             <p style="font-family:sans-serif;font-size:12px;color:#9ca3af;">This is an automated message from Shreeja TMS · Developed &amp; maintained by <strong style="color:#6b7280;">Shreeja IT Team</strong>.</p>`,
      attachments: [{
        filename: `ts_report_${report_date}.xlsx`,
        content: buf,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }],
    });
    res.json({ sent: true, recipients: recipients.rows.length });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
