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

async function buildTsReport(reportDate, basis = 'plan') {
  // basis 'plan': one row per plan of the planning date (default).
  // basis 'ack_entry': only trips whose acknowledgement was ENTERED on the
  // date (trip_acknowledgements.created_at) — every row fully populated.
  const dateFilter = basis === 'ack_entry'
    ? `te.id IS NOT NULL AND EXISTS (SELECT 1 FROM trip_acknowledgements ta2
         WHERE ta2.execution_id=te.id AND ta2.created_at::date=$1)`
    : basis === 'ack_date'
    ? `te.id IS NOT NULL AND EXISTS (SELECT 1 FROM trip_acknowledgements ta2
         WHERE ta2.execution_id=te.id AND ta2.ack_date=$1)`
    : `tp.plan_for_date=$1`;
  const r = await query(`
    SELECT
      tp.id AS plan_id, tp.trip_no, tp.shifts_milk,
      t.tanker_number, rm.route_name, sp.name AS starting_point, dp.name AS unloading_point,
      te.id AS execution_id, te.status AS execution_status, te.dc_number, te.actual_km,
      COALESCE(uu2.user_id, uu1.user_id) AS entered_by,

      (SELECT MIN(teb.milk_date) FROM trip_execution_bmcus teb
        WHERE teb.execution_id=te.id AND teb.is_deleted=FALSE)          AS lifting_date,
      (SELECT MIN(ta.ack_date) FROM trip_acknowledgements ta
        WHERE ta.execution_id=te.id)                                    AS ack_date,
      (SELECT MIN(ta.created_at) FROM trip_acknowledgements ta
        WHERE ta.execution_id=te.id)                                    AS posting_date,
      (SELECT COUNT(*) FROM trip_acknowledgements ta
        WHERE ta.execution_id=te.id)::int                               AS ack_count,

      -- Dispatch totals: ALL non-deleted execution rows (incl. Balance Milk /
      -- Internal Shifting rows — nothing entered in execution is dropped)
      COALESCE((SELECT SUM(teb.qty_litres) FROM trip_execution_bmcus teb
        WHERE teb.execution_id=te.id AND teb.is_deleted=FALSE),0) AS disp_litres,
      COALESCE((SELECT SUM(teb.qty_kgs) FROM trip_execution_bmcus teb
        WHERE teb.execution_id=te.id AND teb.is_deleted=FALSE),0) AS disp_kgs,
      COALESCE((SELECT SUM(teb.kg_fat) FROM trip_execution_bmcus teb
        WHERE teb.execution_id=te.id AND teb.is_deleted=FALSE),0) AS disp_kg_fat,
      COALESCE((SELECT SUM(teb.kg_snf) FROM trip_execution_bmcus teb
        WHERE teb.execution_id=te.id AND teb.is_deleted=FALSE),0) AS disp_kg_snf,

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
    LEFT JOIN starting_points sp ON sp.id=tp.start_point_id
    LEFT JOIN delivery_points dp ON dp.id=tp.delivery_point_id
    LEFT JOIN users uu1         ON uu1.id=te.executed_by
    LEFT JOIN users uu2         ON uu2.id=te.updated_by
    WHERE ${dateFilter} AND tp.status NOT IN ('cancelled','deleted')
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
    const hasExec = !!row.execution_id;
    // Weighted Fat% / SNF% per section = Kg.Fat / Qty Kgs × 100 (same for SNF)
    const pct = (kgPart, kgs) => (parseFloat(kgs) > 0) ? rN(parseFloat(kgPart) / parseFloat(kgs) * 100) : null;
    const rmrdFat = pct(rmrd.kg_fat, rmrd.kgs), rmrdSnf = pct(rmrd.kg_snf, rmrd.kgs);
    const dispFat = pct(row.disp_kg_fat, row.disp_kgs), dispSnf = pct(row.disp_kg_snf, row.disp_kgs);
    const ackFat  = hasAck ? pct(row.ack_kg_fat, row.ack_kgs) : null;
    const ackSnf  = hasAck ? pct(row.ack_kg_snf, row.ack_kgs) : null;
    const d = (a, b) => rN(parseFloat(a) - parseFloat(b), 2);
    // TS Gain/Loss % — confirmed formula (sample workbook cell AV4):
    // (diff Kg.Fat + diff Kg.SNF) / (base Kg.Fat + base Kg.SNF) × 100
    const gain = (diffKgFat, diffKgSnf, baseKgFat, baseKgSnf) => {
      const base = parseFloat(baseKgFat) + parseFloat(baseKgSnf);
      return base > 0 ? rN((parseFloat(diffKgFat) + parseFloat(diffKgSnf)) / base * 100) : null;
    };
    return {
      trip_no: row.trip_no,
      tanker_number: row.tanker_number,
      lifting_date: row.lifting_date,
      ack_date: row.ack_date,
      posting_date: row.posting_date,
      route_name: row.route_name,
      starting_point: row.starting_point,
      unloading_point: row.unloading_point,
      execution_status: row.execution_status,
      shifts_milk: row.shifts_milk,
      entered_by: row.entered_by,
      has_ack: hasAck,
      rmrd_litres: rN(rmrd.litres), rmrd_kgs: rN(rmrd.kgs, 2),
      rmrd_fat: pct(rmrd.kg_fat, rmrd.kgs), rmrd_snf: pct(rmrd.kg_snf, rmrd.kgs),
      rmrd_kg_fat: rN(rmrd.kg_fat, 2), rmrd_kg_snf: rN(rmrd.kg_snf, 2),
      disp_litres: rN(row.disp_litres), disp_kgs: rN(row.disp_kgs, 2),
      disp_fat: pct(row.disp_kg_fat, row.disp_kgs), disp_snf: pct(row.disp_kg_snf, row.disp_kgs),
      disp_kg_fat: rN(row.disp_kg_fat, 2), disp_kg_snf: rN(row.disp_kg_snf, 2),
      ack_litres: hasAck ? rN(row.ack_litres) : null,
      ack_kgs: hasAck ? rN(row.ack_kgs, 2) : null,
      ack_fat: hasAck ? pct(row.ack_kg_fat, row.ack_kgs) : null,
      ack_snf: hasAck ? pct(row.ack_kg_snf, row.ack_kgs) : null,
      ack_kg_fat: hasAck ? rN(row.ack_kg_fat, 2) : null,
      ack_kg_snf: hasAck ? rN(row.ack_kg_snf, 2) : null,
      // Difference Dispatch Vs RMRD (Dispatch − RMRD)
      dd_litres: hasExec ? d(row.disp_litres, rmrd.litres) : null,
      dd_kgs:    hasExec ? d(row.disp_kgs, rmrd.kgs) : null,
      dd_kg_fat: hasExec ? d(row.disp_kg_fat, rmrd.kg_fat) : null,
      dd_kg_snf: hasExec ? d(row.disp_kg_snf, rmrd.kg_snf) : null,
      dd_pct:    hasExec ? gain(d(row.disp_kg_fat, rmrd.kg_fat), d(row.disp_kg_snf, rmrd.kg_snf), rmrd.kg_fat, rmrd.kg_snf) : null,
      // Difference Ack Vs Dispatch (Ack − Dispatch)
      da_litres: hasAck ? d(row.ack_litres, row.disp_litres) : null,
      da_kgs:    hasAck ? d(row.ack_kgs, row.disp_kgs) : null,
      da_fat:    hasAck && ackFat != null && dispFat != null ? rN(ackFat - dispFat) : null,
      da_snf:    hasAck && ackSnf != null && dispSnf != null ? rN(ackSnf - dispSnf) : null,
      da_kg_fat: hasAck ? d(row.ack_kg_fat, row.disp_kg_fat) : null,
      da_kg_snf: hasAck ? d(row.ack_kg_snf, row.disp_kg_snf) : null,
      da_pct:    hasAck ? gain(d(row.ack_kg_fat, row.disp_kg_fat), d(row.ack_kg_snf, row.disp_kg_snf), row.disp_kg_fat, row.disp_kg_snf) : null,
      // Difference Ackn Vs RMRD (Ack − RMRD)
      dr_litres: hasAck ? d(row.ack_litres, rmrd.litres) : null,
      dr_kgs:    hasAck ? d(row.ack_kgs, rmrd.kgs) : null,
      dr_fat:    hasAck && ackFat != null && rmrdFat != null ? rN(ackFat - rmrdFat) : null,
      dr_snf:    hasAck && ackSnf != null && rmrdSnf != null ? rN(ackSnf - rmrdSnf) : null,
      dr_kg_fat: hasAck ? d(row.ack_kg_fat, rmrd.kg_fat) : null,
      dr_kg_snf: hasAck ? d(row.ack_kg_snf, rmrd.kg_snf) : null,
      dr_pct:    hasAck ? gain(d(row.ack_kg_fat, rmrd.kg_fat), d(row.ack_kg_snf, rmrd.kg_snf), rmrd.kg_fat, rmrd.kg_snf) : null,
    };
  });
}

const fmtDate = d => !d ? '' : (d.toISOString ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// Styled workbook (ExcelJS) matching the on-screen layout:
// title row, grouped two-row colored header, section fills, red/green
// differences, frozen panes, Indian number formats, bold totals.
const MEAS6 = ['Qty Ltrs', 'Qty Kgs', 'Fat%', 'SNF%', 'Kg.Fat', 'Kg.SNF'];
const DIFF5 = ['Qty Ltrs', 'Qty Kgs', 'Kg.Fat', 'Kg.SNF', 'Gain/Loss %'];
const DIFF7 = ['Qty Ltrs', 'Qty Kgs', 'Fat%', 'SNF%', 'Kg.Fat', 'Kg.SNF', 'Gain/Loss %'];
const TS_GROUPS = [
  { title: 'As per Dispatch',              fill: 'FFDCFCE7', heads: MEAS6, keys: ['disp_litres','disp_kgs','disp_fat','disp_snf','disp_kg_fat','disp_kg_snf'] },
  { title: 'As per RMRD',                  fill: 'FFE0F2FE', heads: MEAS6, keys: ['rmrd_litres','rmrd_kgs','rmrd_fat','rmrd_snf','rmrd_kg_fat','rmrd_kg_snf'] },
  { title: 'As per Acknowledgement',       fill: 'FFEDE9FE', heads: MEAS6, keys: ['ack_litres','ack_kgs','ack_fat','ack_snf','ack_kg_fat','ack_kg_snf'] },
  { title: 'Difference Dispatch Vs RMRD',  fill: 'FFFEF3C7', heads: DIFF5, keys: ['dd_litres','dd_kgs','dd_kg_fat','dd_kg_snf','dd_pct'], diff: true },
  { title: 'Difference Ack Vs Dispatch',   fill: 'FFFFE4E6', heads: DIFF7, keys: ['da_litres','da_kgs','da_fat','da_snf','da_kg_fat','da_kg_snf','da_pct'], diff: true },
  { title: 'Difference Ackn Vs RMRD',      fill: 'FFFDE68A', heads: DIFF7, keys: ['dr_litres','dr_kgs','dr_fat','dr_snf','dr_kg_fat','dr_kg_snf','dr_pct'], diff: true },
];
// Cumulative start offset of each group within the numeric columns
let _off = 0;
for (const g of TS_GROUPS) { g.offset = _off; _off += g.keys.length; }
const TS_NMEAS = _off;
// Weighted totals for percentage columns (never plain sums):
//   section Fat%/SNF% = Σkg-part / Σkgs × 100
//   diff Fat%/SNF%    = weighted pct of one section minus the other
//   Gain/Loss %       = confirmed formula (sample workbook cell AV4):
//     (Σdiff Kg.Fat + Σdiff Kg.SNF) / (Σbase Kg.Fat + Σbase Kg.SNF) × 100
function tsTotal(key, sum) {
  const w = (part, kgs) => sum(kgs) > 0 ? sum(part) / sum(kgs) * 100 : null;
  const dw = (p1, k1, p2, k2) => {
    const a = w(p1, k1), b = w(p2, k2);
    return a != null && b != null ? a - b : null;
  };
  const g = (diffKgFat, diffKgSnf, baseKgFat, baseKgSnf) => {
    const base = sum(baseKgFat) + sum(baseKgSnf);
    return base > 0 ? (sum(diffKgFat) + sum(diffKgSnf)) / base * 100 : null;
  };
  switch (key) {
    case 'rmrd_fat': return w('rmrd_kg_fat', 'rmrd_kgs');
    case 'rmrd_snf': return w('rmrd_kg_snf', 'rmrd_kgs');
    case 'disp_fat': return w('disp_kg_fat', 'disp_kgs');
    case 'disp_snf': return w('disp_kg_snf', 'disp_kgs');
    case 'ack_fat':  return w('ack_kg_fat', 'ack_kgs');
    case 'ack_snf':  return w('ack_kg_snf', 'ack_kgs');
    case 'da_fat':   return dw('ack_kg_fat', 'ack_kgs', 'disp_kg_fat', 'disp_kgs');
    case 'da_snf':   return dw('ack_kg_snf', 'ack_kgs', 'disp_kg_snf', 'disp_kgs');
    case 'dr_fat':   return dw('ack_kg_fat', 'ack_kgs', 'rmrd_kg_fat', 'rmrd_kgs');
    case 'dr_snf':   return dw('ack_kg_snf', 'ack_kgs', 'rmrd_kg_snf', 'rmrd_kgs');
    case 'dd_pct':   return g('dd_kg_fat', 'dd_kg_snf', 'rmrd_kg_fat', 'rmrd_kg_snf');
    case 'da_pct':   return g('da_kg_fat', 'da_kg_snf', 'disp_kg_fat', 'disp_kg_snf');
    case 'dr_pct':   return g('dr_kg_fat', 'dr_kg_snf', 'rmrd_kg_fat', 'rmrd_kg_snf');
    default:         return sum(key);
  }
}
const INFO_HEADERS = ['Milk Lifting Date', 'Milk Ack Date', 'Posting Date', 'Tanker Number', 'Route Name', 'Starting Point', 'Unloading Point', 'Entered By'];
const RED = 'FFC0392B', GREEN = 'FF1E8449', HEADER_TEXT = 'FF1F2937';
const thin = { style: 'thin', color: { argb: 'FFD1D5DB' } };
const BORDER = { top: thin, bottom: thin, left: thin, right: thin };
const fillOf = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

const TS_BASIS_LABEL = basis =>
  basis === 'ack_entry' ? 'by Ack Entry Date'
  : basis === 'ack_date' ? 'by Ack Date'
  : 'by Planning Date';

function buildTsWorkbook(rows, reportDate, basis = 'plan') {
  const wb = new ExcelJS.Workbook();
  const NINFO = INFO_HEADERS.length;
  const ws = wb.addWorksheet('TS Report', { views: [{ state: 'frozen', xSplit: NINFO, ySplit: 3 }] });

  // Column widths: 6 info + numeric measures
  ws.columns = [
    { width: 14 }, { width: 12 }, { width: 12 }, { width: 16 }, { width: 20 }, { width: 18 }, { width: 18 }, { width: 14 },
    ...Array(TS_NMEAS).fill({ width: 11 }),
  ];

  // Row 1 — title
  ws.mergeCells(1, 1, 1, NINFO + TS_NMEAS);
  const title = ws.getCell(1, 1);
  title.value = `Daily TS Report — ${reportDate} (${TS_BASIS_LABEL(basis)})`;
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
  TS_GROUPS.forEach(g => {
    const startCol = NINFO + 1 + g.offset;
    ws.mergeCells(2, startCol, 2, startCol + g.keys.length - 1);
    const gc = ws.getCell(2, startCol);
    gc.value = g.title;
    gc.font = { bold: true, color: { argb: HEADER_TEXT } };
    gc.fill = fillOf(g.fill);
    gc.alignment = { vertical: 'middle', horizontal: 'center' };
    g.heads.forEach((h, i) => {
      const c = ws.getCell(3, startCol + i);
      c.value = h;
      c.font = { bold: true, size: 10, color: { argb: HEADER_TEXT } };
      c.fill = fillOf(g.fill);
      c.alignment = { vertical: 'middle', horizontal: 'center' };
      c.border = BORDER;
    });
    for (let i = 0; i < g.keys.length; i++) ws.getCell(2, startCol + i).border = BORDER;
  });
  ws.getRow(2).height = 20;

  // Data rows
  const numFmt = () => '#,##0.00'; // all measures 2dp
  rows.forEach((x, ri) => {
    const row = ws.getRow(4 + ri);
    const info = [fmtDate(x.lifting_date), fmtDate(x.ack_date), fmtDate(x.posting_date),
      x.tanker_number, x.route_name, x.starting_point, x.unloading_point, x.entered_by || ''];
    info.forEach((v, i) => {
      const c = row.getCell(i + 1);
      c.value = v ?? '';
      c.border = BORDER;
      c.alignment = { vertical: 'middle', horizontal: 'left' };
      if (i === 3) c.font = { bold: true, color: { argb: 'FF005BA3' } };
    });
    TS_GROUPS.forEach(g => {
      g.keys.forEach((key, ki) => {
        const c = row.getCell(NINFO + 1 + g.offset + ki);
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
  ws.mergeCells(totRowIdx, 1, totRowIdx, NINFO);
  const tl = tr.getCell(1);
  tl.value = `TOTAL — ${rows.length} trips`;
  tl.font = { bold: true, color: { argb: 'FF003A6B' } };
  tl.fill = fillOf('FFDBEAFE');
  tl.border = BORDER;
  const rawSum = key => rows.reduce((s, x) => s + (parseFloat(x[key]) || 0), 0);
  const totCol = key => rN(tsTotal(key, rawSum), 2);
  TS_GROUPS.forEach(g => {
    g.keys.forEach((key, ki) => {
      const c = tr.getCell(NINFO + 1 + g.offset + ki);
      const v = totCol(key);
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
    res.json(await buildTsReport(reportDate, req.query.date_basis || 'plan'));
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
  const basis = req.query.date_basis || 'plan';
  if (!report_date) return res.status(400).json({ error: 'report_date required' });
  try {
    const rows = await buildTsReport(report_date, basis);
    const wb   = buildTsWorkbook(rows, report_date, basis);
    const buf  = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Disposition', `attachment; filename=ts_report_${report_date}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Styled email body: branded header, stat chips, per-trip summary table with
// red/green differences and a weighted TOTAL row. Full detail stays attached.
// Email body shows only the Ack Vs RMRD comparison, in Kgs (no litres, no
// Gain/Loss % — every value is labeled "Loss in ..." regardless of sign).
// Full detail (Dispatch, all three diff groups, Fat%/SNF%) stays in the attachment.
function buildTsEmailHtml(rows, reportDate, basis) {
  const escH = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const n0 = v => v == null ? '—' : Math.round(parseFloat(v)).toLocaleString('en-IN');
  const td = (v, extra = '') => `<td style="padding:5px 8px;border:1px solid #e2e8f0;font-size:12px;${extra}">${v}</td>`;
  // Only actual losses (negative values) are shown, always in red;
  // zero/positive (a gain, not a loss) renders blank.
  const lossCell = v => v == null || parseFloat(v) >= 0 ? td('—', 'text-align:right;color:#cbd5e1;')
    : td(n0(v), 'text-align:right;font-weight:700;color:#dc2626;');

  // A trip is shown if it has a loss on ANY of: Dispatch vs RMRD, or (once
  // acknowledged) Ack vs RMRD Qty/FAT/SNF — otherwise dropped entirely.
  // This catches trips like a Dispatch-vs-RMRD loss that later nets to a
  // gain by acknowledgement time, which the Ack-vs-RMRD-only check missed.
  const lossRows = rows.filter(r =>
    (r.dd_kgs != null && parseFloat(r.dd_kgs) < 0) ||
    (r.has_ack && [r.dr_kgs, r.dr_kg_fat, r.dr_kg_snf].some(v => v != null && parseFloat(v) < 0)));

  const bodyRows = lossRows.map((r, i) => `
    <tr style="background:${i % 2 ? '#f8fafc' : '#ffffff'};">
      ${td(`<b style="color:#005ba3;">${escH(r.tanker_number || '—')}</b>`)}
      ${td(escH(r.route_name || '—'))}
      ${td(escH(r.unloading_point || '—'))}
      ${lossCell(r.dd_kgs)}
      ${r.has_ack ? `${lossCell(r.dr_kgs)}${lossCell(r.dr_kg_fat)}${lossCell(r.dr_kg_snf)}`
        : `${td('pending', 'text-align:center;color:#b45309;font-size:11px;')}${td('—', 'text-align:right;color:#cbd5e1;')}${td('—', 'text-align:right;color:#cbd5e1;')}`}
    </tr>`).join('');

  const sum = k => lossRows.reduce((s, r) => s + (parseFloat(r[k]) || 0), 0);

  return `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:700px;">
    <div style="background:#005ba3;color:#ffffff;padding:14px 20px;border-radius:10px 10px 0 0;">
      <div style="font-size:17px;font-weight:700;">Shreeja TMS — Daily TS Report</div>
      <div style="font-size:12px;opacity:.85;">${escH(reportDate)} · ${TS_BASIS_LABEL(basis)}</div>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;padding:16px 20px;border-radius:0 0 10px 10px;">
      <p style="font-size:13px;margin:0 0 10px;">Dear Team,<br/>Summary of the Daily TS Report for <b>${escH(reportDate)}</b> — the full report is attached.</p>
      ${lossRows.length === 0
        ? `<p style="font-size:13px;color:#15803d;font-weight:600;margin:0 0 10px;">No loss recorded against RMRD for any trip.</p>`
        : `<table style="border-collapse:collapse;width:100%;">
        <tr style="background:#e0f2fe;">
          ${['Tanker', 'Route', 'Delivery Point', 'Dispatch Vs RMRD — Qty Loss in Kgs', 'Ackn Vs RMRD — Qty Loss in Kgs', 'Loss in FAT Kgs', 'Loss in SNF Kgs']
            .map(h => `<th style="padding:6px 8px;border:1px solid #e2e8f0;font-size:12px;color:#0f172a;text-align:left;">${h}</th>`).join('')}
        </tr>
        ${bodyRows}
        <tr style="background:#dbeafe;font-weight:700;">
          ${td(`TOTAL — ${lossRows.length} trip${lossRows.length === 1 ? '' : 's'} with loss`)}${td('')}${td('')}
          ${lossCell(rN(sum('dd_kgs')))}${lossCell(rN(sum('dr_kgs')))}${lossCell(rN(sum('dr_kg_fat')))}${lossCell(rN(sum('dr_kg_snf')))}
        </tr>
      </table>`}
      <p style="font-size:11px;color:#9ca3af;margin:14px 0 0;">This is an automated message from Shreeja TMS · Developed &amp; maintained by <b style="color:#6b7280;">Shreeja IT Team</b>.</p>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reports/send-email  { report_date }  — same workbook as the download
// ─────────────────────────────────────────────────────────────────────────────
router.post('/send-email', authenticate, async (req, res) => {
  const { report_date } = req.body;
  const basis = req.body.date_basis || 'plan';
  if (!report_date) return res.status(400).json({ error: 'report_date required' });
  try {
    const recipients = await query(
      'SELECT email, full_name FROM report_email_config WHERE is_active=TRUE'
    );
    if (!recipients.rows.length)
      return res.status(400).json({ error: 'No active email recipients configured' });

    const rows = await buildTsReport(report_date, basis);
    const wb   = buildTsWorkbook(rows, report_date, basis);
    const buf  = Buffer.from(await wb.xlsx.writeBuffer());

    const acked = rows.filter(r => r.has_ack).length;
    const transporter = createTransport();
    await transporter.sendMail({
      from:    process.env.SMTP_FROM,
      to:      recipients.rows.map(r => `${r.full_name} <${r.email}>`).join(', '),
      subject: `Daily TS Report — ${report_date} (${TS_BASIS_LABEL(basis)})`,
      html: buildTsEmailHtml(rows, report_date, basis),
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

// ═════════════════════════════════════════════════════════════════════════════
// BMCU BREAK UP REPORT — per-BMCU dispatch vs RMRD reconciliation
// (per sample BMCU_Break_Up.xlsx). One block per BMCU per trip:
//   dispatch entry (with compartment) vs RMRD shift rows + signed adjustments
//   (Balance Milk Leftover −, Balance milk lifted +, New MPP +,
//    Milk Shifting + at receiver / − at source plant),
//   Gross Total per BMCU with difference = RMRD − Dispatch.
// ═════════════════════════════════════════════════════════════════════════════

// Shift label per sample: day-of-month + E (evening/PM) or M (morning/AM), e.g. 07E.
const shiftLabel = (milkDate, shift) => {
  const dd = fmtDate(milkDate).slice(8, 10);
  return `${dd}${shift === 'PM' ? 'E' : 'M'}`;
};

async function buildBmcuBreakup(reportDate) {
  // Trips planned for the date with their latest non-cancelled execution.
  const tr = await query(`
    SELECT
      tp.id AS plan_id, tp.trip_no,
      t.tanker_number, rm.route_name,
      te.id AS execution_id,
      COALESCE(uu2.user_id, uu1.user_id) AS entered_by,
      (SELECT MIN(teb.milk_date) FROM trip_execution_bmcus teb
        WHERE teb.execution_id=te.id AND teb.is_deleted=FALSE) AS lifting_date
    FROM trip_plans tp
    LEFT JOIN LATERAL (
      SELECT * FROM trip_executions x
      WHERE x.trip_plan_id=tp.id AND x.status != 'cancelled'
      ORDER BY x.id DESC LIMIT 1
    ) te ON TRUE
    LEFT JOIN tankers t        ON t.id=tp.tanker_id
    LEFT JOIN route_masters rm ON rm.id=tp.route_id
    LEFT JOIN users uu1        ON uu1.id=te.executed_by
    LEFT JOIN users uu2        ON uu2.id=te.updated_by
    WHERE tp.plan_for_date=$1 AND tp.status NOT IN ('cancelled','deleted')
    ORDER BY tp.trip_no`, [reportDate]);

  const execIds = tr.rows.filter(x => x.execution_id).map(x => x.execution_id);
  const notes = [];
  if (!execIds.length) return { report_date: reportDate, trips: [], notes };

  // Dispatch rows per BMCU — ALL non-deleted rows, including those marked
  // 'Balance Milk' / 'Internal Shifting' (their RMRD shifts must count too;
  // the row type is shown next to the BMCU name instead).
  const dr = await query(`
    SELECT teb.execution_id, teb.seq_no, teb.bmcu_id, teb.chamber, teb.description,
           teb.qty_litres, teb.qty_kgs, teb.fat_pct, teb.snf_pct, teb.kg_fat, teb.kg_snf,
           b.bmcu_code, b.bmcu_name
    FROM trip_execution_bmcus teb
    JOIN bmcus b ON b.id=teb.bmcu_id
    WHERE teb.execution_id = ANY($1) AND teb.is_deleted=FALSE
    ORDER BY teb.execution_id, teb.seq_no`, [execIds]);

  // RMRD shift rows keyed to their BMCU block.
  const sr = await query(`
    SELECT tebs.execution_id, tebs.bmcu_seq_no, tebs.milk_date, tebs.shift,
           tebs.rmrd_qty, tebs.rmrd_fat_pct, tebs.rmrd_snf_pct
    FROM trip_execution_bmcu_shifts tebs
    JOIN trip_execution_bmcus teb
      ON teb.execution_id=tebs.execution_id AND teb.seq_no=tebs.bmcu_seq_no AND teb.is_deleted=FALSE
    WHERE tebs.execution_id = ANY($1)
    ORDER BY tebs.milk_date, tebs.shift`, [execIds]);

  // Adjustment entries (balance/lifted/new MPP/shifting) with source plant info.
  const er = await query(`
    SELECT e.execution_id, e.bmcu_seq_no, e.kind, e.category,
           e.qty_litres, e.fat_pct, e.snf_pct, e.source_bmcu_id,
           sb.bmcu_code AS source_bmcu_code, sb.bmcu_name AS source_bmcu_name
    FROM trip_execution_bmcu_entries e
    LEFT JOIN bmcus sb ON sb.id=e.source_bmcu_id
    WHERE e.execution_id = ANY($1)
    ORDER BY e.id`, [execIds]);

  // Block index: (execId, seqNo) → block, plus bmcuId → blocks (to place source-side
  // deduction rows for internal shifting, preferring the same trip).
  const blocks = {}; const byExec = {}; const byBmcu = {};
  const key = (e, s) => `${e}:${s}`;
  for (const d of dr.rows) {
    const b = {
      execution_id: d.execution_id, seq_no: d.seq_no,
      bmcu_code: d.bmcu_code,
      bmcu_name: d.bmcu_name + (d.description && d.description !== 'RMRD' ? ` (${d.description})` : ''),
      compartment: String(d.chamber || '').split(',').map(s => s.trim()).filter(Boolean).join('/'),
      dispatch: {
        litres: rN(d.qty_litres) || 0, kgs: rN(d.qty_kgs) || 0,
        fat: rN(d.fat_pct), snf: rN(d.snf_pct),
        kg_fat: rN(d.kg_fat) || 0, kg_snf: rN(d.kg_snf) || 0,
      },
      rows: [],
    };
    blocks[key(d.execution_id, d.seq_no)] = b;
    (byExec[d.execution_id] ||= []).push(b);
    (byBmcu[d.bmcu_id] ||= []).push(b);
  }

  // Measures helper: qty (may be negative) + fat/snf % → 6 values.
  const measures = (qty, fat, snf) => {
    const litres = parseFloat(qty) || 0;
    const kgs = calcKgs(litres);
    return {
      litres: rN(litres), kgs: rN(kgs),
      fat: fat != null ? rN(fat) : null, snf: snf != null ? rN(snf) : null,
      kg_fat: rN(calcKgFat(kgs, fat)) || 0, kg_snf: rN(calcKgSnf(kgs, snf)) || 0,
    };
  };

  for (const s of sr.rows) {
    const b = blocks[key(s.execution_id, s.bmcu_seq_no)];
    if (!b) continue;
    b.rows.push({
      type: 'shift', label: b.bmcu_name, shift: shiftLabel(s.milk_date, s.shift),
      ...measures(s.rmrd_qty, s.rmrd_fat_pct, s.rmrd_snf_pct),
    });
  }

  for (const e of er.rows) {
    if (!e.qty_litres) continue;
    const b = blocks[key(e.execution_id, e.bmcu_seq_no)];
    if (e.kind === 'balance_milk' && e.category === 'Left Over milk') {
      if (b) b.rows.push({ type: 'adjustment', label: 'Balance Milk Leftover', shift: '',
        ...measures(-e.qty_litres, e.fat_pct, e.snf_pct) });
    } else if (e.kind === 'balance_milk' && e.category === 'Lifted milk') {
      if (b) b.rows.push({ type: 'adjustment', label: 'Balance milk lifted', shift: '',
        ...measures(e.qty_litres, e.fat_pct, e.snf_pct) });
    } else if (e.kind === 'new_mpp') {
      if (b) b.rows.push({ type: 'adjustment', label: 'New MPP', shift: '',
        ...measures(e.qty_litres, e.fat_pct, e.snf_pct) });
    } else if (e.kind === 'internal_shifting') {
      if (b) b.rows.push({ type: 'adjustment',
        label: `Milk Shifting${e.source_bmcu_code ? ` (from ${e.source_bmcu_code})` : ''}`,
        shift: '', ...measures(e.qty_litres, e.fat_pct, e.snf_pct) });
      // Source plant's block gets the matching deduction (prefer the same trip).
      const cands = byBmcu[e.source_bmcu_id] || [];
      const src = cands.find(c => c.execution_id === e.execution_id) || cands[0];
      if (src) {
        src.rows.push({ type: 'adjustment',
          label: `Milk Shifting (to ${b ? b.bmcu_code : '—'})`, shift: '',
          ...measures(-e.qty_litres, e.fat_pct, e.snf_pct) });
      } else if (e.source_bmcu_code) {
        notes.push(`Milk Shifting source ${e.source_bmcu_code} — ${e.source_bmcu_name || ''} is not on any trip of ${reportDate}; deduction not shown.`);
      }
    }
  }

  // Gross total per block, grand total per trip. Fat/SNF are weighted averages.
  const wAvg = (kgPart, kgs) => kgs ? rN(kgPart / kgs * 100) : null;
  const sum6 = rows => rows.reduce((a, r) => ({
    litres: a.litres + (parseFloat(r.litres) || 0), kgs: a.kgs + (parseFloat(r.kgs) || 0),
    kg_fat: a.kg_fat + (parseFloat(r.kg_fat) || 0), kg_snf: a.kg_snf + (parseFloat(r.kg_snf) || 0),
  }), { litres: 0, kgs: 0, kg_fat: 0, kg_snf: 0 });

  const trips = tr.rows.filter(x => x.execution_id && (byExec[x.execution_id] || []).length)
    .map(x => {
      const bmcus = (byExec[x.execution_id] || []).map(b => {
        const rm = sum6(b.rows);
        const rmrd = {
          litres: rN(rm.litres), kgs: rN(rm.kgs),
          fat: wAvg(rm.kg_fat, rm.kgs), snf: wAvg(rm.kg_snf, rm.kgs),
          kg_fat: rN(rm.kg_fat), kg_snf: rN(rm.kg_snf),
        };
        return {
          bmcu_code: b.bmcu_code, bmcu_name: b.bmcu_name, compartment: b.compartment,
          dispatch: b.dispatch, rows: b.rows, rmrd,
          diff: { // Difference Dispatch Vs RMRD = Dispatch − RMRD
            kgs:    rN(b.dispatch.kgs    - rm.kgs),
            litres: rN(b.dispatch.litres - rm.litres),
            kg_fat: rN(b.dispatch.kg_fat - rm.kg_fat),
            kg_snf: rN(b.dispatch.kg_snf - rm.kg_snf),
            // Gain/Loss % — confirmed formula: (diff Kg.Fat + diff Kg.SNF)/(base Kg.Fat + base Kg.SNF)×100
            pct: (rm.kg_fat + rm.kg_snf) > 0
              ? rN(((b.dispatch.kg_fat - rm.kg_fat) + (b.dispatch.kg_snf - rm.kg_snf)) / (rm.kg_fat + rm.kg_snf) * 100)
              : null,
          },
        };
      });
      const gd = sum6(bmcus.map(b => b.dispatch));
      const gr = sum6(bmcus.map(b => b.rmrd));
      return {
        trip_no: x.trip_no, tanker_number: x.tanker_number, route_name: x.route_name,
        entered_by: x.entered_by,
        lifting_date: fmtDate(x.lifting_date), bmcus,
        grand: {
          dispatch: { litres: rN(gd.litres), kgs: rN(gd.kgs),
            fat: wAvg(gd.kg_fat, gd.kgs), snf: wAvg(gd.kg_snf, gd.kgs),
            kg_fat: rN(gd.kg_fat), kg_snf: rN(gd.kg_snf) },
          rmrd: { litres: rN(gr.litres), kgs: rN(gr.kgs),
            fat: wAvg(gr.kg_fat, gr.kgs), snf: wAvg(gr.kg_snf, gr.kgs),
            kg_fat: rN(gr.kg_fat), kg_snf: rN(gr.kg_snf) },
          diff: { kgs: rN(gd.kgs - gr.kgs), litres: rN(gd.litres - gr.litres),
            kg_fat: rN(gd.kg_fat - gr.kg_fat), kg_snf: rN(gd.kg_snf - gr.kg_snf),
            pct: (gr.kg_fat + gr.kg_snf) > 0
              ? rN(((gd.kg_fat - gr.kg_fat) + (gd.kg_snf - gr.kg_snf)) / (gr.kg_fat + gr.kg_snf) * 100)
              : null },
        },
      };
    });

  return { report_date: reportDate, trips, notes };
}

// Styled workbook per sample layout: 23 columns, two-row grouped header, one
// BMCU block per plant (dispatch on first row, RMRD shift/adjustment rows,
// bold Gross Total with red/green diff), Grand Total per trip.
const BK_MEASURES = ['Qty Lts', 'Qty Kgs', 'Fat', 'SNF', 'KG Fat', 'KG SNF'];
const M6 = m => [m.litres, m.kgs, m.fat, m.snf, m.kg_fat, m.kg_snf];
const D4 = d => [d.kgs, d.litres, d.kg_fat, d.kg_snf, d.pct];

function buildBmcuBreakupWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('BMCU breakup', { views: [{ state: 'frozen', xSplit: 5, ySplit: 3 }] });
  // Cols: 1 Route, 2 Lifting Date, 3 Tanker, 4 BMCU Code, 5 BMCU Name, 6 Compartment,
  //       7-12 dispatch, 13 Shift, 14-19 RMRD, 20-23 diff
  ws.columns = [
    { width: 16 }, { width: 13 }, { width: 14 }, { width: 11 }, { width: 22 }, { width: 12 },
    ...Array(6).fill({ width: 10 }), { width: 8 }, ...Array(6).fill({ width: 10 }),
    ...Array(5).fill({ width: 10 }),
  ];

  ws.mergeCells(1, 1, 1, 24);
  const title = ws.getCell(1, 1);
  title.value = `BMCU Break Up Report — ${data.report_date}`;
  title.font = { bold: true, size: 14, color: { argb: 'FF003A6B' } };
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getRow(1).height = 24;

  // Header rows 2-3
  const infoHeaders = ['Route Name', 'Milk Lifting Date', 'Tanker NO', 'BMCU Code', 'BMCUs Name', 'Compartment'];
  infoHeaders.forEach((h, i) => {
    ws.mergeCells(2, i + 1, 3, i + 1);
    const c = ws.getCell(2, i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: HEADER_TEXT } };
    c.fill = fillOf('FFF3F4F6');
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = BORDER;
    ws.getCell(3, i + 1).border = BORDER;
  });
  const groups = [
    { title: 'As per the Tanker Dispatch Quantity', fill: 'FFDCFCE7', start: 7,  heads: BK_MEASURES },
    { title: 'Shift',                               fill: 'FFF3F4F6', start: 13, heads: null },
    { title: 'As Per RMRD',                         fill: 'FFE0F2FE', start: 14, heads: BK_MEASURES },
    { title: 'Difference Dispatch Vs RMRD', fill: 'FFFEF3C7', start: 20, heads: ['Qty Kgs', 'Qty Lts', 'KG Fat', 'KG SNF', 'Gain/Loss %'] },
  ];
  for (const g of groups) {
    if (!g.heads) { // single Shift column spans both header rows
      ws.mergeCells(2, g.start, 3, g.start);
      const c = ws.getCell(2, g.start);
      c.value = g.title;
      c.font = { bold: true, color: { argb: HEADER_TEXT } };
      c.fill = fillOf(g.fill);
      c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      c.border = BORDER; ws.getCell(3, g.start).border = BORDER;
      continue;
    }
    ws.mergeCells(2, g.start, 2, g.start + g.heads.length - 1);
    const gc = ws.getCell(2, g.start);
    gc.value = g.title;
    gc.font = { bold: true, color: { argb: HEADER_TEXT } };
    gc.fill = fillOf(g.fill);
    gc.alignment = { vertical: 'middle', horizontal: 'center' };
    g.heads.forEach((h, i) => {
      const c = ws.getCell(3, g.start + i);
      c.value = h;
      c.font = { bold: true, size: 10, color: { argb: HEADER_TEXT } };
      c.fill = fillOf(g.fill);
      c.alignment = { vertical: 'middle', horizontal: 'center' };
      c.border = BORDER;
    });
    for (let i = 0; i < g.heads.length; i++) ws.getCell(2, g.start + i).border = BORDER;
  }
  ws.getRow(2).height = 22;

  const setNum = (cell, v, { diff = false, bold = false, fill = null } = {}) => {
    cell.value = v == null ? null : parseFloat(v);
    cell.numFmt = '#,##0.00';
    cell.alignment = { horizontal: 'right' };
    cell.border = BORDER;
    if (fill) cell.fill = fillOf(fill);
    if (diff && v != null) cell.font = { bold: true, color: { argb: parseFloat(v) < 0 ? RED : GREEN } };
    else if (bold) cell.font = { bold: true, color: { argb: 'FF003A6B' } };
  };
  const setTxt = (cell, v, { bold = false, fill = null, color = null } = {}) => {
    cell.value = v ?? '';
    cell.border = BORDER;
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    if (fill) cell.fill = fillOf(fill);
    if (bold || color) cell.font = { bold, color: { argb: color || HEADER_TEXT } };
  };

  let rIdx = 4;
  for (const trip of data.trips) {
    for (const b of trip.bmcus) {
      const blockRows = b.rows.length ? b.rows : [{ type: 'shift', label: b.bmcu_name, shift: '',
        litres: null, kgs: null, fat: null, snf: null, kg_fat: null, kg_snf: null }];
      blockRows.forEach((r, i) => {
        const row = ws.getRow(rIdx);
        setTxt(row.getCell(1), trip.route_name);
        setTxt(row.getCell(2), trip.lifting_date);
        setTxt(row.getCell(3), trip.tanker_number, { color: 'FF005BA3', bold: true });
        setTxt(row.getCell(4), b.bmcu_code);
        setTxt(row.getCell(5), r.type === 'adjustment' ? r.label : b.bmcu_name,
          { color: r.type === 'adjustment' ? 'FF92400E' : null, bold: r.type === 'adjustment' });
        setTxt(row.getCell(6), i === 0 ? b.compartment : '');
        M6(i === 0 ? b.dispatch : {}).forEach((v, k) => setNum(row.getCell(7 + k), i === 0 ? v : null, { fill: 'FFF0FDF4' }));
        setTxt(row.getCell(13), r.shift || '');
        row.getCell(13).alignment = { horizontal: 'center' };
        M6(r).forEach((v, k) => setNum(row.getCell(14 + k), v, { fill: 'FFF0F9FF' }));
        for (let k = 0; k < 5; k++) setNum(row.getCell(20 + k), null);
        rIdx++;
      });
      // Gross Total per BMCU
      const row = ws.getRow(rIdx);
      setTxt(row.getCell(1), trip.route_name, { fill: 'FFF8FAFC' });
      setTxt(row.getCell(2), trip.lifting_date, { fill: 'FFF8FAFC' });
      setTxt(row.getCell(3), trip.tanker_number, { fill: 'FFF8FAFC' });
      setTxt(row.getCell(4), b.bmcu_code, { fill: 'FFF8FAFC' });
      setTxt(row.getCell(5), 'Gross Total', { bold: true, fill: 'FFF8FAFC' });
      setTxt(row.getCell(6), '', { fill: 'FFF8FAFC' });
      M6(b.dispatch).forEach((v, k) => setNum(row.getCell(7 + k), v, { bold: true, fill: 'FFF8FAFC' }));
      setTxt(row.getCell(13), '', { fill: 'FFF8FAFC' });
      M6(b.rmrd).forEach((v, k) => setNum(row.getCell(14 + k), v, { bold: true, fill: 'FFF8FAFC' }));
      D4(b.diff).forEach((v, k) => setNum(row.getCell(20 + k), v, { diff: true, fill: 'FFFEF3C7' }));
      rIdx++;
    }
    // Grand Total per trip (cell 1 carries the entered-by user id)
    const row = ws.getRow(rIdx);
    setTxt(row.getCell(1), trip.entered_by ? `Entered by: ${trip.entered_by}` : '', { fill: 'FFDBEAFE' });
    for (let k = 2; k <= 4; k++) setTxt(row.getCell(k), '', { fill: 'FFDBEAFE' });
    setTxt(row.getCell(5), 'Grand Total', { bold: true, fill: 'FFDBEAFE' });
    setTxt(row.getCell(6), '', { fill: 'FFDBEAFE' });
    M6(trip.grand.dispatch).forEach((v, k) => setNum(row.getCell(7 + k), v, { bold: true, fill: 'FFDBEAFE' }));
    setTxt(row.getCell(13), 'E & M', { bold: true, fill: 'FFDBEAFE' });
    row.getCell(13).alignment = { horizontal: 'center' };
    M6(trip.grand.rmrd).forEach((v, k) => setNum(row.getCell(14 + k), v, { bold: true, fill: 'FFDBEAFE' }));
    D4(trip.grand.diff).forEach((v, k) => setNum(row.getCell(20 + k), v, { diff: true, fill: 'FFDBEAFE' }));
    rIdx += 2; // blank spacer row between trips
  }

  if (data.notes.length) {
    for (const n of data.notes) {
      ws.mergeCells(rIdx, 1, rIdx, 24);
      const c = ws.getCell(rIdx, 1);
      c.value = `Note: ${n}`;
      c.font = { italic: true, size: 10, color: { argb: 'FF92400E' } };
      rIdx++;
    }
  }
  return wb;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/bmcu-breakup?report_date=YYYY-MM-DD   (planning date)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/bmcu-breakup', authenticate, async (req, res) => {
  const { report_date } = req.query;
  if (!report_date) return res.status(400).json({ error: 'report_date required' });
  try {
    res.json(await buildBmcuBreakup(report_date));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/bmcu-breakup/excel?report_date=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────
router.get('/bmcu-breakup/excel', authenticate, async (req, res) => {
  const { report_date } = req.query;
  if (!report_date) return res.status(400).json({ error: 'report_date required' });
  try {
    const data = await buildBmcuBreakup(report_date);
    const wb   = buildBmcuBreakupWorkbook(data);
    const buf  = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Disposition', `attachment; filename=bmcu_breakup_${report_date}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// DAY WISE TANKER UTILISATION — per acknowledged trip, by ack date.
// Utilization % = Ack Qty Ltrs / tanker capacity × 100; remark ABOVE/BELOW threshold.
// ═════════════════════════════════════════════════════════════════════════════
async function buildDayUtilisation(fromDate, toDate, threshold) {
  const r = await query(`
    SELECT tp.trip_no, t.tanker_number, t.capacity_litres,
           rm.route_name, sp.name AS starting_point, dp.name AS delivery_point,
           MIN(ta.ack_date)      AS ack_date,
           SUM(ta.qty_litres)    AS ack_litres,
           SUM(ta.qty_kgs)       AS ack_kgs,
           SUM(ta.kg_fat)        AS ack_kg_fat,
           SUM(ta.kg_snf)        AS ack_kg_snf
    FROM trip_executions te
    JOIN trip_plans tp           ON tp.id=te.trip_plan_id
    JOIN trip_acknowledgements ta ON ta.execution_id=te.id
    LEFT JOIN tankers t          ON t.id=tp.tanker_id
    LEFT JOIN route_masters rm   ON rm.id=tp.route_id
    LEFT JOIN starting_points sp ON sp.id=tp.start_point_id
    LEFT JOIN delivery_points dp ON dp.id=tp.delivery_point_id
    WHERE te.status != 'cancelled' AND tp.status NOT IN ('cancelled','deleted')
    GROUP BY tp.id, tp.trip_no, t.tanker_number, t.capacity_litres,
             rm.route_name, sp.name, dp.name, te.id
    HAVING MIN(ta.ack_date) BETWEEN $1 AND $2
    ORDER BY MIN(ta.ack_date), tp.trip_no`, [fromDate, toDate]);

  return r.rows.map((x, i) => {
    const litres = parseFloat(x.ack_litres) || 0;
    const kgs    = parseFloat(x.ack_kgs) || 0;
    const cap    = parseFloat(x.capacity_litres) || 0;
    const util   = cap ? rN(litres / cap * 100) : null;
    return {
      s_no: i + 1,
      starting_point: x.starting_point, delivery_point: x.delivery_point,
      ack_date: fmtDate(x.ack_date),
      tanker_number: x.tanker_number, route_name: x.route_name, trip_no: x.trip_no,
      ack_litres: rN(litres), ack_kgs: rN(kgs),
      fat: kgs ? rN(parseFloat(x.ack_kg_fat) / kgs * 100) : null,
      snf: kgs ? rN(parseFloat(x.ack_kg_snf) / kgs * 100) : null,
      kg_fat: rN(x.ack_kg_fat), kg_snf: rN(x.ack_kg_snf),
      capacity: cap || null,
      utilization: util,
      remarks: util == null ? '' : util >= threshold ? `ABOVE ${threshold}` : `BELOW ${threshold}`,
    };
  });
}

const UTIL_HEADERS = [
  { title: 'S.NO', key: 's_no', width: 6 },
  { title: 'Started Point', key: 'starting_point', width: 16 },
  { title: 'Delivery Point', key: 'delivery_point', width: 16 },
  { title: 'Ack date', key: 'ack_date', width: 12 },
  { title: 'Tanker Number', key: 'tanker_number', width: 15 },
  { title: 'Route Name', key: 'route_name', width: 18 },
  { title: 'Ack Qty Ltrs', key: 'ack_litres', width: 12, num: true },
  { title: 'Ack Qty Kgs', key: 'ack_kgs', width: 12, num: true },
  { title: 'Fat', key: 'fat', width: 8, num: true },
  { title: 'SNF', key: 'snf', width: 8, num: true },
  { title: 'KG Fat', key: 'kg_fat', width: 10, num: true },
  { title: 'Kg SNF', key: 'kg_snf', width: 10, num: true },
  { title: 'Tanker Capacity', key: 'capacity', width: 13, num: true },
  { title: 'Utilization %', key: 'utilization', width: 12, num: true },
  { title: 'Remarks', key: 'remarks', width: 12 },
];

function buildDayUtilisationWorkbook(rows, fromDate, toDate, threshold) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Day wise Utilisation', { views: [{ state: 'frozen', ySplit: 2 }] });
  ws.columns = UTIL_HEADERS.map(h => ({ width: h.width }));

  ws.mergeCells(1, 1, 1, UTIL_HEADERS.length);
  const title = ws.getCell(1, 1);
  title.value = `Day wise Tanker Utilisation — ${fromDate}${toDate !== fromDate ? ` to ${toDate}` : ''} (threshold ${threshold}%)`;
  title.font = { bold: true, size: 14, color: { argb: 'FF003A6B' } };
  ws.getRow(1).height = 24;

  UTIL_HEADERS.forEach((h, i) => {
    const c = ws.getCell(2, i + 1);
    c.value = h.title;
    c.font = { bold: true, color: { argb: HEADER_TEXT } };
    c.fill = fillOf('FFE0F2FE');
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = BORDER;
  });

  rows.forEach((x, ri) => {
    const row = ws.getRow(3 + ri);
    UTIL_HEADERS.forEach((h, i) => {
      const c = row.getCell(i + 1);
      const v = x[h.key];
      c.border = BORDER;
      if (h.num) {
        c.value = v == null ? null : parseFloat(v);
        c.numFmt = '#,##0.00';
        c.alignment = { horizontal: 'right' };
      } else c.value = v ?? '';
      if (h.key === 'remarks' && v) {
        c.font = { bold: true, color: { argb: v.startsWith('ABOVE') ? GREEN : RED } };
        c.alignment = { horizontal: 'center' };
      }
      if (h.key === 'utilization' && v != null) {
        c.font = { bold: true, color: { argb: parseFloat(v) >= threshold ? GREEN : RED } };
      }
    });
  });
  return wb;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/day-utilisation?from_date=&to_date=&threshold=95
// ─────────────────────────────────────────────────────────────────────────────
router.get('/day-utilisation', authenticate, async (req, res) => {
  const { from_date, to_date } = req.query;
  const threshold = parseFloat(req.query.threshold) || 95;
  if (!from_date) return res.status(400).json({ error: 'from_date required' });
  try {
    res.json(await buildDayUtilisation(from_date, to_date || from_date, threshold));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/day-utilisation/excel?from_date=&to_date=&threshold=95
// ─────────────────────────────────────────────────────────────────────────────
router.get('/day-utilisation/excel', authenticate, async (req, res) => {
  const { from_date, to_date } = req.query;
  const threshold = parseFloat(req.query.threshold) || 95;
  if (!from_date) return res.status(400).json({ error: 'from_date required' });
  try {
    const to = to_date || from_date;
    const rows = await buildDayUtilisation(from_date, to, threshold);
    const wb   = buildDayUtilisationWorkbook(rows, from_date, to, threshold);
    const buf  = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Disposition', `attachment; filename=day_utilisation_${from_date}_${to}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// TRIP DURATIONS REPORT — derived from Gate Pass / COA first-print timestamps.
//   Round Trip: gate_pass first print (trip start) → coa first print (arrived).
//   Delivery Turnaround: per tanker, coa first print → SAME tanker's next trip
//   gate_pass first print (time spent inside the delivery point).
// ═════════════════════════════════════════════════════════════════════════════
const durationParts = mins => {
  if (mins == null) return { minutes: null, days: null, label: null };
  const m = Math.max(0, Math.round(mins));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return {
    minutes: m,
    days: rN(m / 1440, 2),
    label: `${d}d ${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
  };
};

async function buildTripDurations(fromDate, toDate) {
  // First prints per trip in the plan-date window, plus tanker id for pairing.
  const r = await query(`
    SELECT tp.id AS plan_id, tp.trip_no, tp.plan_for_date, tp.tanker_id,
           t.tanker_number, rm.route_name,
           sp.name AS starting_point, dp.name AS delivery_point,
           (SELECT MIN(printed_at) FROM trip_document_prints
             WHERE trip_plan_id=tp.id AND doc_type='gate_pass') AS gate_pass_at,
           (SELECT MIN(printed_at) FROM trip_document_prints
             WHERE trip_plan_id=tp.id AND doc_type='coa')       AS coa_at,
           (SELECT MIN(printed_at) FROM trip_document_prints
             WHERE trip_plan_id=tp.id AND doc_type='unloading') AS unloaded_at
    FROM trip_plans tp
    LEFT JOIN tankers t          ON t.id=tp.tanker_id
    LEFT JOIN route_masters rm   ON rm.id=tp.route_id
    LEFT JOIN starting_points sp ON sp.id=tp.start_point_id
    LEFT JOIN delivery_points dp ON dp.id=tp.delivery_point_id
    WHERE tp.plan_for_date BETWEEN $1 AND $2
      AND tp.status NOT IN ('cancelled','deleted')
    ORDER BY tp.plan_for_date, tp.trip_no`, [fromDate, toDate]);

  const round_trips = r.rows.map(x => {
    const started = !!x.gate_pass_at;
    const arrived = !!x.coa_at;
    const mins = started && arrived
      ? (new Date(x.coa_at) - new Date(x.gate_pass_at)) / 60000 : null;
    return {
      trip_no: x.trip_no, plan_for_date: fmtDate(x.plan_for_date),
      tanker_number: x.tanker_number, route_name: x.route_name,
      starting_point: x.starting_point, delivery_point: x.delivery_point,
      trip_start_at: x.gate_pass_at, arrived_at: x.coa_at,
      status: arrived ? 'Completed' : started ? 'On trip' : 'Not started',
      duration: durationParts(mins),
    };
  });

  // Turnaround: pair each COA with the same tanker's NEXT gate-pass first print
  // (any plan date — look ahead beyond the window so recent COAs pair correctly).
  const gp = await query(`
    SELECT tp.tanker_id, tp.trip_no, MIN(p.printed_at) AS first_at
    FROM trip_document_prints p
    JOIN trip_plans tp ON tp.id=p.trip_plan_id
    WHERE p.doc_type='gate_pass' AND tp.tanker_id IS NOT NULL
      AND tp.status NOT IN ('cancelled','deleted')
    GROUP BY tp.tanker_id, tp.trip_no, tp.id`);
  const gpByTanker = {};
  for (const g of gp.rows) (gpByTanker[g.tanker_id] ||= []).push(g);
  for (const list of Object.values(gpByTanker)) list.sort((a, b) => new Date(a.first_at) - new Date(b.first_at));

  const turnarounds = [];
  for (const x of r.rows) {
    if (!x.coa_at || !x.tanker_id) continue;
    const next = (gpByTanker[x.tanker_id] || [])
      .find(g => new Date(g.first_at) > new Date(x.coa_at));
    const mins = next ? (new Date(next.first_at) - new Date(x.coa_at)) / 60000 : null;
    // Split of in-plant time: unloading = COA → unloading-done click;
    // cleaning = unloading-done → next gate pass (same tanker).
    const unloadMins = x.unloaded_at
      ? (new Date(x.unloaded_at) - new Date(x.coa_at)) / 60000 : null;
    const cleanMins = x.unloaded_at && next
      ? (new Date(next.first_at) - new Date(x.unloaded_at)) / 60000 : null;
    turnarounds.push({
      tanker_number: x.tanker_number,
      arrived_trip_no: x.trip_no, plan_for_date: fmtDate(x.plan_for_date),
      delivery_point: x.delivery_point,
      arrived_at: x.coa_at,
      unloading_done_at: x.unloaded_at,
      next_trip_no: next ? next.trip_no : null,
      next_gate_pass_at: next ? next.first_at : null,
      status: next ? 'Departed' : 'In plant',
      unloading: durationParts(unloadMins),
      cleaning: durationParts(cleanMins),
      duration: durationParts(mins),
    });
  }

  return { from_date: fromDate, to_date: toDate, round_trips, turnarounds };
}

const fmtTs = ts => {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function buildTripDurationsWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  const header = (ws, cols) => {
    ws.getRow(1).height = 22;
    cols.forEach((h, i) => {
      const c = ws.getCell(1, i + 1);
      c.value = h.title;
      c.font = { bold: true, color: { argb: HEADER_TEXT } };
      c.fill = fillOf('FFE0F2FE');
      c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      c.border = BORDER;
      ws.getColumn(i + 1).width = h.width;
    });
  };
  const put = (ws, rIdx, vals, numCols = []) => vals.forEach((v, i) => {
    const c = ws.getCell(rIdx, i + 1);
    c.value = v ?? '';
    c.border = BORDER;
    if (numCols.includes(i)) { c.numFmt = '#,##0.00'; c.alignment = { horizontal: 'right' }; }
  });

  const ws1 = wb.addWorksheet('Round Trips');
  header(ws1, [
    { title: 'Trip #', width: 8 }, { title: 'Plan Date', width: 12 }, { title: 'Tanker', width: 15 },
    { title: 'Route', width: 20 }, { title: 'Starting Point', width: 16 }, { title: 'Delivery Point', width: 16 },
    { title: 'Trip Start (Gate Pass)', width: 18 }, { title: 'Arrived (COA)', width: 18 },
    { title: 'Round Trip (d hh:mm)', width: 16 }, { title: 'Days (decimal)', width: 13 }, { title: 'Status', width: 12 },
  ]);
  data.round_trips.forEach((x, i) => put(ws1, i + 2, [
    x.trip_no, x.plan_for_date, x.tanker_number, x.route_name, x.starting_point, x.delivery_point,
    fmtTs(x.trip_start_at), fmtTs(x.arrived_at), x.duration.label, x.duration.days, x.status,
  ], [9]));

  const ws2 = wb.addWorksheet('Delivery Turnaround');
  header(ws2, [
    { title: 'Tanker', width: 15 }, { title: 'Arrived Trip #', width: 12 }, { title: 'Plan Date', width: 12 },
    { title: 'Delivery Point', width: 16 }, { title: 'Arrived (COA)', width: 18 },
    { title: 'Unloading Done', width: 18 }, { title: 'Unloading (d hh:mm)', width: 16 },
    { title: 'Next Trip #', width: 10 }, { title: 'Next Gate Pass', width: 18 },
    { title: 'Cleaning (d hh:mm)', width: 16 },
    { title: 'In-Plant Total (d hh:mm)', width: 18 }, { title: 'Days (decimal)', width: 13 }, { title: 'Status', width: 12 },
  ]);
  data.turnarounds.forEach((x, i) => put(ws2, i + 2, [
    x.tanker_number, x.arrived_trip_no, x.plan_for_date, x.delivery_point, fmtTs(x.arrived_at),
    fmtTs(x.unloading_done_at), x.unloading.label,
    x.next_trip_no, fmtTs(x.next_gate_pass_at), x.cleaning.label,
    x.duration.label, x.duration.days, x.status,
  ], [11]));

  return wb;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/trip-durations?from_date=&to_date=
// ─────────────────────────────────────────────────────────────────────────────
router.get('/trip-durations', authenticate, async (req, res) => {
  const { from_date, to_date } = req.query;
  if (!from_date || !to_date) return res.status(400).json({ error: 'from_date and to_date required' });
  try {
    res.json(await buildTripDurations(from_date, to_date));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/trip-durations/excel?from_date=&to_date=
// ─────────────────────────────────────────────────────────────────────────────
router.get('/trip-durations/excel', authenticate, async (req, res) => {
  const { from_date, to_date } = req.query;
  if (!from_date || !to_date) return res.status(400).json({ error: 'from_date and to_date required' });
  try {
    const data = await buildTripDurations(from_date, to_date);
    const wb   = buildTripDurationsWorkbook(data);
    const buf  = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Disposition', `attachment; filename=trip_durations_${from_date}_${to_date}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
