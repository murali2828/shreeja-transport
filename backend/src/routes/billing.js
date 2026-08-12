// backend/src/routes/billing.js
// Fortnightly vendor payment billing:
//   biller executes a date range → all trips WITH acknowledgement data become
//   billing lines; per trip the biller selects the STATE, sees the derived
//   transport type (1 BMCU pickup → Point to Point, 2+ → BMCU/CC to Dairy/CC),
//   the system distance (Distance Master + Google legs, with breakdown), can
//   override the billed km and add remarks. Rate = tanker_rates row matching
//   state × capacity KL × transport type whose period covers the trip's
//   PLANNING date. Amount = billed km × rate.
//   Submit → 3-level sequential email approval (no-login token links):
//     L1 Mahesh → L2 Krithiga → L3 Thimmappa. Reject (remarks mandatory)
//   returns the run to the biller; resubmission restarts from L1.
const express    = require('express');
const router     = express.Router();
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const ExcelJS    = require('exceljs');
const { query, pool } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { computeExecutionDistance } = require('../services/executionData');

const APPROVERS = [
  { level: 1, email: process.env.BILLING_APPROVER_1 || 'Mahesh.k@shreejamilk.com',      name: 'Mahesh K' },
  { level: 2, email: process.env.BILLING_APPROVER_2 || 'krithiga.a@shreejamilk.com',    name: 'Krithiga A' },
  { level: 3, email: process.env.BILLING_APPROVER_3 || 'Thimmappa.sura@shreejamilk.com', name: 'Thimmappa Sura' },
];
const BASE_URL = () => process.env.APP_BASE_URL || 'https://tms.shreejamilk.com';
const STATES = ['Andhra Pradesh', 'Tamil Nadu', 'Karnataka', 'Telangana'];

const rN = (v, d = 2) => v == null ? null : Math.round(parseFloat(v) * 10 ** d) / 10 ** d;
const nf = (v, d = 2) => v == null ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

const { createTransport } = require('../config/mailer');

const canBill = ['admin', 'biller'];

// Rate lookup: state × transport type × capacity KL, period covering planDate.
async function findRate(state, transportType, capacityLitres, planDate) {
  if (!state || !transportType || !capacityLitres || !planDate) return null;
  const r = await query(`
    SELECT id, rate_per_km FROM tanker_rates
    WHERE state = $1 AND transport_type = $2
      AND ABS(capacity_kl - $3::numeric / 1000.0) < 0.051
      AND $4::date BETWEEN effective_from AND effective_to
    ORDER BY ABS(capacity_kl - $3::numeric / 1000.0)
    LIMIT 1`, [state, transportType, capacityLitres, planDate]);
  return r.rows[0] || null;
}

function recomputeAmount(trip) {
  return (trip.billed_km != null && trip.rate_per_km != null)
    ? rN(parseFloat(trip.billed_km) * parseFloat(trip.rate_per_km))
    : null;
}

// ── POST /api/billing/runs  { from_date, to_date } — execute a fortnight ────
router.post('/runs', authenticate, authorize(...canBill), async (req, res) => {
  const { from_date, to_date } = req.body;
  if (!from_date || !to_date) return res.status(400).json({ error: 'from_date and to_date are required' });
  if (to_date < from_date)    return res.status(400).json({ error: 'to_date is before from_date' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query(`
      INSERT INTO billing_runs (from_date, to_date, created_by, created_by_name)
      VALUES ($1,$2,$3,$4) RETURNING id`,
      [from_date, to_date, req.user.id, req.user.user_id || req.user.full_name || null]);
    const runId = run.rows[0].id;

    // Trips with acknowledgement data — the fortnight's own trips PLUS
    // carry-forward: earlier trips (up to 31 days back) whose acknowledgement
    // arrived late and which were never included in any other billing run,
    // e.g. planned on the 15th but acknowledged on the 16th/17th. Rates for
    // carried trips still apply by their own PLANNING date.
    const trips = await client.query(`
      SELECT te.id AS execution_id, tp.plan_for_date::text AS plan_for_date,
             (tp.plan_for_date < $1::date) AS carried_forward,
             t.tanker_number, t.capacity_litres, t.vendor_id,
             COALESCE(v.vendor_name, t.vendor_name) AS vendor_name,
             rm.route_name, sp.name AS start_point, dp.name AS delivery_point,
             (SELECT COUNT(DISTINCT teb.bmcu_id) FROM trip_execution_bmcus teb
               WHERE teb.execution_id = te.id AND teb.is_deleted = FALSE)::int AS bmcu_count,
             (SELECT SUM(ta.qty_litres) FROM trip_acknowledgements ta WHERE ta.execution_id = te.id) AS ack_litres,
             (SELECT SUM(ta.qty_kgs)    FROM trip_acknowledgements ta WHERE ta.execution_id = te.id) AS ack_kgs
      FROM trip_plans tp
      JOIN trip_executions te ON te.trip_plan_id = tp.id
      LEFT JOIN tankers t          ON t.id  = tp.tanker_id
      LEFT JOIN vendors v          ON v.id  = t.vendor_id
      LEFT JOIN route_masters rm   ON rm.id = tp.route_id
      LEFT JOIN starting_points sp ON sp.id = tp.start_point_id
      LEFT JOIN delivery_points dp ON dp.id = tp.delivery_point_id
      WHERE tp.plan_for_date BETWEEN ($1::date - INTERVAL '31 days') AND $2
        AND tp.status NOT IN ('cancelled','deleted')
        AND EXISTS (SELECT 1 FROM trip_acknowledgements ta WHERE ta.execution_id = te.id)
        AND NOT EXISTS (SELECT 1 FROM billing_run_trips brt WHERE brt.execution_id = te.id)
      ORDER BY tp.plan_for_date, t.tanker_number`, [from_date, to_date]);

    for (const tr of trips.rows) {
      // System distance with leg breakdown (Master → Google → estimate)
      const dist = await computeExecutionDistance(client, tr.execution_id, req.user.id);
      const sumBy = src => rN(dist.legs.filter(l => l.source === src).reduce((s, l) => s + l.km, 0));
      const transportType = tr.bmcu_count > 1 ? 'BMCU/CC to Dairy/CC' : 'Point to Point';
      await client.query(`
        INSERT INTO billing_run_trips
          (run_id, execution_id, plan_for_date, tanker_number, capacity_litres,
           vendor_id, vendor_name, route_name, start_point, delivery_point,
           bmcu_count, ack_litres, ack_kgs, transport_type,
           system_km, google_km, master_km, estimated_km, billed_km, legs)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [runId, tr.execution_id, tr.plan_for_date, tr.tanker_number, tr.capacity_litres,
         tr.vendor_id, tr.vendor_name, tr.route_name, tr.start_point, tr.delivery_point,
         tr.bmcu_count, rN(tr.ack_litres), rN(tr.ack_kgs), transportType,
         rN(dist.total_km), sumBy('google'), sumBy('master'), sumBy('estimated'),
         rN(dist.total_km), JSON.stringify(dist.legs)]);
    }
    await client.query('COMMIT');
    res.json({ id: runId, trips: trips.rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Billing run create error:', err);
    res.status(500).json({ error: 'Failed to create billing run' });
  } finally { client.release(); }
});

// ── GET /api/billing/runs — list ─────────────────────────────────────────────
router.get('/runs', authenticate, authorize(...canBill, 'viewer'), async (req, res) => {
  try {
    const r = await query(`
      SELECT br.*, br.from_date::text AS from_date, br.to_date::text AS to_date,
             (SELECT COUNT(*) FROM billing_run_trips t WHERE t.run_id = br.id)::int AS trip_count
      FROM billing_runs br ORDER BY br.id DESC LIMIT 100`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/billing/runs/:id — full detail ──────────────────────────────────
router.get('/runs/:id', authenticate, authorize(...canBill, 'viewer'), async (req, res) => {
  try {
    const run = await query(`
      SELECT br.*, br.from_date::text AS from_date, br.to_date::text AS to_date
      FROM billing_runs br WHERE br.id = $1`, [req.params.id]);
    if (!run.rows.length) return res.status(404).json({ error: 'Run not found' });
    const trips = await query(`
      SELECT *, plan_for_date::text AS plan_for_date
      FROM billing_run_trips WHERE run_id = $1
      ORDER BY plan_for_date, tanker_number`, [req.params.id]);
    const approvals = await query(`
      SELECT level, approver_email, status, remarks, decided_at
      FROM billing_run_approvals WHERE run_id = $1 ORDER BY level`, [req.params.id]);
    res.json({ ...run.rows[0], trips: trips.rows, approvals: approvals.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /api/billing/runs/:id/trips — bulk update lines (biller edits) ───────
router.put('/runs/:id/trips', authenticate, authorize(...canBill), async (req, res) => {
  const updates = req.body.trips || [];
  try {
    const run = await query('SELECT status FROM billing_runs WHERE id=$1', [req.params.id]);
    if (!run.rows.length) return res.status(404).json({ error: 'Run not found' });
    if (!['draft', 'rejected'].includes(run.rows[0].status))
      return res.status(400).json({ error: 'Run is under approval or approved — lines cannot be edited' });

    const results = [];
    for (const u of updates) {
      const cur = await query('SELECT * FROM billing_run_trips WHERE id=$1 AND run_id=$2', [u.id, req.params.id]);
      if (!cur.rows.length) continue;
      const t = cur.rows[0];
      const state          = u.state !== undefined ? (u.state || null) : t.state;
      const billedKm       = u.billed_km !== undefined ? rN(u.billed_km) : t.billed_km;
      const remarks        = u.remarks !== undefined ? (u.remarks || null) : t.remarks;
      const transportType  = u.transport_type !== undefined ? u.transport_type : t.transport_type;
      if (state && !STATES.includes(state))
        return res.status(400).json({ error: `Invalid state: ${state}` });

      let rateId = t.rate_id, ratePerKm = t.rate_per_km;
      const rate = await findRate(state, transportType, t.capacity_litres, t.plan_for_date);
      rateId = rate ? rate.id : null;
      ratePerKm = rate ? rate.rate_per_km : null;
      const amount = recomputeAmount({ billed_km: billedKm, rate_per_km: ratePerKm });

      await query(`
        UPDATE billing_run_trips
        SET state=$1, billed_km=$2, remarks=$3, transport_type=$4,
            rate_id=$5, rate_per_km=$6, amount=$7, updated_at=NOW()
        WHERE id=$8`,
        [state, billedKm, remarks, transportType, rateId, ratePerKm, amount, u.id]);
      results.push({ id: u.id, rate_per_km: ratePerKm, amount, no_rate: state != null && !rate });
    }
    // refresh run total
    await query(`UPDATE billing_runs SET total_amount =
      (SELECT SUM(amount) FROM billing_run_trips WHERE run_id=$1), updated_at=NOW() WHERE id=$1`,
      [req.params.id]);
    const total = await query('SELECT total_amount FROM billing_runs WHERE id=$1', [req.params.id]);
    res.json({ updated: results, total_amount: total.rows[0].total_amount });
  } catch (err) {
    console.error('Billing trips update error:', err);
    res.status(500).json({ error: 'Failed to update billing lines' });
  }
});

// ── DELETE /api/billing/runs/:id — discard a draft/rejected run ──────────────
router.delete('/runs/:id', authenticate, authorize(...canBill), async (req, res) => {
  try {
    const r = await query(`DELETE FROM billing_runs WHERE id=$1 AND status IN ('draft','rejected') RETURNING id`,
      [req.params.id]);
    if (!r.rows.length) return res.status(400).json({ error: 'Only draft/rejected runs can be deleted' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Summaries (tanker-wise / vendor-wise) ────────────────────────────────────
async function runSummaries(runId) {
  const tankers = await query(`
    SELECT tanker_number, MAX(vendor_name) AS vendor_name, COUNT(*)::int AS trips,
           SUM(billed_km) AS billed_km, SUM(system_km) AS system_km,
           SUM(google_km) AS google_km, SUM(amount) AS amount
    FROM billing_run_trips WHERE run_id=$1
    GROUP BY tanker_number ORDER BY tanker_number`, [runId]);
  const vendors = await query(`
    SELECT COALESCE(vendor_name,'— No vendor mapped —') AS vendor_name,
           COUNT(DISTINCT tanker_number)::int AS tankers, COUNT(*)::int AS trips,
           SUM(billed_km) AS billed_km, SUM(system_km) AS system_km,
           SUM(google_km) AS google_km, SUM(amount) AS amount
    FROM billing_run_trips WHERE run_id=$1
    GROUP BY COALESCE(vendor_name,'— No vendor mapped —') ORDER BY 1`, [runId]);
  const dates = await query(`
    SELECT plan_for_date::text AS date, COUNT(*)::int AS trips,
           COUNT(DISTINCT tanker_number)::int AS tankers,
           SUM(billed_km) AS billed_km, SUM(system_km) AS system_km,
           SUM(google_km) AS google_km, SUM(amount) AS amount
    FROM billing_run_trips WHERE run_id=$1
    GROUP BY plan_for_date ORDER BY plan_for_date`, [runId]);
  return { tankers: tankers.rows, vendors: vendors.rows, dates: dates.rows };
}

router.get('/runs/:id/summary', authenticate, authorize(...canBill, 'viewer'), async (req, res) => {
  try { res.json(await runSummaries(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Excel report (trip / tanker / vendor sheets, incl. system+google km) ─────
async function buildRunWorkbook(runId) {
  const run = (await query('SELECT *, from_date::text AS from_date, to_date::text AS to_date FROM billing_runs WHERE id=$1', [runId])).rows[0];
  const trips = (await query('SELECT *, plan_for_date::text AS plan_for_date FROM billing_run_trips WHERE run_id=$1 ORDER BY plan_for_date, tanker_number', [runId])).rows;
  const { tankers, vendors, dates } = await runSummaries(runId);
  const approvals = (await query('SELECT level, approver_email, status, remarks, decided_at FROM billing_run_approvals WHERE run_id=$1 ORDER BY level', [runId])).rows;

  const wb = new ExcelJS.Workbook();
  const head = (ws, cols) => { const r = ws.addRow(cols); r.font = { bold: true };
    ws.columns.forEach(c => { c.width = 16; }); };

  const ws1 = wb.addWorksheet('Trip Wise');
  ws1.addRow([`Tanker Payment Billing — Run #${runId} · ${run.from_date} → ${run.to_date} · Status: ${run.status}`]).font = { bold: true, size: 13 };
  ws1.addRow([]);
  head(ws1, ['Date', 'Tanker', 'Capacity (KL)', 'Vendor', 'Route', 'Start Point', 'Delivery Point',
    'BMCUs', 'Ack Kgs', 'State', 'Transport Type', 'System KM', 'Google KM', 'Master KM', 'Estimated KM',
    'Billed KM', 'Rate/KM (₹)', 'Amount (₹)', 'Remarks']);
  trips.forEach(t => ws1.addRow([t.plan_for_date, t.tanker_number, rN(t.capacity_litres / 1000, 1),
    t.vendor_name, t.route_name, t.start_point, t.delivery_point, t.bmcu_count, t.ack_kgs,
    t.state, t.transport_type, t.system_km, t.google_km, t.master_km, t.estimated_km,
    t.billed_km, t.rate_per_km, t.amount, t.remarks]));
  const totRow = ws1.addRow(['TOTAL', '', '', '', '', '', '', '', '', '', '',
    rN(trips.reduce((s, t) => s + (+t.system_km || 0), 0)),
    rN(trips.reduce((s, t) => s + (+t.google_km || 0), 0)), '', '',
    rN(trips.reduce((s, t) => s + (+t.billed_km || 0), 0)), '',
    rN(trips.reduce((s, t) => s + (+t.amount || 0), 0)), '']);
  totRow.font = { bold: true };

  const ws2 = wb.addWorksheet('Tanker Wise');
  head(ws2, ['Tanker', 'Vendor', 'Trips', 'Billed KM', 'System KM', 'Google KM', 'Amount (₹)']);
  tankers.forEach(t => ws2.addRow([t.tanker_number, t.vendor_name, t.trips, rN(t.billed_km), rN(t.system_km), rN(t.google_km), rN(t.amount)]));
  ws2.addRow(['TOTAL', '', tankers.reduce((s, t) => s + t.trips, 0),
    rN(tankers.reduce((s, t) => s + (+t.billed_km || 0), 0)), '', '',
    rN(tankers.reduce((s, t) => s + (+t.amount || 0), 0))]).font = { bold: true };

  const ws3 = wb.addWorksheet('Vendor Wise');
  head(ws3, ['Vendor', 'Tankers', 'Trips', 'Billed KM', 'System KM', 'Google KM', 'Amount (₹)']);
  vendors.forEach(v => ws3.addRow([v.vendor_name, v.tankers, v.trips, rN(v.billed_km), rN(v.system_km), rN(v.google_km), rN(v.amount)]));
  ws3.addRow(['TOTAL', '', vendors.reduce((s, v) => s + v.trips, 0),
    rN(vendors.reduce((s, v) => s + (+v.billed_km || 0), 0)), '', '',
    rN(vendors.reduce((s, v) => s + (+v.amount || 0), 0))]).font = { bold: true };

  const wsD = wb.addWorksheet('Date Wise');
  head(wsD, ['Date', 'Trips', 'Tankers', 'Billed KM', 'System KM', 'Google KM', 'Amount (₹)']);
  dates.forEach(d => wsD.addRow([d.date, d.trips, d.tankers, rN(d.billed_km), rN(d.system_km), rN(d.google_km), rN(d.amount)]));
  wsD.addRow(['TOTAL', dates.reduce((s, d) => s + d.trips, 0), '',
    rN(dates.reduce((s, d) => s + (+d.billed_km || 0), 0)), '', '',
    rN(dates.reduce((s, d) => s + (+d.amount || 0), 0))]).font = { bold: true };

  const ws4 = wb.addWorksheet('Approvals');
  head(ws4, ['Level', 'Approver', 'Status', 'Remarks', 'Decided At']);
  approvals.forEach(a => ws4.addRow([a.level, a.approver_email, a.status, a.remarks, a.decided_at ? new Date(a.decided_at).toLocaleString('en-IN') : '']));

  return { wb, run, trips, tankers, vendors };
}

router.get('/runs/:id/report', authenticate, authorize(...canBill, 'viewer'), async (req, res) => {
  try {
    const { wb, run } = await buildRunWorkbook(req.params.id);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Disposition', `attachment; filename=tanker_billing_${run.from_date}_${run.to_date}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('Billing report error:', err);
    res.status(500).json({ error: 'Failed to build report' });
  }
});

// ── Approval emails ──────────────────────────────────────────────────────────
function approvalEmailHtml(run, tankers, vendors, approver, token) {
  const base = BASE_URL();
  const approveUrl = `${base}/api/billing/decide?token=${token}&decision=approve`;
  const rejectUrl  = `${base}/billing-decision?token=${token}&decision=reject`;
  const row = (cells, bold = false) =>
    `<tr>${cells.map(c => `<td style="padding:5px 8px;border:1px solid #e2e8f0;font-size:12px;${bold ? 'font-weight:700;background:#dbeafe;' : ''}">${c}</td>`).join('')}</tr>`;
  return `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:760px;">
    <div style="background:#005ba3;color:#fff;padding:14px 20px;border-radius:10px 10px 0 0;">
      <div style="font-size:17px;font-weight:700;">Tanker Payment Approval — Level ${approver.level}</div>
      <div style="font-size:12px;opacity:.85;">Billing Run #${run.id} · ${run.from_date} → ${run.to_date}</div>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;padding:16px 20px;border-radius:0 0 10px 10px;">
      <p style="font-size:13px;">Dear ${esc(approver.name)},<br/>
        The fortnightly tanker payment for <b>${run.from_date} → ${run.to_date}</b> is awaiting your approval.
        Total payable: <b style="font-size:15px;">₹ ${nf(run.total_amount)}</b>. The detailed report (trip / tanker / vendor wise,
        with system + Google distances) is attached.</p>
      <p style="font-size:13px;font-weight:700;margin:14px 0 6px;">Vendor Wise Summary</p>
      <table style="border-collapse:collapse;width:100%;">
        ${row(['Vendor', 'Tankers', 'Trips', 'Billed KM', 'Amount (₹)'], true)}
        ${vendors.map(v => row([esc(v.vendor_name), v.tankers, v.trips, nf(v.billed_km), nf(v.amount)])).join('')}
      </table>
      <div style="margin:22px 0;text-align:center;">
        <a href="${approveUrl}" style="background:#16a34a;color:#fff;padding:11px 30px;border-radius:8px;text-decoration:none;font-weight:700;margin-right:14px;">✓ APPROVE</a>
        <a href="${rejectUrl}"  style="background:#dc2626;color:#fff;padding:11px 30px;border-radius:8px;text-decoration:none;font-weight:700;">✗ REJECT</a>
      </div>
      <p style="font-size:11px;color:#9ca3af;">One-click links — no login needed. Rejection asks for mandatory remarks.
        To add optional remarks while approving, use: <a href="${base}/billing-decision?token=${token}&decision=approve">approve with remarks</a>.</p>
    </div>
  </div>`;
}

async function sendApprovalEmail(runId, level) {
  const approver = APPROVERS.find(a => a.level === level);
  const ap = await query('SELECT token FROM billing_run_approvals WHERE run_id=$1 AND level=$2', [runId, level]);
  if (!ap.rows.length) throw new Error(`No approval row for run ${runId} level ${level}`);
  const { wb, run, tankers, vendors } = await buildRunWorkbook(runId);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  await createTransport().sendMail({
    from: process.env.SMTP_FROM,
    to: approver.email,
    subject: `Tanker Payment Approval L${level} — Run #${runId} (${run.from_date} → ${run.to_date}) · ₹ ${nf(run.total_amount)}`,
    html: approvalEmailHtml(run, tankers, vendors, approver, ap.rows[0].token),
    attachments: [{ filename: `tanker_billing_${run.from_date}_${run.to_date}.xlsx`, content: buf }],
  });
  await query(`UPDATE billing_run_approvals SET status='pending' WHERE run_id=$1 AND level=$2`, [runId, level]);
}

async function notifyBiller(runId, subject, bodyHtml) {
  const run = (await query('SELECT * FROM billing_runs WHERE id=$1', [runId])).rows[0];
  const u = await query('SELECT email FROM users WHERE id=$1', [run.created_by]);
  const to = u.rows[0]?.email;
  if (!to) return;
  await createTransport().sendMail({ from: process.env.SMTP_FROM, to, subject, html: bodyHtml }).catch(() => {});
}

// ── POST /api/billing/runs/:id/submit — start the approval chain ─────────────
router.post('/runs/:id/submit', authenticate, authorize(...canBill), async (req, res) => {
  try {
    const runId = req.params.id;
    const run = (await query('SELECT * FROM billing_runs WHERE id=$1', [runId])).rows[0];
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!['draft', 'rejected'].includes(run.status))
      return res.status(400).json({ error: 'Run is already submitted or approved' });

    const missing = await query(`
      SELECT COUNT(*)::int AS n FROM billing_run_trips
      WHERE run_id=$1 AND (state IS NULL OR rate_per_km IS NULL OR billed_km IS NULL)`, [runId]);
    if (missing.rows[0].n > 0)
      return res.status(400).json({ error: `${missing.rows[0].n} trip(s) missing state / rate / billed km — complete them before submitting` });

    await query(`UPDATE billing_runs SET total_amount =
      (SELECT SUM(amount) FROM billing_run_trips WHERE run_id=$1) WHERE id=$1`, [runId]);

    // (Re)create the approval chain with fresh tokens — resubmission restarts from L1
    await query('DELETE FROM billing_run_approvals WHERE run_id=$1', [runId]);
    for (const a of APPROVERS) {
      await query(`
        INSERT INTO billing_run_approvals (run_id, level, approver_email, token, status)
        VALUES ($1,$2,$3,$4,'waiting')`,
        [runId, a.level, a.email, crypto.randomBytes(32).toString('hex')]);
    }
    await query(`UPDATE billing_runs SET status='pending_l1', submitted_at=NOW(), updated_at=NOW() WHERE id=$1`, [runId]);
    await sendApprovalEmail(runId, 1);
    res.json({ ok: true, status: 'pending_l1' });
  } catch (err) {
    console.error('Billing submit error:', err);
    res.status(500).json({ error: 'Failed to submit for approval' });
  }
});

// ── Decision core (shared by one-click link and remarks page) ────────────────
async function decide(token, decision, remarks) {
  const ap = (await query('SELECT * FROM billing_run_approvals WHERE token=$1', [token])).rows[0];
  if (!ap) return { error: 'This link is invalid or the run was resubmitted with fresh links.' };
  if (ap.status !== 'pending') return { error: `This approval is already ${ap.status}. No action taken.` };
  if (decision === 'reject' && !String(remarks || '').trim())
    return { error: 'Remarks are mandatory for rejection.', needRemarks: true, run_id: ap.run_id, level: ap.level };

  if (decision === 'approve') {
    await query(`UPDATE billing_run_approvals SET status='approved', remarks=$1, decided_at=NOW() WHERE id=$2`,
      [String(remarks || '').trim() || null, ap.id]);
    if (ap.level < 3) {
      await query(`UPDATE billing_runs SET status=$1, updated_at=NOW() WHERE id=$2`,
        [`pending_l${ap.level + 1}`, ap.run_id]);
      await sendApprovalEmail(ap.run_id, ap.level + 1);
      return { ok: true, message: `Level ${ap.level} approved. The request has been forwarded to the Level ${ap.level + 1} approver.`, run_id: ap.run_id };
    }
    await query(`UPDATE billing_runs SET status='approved', approved_at=NOW(), updated_at=NOW() WHERE id=$1`, [ap.run_id]);
    await notifyBiller(ap.run_id, `Billing Run #${ap.run_id} FULLY APPROVED`,
      `<p style="font-family:sans-serif">Billing run #${ap.run_id} has received final approval. The finance team can make payments per the approved report in the portal (Billing → Run #${ap.run_id}).</p>`);
    return { ok: true, message: 'Final approval recorded. The billing run is now fully APPROVED and the finance team can proceed with payments.', run_id: ap.run_id };
  }

  // reject
  await query(`UPDATE billing_run_approvals SET status='rejected', remarks=$1, decided_at=NOW() WHERE id=$2`,
    [String(remarks).trim(), ap.id]);
  await query(`UPDATE billing_runs SET status='rejected', updated_at=NOW() WHERE id=$1`, [ap.run_id]);
  await notifyBiller(ap.run_id, `Billing Run #${ap.run_id} REJECTED at Level ${ap.level}`,
    `<p style="font-family:sans-serif">Billing run #${ap.run_id} was rejected by the Level ${ap.level} approver.<br/>
     <b>Remarks:</b> ${esc(remarks)}<br/>Correct the run in the portal and resubmit — approvals will restart from Level 1.</p>`);
  return { ok: true, message: `Rejection recorded with remarks. The biller has been notified to correct and resubmit.`, run_id: ap.run_id };
}

const decisionPage = (title, body, ok) => `<!doctype html>
  <html><body style="font-family:sans-serif;background:#f0f7ff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
    <div style="background:#fff;border-radius:14px;padding:36px 44px;box-shadow:0 8px 30px rgba(0,60,120,0.12);max-width:480px;text-align:center;">
      <div style="font-size:40px;">${ok ? '✅' : '🚫'}</div>
      <h2 style="color:${ok ? '#16a34a' : '#dc2626'};margin:12px 0 8px;">${title}</h2>
      <p style="color:#4b5563;font-size:14px;">${body}</p>
    </div></body></html>`;

// ── GET /api/billing/decide — one-click approve from email (public) ──────────
router.get('/decide', async (req, res) => {
  const { token, decision } = req.query;
  if (!token || decision !== 'approve')
    return res.send(decisionPage('Invalid link', 'This link is malformed. Use the buttons in the approval email.', false));
  try {
    const r = await decide(token, 'approve', null);
    if (r.error) return res.send(decisionPage('Cannot approve', esc(r.error), false));
    res.send(decisionPage('Approved', esc(r.message), true));
  } catch (err) {
    console.error('Billing decide error:', err);
    res.send(decisionPage('Something went wrong', esc(err.message), false));
  }
});

// ── GET /api/billing/decision-info — public info for the remarks page ────────
router.get('/decision-info', async (req, res) => {
  try {
    const ap = (await query(`
      SELECT a.run_id, a.level, a.status, a.approver_email, br.from_date::text AS from_date,
             br.to_date::text AS to_date, br.total_amount
      FROM billing_run_approvals a JOIN billing_runs br ON br.id = a.run_id
      WHERE a.token = $1`, [req.query.token])).rows[0];
    if (!ap) return res.status(404).json({ error: 'Invalid or superseded link' });
    res.json(ap);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/billing/decide — decision with remarks (public, from web page) ─
router.post('/decide', async (req, res) => {
  const { token, decision, remarks } = req.body;
  if (!token || !['approve', 'reject'].includes(decision))
    return res.status(400).json({ error: 'Invalid request' });
  try {
    const r = await decide(token, decision, remarks);
    if (r.error) return res.status(400).json({ error: r.error, needRemarks: !!r.needRemarks });
    res.json({ ok: true, message: r.message });
  } catch (err) {
    console.error('Billing decide error:', err);
    res.status(500).json({ error: 'Failed to record the decision' });
  }
});

// ── Cross-run payment report: date-range + filters (finance view) ────────────
// GET /api/billing/report-data?from&to&status=approved|all&tanker=&vendor=
// Aggregates billing lines by trip date across ALL runs whose lines fall in
// the range. status=approved (default) restricts to fully-approved runs —
// the amounts finance can actually pay.
async function reportData(q) {
  const params = [q.from, q.to];
  const cond = ['t.plan_for_date BETWEEN $1 AND $2'];
  if ((q.status || 'approved') !== 'all') { params.push('approved'); cond.push(`br.status = $${params.length}`); }
  if (q.tanker) { params.push(q.tanker); cond.push(`t.tanker_number = $${params.length}`); }
  if (q.vendor) { params.push(q.vendor); cond.push(`COALESCE(t.vendor_name,'— No vendor mapped —') = $${params.length}`); }
  const where = 'WHERE ' + cond.join(' AND ');
  const base = `FROM billing_run_trips t JOIN billing_runs br ON br.id = t.run_id ${where}`;

  const trips = await query(`
    SELECT t.run_id, br.status AS run_status, t.plan_for_date::text AS plan_for_date,
           t.tanker_number, t.capacity_litres, COALESCE(t.vendor_name,'— No vendor mapped —') AS vendor_name,
           t.route_name, t.delivery_point, t.state, t.transport_type,
           t.system_km, t.google_km, t.master_km, t.estimated_km,
           t.billed_km, t.rate_per_km, t.amount, t.remarks
    ${base} ORDER BY t.plan_for_date, t.tanker_number`, params);
  const dates = await query(`
    SELECT t.plan_for_date::text AS date, COUNT(*)::int AS trips,
           COUNT(DISTINCT t.tanker_number)::int AS tankers,
           SUM(t.billed_km) AS billed_km, SUM(t.system_km) AS system_km,
           SUM(t.google_km) AS google_km, SUM(t.amount) AS amount
    ${base} GROUP BY t.plan_for_date ORDER BY t.plan_for_date`, params);
  const tankers = await query(`
    SELECT t.tanker_number, MAX(t.vendor_name) AS vendor_name, COUNT(*)::int AS trips,
           SUM(t.billed_km) AS billed_km, SUM(t.system_km) AS system_km,
           SUM(t.google_km) AS google_km, SUM(t.amount) AS amount
    ${base} GROUP BY t.tanker_number ORDER BY t.tanker_number`, params);
  const vendors = await query(`
    SELECT COALESCE(t.vendor_name,'— No vendor mapped —') AS vendor_name,
           COUNT(DISTINCT t.tanker_number)::int AS tankers, COUNT(*)::int AS trips,
           SUM(t.billed_km) AS billed_km, SUM(t.system_km) AS system_km,
           SUM(t.google_km) AS google_km, SUM(t.amount) AS amount
    ${base} GROUP BY COALESCE(t.vendor_name,'— No vendor mapped —') ORDER BY 1`, params);
  return { trips: trips.rows, dates: dates.rows, tankers: tankers.rows, vendors: vendors.rows };
}

router.get('/report-data', authenticate, authorize(...canBill, 'viewer'), async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  try { res.json(await reportData(req.query)); }
  catch (err) { console.error('Billing report-data error:', err); res.status(500).json({ error: 'Failed to build report' }); }
});

// Excel of the cross-run report
router.get('/report-excel', authenticate, authorize(...canBill, 'viewer'), async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  try {
    const d = await reportData(req.query);
    const statusLabel = (req.query.status || 'approved') === 'all' ? 'All runs' : 'APPROVED runs only';
    const wb = new ExcelJS.Workbook();
    const head = (ws, cols) => { ws.addRow(cols).font = { bold: true }; ws.columns.forEach(c => { c.width = 16; }); };

    const ws1 = wb.addWorksheet('Trip Wise');
    ws1.addRow([`Tanker Payment Report ${from} → ${to} · ${statusLabel}`]).font = { bold: true, size: 13 };
    ws1.addRow([]);
    head(ws1, ['Date', 'Run #', 'Run Status', 'Tanker', 'Capacity (KL)', 'Vendor', 'Route', 'Delivery Point',
      'State', 'Transport Type', 'System KM', 'Google KM', 'Billed KM', 'Rate/KM (₹)', 'Amount (₹)', 'Remarks']);
    d.trips.forEach(t => ws1.addRow([t.plan_for_date, t.run_id, t.run_status, t.tanker_number,
      t.capacity_litres ? rN(t.capacity_litres / 1000, 1) : null, t.vendor_name, t.route_name, t.delivery_point,
      t.state, t.transport_type, t.system_km, t.google_km, t.billed_km, t.rate_per_km, t.amount, t.remarks]));
    ws1.addRow(['TOTAL', '', '', '', '', '', '', '', '', '',
      rN(d.trips.reduce((s, t) => s + (+t.system_km || 0), 0)),
      rN(d.trips.reduce((s, t) => s + (+t.google_km || 0), 0)),
      rN(d.trips.reduce((s, t) => s + (+t.billed_km || 0), 0)), '',
      rN(d.trips.reduce((s, t) => s + (+t.amount || 0), 0)), '']).font = { bold: true };

    const sheet = (name, rows, firstHead, firstKey, secondKey) => {
      const ws = wb.addWorksheet(name);
      head(ws, [firstHead, secondKey === 'vendor_name' ? 'Vendor' : 'Tankers', 'Trips',
        'Billed KM', 'System KM', 'Google KM', 'Amount (₹)']);
      rows.forEach(r => ws.addRow([r[firstKey], r[secondKey], r.trips,
        rN(r.billed_km), rN(r.system_km), rN(r.google_km), rN(r.amount)]));
      ws.addRow(['TOTAL', '', rows.reduce((s, r) => s + (+r.trips || 0), 0),
        rN(rows.reduce((s, r) => s + (+r.billed_km || 0), 0)), '', '',
        rN(rows.reduce((s, r) => s + (+r.amount || 0), 0))]).font = { bold: true };
    };
    sheet('Date Wise', d.dates, 'Date', 'date', 'tankers');
    sheet('Tanker Wise', d.tankers, 'Tanker', 'tanker_number', 'vendor_name');
    sheet('Vendor Wise', d.vendors, 'Vendor', 'vendor_name', 'tankers');

    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Disposition', `attachment; filename=tanker_payment_report_${from}_${to}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('Billing report-excel error:', err);
    res.status(500).json({ error: 'Failed to build report' });
  }
});

module.exports = router;
