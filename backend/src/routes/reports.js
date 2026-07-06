// backend/src/routes/reports.js
const express    = require('express');
const router     = express.Router();
const ExcelJS    = require('exceljs');
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
//   Difference RMRD Vs Ack (Ack−RMRD) | Difference Dispatch Vs Ack (Ack−Dispatch)
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

    // RMRD adjustments from sub-entries (user rules):
    //   Left Over milk    → DEDUCT from RMRD (milk left behind at the BMCU)
    //   Lifted milk       → ADD to RMRD (extra milk lifted)
    //   Internal shifting → ADD to the receiving trip's RMRD, and DEDUCT the same
    //                       qty/kg fat/kg snf from the trip containing the SOURCE
    //                       plant (milk moved out of that BMCU's RMRD)
    //   New MPP           → ADD to RMRD (new MPP milk collected on the trip)
    // Map BMCU → executions of this report date (to locate the source plant's trip).
    const bm2exec = {};
    const bmRes = await query(`
      SELECT DISTINCT execution_id, bmcu_id FROM trip_execution_bmcus
      WHERE execution_id = ANY($1) AND is_deleted=FALSE`, [execIds]);
    for (const b of bmRes.rows) (bm2exec[b.bmcu_id] ||= []).push(b.execution_id);

    const applyAdj = (execId, sign, qty, fat, snf) => {
      const acc = rmrdByExec[execId] ||= { litres: 0, kgs: 0, kg_fat: 0, kg_snf: 0 };
      const kgs = calcKgs(qty);
      acc.litres += sign * (parseFloat(qty) || 0);
      acc.kgs    += sign * kgs;
      acc.kg_fat += sign * calcKgFat(kgs, fat);
      acc.kg_snf += sign * calcKgSnf(kgs, snf);
    };

    const er = await query(`
      SELECT execution_id, kind, category, qty_litres, fat_pct, snf_pct, source_bmcu_id
      FROM trip_execution_bmcu_entries
      WHERE execution_id = ANY($1)`, [execIds]);
    for (const e of er.rows) {
      if (!e.qty_litres) continue;
      if (e.kind === 'balance_milk' && e.category === 'Left Over milk') {
        applyAdj(e.execution_id, -1, e.qty_litres, e.fat_pct, e.snf_pct);
      } else if (e.kind === 'balance_milk' && e.category === 'Lifted milk') {
        applyAdj(e.execution_id, 1, e.qty_litres, e.fat_pct, e.snf_pct);
      } else if (e.kind === 'new_mpp') {
        applyAdj(e.execution_id, 1, e.qty_litres, e.fat_pct, e.snf_pct);
      } else if (e.kind === 'internal_shifting') {
        applyAdj(e.execution_id, 1, e.qty_litres, e.fat_pct, e.snf_pct); // receiving trip
        // Deduct from the trip that carries the source plant (prefer the same trip).
        const srcExecs = bm2exec[e.source_bmcu_id] || [];
        const target = srcExecs.includes(e.execution_id) ? e.execution_id : srcExecs[0];
        if (target) applyAdj(target, -1, e.qty_litres, e.fat_pct, e.snf_pct);
      }
    }
  }

  return r.rows.map(row => {
    const rmrd = rmrdByExec[row.execution_id] || { litres: 0, kgs: 0, kg_fat: 0, kg_snf: 0 };
    const hasAck = row.ack_count > 0;
    const diff = (ack, other) => hasAck ? rN(parseFloat(ack) - parseFloat(other), 2) : null;
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
      rmrd_litres: rN(rmrd.litres), rmrd_kgs: rN(rmrd.kgs, 2),
      rmrd_kg_fat: rN(rmrd.kg_fat, 2), rmrd_kg_snf: rN(rmrd.kg_snf, 2),
      disp_litres: rN(row.disp_litres), disp_kgs: rN(row.disp_kgs, 2),
      disp_kg_fat: rN(row.disp_kg_fat, 2), disp_kg_snf: rN(row.disp_kg_snf, 2),
      ack_litres: hasAck ? rN(row.ack_litres) : null,
      ack_kgs: hasAck ? rN(row.ack_kgs, 2) : null,
      ack_kg_fat: hasAck ? rN(row.ack_kg_fat, 2) : null,
      ack_kg_snf: hasAck ? rN(row.ack_kg_snf, 2) : null,
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

// Styled workbook (ExcelJS) matching the on-screen layout:
// title row, grouped two-row colored header, section fills, red/green
// differences, frozen panes, Indian number formats, bold totals.
const TS_GROUPS = [
  { title: 'As per RMRD',                fill: 'FFE0F2FE', keys: ['rmrd_litres','rmrd_kgs','rmrd_kg_fat','rmrd_kg_snf'] },
  { title: 'As per Dispatch',            fill: 'FFDCFCE7', keys: ['disp_litres','disp_kgs','disp_kg_fat','disp_kg_snf'] },
  { title: 'As per Acknowledgement',     fill: 'FFEDE9FE', keys: ['ack_litres','ack_kgs','ack_kg_fat','ack_kg_snf'] },
  { title: 'Difference RMRD Vs Ack',     fill: 'FFFEF3C7', keys: ['diff_rmrd_litres','diff_rmrd_kgs','diff_rmrd_kg_fat','diff_rmrd_kg_snf'], diff: true },
  { title: 'Difference Dispatch Vs Ack', fill: 'FFFFE4E6', keys: ['diff_disp_litres','diff_disp_kgs','diff_disp_kg_fat','diff_disp_kg_snf'], diff: true },
];
const INFO_HEADERS = ['Tanker Number', 'Milk Lifting Date', 'Ack.Date', 'Route Name', 'Unloading Point'];
const RED = 'FFC0392B', GREEN = 'FF1E8449', HEADER_TEXT = 'FF1F2937';
const thin = { style: 'thin', color: { argb: 'FFD1D5DB' } };
const BORDER = { top: thin, bottom: thin, left: thin, right: thin };
const fillOf = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

function buildTsWorkbook(rows, reportDate) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('TS Report', { views: [{ state: 'frozen', xSplit: 5, ySplit: 3 }] });

  // Column widths: 5 info + 20 numeric
  ws.columns = [
    { width: 16 }, { width: 14 }, { width: 12 }, { width: 20 }, { width: 18 },
    ...Array(20).fill({ width: 12 }),
  ];

  // Row 1 — title
  ws.mergeCells(1, 1, 1, 25);
  const title = ws.getCell(1, 1);
  title.value = `Daily TS Report — ${reportDate}`;
  title.font = { bold: true, size: 14, color: { argb: 'FF003A6B' } };
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getRow(1).height = 24;

  // Rows 2-3 — grouped header
  INFO_HEADERS.forEach((h, i) => {
    ws.mergeCells(2, i + 1, 3, i + 1);
    const c = ws.getCell(2, i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: HEADER_TEXT } };
    c.fill = fillOf('FFF3F4F6');
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = BORDER;
    ws.getCell(3, i + 1).border = BORDER;
  });
  TS_GROUPS.forEach((g, gi) => {
    const startCol = 6 + gi * 4;
    ws.mergeCells(2, startCol, 2, startCol + 3);
    const gc = ws.getCell(2, startCol);
    gc.value = g.title;
    gc.font = { bold: true, color: { argb: HEADER_TEXT } };
    gc.fill = fillOf(g.fill);
    gc.alignment = { vertical: 'middle', horizontal: 'center' };
    ['Qty Ltrs', 'Qty Kgs', 'Kg.Fat', 'Kg.SNF'].forEach((h, i) => {
      const c = ws.getCell(3, startCol + i);
      c.value = h;
      c.font = { bold: true, size: 10, color: { argb: HEADER_TEXT } };
      c.fill = fillOf(g.fill);
      c.alignment = { vertical: 'middle', horizontal: 'center' };
      c.border = BORDER;
    });
    for (let i = 0; i < 4; i++) ws.getCell(2, startCol + i).border = BORDER;
  });
  ws.getRow(2).height = 20;

  // Data rows
  const numFmt = () => '#,##0.00'; // all measures 2dp
  rows.forEach((x, ri) => {
    const row = ws.getRow(4 + ri);
    const info = [x.tanker_number, fmtDate(x.lifting_date), fmtDate(x.ack_date), x.route_name, x.unloading_point];
    info.forEach((v, i) => {
      const c = row.getCell(i + 1);
      c.value = v ?? '';
      c.border = BORDER;
      c.alignment = { vertical: 'middle', horizontal: i === 0 ? 'left' : 'left' };
      if (i === 0) c.font = { bold: true, color: { argb: 'FF005BA3' } };
    });
    TS_GROUPS.forEach((g, gi) => {
      g.keys.forEach((key, ki) => {
        const c = row.getCell(6 + gi * 4 + ki);
        const v = x[key];
        c.value = v == null ? null : parseFloat(v);
        c.numFmt = numFmt(ki);
        c.alignment = { horizontal: 'right' };
        c.border = BORDER;
        c.fill = fillOf(g.fill);
        if (g.diff && v != null) {
          c.font = { color: { argb: parseFloat(v) < 0 ? RED : GREEN }, bold: true };
        }
      });
    });
  });

  // Totals row
  const totRowIdx = 4 + rows.length;
  const tr = ws.getRow(totRowIdx);
  ws.mergeCells(totRowIdx, 1, totRowIdx, 5);
  const tl = tr.getCell(1);
  tl.value = `TOTAL — ${rows.length} trips`;
  tl.font = { bold: true, color: { argb: 'FF003A6B' } };
  tl.fill = fillOf('FFDBEAFE');
  tl.border = BORDER;
  const sumCol = key => rN(rows.reduce((s, x) => s + (parseFloat(x[key]) || 0), 0), 2);
  TS_GROUPS.forEach((g, gi) => {
    g.keys.forEach((key, ki) => {
      const c = tr.getCell(6 + gi * 4 + ki);
      const v = sumCol(key);
      c.value = v;
      c.numFmt = numFmt(ki);
      c.alignment = { horizontal: 'right' };
      c.fill = fillOf('FFDBEAFE');
      c.border = { ...BORDER, top: { style: 'double', color: { argb: 'FF94A3B8' } } };
      c.font = g.diff
        ? { bold: true, color: { argb: v < 0 ? RED : GREEN } }
        : { bold: true, color: { argb: 'FF003A6B' } };
    });
  });

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
    const buf  = Buffer.from(await wb.xlsx.writeBuffer());
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
    const buf  = Buffer.from(await wb.xlsx.writeBuffer());

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
