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
const { authenticate, authorize, authorizeOrModule } = require('../middleware/auth');
const { computeExecutionDistance } = require('../services/executionData');
const { fmtDateDisplay } = require('../utils/date');
const { loadMasterDistanceCache } = require('../services/distanceLookup');

const { APPROVERS } = require('../services/billingApprovers'); // shared with utilisation approvals (074)
const BASE_URL = () => process.env.APP_BASE_URL || 'https://tms.shreejamilk.com';
const STATES = ['Andhra Pradesh', 'Tamil Nadu', 'Karnataka', 'Telangana'];

const { autoWidth, stylePortalWorkbook } = require('../services/portalExcel');
const { HISTORY_UNTIL, MONTH_NAMES } = require('../services/transportCumulative');
const { fixedCostsInPeriod, normTanker } = require('../services/fixedCosts');
const { portalPlantMap } = require('../services/plantNames');
const { utilisationNote, utilisationNoteHtml } = require('../services/dayUtilisation');
const rN = (v, d = 2) => v == null ? null : Math.round(parseFloat(v) * 10 ** d) / 10 ** d;
const nf = (v, d = 2) => v == null ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const { createTransport: baseTransport } = require('../config/mailer');
// Billing-only QA redirect: set BILLING_EMAIL_REDIRECT on QA to divert ALL
// billing approval/notification emails to one inbox. Other modules
// (TS report, plan emails, etc.) are never affected.
const createTransport = () => baseTransport(process.env.BILLING_EMAIL_REDIRECT);

// ── Vendor email on/off switch — admin-toggleable from the Billing screen,
// separate from the QA-only env redirect above. When OFF (the seeded
// default), vendor-facing tanker-card emails (Push to Vendors + final
// approval) are diverted to a single inbox instead of real vendor
// addresses — used to trial-run the billing workflow against real
// production data without actually contacting vendors. Approver/biller
// notification emails are NOT affected; only the vendor send path checks this.
async function getVendorEmailSettings() {
  const r = await query(`SELECT key, value FROM app_settings WHERE key IN ('billing_vendor_emails_enabled','billing_vendor_email_redirect_to')`);
  const m = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
  return {
    enabled: m.billing_vendor_emails_enabled === 'true',
    redirect_to: m.billing_vendor_email_redirect_to || '',
  };
}
async function createVendorTransport() {
  const s = await getVendorEmailSettings();
  return baseTransport(s.enabled ? null : s.redirect_to);
}

router.get('/vendor-email-settings', authenticate, authorize('admin'), async (req, res) => {
  try { res.json(await getVendorEmailSettings()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.put('/vendor-email-settings', authenticate, authorize('admin'), async (req, res) => {
  const { enabled, redirect_to } = req.body;
  if (!enabled && !String(redirect_to || '').trim())
    return res.status(400).json({ error: 'A redirect address is required while vendor emails are switched off' });
  try {
    await query(`
      INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ('billing_vendor_emails_enabled', $1, NOW(), $2)
      ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW(), updated_by=$2`,
      [enabled ? 'true' : 'false', req.user.id]);
    if (redirect_to !== undefined) {
      await query(`
        INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ('billing_vendor_email_redirect_to', $1, NOW(), $2)
        ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW(), updated_by=$2`,
        [String(redirect_to || '').trim(), req.user.id]);
    }
    res.json(await getVendorEmailSettings());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const canBill = ['admin', 'biller'];

// Toll challan uploads: one PDF/image per tanker per run. Scanned FASTag
// statements run to 8–12 MB, so the limit is 15 MB (nginx allows 20 MB);
// size/type failures come back as a readable 413/400 instead of a bare
// "Request failed with status code 413".
const multer = require('multer');
const CHALLAN_MAX_MB = parseInt(process.env.CHALLAN_MAX_MB || '15', 10) || 15;
const CHALLAN_FILTER = (req, file, cb) => {
  const ok = /\.(pdf|jpg|jpeg|png)$/i.test(file.originalname || '');
  cb(ok ? null : new Error('Challan must be a PDF or JPG/PNG image'), ok);
};
const challanMulter = multer({ storage: multer.memoryStorage(),
  limits: { fileSize: CHALLAN_MAX_MB * 1024 * 1024 }, fileFilter: CHALLAN_FILTER });
// Express-style wrapper so multer errors become JSON with a clear message.
const challanUpload = { single: field => (req, res, next) => challanMulter.single(field)(req, res, err => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: `File is larger than ${CHALLAN_MAX_MB} MB — compress the PDF (or scan at lower resolution) and try again` });
  return res.status(400).json({ error: err.message || 'Upload rejected' });
}) };

// Run grand total = km-based trip amounts + toll challan reimbursements
async function refreshRunTotal(runId) {
  await query(`UPDATE billing_runs SET total_amount =
      COALESCE((SELECT SUM(amount) FROM billing_run_trips WHERE run_id=$1 AND excluded=FALSE), 0)
    + COALESCE((SELECT SUM(amount) FROM billing_run_tolls WHERE run_id=$1), 0),
    updated_at=NOW() WHERE id=$1`, [runId]);
}

// Rate lookup: state × transport type × capacity KL, period covering planDate.
// Shared with the Day Optimizer so both price a trip identically.
const { findRate } = require('../services/rates');

function recomputeAmount(trip) {
  return (trip.billed_km != null && trip.rate_per_km != null)
    ? rN(parseFloat(trip.billed_km) * parseFloat(trip.rate_per_km))
    : null;
}

// ── Eligible trips of a fortnight (shared by Execute and Re-add) ─────────────
// Trips with acknowledgement data — the fortnight's own trips PLUS
// carry-forward: earlier trips (up to 31 days back) whose acknowledgement
// arrived late and which were never included in any other billing run,
// e.g. planned on the 15th but acknowledged on the 16th/17th. Rates for
// carried trips still apply by their own PLANNING date.
//
// BILLING_CARRY_FORWARD_FLOOR (env, optional, 'YYYY-MM-DD'): the
// carry-forward window never reaches earlier than this BILLING date
// (plan_for_date + BILLING_DATE_OFFSET_DAYS), regardless of the 31-day
// lookback. For the Sep 2026 parallel run with the transport billing team
// it is '2026-09-01' so nothing from August is swept in. Set on production only, to '2026-08-16' —
// billing cycles for 2nd fortnight July 2026 through 1st fortnight
// August 2026 were intentionally never run, and those unbilled trips
// must NOT be swept into the 2nd fortnight August 2026 run. Once every
// run's own 31-day lookback naturally stays at/after this floor (i.e.
// from the run after 2nd fortnight August 2026 onward), this setting
// becomes a permanent no-op and can be left in place or removed.
// BILLING_DATE_OFFSET_DAYS (env, default 0): the transport billing team
// bills a trip on its DELIVERY date, which is the milk-lifting date
// (= trip_plans.plan_for_date) + 1. With offset 1 a run for 1–15 Sep
// selects plan_for_date 31 Aug – 14 Sep, matching the team's "Sep 1st FN"
// tanker cards exactly (verified row for row on 17 Sep 2026). Set to 1 on
// both tiers; leave 0 only for a fortnight defined on lifting dates.
//
// NOT EXISTS on billing_run_trips means the same query also yields exactly
// the trips a run LOST (e.g. dropped by the pre-2026-09-29 Submit) when it
// is re-run for that run's period — that is what Re-add relies on.
//
// opts.includeLateAcks (biller override, owner decision 2026-10-05): also
// return trips of the period acknowledged AFTER the cutoff (they would
// otherwise carry forward whole into the next fortnight). Each such row comes
// back with late_ack = true and late_ack_at so the billing line can say so.
// Acknowledgement cutoff for a fortnight ending on to_date: BILLING_ACK_CUTOFF_TIME
// (HH:MM, default 06:00) on the morning AFTER the period end, i.e. 06:00 on the
// 16th / 1st (owner, 2026-10-05; was 23:59:59 of the last day). Night deliveries
// of the last day are acknowledged in the small hours and belong to the period.
function ackCutoffFor(to_date) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((process.env.BILLING_ACK_CUTOFF_TIME || '06:00').trim());
  const hh = m ? String(Math.min(23, +m[1])).padStart(2, '0') : '06', mm = m ? m[2] : '00';
  const d = new Date(`${to_date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
  return `${d.toISOString().slice(0, 10)} ${hh}:${mm}:00`;
}

// Column list shared by Execute / Re-add (period selection) and "Pull trip"
// (one execution by tanker + lifting date, outside the period — 2026-10-06).
// $1 from_date, $2 to_date, $3 ack cutoff, $4 carry-forward floor, $5 offset days.
const ELIGIBLE_TRIP_SELECT = `
      SELECT te.id AS execution_id, tp.plan_for_date::text AS plan_for_date,
             tp.trip_kind, te.actual_km AS manual_km,
             (tp.plan_for_date + ($5::int) < $1::date) AS carried_forward,
             EXISTS (SELECT 1 FROM trip_acknowledgements ta WHERE ta.execution_id = te.id AND ta.created_at > $3::timestamp) AS late_ack,
             (SELECT to_char(MAX(ta.created_at) AT TIME ZONE 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI')
                FROM trip_acknowledgements ta WHERE ta.execution_id = te.id) AS late_ack_at,
             t.tanker_number, t.capacity_litres, t.vendor_id,
             COALESCE(v.vendor_name, t.vendor_name) AS vendor_name,
             rm.route_name, sp.name AS start_point, dp.name AS delivery_point,
             (SELECT COUNT(DISTINCT teb.bmcu_id) FROM trip_execution_bmcus teb
               WHERE teb.execution_id = te.id AND teb.is_deleted = FALSE)::int AS bmcu_count,
             COALESCE(
               (SELECT SUM(ta.qty_litres) FROM trip_acknowledgements ta WHERE ta.execution_id = te.id),
               (SELECT SUM(teb.qty_litres) FROM trip_execution_bmcus teb WHERE teb.execution_id = te.id AND teb.is_deleted = FALSE)
             ) AS ack_litres,
             COALESCE(
               (SELECT SUM(ta.qty_kgs) FROM trip_acknowledgements ta WHERE ta.execution_id = te.id),
               (SELECT SUM(teb.qty_kgs) FROM trip_execution_bmcus teb WHERE teb.execution_id = te.id AND teb.is_deleted = FALSE)
             ) AS ack_kgs,
             -- Weighted-average Fat%/SNF% (kg fat/snf ÷ kg total), same
             -- source cascade (acknowledgement rows, else BMCU dispatch).
             COALESCE(
               (SELECT CASE WHEN SUM(ta.qty_kgs) > 0 THEN SUM(ta.kg_fat) / SUM(ta.qty_kgs) * 100 END FROM trip_acknowledgements ta WHERE ta.execution_id = te.id),
               (SELECT CASE WHEN SUM(teb.qty_kgs) > 0 THEN SUM(teb.kg_fat) / SUM(teb.qty_kgs) * 100 END FROM trip_execution_bmcus teb WHERE teb.execution_id = te.id AND teb.is_deleted = FALSE)
             ) AS ack_fat_pct,
             COALESCE(
               (SELECT CASE WHEN SUM(ta.qty_kgs) > 0 THEN SUM(ta.kg_snf) / SUM(ta.qty_kgs) * 100 END FROM trip_acknowledgements ta WHERE ta.execution_id = te.id),
               (SELECT CASE WHEN SUM(teb.qty_kgs) > 0 THEN SUM(teb.kg_snf) / SUM(teb.qty_kgs) * 100 END FROM trip_execution_bmcus teb WHERE teb.execution_id = te.id AND teb.is_deleted = FALSE)
             ) AS ack_snf_pct,
             -- Sale Tanker: identified by the TANKER itself (a placeholder
             -- vehicle named e.g. "SALE TANKER" used when milk is sold
             -- directly at the BMCU, never acknowledged at a delivery
             -- point) OR by the planner's manual flag on the trip plan.
             -- Milk still counts in TS/Analytics (read from executions/
             -- acknowledgements directly); only vendor billing excludes it.
             (tp.is_sale_tanker OR t.tanker_number ILIKE 'SALE%') AS is_sale_tanker
      FROM trip_plans tp
      -- A plan can carry a CANCELLED execution next to its live one (trip
      -- cancelled and restarted); only the live execution is billable.
      JOIN trip_executions te ON te.trip_plan_id = tp.id AND te.status <> 'cancelled'
      LEFT JOIN tankers t          ON t.id  = tp.tanker_id
      LEFT JOIN vendors v          ON v.id  = t.vendor_id
      LEFT JOIN route_masters rm   ON rm.id = tp.route_id
      LEFT JOIN starting_points sp ON sp.id = tp.start_point_id
      LEFT JOIN delivery_points dp ON dp.id = tp.delivery_point_id
`;

async function selectEligibleTrips(client, from_date, to_date, opts = {}) {
  const includeLate = !!opts.includeLateAcks;
  const offsetDays = Math.max(0, parseInt(process.env.BILLING_DATE_OFFSET_DAYS || '0', 10) || 0);
  const trips = await client.query(ELIGIBLE_TRIP_SELECT + `      WHERE tp.plan_for_date + ($5::int)
              BETWEEN GREATEST($1::date - INTERVAL '31 days', COALESCE($4::date, '1900-01-01'::date)) AND $2::date
        AND tp.status NOT IN ('cancelled','deleted')
        AND (
          -- Acknowledgement entry must be fully complete by the fortnight
          -- cutoff (ackCutoffFor: 06:00 on the morning after the period end)
          -- — a trip with even one ack row entered after the cutoff carries
          -- forward whole to the next cycle (unless the biller includes it).
          (EXISTS (SELECT 1 FROM trip_acknowledgements ta WHERE ta.execution_id = te.id)
           AND ($6::boolean OR NOT EXISTS (SELECT 1 FROM trip_acknowledgements ta WHERE ta.execution_id = te.id AND ta.created_at > $3::timestamp)))
          OR t.tanker_number ILIKE 'SALE%'
        )
        AND NOT EXISTS (SELECT 1 FROM billing_run_trips brt WHERE brt.execution_id = te.id)
      ORDER BY tp.plan_for_date, t.tanker_number`,
      [from_date, to_date, ackCutoffFor(to_date), process.env.BILLING_CARRY_FORWARD_FLOOR || null, offsetDays, includeLate]);
  return trips.rows;
}

// One closed, acknowledged, unbilled execution by tanker + lifting date, in the
// same row shape as selectEligibleTrips, regardless of the run's period or the
// ack cutoff. Used by POST /runs/:id/pull-trip (biller override).
async function selectTripByKey(client, from_date, to_date, tankerNumber, planForDate) {
  const offsetDays = Math.max(0, parseInt(process.env.BILLING_DATE_OFFSET_DAYS || '0', 10) || 0);
  const r = await client.query(ELIGIBLE_TRIP_SELECT + `
      WHERE regexp_replace(upper(t.tanker_number), '[^A-Z0-9]', '', 'g') = regexp_replace(upper($6::text), '[^A-Z0-9]', '', 'g')
        AND tp.plan_for_date = $7::date
        AND tp.status NOT IN ('cancelled','deleted')
        AND te.status = 'closed'
        AND EXISTS (SELECT 1 FROM trip_acknowledgements ta WHERE ta.execution_id = te.id)
        AND NOT EXISTS (SELECT 1 FROM billing_run_trips brt WHERE brt.execution_id = te.id)
        -- $2 / $4 are only used by the period WHERE; reference them so pg can type them
        AND $2::date IS NOT NULL AND COALESCE($4::date, $2::date) IS NOT NULL
      ORDER BY te.id`,
      [from_date, to_date, ackCutoffFor(to_date), process.env.BILLING_CARRY_FORWARD_FLOOR || null, offsetDays, tankerNumber, planForDate]);
  return r.rows;
}

// Insert eligible trips as billing lines of runId (system distance with leg
// breakdown, google reference km, transport type, sale flag, carry-forward).
// Returns the number of new-combination legs. Caller owns the transaction.
async function insertRunTrips(client, runId, trips, userId) {
  // Preload the whole Distance Master once — avoids ~5 SELECTs per trip
  // (an N+1 of thousands of round-trips on a full fortnight).
  const masterCache = await loadMasterDistanceCache(client);

  let newCombos = 0;
  for (const tr of trips) {
    // System distance with leg breakdown (Master → Google → estimate)
    const dist = await computeExecutionDistance(client, tr.execution_id, userId, masterCache);
    newCombos += dist.legs.filter(l => l.is_new).length;
    const sumBy = src => rN(dist.legs.filter(l => l.source === src).reduce((s, l) => s + l.km, 0));
    // Google KM is the reference distance for the whole trip regardless of
    // which source (master/google/estimated) the BILLED km came from — a
    // leg on a manually-entered Master distance still carries its own
    // google_km reference once fetched.
    const googleRefKm = rN(dist.legs.reduce((s, l) => s + (l.google_km || 0), 0));
    const transportType = tr.bmcu_count > 1 ? 'BMCU/CC to Dairy/CC' : 'Point to Point';
    await client.query(`
      INSERT INTO billing_run_trips
        (run_id, execution_id, plan_for_date, tanker_number, capacity_litres,
         vendor_id, vendor_name, route_name, start_point, delivery_point,
         bmcu_count, ack_litres, ack_kgs, ack_fat_pct, ack_snf_pct, transport_type,
         system_km, google_km, master_km, estimated_km, billed_km, legs,
         is_sale_tanker, excluded, carried_forward, remarks, trip_kind)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
      [runId, tr.execution_id, tr.plan_for_date, tr.tanker_number, tr.capacity_litres,
       tr.vendor_id, tr.vendor_name, tr.route_name, tr.start_point, tr.delivery_point,
       tr.bmcu_count, rN(tr.ack_litres), rN(tr.ack_kgs), rN(tr.ack_fat_pct, 3), rN(tr.ack_snf_pct, 3), transportType,
       rN(dist.total_km), googleRefKm, sumBy('master'), sumBy('estimated'),
       // Material trips: the executor keys the km to the customer; it is the
       // billed km by default, system / Google stay as the reference.
       tr.trip_kind === 'material' && tr.manual_km != null ? rN(tr.manual_km) : rN(dist.total_km), JSON.stringify(dist.legs),
       !!tr.is_sale_tanker, !!tr.is_sale_tanker, !!tr.carried_forward,
       tr.pulled_remark || (tr.late_ack && !tr.is_sale_tanker ? `Acknowledged after cutoff (${tr.late_ack_at}) — added by biller` : null),
       tr.trip_kind || 'milk']);
  }
  return newCombos;
}

// ── POST /api/billing/runs  { from_date, to_date } — execute a fortnight ────
router.post('/runs', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  const { from_date, to_date } = req.body;
  if (!from_date || !to_date) return res.status(400).json({ error: 'from_date and to_date are required' });
  if (to_date < from_date)    return res.status(400).json({ error: 'to_date is before from_date' });
  // Billing is strictly fortnightly: 1st–15th, or 16th–month end.
  {
    const [fy, fm, fd] = from_date.split('-').map(Number);
    const [ty, tm, td] = to_date.split('-').map(Number);
    const sameMonth = fy === ty && fm === tm;
    const monthEnd = new Date(Date.UTC(fy, fm, 0)).getUTCDate(); // last day of from-month
    const firstFn  = sameMonth && fd === 1  && td === 15;
    const secondFn = sameMonth && fd === 16 && td === monthEnd;
    if (!firstFn && !secondFn)
      return res.status(400).json({ error: `Billing periods are fortnights only: 1–15 or 16–${monthEnd} of a month` });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query(`
      INSERT INTO billing_runs (from_date, to_date, created_by, created_by_name)
      VALUES ($1,$2,$3,$4) RETURNING id`,
      [from_date, to_date, req.user.id, req.user.user_id || req.user.full_name || null]);
    const runId = run.rows[0].id;
    const trips = await selectEligibleTrips(client, from_date, to_date);
    const newCombos = await insertRunTrips(client, runId, trips, req.user.id);
    await client.query('COMMIT');
    res.json({ id: runId, trips: trips.length, new_combinations: newCombos });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Billing run create error:', err);
    res.status(500).json({ error: 'Failed to create billing run' });
  } finally { client.release(); }
});

// ── Re-add unbilled trips of a run's own period ─────────────────────────────
// Recovery for a run that lost lines (the pre-2026-09-29 Submit deleted the
// trips of tankers without a toll challan; production run #15 lost 219 of
// 666). Same eligibility query and insert path as Execute for the run's
// from/to (same offset, floor, ack cutoff, NOT EXISTS in billing_run_trips),
// so only trips in NO run come back. Keyed state/km on existing lines are
// untouched; the re-added lines start unkeyed like a fresh Execute
// (scripts/restore_run_keyed.js restores them from a CSV).
const EDITABLE = ['draft', 'rejected', 'pending_vendor'];
router.get('/runs/:id/readd-preview', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  const client = await pool.connect();
  try {
    const run = (await client.query('SELECT *, from_date::text AS from_date, to_date::text AS to_date FROM billing_runs WHERE id=$1', [req.params.id])).rows[0];
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const trips = await selectEligibleTrips(client, run.from_date, run.to_date);
    // Late-acknowledged trips of the same period, offered separately so the
    // biller opts in to them explicitly (owner decision 2026-10-05).
    const withLate = await selectEligibleTrips(client, run.from_date, run.to_date, { includeLateAcks: true });
    const late = withLate.filter(t => t.late_ack && !t.is_sale_tanker);
    res.json({ missing: trips.length, tankers: [...new Set(trips.map(t => t.tanker_number))].sort(),
               late_missing: late.length, late_tankers: [...new Set(late.map(t => t.tanker_number))].sort(),
               ack_cutoff: ackCutoffFor(run.to_date) });
  } catch (err) {
    console.error('Billing readd-preview error:', err);
    res.status(500).json({ error: 'Failed to check unbilled trips' });
  } finally { client.release(); }
});

router.post('/runs/:id/readd-trips', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  const client = await pool.connect();
  try {
    const runId = req.params.id;
    const run = (await client.query('SELECT *, from_date::text AS from_date, to_date::text AS to_date FROM billing_runs WHERE id=$1', [runId])).rows[0];
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!EDITABLE.includes(run.status))
      return res.status(400).json({ error: 'Trips can only be re-added to a draft / rejected run — withdraw it from approval first' });
    const includeLateAcks = req.body?.include_late_acks === true;
    await client.query('BEGIN');
    const trips = await selectEligibleTrips(client, run.from_date, run.to_date, { includeLateAcks });
    const newCombos = await insertRunTrips(client, runId, trips, req.user.id);
    await client.query('COMMIT');
    await refreshRunTotal(runId);
    const late = trips.filter(t => t.late_ack && !t.is_sale_tanker).length;
    if (late) console.log(`[billing] run ${runId}: ${late} late-acknowledged trip(s) added by ${req.user.user_id || req.user.id}`);
    res.json({ added: trips.length, late_added: late, tankers: [...new Set(trips.map(t => t.tanker_number))].sort(), new_combinations: newCombos });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Billing readd-trips error:', err);
    res.status(500).json({ error: 'Failed to re-add trips' });
  } finally { client.release(); }
});

// ── GET /api/billing/rate-lookup — live rate preview for the run editor ──────
// Called when the biller selects a State so the rate/amount show immediately,
// before Save. Same findRate the save path uses.
router.get('/rate-lookup', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  try {
    const { state, transport_type, capacity_litres, plan_date } = req.query;
    const rate = await findRate(state, transport_type, capacity_litres, plan_date);
    res.json({ rate_per_km: rate ? parseFloat(rate.rate_per_km) : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/billing/runs — list ─────────────────────────────────────────────
router.get('/runs', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  try {
    const r = await query(`
      SELECT br.*, br.from_date::text AS from_date, br.to_date::text AS to_date,
             (SELECT COUNT(*) FROM billing_run_trips t WHERE t.run_id = br.id)::int AS trip_count
      FROM billing_runs br ORDER BY br.id DESC LIMIT 100`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/billing/missing-coordinates?run_id=N | from_date&to_date ────────
// Every BMCU / starting point / delivery point WITHOUT latitude+longitude that
// is touched by the trips of a run (run_id) or by the trips a fortnight run
// WOULD pick up (from_date/to_date, billing-date basis). Lets the biller fix
// masters before executing, and explains "missing" legs on an existing run.
router.get('/missing-coordinates', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  try {
    const { run_id, from_date, to_date } = req.query;
    const offsetDays = Math.max(0, parseInt(process.env.BILLING_DATE_OFFSET_DAYS || '0', 10) || 0);
    let execFilter, params;
    if (run_id) {
      execFilter = 'te.id IN (SELECT execution_id FROM billing_run_trips WHERE run_id = $1)';
      params = [run_id];
    } else if (from_date && to_date) {
      execFilter = `tp.plan_for_date + ($3::int) BETWEEN $1::date AND $2::date
        AND tp.status NOT IN ('cancelled','deleted') AND te.status <> 'cancelled'`;
      params = [from_date, to_date, offsetDays];
    } else return res.status(400).json({ error: 'run_id or from_date+to_date required' });

    const r = await query(`
      WITH ex AS (
        SELECT te.id AS execution_id, tp.start_point_id, tp.delivery_point_id
        FROM trip_executions te JOIN trip_plans tp ON tp.id = te.trip_plan_id
        WHERE ${execFilter}
      ),
      pts AS (
        SELECT 'bmcu' AS kind, teb.bmcu_id AS id, ex.execution_id
        FROM ex JOIN trip_execution_bmcus teb ON teb.execution_id = ex.execution_id AND teb.is_deleted = FALSE
        UNION ALL SELECT 'starting_point', start_point_id, execution_id FROM ex WHERE start_point_id IS NOT NULL
        UNION ALL SELECT 'delivery_point', delivery_point_id, execution_id FROM ex WHERE delivery_point_id IS NOT NULL
      ),
      named AS (
        SELECT p.kind, p.id, p.execution_id,
               CASE p.kind WHEN 'bmcu' THEN b.bmcu_code || ' — ' || b.bmcu_name
                           WHEN 'starting_point' THEN sp.name ELSE dp.name END AS name,
               CASE p.kind WHEN 'bmcu' THEN b.latitude WHEN 'starting_point' THEN sp.latitude ELSE dp.latitude END AS lat,
               CASE p.kind WHEN 'bmcu' THEN b.longitude WHEN 'starting_point' THEN sp.longitude ELSE dp.longitude END AS lng
        FROM pts p
        LEFT JOIN bmcus b            ON p.kind = 'bmcu'           AND b.id  = p.id
        LEFT JOIN starting_points sp ON p.kind = 'starting_point' AND sp.id = p.id
        LEFT JOIN delivery_points dp ON p.kind = 'delivery_point' AND dp.id = p.id
      )
      SELECT kind, id, name, COUNT(DISTINCT execution_id)::int AS trips
      FROM named WHERE lat IS NULL OR lng IS NULL
      GROUP BY kind, id, name
      ORDER BY trips DESC, kind, name`, params);
    res.json({ points: r.rows, trips_affected: r.rows.length
      ? (await query(`SELECT COUNT(DISTINCT execution_id)::int AS n FROM (
           SELECT te.id AS execution_id, tp.start_point_id, tp.delivery_point_id
           FROM trip_executions te JOIN trip_plans tp ON tp.id = te.trip_plan_id WHERE ${execFilter}) ex
         WHERE EXISTS (SELECT 1 FROM trip_execution_bmcus teb JOIN bmcus b ON b.id = teb.bmcu_id
                       WHERE teb.execution_id = ex.execution_id AND teb.is_deleted = FALSE AND (b.latitude IS NULL OR b.longitude IS NULL))
            OR EXISTS (SELECT 1 FROM starting_points sp WHERE sp.id = ex.start_point_id AND (sp.latitude IS NULL OR sp.longitude IS NULL))
            OR EXISTS (SELECT 1 FROM delivery_points dp WHERE dp.id = ex.delivery_point_id AND (dp.latitude IS NULL OR dp.longitude IS NULL))`,
         params)).rows[0].n
      : 0 });
  } catch (err) {
    console.error('Billing missing-coordinates error:', err);
    res.status(500).json({ error: 'Failed to check coordinates' });
  }
});

// ── GET /api/billing/runs/:id — full detail ──────────────────────────────────
router.get('/runs/:id', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  try {
    const run = await query(`
      SELECT br.*, br.from_date::text AS from_date, br.to_date::text AS to_date
      FROM billing_runs br WHERE br.id = $1`, [req.params.id]);
    if (!run.rows.length) return res.status(404).json({ error: 'Run not found' });
    const trips = await query(`
      SELECT t.*, t.plan_for_date::text AS plan_for_date,
             (t.is_sale_tanker OR t.tanker_number ILIKE 'SALE%') AS is_sale_tanker
      FROM billing_run_trips t WHERE t.run_id = $1
      ORDER BY t.plan_for_date, t.tanker_number`, [req.params.id]);
    const approvals = await query(`
      SELECT level, approver_email, status, remarks, decided_at
      FROM billing_run_approvals WHERE run_id = $1 ORDER BY level`, [req.params.id]);
    res.json({ ...run.rows[0], trips: trips.rows, approvals: approvals.rows,
      tolls: await tollRowsOfRun(run.rows[0].id),
      tolls_pending_earlier: await pendingEarlierTolls(run.rows[0]) });
  } catch (err) { console.error('Billing run detail error:', err); res.status(500).json({ error: err.message }); }
});

// ── POST /api/billing/runs/:id/assign-vendor — fix a tanker with no vendor
// mapped, without leaving the billing screen. Updates the Tanker master
// (so future runs auto-map it) and every line for that tanker in THIS run.
router.post('/runs/:id/assign-vendor', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  const { tanker_number, vendor_id } = req.body;
  if (!tanker_number || !vendor_id) return res.status(400).json({ error: 'tanker_number and vendor_id required' });
  try {
    const run = await query('SELECT status FROM billing_runs WHERE id=$1', [req.params.id]);
    if (!run.rows.length) return res.status(404).json({ error: 'Run not found' });
    if (!['draft', 'rejected', 'pending_vendor'].includes(run.rows[0].status))
      return res.status(400).json({ error: 'Run is under approval or approved — lines cannot be edited' });

    const v = (await query('SELECT id, vendor_name FROM vendors WHERE id=$1', [vendor_id])).rows[0];
    if (!v) return res.status(404).json({ error: 'Vendor not found' });

    await query('UPDATE tankers SET vendor_id=$1, updated_at=NOW() WHERE tanker_number=$2', [vendor_id, tanker_number]);
    const r = await query(
      `UPDATE billing_run_trips SET vendor_id=$1, vendor_name=$2, updated_at=NOW()
       WHERE run_id=$3 AND tanker_number=$4 RETURNING id`,
      [vendor_id, v.vendor_name, req.params.id, tanker_number]);
    res.json({ ok: true, vendor_name: v.vendor_name, trips_updated: r.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /api/billing/runs/:id/trips — bulk update lines (biller edits) ───────
router.put('/runs/:id/trips', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  const updates = req.body.trips || [];
  try {
    const run = await query('SELECT status FROM billing_runs WHERE id=$1', [req.params.id]);
    if (!run.rows.length) return res.status(404).json({ error: 'Run not found' });
    if (!['draft', 'rejected', 'pending_vendor'].includes(run.rows[0].status))
      return res.status(400).json({ error: 'Run is under approval or approved — lines cannot be edited' });

    const results = [];
    for (const u of updates) {
      const cur = await query('SELECT * FROM billing_run_trips WHERE id=$1 AND run_id=$2', [u.id, req.params.id]);
      if (!cur.rows.length) continue;
      const t = cur.rows[0];
      const state          = u.state !== undefined ? (u.state || null) : t.state;
      let   billedKm       = u.billed_km !== undefined ? rN(u.billed_km) : t.billed_km;
      const remarks        = u.remarks !== undefined ? (u.remarks || null) : t.remarks;
      const transportType  = u.transport_type !== undefined ? u.transport_type : t.transport_type;
      const excluded        = u.excluded !== undefined ? !!u.excluded : t.excluded;
      if (state && !STATES.includes(state))
        return res.status(400).json({ error: `Invalid state: ${state}` });
      if (u.transport_type !== undefined && !['BMCU/CC to Dairy/CC', 'Point to Point'].includes(u.transport_type))
        return res.status(400).json({ error: `Invalid transport type: ${u.transport_type}` });

      // Leg-level distance edits: [{index, km}]. Edited legs become source
      // 'manual' (original km preserved as orig_km); billed km follows the new
      // leg total unless the biller typed a billed km themselves. Remarks are
      // MANDATORY whenever a leg distance is changed.
      let legsArr = Array.isArray(t.legs) ? t.legs : JSON.parse(t.legs || '[]');
      let legsChanged = false;
      if (Array.isArray(u.legs)) {
        for (const le of u.legs) {
          const i = parseInt(le.index, 10), km = rN(le.km);
          if (!Number.isInteger(i) || i < 0 || i >= legsArr.length || km == null || km < 0)
            return res.status(400).json({ error: `Invalid leg distance edit on trip ${t.tanker_number} (${t.plan_for_date})` });
          const leg = legsArr[i];
          if (rN(leg.km) !== km) {
            if (leg.orig_km == null) leg.orig_km = leg.km;
            leg.km = km;
            leg.source = 'manual';
            legsChanged = true;
          }
        }
        if (legsChanged) {
          if (!String(remarks || '').trim())
            return res.status(400).json({ error: `Remarks are mandatory when leg distances are edited (${t.tanker_number}, ${t.plan_for_date})` });
          if (u.billed_km === undefined)
            billedKm = rN(legsArr.reduce((s, l) => s + (parseFloat(l.km) || 0), 0));
        }
      }

      let rateId = t.rate_id, ratePerKm = t.rate_per_km;
      const rate = await findRate(state, transportType, t.capacity_litres, t.plan_for_date);
      rateId = rate ? rate.id : null;
      ratePerKm = rate ? rate.rate_per_km : null;
      const amount = recomputeAmount({ billed_km: billedKm, rate_per_km: ratePerKm });

      await query(`
        UPDATE billing_run_trips
        SET state=$1, billed_km=$2, remarks=$3, transport_type=$4,
            rate_id=$5, rate_per_km=$6, amount=$7, legs=$8, excluded=$9, updated_at=NOW()
        WHERE id=$10`,
        [state, billedKm, remarks, transportType, rateId, ratePerKm, amount,
         JSON.stringify(legsArr), excluded, u.id]);
      results.push({ id: u.id, rate_per_km: ratePerKm, amount, no_rate: state != null && !rate });
    }
    // refresh run total (trips + tolls)
    await refreshRunTotal(req.params.id);
    const total = await query('SELECT total_amount FROM billing_runs WHERE id=$1', [req.params.id]);
    res.json({ updated: results, total_amount: total.rows[0].total_amount });
  } catch (err) {
    console.error('Billing trips update error:', err);
    res.status(500).json({ error: 'Failed to update billing lines' });
  }
});

// ── DELETE /api/billing/runs/:id — discard a draft/rejected run ──────────────
// ── POST /api/billing/runs/:id/pull-trip { tanker_number, plan_for_date } ──
// Biller override (owner, 2026-10-06, to align run #20 with the manual tanker
// cards): add ONE closed, acknowledged, unbilled trip to a draft / rejected run
// even though its billing date falls outside the run's period or its
// acknowledgement came after the cutoff. The line is remarked so approvers see
// it; the trip can no longer be picked up by its own period's run.
router.post('/runs/:id/pull-trip', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  const tanker = String(req.body?.tanker_number || '').trim();
  const date = String(req.body?.plan_for_date || '').trim();
  if (!tanker || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'tanker_number and plan_for_date (YYYY-MM-DD) required' });
  const client = await pool.connect();
  try {
    const runId = req.params.id;
    const run = (await client.query('SELECT *, from_date::text AS from_date, to_date::text AS to_date FROM billing_runs WHERE id=$1', [runId])).rows[0];
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!EDITABLE.includes(run.status))
      return res.status(400).json({ error: 'Trips can only be added to a draft / rejected run — withdraw it from approval first' });
    const trips = await selectTripByKey(client, run.from_date, run.to_date, tanker, date);
    if (!trips.length) {
      const any = await client.query(`
        SELECT te.status, (SELECT br.id FROM billing_run_trips brt JOIN billing_runs br ON br.id = brt.run_id WHERE brt.execution_id = te.id LIMIT 1) AS in_run
        FROM trip_executions te JOIN trip_plans tp ON tp.id = te.trip_plan_id JOIN tankers t ON t.id = tp.tanker_id
        WHERE regexp_replace(upper(t.tanker_number), '[^A-Z0-9]', '', 'g') = regexp_replace(upper($1::text), '[^A-Z0-9]', '', 'g')
          AND tp.plan_for_date = $2::date AND te.status <> 'cancelled' AND tp.status NOT IN ('cancelled','deleted') LIMIT 1`, [tanker, date]);
      const a = any.rows[0];
      return res.status(404).json({ error: !a ? `No trip of ${tanker} lifted on ${fmtDateDisplay(date)} in the portal`
        : a.in_run ? `That trip is already in Billing Run #${a.in_run}`
        : `That trip is ${a.status.replace('_', ' ')} — it must be closed (acknowledged) before it can be billed` });
    }
    const remark = `Pulled into run #${runId} by biller (lifted ${fmtDateDisplay(date)}, bills ${fmtDateDisplay(trips[0].plan_for_date)} + offset; outside ${fmtDateDisplay(run.from_date)} → ${fmtDateDisplay(run.to_date)})`;
    await client.query('BEGIN');
    const newCombos = await insertRunTrips(client, runId, trips.map(t => ({ ...t, carried_forward: false, pulled_remark: remark })), req.user.id);
    await client.query('COMMIT');
    await refreshRunTotal(runId);
    console.log(`[billing] run ${runId}: ${tanker} ${date} pulled in by ${req.user.user_id || req.user.id}`);
    res.json({ added: trips.length, tanker_number: trips[0].tanker_number, plan_for_date: trips[0].plan_for_date, new_combinations: newCombos });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Billing pull-trip error:', err);
    res.status(500).json({ error: 'Failed to add the trip' });
  } finally { client.release(); }
});

// ── DELETE /api/billing/runs/:id/trips/:tripId — remove one line from an
// editable run. The trip goes back to the unbilled pool, so the next fortnight's
// Execute (or Re-add) picks it up as carried forward — unlike "Excl.", which
// keeps the line in this run and therefore never carries it forward. Owner /
// billing team request 2026-10-06 (align run #20 with the manual tanker cards).
router.delete('/runs/:id/trips/:tripId', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  try {
    const run = (await query('SELECT id, status FROM billing_runs WHERE id=$1', [req.params.id])).rows[0];
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!EDITABLE.includes(run.status))
      return res.status(400).json({ error: 'Trips can only be removed from a draft / rejected run — withdraw it from approval first' });
    const r = await query('DELETE FROM billing_run_trips WHERE id=$1 AND run_id=$2 RETURNING execution_id, tanker_number, plan_for_date::text AS plan_for_date',
      [req.params.tripId, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Trip line not found in this run' });
    await refreshRunTotal(req.params.id);
    console.log(`[billing] run ${req.params.id}: line ${req.params.tripId} (${r.rows[0].tanker_number} ${r.rows[0].plan_for_date}) removed by ${req.user.user_id || req.user.id} — carries forward`);
    res.json({ removed: r.rows[0] });
  } catch (err) {
    console.error('Billing remove-trip error:', err);
    res.status(500).json({ error: 'Failed to remove the trip from the run' });
  }
});

router.delete('/runs/:id', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  try {
    const r = await query(`DELETE FROM billing_runs WHERE id=$1 AND status IN ('draft','rejected','pending_vendor') RETURNING id`,
      [req.params.id]);
    if (!r.rows.length) return res.status(400).json({ error: 'Only draft/rejected runs can be deleted' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Toll gate challans — one per tanker per period; a missing challan never
// blocks submit or drops trips, it is uploaded in a later run with for_run_id
// (migration 046) and paid there ─────────────────────────────────────────────
async function assertEditableRun(runId, res) {
  const run = (await query('SELECT status FROM billing_runs WHERE id=$1', [runId])).rows[0];
  if (!run) { res.status(404).json({ error: 'Run not found' }); return false; }
  if (!['draft', 'rejected', 'pending_vendor'].includes(run.status)) {
    res.status(400).json({ error: 'Run is under approval or approved — toll challans cannot be changed' });
    return false;
  }
  return true;
}

// A toll "for" a run's period is a row with run_id = that run and no
// for_run_id (its own cycle) OR a row anywhere with for_run_id = that run
// (uploaded and paid in a later cycle, migration 046). A challan counts only
// with an amount > 0 and a file attached.
// A "No toll" row (not_applicable, migration 048) also satisfies it.
const TOLL_FOR_RUN_SQL = `
  SELECT tanker_number FROM billing_run_tolls
  WHERE ((amount > 0 AND file_data IS NOT NULL) OR not_applicable = TRUE)
    AND ((run_id = $1 AND for_run_id IS NULL) OR for_run_id = $1)`;

// Tankers with billable (non-excluded, non-sale) trips in runId that still
// have no valid toll challan for runId's period.
async function pendingTollTankers(runId) {
  const r = await query(`
    SELECT DISTINCT t.tanker_number FROM billing_run_trips t
    WHERE t.run_id = $1 AND t.excluded = FALSE
      AND NOT (COALESCE(t.is_sale_tanker, FALSE) OR t.tanker_number ILIKE 'SALE%')
      AND t.tanker_number NOT IN (${TOLL_FOR_RUN_SQL})
    ORDER BY t.tanker_number`, [runId]);
  return r.rows.map(x => x.tanker_number);
}

// Earlier runs (submitted or beyond, from_date before this run's, last 90
// days) whose tankers still owe a toll challan — the biller uploads them in
// THIS run with for_run_id and they are paid in this run's total. Runs still
// in draft / rejected take their tolls directly, so they are not listed.
async function pendingEarlierTolls(run) {
  const r = await query(`
    SELECT t.tanker_number, MAX(t.vendor_name) AS vendor_name,
           br.id AS run_id, br.from_date::text AS from_date, br.to_date::text AS to_date
    FROM billing_runs br
    JOIN billing_run_trips t ON t.run_id = br.id AND t.excluded = FALSE
      AND NOT (COALESCE(t.is_sale_tanker, FALSE) OR t.tanker_number ILIKE 'SALE%')
    WHERE br.id <> $1
      AND br.status IN ('pending_l1','pending_l2','pending_l3','approved')
      AND br.from_date < $2::date
      AND br.from_date >= $2::date - INTERVAL '90 days'
      AND NOT EXISTS (
        SELECT 1 FROM billing_run_tolls x
        WHERE x.tanker_number = t.tanker_number AND ((x.amount > 0 AND x.file_data IS NOT NULL) OR x.not_applicable = TRUE)
          AND ((x.run_id = br.id AND x.for_run_id IS NULL) OR x.for_run_id = br.id))
    GROUP BY t.tanker_number, br.id, br.from_date, br.to_date
    ORDER BY br.from_date, t.tanker_number`, [run.id, run.from_date]);
  return r.rows;
}

// GET /runs/:id/tolls — challan rows of this run (own period + carried in)
// plus the earlier-cycle tankers still owing a challan.
router.get('/runs/:id/tolls', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  try {
    const run = (await query('SELECT id, from_date::text AS from_date FROM billing_runs WHERE id=$1', [req.params.id])).rows[0];
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json({ tolls: await tollRowsOfRun(run.id), pending_earlier: await pendingEarlierTolls(run) });
  } catch (err) { res.status(500).json({ error: 'Failed to load toll challans' }); }
});

async function tollRowsOfRun(runId) {
  return (await query(`
    SELECT x.id, x.tanker_number, x.amount, x.remarks, x.file_name, (x.file_data IS NOT NULL) AS has_file,
           x.not_applicable, x.for_run_id, fr.from_date::text AS for_from_date, fr.to_date::text AS for_to_date
    FROM billing_run_tolls x LEFT JOIN billing_runs fr ON fr.id = x.for_run_id
    WHERE x.run_id = $1 ORDER BY x.tanker_number, x.for_run_id NULLS FIRST`, [runId])).rows;
}

// Upsert: attach/replace the challan + amount for one tanker. Optional
// for_run_id = an EARLIER run's period this challan covers (must be genuinely
// pending there); the row is still paid in THIS run's total.
router.post('/runs/:id/tolls', authenticate, authorizeOrModule('billing', ...canBill), challanUpload.single('file'), async (req, res) => {
  try {
    if (!(await assertEditableRun(req.params.id, res))) return;
    const { tanker_number, amount, remarks } = req.body;
    const forRunId = req.body.for_run_id ? parseInt(req.body.for_run_id, 10) : null;
    const amt = rN(amount);
    if (!tanker_number || amt == null || amt < 0)
      return res.status(400).json({ error: 'Tanker and a non-negative toll amount are required' });
    if (forRunId) {
      if (!Number.isInteger(forRunId) || forRunId === Number(req.params.id))
        return res.status(400).json({ error: 'for_run_id must be an earlier billing run' });
      const run = (await query('SELECT id, from_date::text AS from_date FROM billing_runs WHERE id=$1', [req.params.id])).rows[0];
      const pending = (await pendingEarlierTolls(run)).find(p => p.run_id === forRunId && p.tanker_number === tanker_number);
      if (!pending && !(await query('SELECT 1 FROM billing_run_tolls WHERE run_id=$1 AND tanker_number=$2 AND for_run_id=$3',
          [req.params.id, tanker_number, forRunId])).rows.length)
        return res.status(400).json({ error: `Tanker ${tanker_number} has no toll pending for run #${forRunId}` });
    } else {
      const inRun = await query(
        'SELECT 1 FROM billing_run_trips WHERE run_id=$1 AND tanker_number=$2 LIMIT 1',
        [req.params.id, tanker_number]);
      if (!inRun.rows.length)
        return res.status(400).json({ error: `Tanker ${tanker_number} has no trips in this run` });
    }
    const f = req.file;
    const existing = await query(
      'SELECT file_data IS NOT NULL AS has_file FROM billing_run_tolls WHERE run_id=$1 AND tanker_number=$2 AND for_run_id IS NOT DISTINCT FROM $3',
      [req.params.id, tanker_number, forRunId]);
    if (!f && !existing.rows[0]?.has_file)
      return res.status(400).json({ error: `${tanker_number}: a toll challan attachment (PDF/JPG/PNG) is mandatory — choose a file before saving` });
    const r = await query(`
      INSERT INTO billing_run_tolls (run_id, tanker_number, amount, remarks, file_name, file_mime, file_data, created_by, for_run_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (run_id, tanker_number, COALESCE(for_run_id, 0)) DO UPDATE SET
        amount=$3, remarks=$4,
        file_name=COALESCE($5, billing_run_tolls.file_name),
        file_mime=COALESCE($6, billing_run_tolls.file_mime),
        file_data=COALESCE($7, billing_run_tolls.file_data),
        updated_at=NOW()
      RETURNING id`,
      [req.params.id, tanker_number, amt, remarks || null,
       f ? f.originalname : null, f ? f.mimetype : null, f ? f.buffer : null, req.user.id, forRunId]);
    await refreshRunTotal(req.params.id);
    res.json({ id: r.rows[0].id, ok: true });
  } catch (err) {
    console.error('Toll upsert error:', err);
    res.status(500).json({ error: 'Failed to save toll challan' });
  }
});

// Upload a FASTag statement PDF: tolls are parsed per vehicle plate, matched
// to the run's tankers, and applied as that tanker's toll challan (statement
// attached as the challan document). Supports ICICI E-Statements (multi-
// vehicle Vehicle Summary) and generic FASTag account summaries.
const { parseFastagPdf, normPlate } = require('../services/fastagParser');
router.post('/runs/:id/fastag', authenticate, authorizeOrModule('billing', ...canBill), challanUpload.single('file'), async (req, res) => {
  try {
    if (!(await assertEditableRun(req.params.id, res))) return;
    if (!req.file || !/\.pdf$/i.test(req.file.originalname || ''))
      return res.status(400).json({ error: 'Upload the FASTag statement as a PDF' });

    const { vehicles, format } = await parseFastagPdf(req.file.buffer);
    if (!vehicles.length)
      return res.status(400).json({ error: 'No vehicle toll debits could be read from this statement — attach challans manually' });

    const runTankers = (await query(
      'SELECT DISTINCT tanker_number FROM billing_run_trips WHERE run_id=$1', [req.params.id])).rows
      .map(r => r.tanker_number);
    const byPlate = new Map(runTankers.map(t => [normPlate(t), t]));

    const matched = [], unmatched = [];
    for (const v of vehicles) {
      const tanker = byPlate.get(v.plate);
      if (!tanker) { unmatched.push(v); continue; }
      await query(`
        INSERT INTO billing_run_tolls (run_id, tanker_number, amount, remarks, file_name, file_mime, file_data, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (run_id, tanker_number, COALESCE(for_run_id, 0)) DO UPDATE SET
          amount=$3, remarks=$4, file_name=$5, file_mime=$6, file_data=$7, updated_at=NOW()`,
        [req.params.id, tanker, v.toll_amount,
         `FASTag statement (${format}): ${v.trips} toll trips`,
         req.file.originalname, req.file.mimetype, req.file.buffer, req.user.id]);
      matched.push({ tanker_number: tanker, toll_amount: v.toll_amount, trips: v.trips });
    }
    await refreshRunTotal(req.params.id);
    res.json({ format, matched, unmatched });
  } catch (err) {
    console.error('FASTag statement parse error:', err);
    res.status(500).json({ error: 'Failed to parse the FASTag statement' });
  }
});

// Mark a tanker-period as "No toll" (route has no toll plazas): a row with
// amount 0, no file, not_applicable = TRUE. Counts as satisfied everywhere a
// challan would; delete the row to undo. Optional for_run_id = earlier period.
router.post('/runs/:id/tolls/not-applicable', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  try {
    if (!(await assertEditableRun(req.params.id, res))) return;
    const runId = parseInt(req.params.id, 10);
    const tn = String(req.body?.tanker_number || '').trim();
    const forRunId = req.body?.for_run_id ? parseInt(req.body.for_run_id, 10) : null;
    const remarks = String(req.body?.remarks || '').trim() || 'No toll on this route';
    if (!tn) return res.status(400).json({ error: 'tanker_number required' });
    const inRun = forRunId
      ? (await query('SELECT 1 FROM billing_run_trips WHERE run_id=$1 AND tanker_number=$2 AND excluded=FALSE LIMIT 1', [forRunId, tn])).rows.length
      : (await query('SELECT 1 FROM billing_run_trips WHERE run_id=$1 AND tanker_number=$2 AND excluded=FALSE LIMIT 1', [runId, tn])).rows.length;
    if (!inRun) return res.status(400).json({ error: `${tn} has no billable trips in run #${forRunId || runId}` });
    await query(`
      INSERT INTO billing_run_tolls (run_id, tanker_number, amount, remarks, for_run_id, not_applicable)
      VALUES ($1, $2, 0, $3, $4, TRUE)
      ON CONFLICT (run_id, tanker_number, COALESCE(for_run_id, 0))
      DO UPDATE SET amount = 0, file_name = NULL, file_mime = NULL, file_data = NULL, remarks = EXCLUDED.remarks, not_applicable = TRUE`,
      [runId, tn, remarks, forRunId]);
    await refreshRunTotal(runId);
    res.json({ ok: true, tanker_number: tn, for_run_id: forRunId, not_applicable: true });
  } catch (err) {
    console.error('Billing toll not-applicable error:', err);
    res.status(500).json({ error: 'Failed to mark toll as not applicable' });
  }
});

router.delete('/runs/:id/tolls/:tollId', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  try {
    if (!(await assertEditableRun(req.params.id, res))) return;
    await query('DELETE FROM billing_run_tolls WHERE id=$1 AND run_id=$2', [req.params.tollId, req.params.id]);
    await refreshRunTotal(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to delete toll challan' }); }
});

router.get('/runs/:id/tolls/:tollId/file', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  try {
    const r = await query(
      'SELECT file_name, file_mime, file_data FROM billing_run_tolls WHERE id=$1 AND run_id=$2',
      [req.params.tollId, req.params.id]);
    if (!r.rows.length || !r.rows[0].file_data) return res.status(404).json({ error: 'No challan file' });
    const { file_name, file_mime, file_data } = r.rows[0];
    const SAFE = ['application/pdf', 'image/jpeg', 'image/png'];
    const safeName = String(file_name || 'challan').replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', SAFE.includes(file_mime) ? file_mime : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(file_data);
  } catch (err) { res.status(500).json({ error: 'Failed to download challan' }); }
});

// Portal look for every sheet of a workbook (same palette as the Tanker Rates
// template): blue title band (rows starting with titlePrefix), light-blue bold
// header with borders, zebra rows, yellow bold TOTAL, header frozen, columns
// fitted. Sheets named in `skip` keep their own formatting.

// ── Summaries (tanker-wise / vendor-wise) ────────────────────────────────────
async function runSummaries(runId, { vendorIds } = {}) {
  const scoped = Array.isArray(vendorIds) && vendorIds.length > 0;
  const vScope = scoped ? 'AND vendor_id = ANY($2)' : '';
  const params = scoped ? [runId, vendorIds] : [runId];
  // Milk received (plant acknowledgement) per tanker / date for the finance
  // layout of the run Excel (Date Wise and Tanker Wise milk columns).
  const ackJoin = `LEFT JOIN LATERAL (
      SELECT SUM(a.qty_litres) AS litres, SUM(a.qty_kgs) AS kgs, SUM(a.kg_fat) AS kg_fat, SUM(a.kg_snf) AS kg_snf
      FROM trip_acknowledgements a WHERE a.execution_id = t.execution_id) ack ON TRUE`;
  const milkCols = `SUM(t.capacity_litres) AS capacity_litres, SUM(ack.litres) AS milk_litres, SUM(ack.kgs) AS milk_kgs,
           SUM(ack.kg_fat) AS kg_fat, SUM(ack.kg_snf) AS kg_snf`;
  const tankers = await query(`
    SELECT t.tanker_number, MAX(t.vendor_name) AS vendor_name, COUNT(*)::int AS trips,
           SUM(t.billed_km) AS billed_km, SUM(t.system_km) AS system_km,
           SUM(t.google_km) AS google_km, SUM(t.amount) AS amount, ${milkCols}
    FROM billing_run_trips t ${ackJoin} WHERE t.run_id=$1 AND t.excluded=FALSE ${vScope.replace('vendor_id', 't.vendor_id')}
    GROUP BY t.tanker_number ORDER BY t.tanker_number`, params);
  const vendors = await query(`
    SELECT COALESCE(vendor_name,'— No vendor mapped —') AS vendor_name,
           COUNT(DISTINCT tanker_number)::int AS tankers, COUNT(*)::int AS trips,
           SUM(billed_km) AS billed_km, SUM(system_km) AS system_km,
           SUM(google_km) AS google_km, SUM(amount) AS amount
    FROM billing_run_trips WHERE run_id=$1 AND excluded=FALSE ${vScope}
    GROUP BY COALESCE(vendor_name,'— No vendor mapped —') ORDER BY 1`, params);
  const dates = await query(`
    SELECT t.plan_for_date::text AS date, COUNT(*)::int AS trips,
           COUNT(DISTINCT t.tanker_number)::int AS tankers,
           SUM(t.billed_km) AS billed_km, SUM(t.system_km) AS system_km,
           SUM(t.google_km) AS google_km, SUM(t.amount) AS amount, ${milkCols}
    FROM billing_run_trips t ${ackJoin} WHERE t.run_id=$1 AND t.excluded=FALSE ${vScope.replace('vendor_id', 't.vendor_id')}
    GROUP BY t.plan_for_date ORDER BY t.plan_for_date`, params);

  // Merge toll challans: per tanker directly; per vendor via the tanker's
  // vendor. total_payable = km-based amount + toll reimbursement.
  // A tanker may carry two rows: its own period and an earlier period's
  // challan uploaded here (for_run_id) — both are paid in this run.
  const tolls = await query('SELECT tanker_number, SUM(amount) AS amount FROM billing_run_tolls WHERE run_id=$1 GROUP BY tanker_number', [runId]);
  const tollBy = new Map(tolls.rows.map(r => [r.tanker_number, parseFloat(r.amount) || 0]));
  const vendorToll = new Map();
  for (const t of tankers.rows) {
    t.toll_amount = tollBy.get(t.tanker_number) || 0;
    t.total_payable = rN((parseFloat(t.amount) || 0) + t.toll_amount);
    const vk = t.vendor_name || '— No vendor mapped —';
    vendorToll.set(vk, (vendorToll.get(vk) || 0) + t.toll_amount);
  }
  for (const v of vendors.rows) {
    v.toll_amount = vendorToll.get(v.vendor_name) || 0;
    v.total_payable = rN((parseFloat(v.amount) || 0) + v.toll_amount);
  }
  return { tankers: tankers.rows, vendors: vendors.rows, dates: dates.rows };
}

router.get('/runs/:id/summary', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  try { res.json(await runSummaries(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Excel report (trip / tanker / vendor sheets, incl. system+google km) ─────
async function buildRunWorkbook(runId, { vendorIds } = {}) {
  const run = (await query('SELECT *, from_date::text AS from_date, to_date::text AS to_date FROM billing_runs WHERE id=$1', [runId])).rows[0];
  const scoped = Array.isArray(vendorIds) && vendorIds.length > 0;
  // Milk figures live from the acknowledgements (older runs, before
  // migration 034, carry no stored fat / SNF); SAP code = vendor master code.
  const trips = (await query(`
    SELECT t.*, t.plan_for_date::text AS plan_for_date,
           (t.is_sale_tanker OR t.tanker_number ILIKE 'SALE%') AS is_sale_tanker,
           v.vendor_code AS vendor_sap_code,
           COALESCE(ack.litres, t.ack_litres) AS milk_litres, COALESCE(ack.kgs, t.ack_kgs) AS milk_kgs,
           COALESCE(CASE WHEN ack.kgs > 0 THEN ack.kg_fat / ack.kgs * 100 END, t.ack_fat_pct) AS fat_pct,
           COALESCE(CASE WHEN ack.kgs > 0 THEN ack.kg_snf / ack.kgs * 100 END, t.ack_snf_pct) AS snf_pct,
           COALESCE(ack.kg_fat, t.ack_kgs * t.ack_fat_pct / 100) AS kg_fat,
           COALESCE(ack.kg_snf, t.ack_kgs * t.ack_snf_pct / 100) AS kg_snf
    FROM billing_run_trips t
    LEFT JOIN vendors v ON v.id = t.vendor_id
    LEFT JOIN LATERAL (
      SELECT SUM(a.qty_litres) AS litres, SUM(a.qty_kgs) AS kgs, SUM(a.kg_fat) AS kg_fat, SUM(a.kg_snf) AS kg_snf
      FROM trip_acknowledgements a WHERE a.execution_id = t.execution_id) ack ON TRUE
    WHERE t.run_id=$1 ${scoped ? 'AND t.vendor_id = ANY($2)' : ''}
    ORDER BY t.plan_for_date, t.tanker_number`, scoped ? [runId, vendorIds] : [runId])).rows;
  const { tankers, vendors, dates } = await runSummaries(runId, { vendorIds });

  // BMCU details per trip (code + name, in pickup order) for the Trip Wise
  // sheet's "BMCU Details" column — bmcu_count alone doesn't name the plants.
  const bmcuByExec = {};
  if (trips.length) {
    const bm = await query(`
      SELECT teb.execution_id, teb.seq_no, b.bmcu_code, b.bmcu_name
      FROM trip_execution_bmcus teb JOIN bmcus b ON b.id = teb.bmcu_id
      WHERE teb.execution_id = ANY($1) AND teb.is_deleted = FALSE
      ORDER BY teb.execution_id, teb.seq_no`,
      [trips.map(t => t.execution_id)]);
    for (const r of bm.rows)
      (bmcuByExec[r.execution_id] ||= []).push(`${r.bmcu_code} - ${r.bmcu_name}`);
    // Material trips (migration 049) carry the material instead of a BMCU chain.
    const md = await query(`
      SELECT d.execution_id, m.name, m.sap_code, d.purchase_qty_litres
      FROM trip_material_data d LEFT JOIN materials m ON m.id = d.material_id
      WHERE d.execution_id = ANY($1)`, [trips.map(t => t.execution_id)]);
    for (const r of md.rows)
      bmcuByExec[r.execution_id] = [`Material: ${r.name || '—'}${r.sap_code ? ` (SAP ${r.sap_code})` : ''}${r.purchase_qty_litres ? ` · purchased ${rN(r.purchase_qty_litres)} L` : ''}`];
  }
  const bmcuDetails = execId => (bmcuByExec[execId] || []).join(' → ') || '—';

  const wb = new ExcelJS.Workbook();
  const head = (ws, cols) => { const r = ws.addRow(cols); r.font = { bold: true };
    ws.columns.forEach(c => { c.width = 16; }); };

  // Trip Wise = trips actually under vendor payment (Sale Tanker trips are
  // shown separately on their own sheet, matching the on-screen tabs).
  // A Sale-Tanker-flagged line the biller un-excludes (e.g. a Jersey / HUL
  // delivery the vendor is paid for) is a payment trip, not a sale trip.
  const isSale        = t => t.is_sale_tanker && t.excluded;
  const paymentTrips  = trips.filter(t => !isSale(t) && t.trip_kind !== 'material');
  const materialTrips = trips.filter(t => !isSale(t) && t.trip_kind === 'material');
  const saleTrips     = trips.filter(isSale);

  const tripCols = (rows, sheetName) => {
    const ws = wb.addWorksheet(sheetName);
    ws.addRow([`Tanker Payment Billing — Run #${runId} · ${fmtDateDisplay(run.from_date)} → ${fmtDateDisplay(run.to_date)} · Status: ${run.status}`]).font = { bold: true, size: 13 };
    ws.addRow([]);
    // Finance's layout (2026-10-08): SAP vendor code, milk received in
    // litres and kgs with fat / SNF %, cost per litre and utilisation; no
    // System / Google / Master KM, Excluded or Remarks columns (excluded
    // lines still show ₹0). Remarks remain on screen.
    head(ws, ['Date', 'Tanker', 'Capacity (KL)', 'SAP Vendor Code', 'Vendor', 'Route', 'Start Point', 'Delivery Point',
      'Qty in Lts', 'Qty in Kgs', 'Fat %', 'Fat Kgs', 'SNF %', 'SNF Kgs', 'State', 'Transport Type',
      'Billed KM', 'Rate/KM (₹)', 'Amount (₹)', 'Cost Per Ltr', 'Utilization %', 'BMCU Details']);
    ws.getColumn(22).width = 60;
    const amt = t => t.excluded ? 0 : (+t.amount || 0);
    rows.forEach(t => {
      const l = +t.milk_litres || 0, cap = +t.capacity_litres || 0;
      ws.addRow([fmtDateDisplay(t.plan_for_date), t.tanker_number, rN(t.capacity_litres / 1000, 1),
        t.vendor_sap_code, t.vendor_name, t.route_name, t.start_point, t.delivery_point,
        rN(t.milk_litres), rN(t.milk_kgs), rN(t.fat_pct), rN(t.kg_fat), rN(t.snf_pct), rN(t.kg_snf),
        t.state, t.transport_type,
        rN(t.billed_km), rN(t.rate_per_km), rN(amt(t)), l > 0 ? rN(amt(t) / l) : null, cap > 0 && l > 0 ? rN(l / cap * 100) : null,
        bmcuDetails(t.execution_id)]);
    });
    const sumL = rows.reduce((s, t) => s + (+t.milk_litres || 0), 0), sumKg = rows.reduce((s, t) => s + (+t.milk_kgs || 0), 0);
    const sumCap = rows.reduce((s, t) => s + (+t.capacity_litres || 0), 0), sumAmt = rows.reduce((s, t) => s + amt(t), 0);
    const sumKf = rows.reduce((s, t) => s + (+t.kg_fat || 0), 0), sumKs = rows.reduce((s, t) => s + (+t.kg_snf || 0), 0);
    const sumKm = rows.reduce((s, t) => s + (+t.billed_km || 0), 0);
    const totRow = ws.addRow(['TOTAL', '', '', '', '', '', '', '',
      rN(sumL), rN(sumKg), sumKg > 0 ? rN(sumKf / sumKg * 100) : '', rN(sumKf), sumKg > 0 ? rN(sumKs / sumKg * 100) : '', rN(sumKs), '', '',
      rN(sumKm), sumKm > 0 ? rN(sumAmt / sumKm) : null,
      rN(sumAmt), sumL > 0 ? rN(sumAmt / sumL) : null, sumCap > 0 && sumL > 0 ? rN(sumL / sumCap * 100) : null, '']);
    for (let c = 3; c <= 21; c++) if (c !== 4 && c !== 5 && c !== 6 && c !== 7 && c !== 8 && c !== 15 && c !== 16) ws.getColumn(c).numFmt = '0.00';
    totRow.font = { bold: true };
    return ws;
  };
  const ws1 = tripCols(paymentTrips, 'Trip Wise');
  if (materialTrips.length) tripCols(materialTrips, 'Material Trips');
  if (saleTrips.length) tripCols(saleTrips, 'Sale Tankers');

  // Milk helpers for the aggregate sheets (finance wording).
  const MILK_HEADS_AGG = ['Milk Received in Ltrs', "Milk Received in KG's", 'FAT %', "FAT KG's", 'SNF%', "SNF KG's"];
  const sumOf = (rows, k) => rows.reduce((s, r) => s + (+r[k] || 0), 0);
  const milkCells = r => { const kg = +r.milk_kgs || 0; return [rN(r.milk_litres), rN(kg),
    kg > 0 ? rN((+r.kg_fat || 0) / kg * 100) : null, rN(r.kg_fat), kg > 0 ? rN((+r.kg_snf || 0) / kg * 100) : null, rN(r.kg_snf)]; };
  const milkTotals = rows => { const kg = sumOf(rows, 'milk_kgs'); return [rN(sumOf(rows, 'milk_litres')), rN(kg),
    kg > 0 ? rN(sumOf(rows, 'kg_fat') / kg * 100) : null, rN(sumOf(rows, 'kg_fat')), kg > 0 ? rN(sumOf(rows, 'kg_snf') / kg * 100) : null, rN(sumOf(rows, 'kg_snf'))]; };
  const costCells = (amt, km, l, cap) => [km > 0 ? rN(amt / km) : null, l > 0 ? rN(amt / l) : null, cap > 0 && l > 0 ? rN(l / cap * 100) : null];

  const ws2 = wb.addWorksheet('Tanker Wise');
  head(ws2, ['Tanker', 'Vendor', 'Trips', 'Billed KM', 'Amount (₹)', 'Toll (₹)', 'Total Payable (₹)', ...MILK_HEADS_AGG]);
  tankers.forEach(t => ws2.addRow([t.tanker_number, t.vendor_name, t.trips, rN(t.billed_km), rN(t.amount), rN(t.toll_amount), rN(t.total_payable), ...milkCells(t)]));
  ws2.addRow(['TOTAL', '', tankers.reduce((s, t) => s + t.trips, 0),
    rN(tankers.reduce((s, t) => s + (+t.billed_km || 0), 0)),
    rN(tankers.reduce((s, t) => s + (+t.amount || 0), 0)),
    rN(tankers.reduce((s, t) => s + (+t.toll_amount || 0), 0)),
    rN(tankers.reduce((s, t) => s + (+t.total_payable || 0), 0)), ...milkTotals(tankers)]).font = { bold: true };

  const ws3 = wb.addWorksheet('Vendor Wise');
  head(ws3, ['Vendor', 'Tankers', 'Trips', 'Billed KM', 'Amount (₹)', 'Toll (₹)', 'Total Payable (₹)']);
  vendors.forEach(v => ws3.addRow([v.vendor_name, v.tankers, v.trips, rN(v.billed_km), rN(v.amount), rN(v.toll_amount), rN(v.total_payable)]));
  ws3.addRow(['TOTAL', '', vendors.reduce((s, v) => s + v.trips, 0),
    rN(vendors.reduce((s, v) => s + (+v.billed_km || 0), 0)),
    rN(vendors.reduce((s, v) => s + (+v.amount || 0), 0)),
    rN(vendors.reduce((s, v) => s + (+v.toll_amount || 0), 0)),
    rN(vendors.reduce((s, v) => s + (+v.total_payable || 0), 0))]).font = { bold: true };

  const tollRows = await tollRowsOfRun(runId);
  const wsT = wb.addWorksheet('Toll Challans');
  head(wsT, ['Tanker', 'Period Covered', 'Toll Amount (₹)', 'Challan File', 'Remarks']);
  tollRows.forEach(t => wsT.addRow([t.tanker_number, tollPeriodLabel(t, run), rN(t.amount), t.file_name || '—', t.remarks || '']));
  wsT.addRow(['TOTAL', '', rN(tollRows.reduce((s, t) => s + (+t.amount || 0), 0)), '', '']).font = { bold: true };
  const pendingTolls = await pendingTollTankers(runId);
  if (pendingTolls.length) {
    wsT.addRow([]);
    wsT.addRow([`Toll challans pending for ${pendingTolls.length} tanker(s) — to be uploaded and paid in the next cycle: ${pendingTolls.join(', ')}`]).font = { italic: true };
  }

  // Date Wise — after Toll Challans (owner, 2026-10-09), finance layout.
  const wsD = wb.addWorksheet('Date Wise');
  wsD.addRow([`Tanker Payment Billing — Run #${runId} · ${fmtDateDisplay(run.from_date)} → ${fmtDateDisplay(run.to_date)} · Status: ${run.status}`]).font = { bold: true, size: 13 };
  wsD.addRow([]);
  head(wsD, ['Date', 'Tankers', 'Trips', 'Tankers capacity', ...MILK_HEADS_AGG, 'Billed KM', 'Amount (₹)', 'Rate Per KM', 'Cost Per Ltr', 'Utilization %']);
  dates.forEach(d => wsD.addRow([fmtDateDisplay(d.date), d.tankers, d.trips, rN(d.capacity_litres), ...milkCells(d),
    rN(d.billed_km), rN(d.amount), ...costCells(+d.amount || 0, +d.billed_km || 0, +d.milk_litres || 0, +d.capacity_litres || 0)]));
  wsD.addRow(['TOTAL', '', dates.reduce((s, d) => s + d.trips, 0), rN(sumOf(dates, 'capacity_litres')), ...milkTotals(dates),
    rN(sumOf(dates, 'billed_km')), rN(sumOf(dates, 'amount')),
    ...costCells(sumOf(dates, 'amount'), sumOf(dates, 'billed_km'), sumOf(dates, 'milk_litres'), sumOf(dates, 'capacity_litres'))]).font = { bold: true };
  // Toll challans of the run (per tanker, never per day) and the grand total
  // the vendor is paid: trips amount + tolls (owner, 2026-10-09).
  const runToll = sumOf(tankers, 'toll_amount'), runAmount = sumOf(dates, 'amount');
  wsD.addRow(['Toll Challans (₹)', '', '', '', '', '', '', '', '', '', '', rN(runToll), '', '', '']).font = { bold: true };
  wsD.addRow(['GRAND TOTAL (Amount + Toll)', '', '', '', '', '', '', '', '', '', '', rN(runAmount + runToll), '', '', '']).font = { bold: true };
  for (let c = 4; c <= 15; c++) wsD.getColumn(c).numFmt = '0.00';

  // The Tanker Utilisation sheet was removed (owner, 2026-10-16): utilisation
  // goes with its own approval mail and Reports → Tanker Utilisation.

  stylePortalWorkbook(wb, 'Tanker Payment Billing');
  return { wb, run, trips, tankers, vendors };
}

router.get('/runs/:id/report', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  try {
    const vendorIds = req.query.vendor_ids
      ? String(req.query.vendor_ids).split(',').map(Number).filter(Number.isFinite) : undefined;
    const { wb, run } = await buildRunWorkbook(req.params.id, { vendorIds });
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
// New route combinations (legs whose pair was absent from the Distance
// Master when the run executed) — surfaced to the approval chain so approving
// the run is the competent-authority approval of these combinations.
// Sale-tanker trips (Milma collections, third-party sales) are not paid by
// Shreeja and their plants (Milma Plant, "Third Party Sale") have no
// coordinates, so their legs are neither approvable nor Google-measurable —
// they are left out of the list and the count.
function collectNewCombos(trips) {
  const combos = [];
  for (const t of trips) {
    if (t.is_sale_tanker || /^SALE/i.test(t.tanker_number || '')) continue;
    const legs = Array.isArray(t.legs) ? t.legs : JSON.parse(t.legs || '[]');
    for (const l of legs) if (l.is_new)
      combos.push({ date: t.plan_for_date, tanker: t.tanker_number,
                    from: l.from_label, to: l.to_label, km: l.km,
                    google_km: l.google_km, source: l.source });
  }
  return combos;
}

// Label for the period a toll challan covers: the run's own fortnight, or
// the earlier run it was carried from ("for run #15 · 01-09-2026 → 15-09-2026").
function tollPeriodLabel(toll, run) {
  return toll.for_run_id
    ? `for run #${toll.for_run_id} · ${fmtDateDisplay(toll.for_from_date)} → ${fmtDateDisplay(toll.for_to_date)}`
    : `${fmtDateDisplay(run.from_date)} → ${fmtDateDisplay(run.to_date)}`;
}

function approvalEmailHtml(run, tankers, vendors, approver, token, newCombos = [], tollsPending = [], utilHtml = '') {
  const base = BASE_URL();
  // Both links land on the no-login frontend decision page, which shows the
  // run details and only fires the actual state-changing POST /decide when
  // the approver clicks the on-page button (never on a bare GET).
  const approveUrl = `${base}/billing-decision?token=${token}&decision=approve`;
  const rejectUrl  = `${base}/billing-decision?token=${token}&decision=reject`;
  const row = (cells, bold = false) =>
    `<tr>${cells.map(c => `<td style="padding:5px 8px;border:1px solid #e2e8f0;font-size:12px;${bold ? 'font-weight:700;background:#dbeafe;' : ''}">${c}</td>`).join('')}</tr>`;
  return `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:760px;">
    <div style="background:#005ba3;color:#fff;padding:14px 20px;border-radius:10px 10px 0 0;">
      <div style="font-size:17px;font-weight:700;">Tanker Payment Approval — Level ${approver.level}</div>
      <div style="font-size:12px;opacity:.85;">Billing Run #${run.id} · ${fmtDateDisplay(run.from_date)} → ${fmtDateDisplay(run.to_date)}</div>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;padding:16px 20px;border-radius:0 0 10px 10px;">
      <p style="font-size:13px;">Dear ${esc(approver.name)},<br/>
        The fortnightly tanker payment for <b>${fmtDateDisplay(run.from_date)} → ${fmtDateDisplay(run.to_date)}</b> is awaiting your approval.
        Total payable: <b style="font-size:15px;">₹ ${nf(run.total_amount)}</b>. The detailed report (trip / tanker / vendor wise,
        with system + Google distances) is attached.</p>
      <p style="font-size:13px;font-weight:700;margin:14px 0 6px;">Vendor Wise Summary</p>
      <table style="border-collapse:collapse;width:100%;">
        ${row(['Vendor', 'Tankers', 'Trips', 'Billed KM', 'Amount (₹)', 'Toll (₹)', 'Total Payable (₹)'], true)}
        ${vendors.map(v => row([esc(v.vendor_name), v.tankers, v.trips, nf(v.billed_km), nf(v.amount), nf(v.toll_amount), nf(v.total_payable)])).join('')}
      </table>
      ${newCombos.length ? `
      <p style="font-size:13px;font-weight:700;margin:16px 0 6px;color:#b45309;">
        ⚠ New Route Combinations — ${newCombos.length} leg(s) not in the KM Master (your approval of this run approves these)</p>
      <table style="border-collapse:collapse;width:100%;">
        ${row(['Date', 'Tanker', 'From', 'To', 'KM', 'Google KM (ref)', 'Source'], true)}
        ${newCombos.slice(0, 30).map(c => row([fmtDateDisplay(c.date), esc(c.tanker), esc(c.from), esc(c.to), nf(c.km),
          c.google_km != null ? nf(c.google_km) : '—', esc(c.source)])).join('')}
        ${newCombos.length > 30 ? row([`… and ${newCombos.length - 30} more — see the attached report`, '', '', '', '', '', '']) : ''}
      </table>` : ''}
      ${tollsPending.length ? `
      <p style="font-size:13px;font-weight:700;margin:16px 0 6px;color:#b45309;">
        Toll challans pending (to be paid in the next cycle) — ${tollsPending.length} tanker(s)</p>
      <p style="font-size:12px;margin:0;">${tollsPending.map(esc).join(', ')}</p>
      <p style="font-size:11px;color:#6b7280;margin:4px 0 0;">Trip payment for these tankers is included above; only the toll
        reimbursement is carried forward and will be paid in the next fortnight once the challan is uploaded against this period.</p>` : ''}
      ${utilHtml}
      <div style="margin:22px 0;text-align:center;">
        <a href="${approveUrl}" style="background:#16a34a;color:#fff;padding:11px 30px;border-radius:8px;text-decoration:none;font-weight:700;margin-right:14px;">✓ APPROVE</a>
        <a href="${rejectUrl}"  style="background:#dc2626;color:#fff;padding:11px 30px;border-radius:8px;text-decoration:none;font-weight:700;">✗ REJECT</a>
      </div>
      <p style="font-size:11px;color:#9ca3af;">No login needed — click a button above to open a confirmation page with the
        run details, then confirm there. Rejection asks for mandatory remarks; remarks are optional when approving.</p>
    </div>
  </div>`;
}

async function sendApprovalEmail(runId, level) {
  const approver = APPROVERS.find(a => a.level === level);
  const ap = await query('SELECT token FROM billing_run_approvals WHERE run_id=$1 AND level=$2', [runId, level]);
  if (!ap.rows.length) throw new Error(`No approval row for run ${runId} level ${level}`);
  const { wb, run, trips, tankers, vendors } = await buildRunWorkbook(runId);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  // Under-utilisation approval note (owner, 2026-10-16): approving the run
  // approves it; a failure here must never stop the approval mail.
  let utilHtml = '';
  try {
    // Utilisation approval is its own L1–L3 chain raised by logistics (074);
    // the run mail carries the note (as edited) and one status line.
    const ua = require('./utilisationApprovals');
    const cur = await ua.currentForRun(runId);
    utilHtml = utilisationNoteHtml(await utilisationNote(runId), {
      text: cur && cur.status !== 'rejected' ? cur.note_text : null,
      status: await ua.statusLineForRun(runId),
    });
  }
  catch (e) { console.warn('[billing] utilisation note skipped:', e.message); }
  await createTransport().sendMail({
    from: process.env.SMTP_FROM,
    to: approver.email,
    subject: `Tanker Payment Approval L${level} — Run #${runId} (${fmtDateDisplay(run.from_date)} → ${fmtDateDisplay(run.to_date)}) · ₹ ${nf(run.total_amount)}`,
    html: approvalEmailHtml(run, tankers, vendors, approver, ap.rows[0].token, collectNewCombos(trips), await pendingTollTankers(runId), utilHtml),
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

// ── Transporter publishing — on final approval, email each vendor an Excel of
// THEIR trips (km, rate, amount). Vendors without an email in the Vendor
// master are reported back to the biller instead.
// Printable tanker cards for a vendor (owner, 2026-10-17; layout of the
// logistics team's "Tanker Cards" workbook): a sheet per state, one block per
// tanker × transport type (material trips in their own block), each block on
// its own portrait A4 page with a SUM total and the vendor's signature line, so the
// vendor prints, signs every page and returns it. Excluded lines never appear.
const CARD_TYPE_ORDER = { 'BMCU/CC to Dairy/CC': 0, 'Point to Point': 1, Material: 2 };
async function buildTankerCardsWorkbook(run, vendorName, trips, tollBy, bmcuDetails) {
  const num = v => (v == null || v === '' ? null : parseFloat(v));
  const dot = d => String(d || '').split('-').reverse().join('.');
  const period = `Road Tankers Movement Of BMCU's Details From ${dot(run.from_date)} To ${dot(run.to_date)}`;
  const thin = { style: 'thin', color: { argb: 'FF475569' } };
  const BOX = { top: thin, bottom: thin, left: thin, right: thin };
  const HEAD = ['SL', 'Date', 'Vehicle No.', 'Capacity (KL)', 'Transport Type', 'Route', 'BMCUs', 'Kms', 'Rate', 'Amount'];
  const WIDTHS = [4, 11, 12, 8, 13, 14, 38, 8, 7, 11];   // portrait A4: BMCU chain wraps
  const setup = ws => {
    ws.pageSetup = { orientation: 'portrait', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
    ws.headerFooter = { oddFooter: `&L${vendorName}&CPage &P of &N&RRun #${run.id}` };
    WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  };
  const blocks = new Map();   // state → Map(tanker|type → trips)
  for (const t of trips) {
    const st = t.state || 'No state';
    const type = t.trip_kind === 'material' ? 'Material' : (t.transport_type || '—');
    if (!blocks.has(st)) blocks.set(st, new Map());
    const k = `${t.tanker_number}|${type}`;
    if (!blocks.get(st).has(k)) blocks.get(st).set(k, []);
    blocks.get(st).get(k).push(t);
  }
  const wb = new ExcelJS.Workbook();
  const summary = wb.addWorksheet('Summary');
  setup(summary);
  const summaryRows = [];
  for (const st of [...blocks.keys()].sort()) {
    const ws = wb.addWorksheet(`${st} cards`.slice(0, 31));
    setup(ws);
    const keys = [...blocks.get(st).keys()].sort((a, b) => {
      const [ta, ya] = a.split('|'), [tb, yb] = b.split('|');
      return ta.localeCompare(tb) || (CARD_TYPE_ORDER[ya] ?? 9) - (CARD_TYPE_ORDER[yb] ?? 9);
    });
    keys.forEach((k, bi) => {
      const [tanker, type] = k.split('|');
      const rows = blocks.get(st).get(k).sort((a, b) => a.plan_for_date.localeCompare(b.plan_for_date));
      const line = (text, opts = {}) => {
        const r = ws.addRow([text]);
        ws.mergeCells(r.number, 1, r.number, HEAD.length);
        r.getCell(1).font = { bold: true, size: opts.size || 11 };
        r.getCell(1).alignment = { horizontal: opts.align || 'center' };
        return r;
      };
      line('Shreeja MMPCL, Tirupati', { size: 14 });
      line(period, { size: 12 });
      line(`Vendor: ${vendorName}   ·   Tanker: ${tanker}   ·   ${type}   ·   State: ${st}`, { size: 10 });
      const h = ws.addRow(HEAD);
      h.eachCell(c => { c.font = { bold: true }; c.border = BOX; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }; });
      const first = h.number + 1;
      rows.forEach((t, i) => {
        const r = ws.addRow([i + 1, fmtDateDisplay(t.plan_for_date), t.tanker_number,
          t.capacity_litres ? rN(t.capacity_litres / 1000, 1) : null, type === 'Material' ? 'Material' : t.transport_type,
          type === 'Material' ? `${t.start_point || ''} → ${t.delivery_point || ''}` : t.route_name,
          bmcuDetails(t.execution_id), num(t.billed_km), num(t.rate_per_km), num(t.amount)]);
        r.eachCell({ includeEmpty: true }, (c, ci) => { c.border = BOX; c.alignment = { vertical: 'top', wrapText: ci === 7 || ci === 6 }; });
        [8, 9, 10].forEach(ci => { r.getCell(ci).numFmt = '#,##0.00'; });
      });
      const last = ws.rowCount;
      const tot = ws.addRow(['Total', '', '', '', '', '', '', { formula: `SUM(H${first}:H${last})` }, '', { formula: `SUM(J${first}:J${last})` }]);
      ws.mergeCells(tot.number, 1, tot.number, 7);
      tot.eachCell({ includeEmpty: true }, c => { c.font = { bold: true }; c.border = BOX; });
      [8, 10].forEach(ci => { tot.getCell(ci).numFmt = '#,##0.00'; });
      ws.addRow([]); ws.addRow([]);
      const sig = ws.addRow(['Vendor signature & seal: ____________________']);
      ws.mergeCells(sig.number, 1, sig.number, 5);
      if (bi < keys.length - 1) sig.addPageBreak();
      const km = rows.reduce((a, t) => a + (parseFloat(t.billed_km) || 0), 0);
      const amt = rows.reduce((a, t) => a + (parseFloat(t.amount) || 0), 0);
      summaryRows.push([st, tanker, type, rows.length, rN(km), rN(amt)]);
    });
  }
  // Summary page: state × tanker × type, tolls, total payable, signature.
  const sl = (text, size) => { const r = summary.addRow([text]); summary.mergeCells(r.number, 1, r.number, 6); r.getCell(1).font = { bold: true, size }; r.getCell(1).alignment = { horizontal: 'center' }; };
  ['State', 'Tanker', 'Type', 'Trips', 'Kms', 'Amount'].forEach((_, i) => { summary.getColumn(i + 1).width = [12, 16, 22, 8, 12, 16][i]; });
  sl('Shreeja MMPCL, Tirupati', 14); sl(period, 12); sl(`Vendor: ${vendorName}   ·   Run #${run.id}`, 10);
  const sh = summary.addRow(['State', 'Tanker', 'Type', 'Trips', 'Kms', 'Amount']);
  sh.eachCell(c => { c.font = { bold: true }; c.border = BOX; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }; });
  const sFirst = sh.number + 1;
  summaryRows.forEach(r => { const x = summary.addRow(r); x.eachCell({ includeEmpty: true }, c => { c.border = BOX; }); x.getCell(5).numFmt = '#,##0.00'; x.getCell(6).numFmt = '#,##0.00'; });
  const sLast = summary.rowCount;
  const tt = summary.addRow(['Trips total', '', '', { formula: `SUM(D${sFirst}:D${sLast})` }, { formula: `SUM(E${sFirst}:E${sLast})` }, { formula: `SUM(F${sFirst}:F${sLast})` }]);
  tt.eachCell({ includeEmpty: true }, c => { c.font = { bold: true }; c.border = BOX; }); tt.getCell(5).numFmt = '#,##0.00'; tt.getCell(6).numFmt = '#,##0.00';
  const tollRowsList = [...new Set(trips.map(t => t.tanker_number))].flatMap(tn => (tollBy.get(tn) || []).map(x => [tn, x]));
  for (const [tn, x] of tollRowsList) {
    const r = summary.addRow(['Toll challan', tn, x.period || '', '', '', rN(x.amount)]);
    r.eachCell({ includeEmpty: true }, c => { c.border = BOX; }); r.getCell(6).numFmt = '#,##0.00';
  }
  const tp = summary.addRow(['TOTAL PAYABLE', '', '', '', '', { formula: `SUM(F${sLast + 1}:F${summary.rowCount})` }]);
  tp.eachCell({ includeEmpty: true }, c => { c.font = { bold: true }; c.border = BOX; }); tp.getCell(6).numFmt = '#,##0.00';
  summary.addRow([]); summary.addRow([]);
  summary.addRow(['Vendor signature & seal: ____________________']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function publishRunToVendors(runId, { draft = false, vendorIds } = {}) {
  const run = (await query('SELECT *, from_date::text AS from_date, to_date::text AS to_date FROM billing_runs WHERE id=$1', [runId])).rows[0];
  const scoped = Array.isArray(vendorIds) && vendorIds.length > 0;
  const allTrips = (await query(`
    SELECT t.*, t.plan_for_date::text AS plan_for_date, v.email AS vendor_email,
           (t.is_sale_tanker OR t.tanker_number ILIKE 'SALE%') AS is_sale_tanker
    FROM billing_run_trips t LEFT JOIN vendors v ON v.id = t.vendor_id
    WHERE t.run_id=$1 ${scoped ? 'AND t.vendor_id = ANY($2)' : ''}
    ORDER BY t.plan_for_date, t.tanker_number`, scoped ? [runId, vendorIds] : [runId])).rows;
  // Sale Tanker / excluded trips never go to vendors for verification or
  // payment — they live on their own tab/sheet, not in vendor billing.
  const trips = allTrips.filter(t => !t.excluded); // un-excluded sale-flagged lines are paid (2026-10-06)
  if (!trips.length)
    return [scoped
      ? `No billable trips for the selected vendor(s) in this run.`
      : `No billable trips in this run — all ${allTrips.length} trip(s) are Sale Tanker / excluded. Nothing to push to vendors.`];

  // Per tanker: own-period challan plus any earlier period's challan paid here.
  const tollRows = await tollRowsOfRun(runId);
  const tollBy = new Map();
  for (const r of tollRows) {
    if (!tollBy.has(r.tanker_number)) tollBy.set(r.tanker_number, []);
    tollBy.get(r.tanker_number).push({ amount: parseFloat(r.amount) || 0, period: tollPeriodLabel(r, run) });
  }

  // BMCU pickup sequence per trip (code + name, in order) for the tanker card.
  const bmcuByExec = {};
  if (trips.length) {
    const bm = await query(`
      SELECT teb.execution_id, teb.seq_no, b.bmcu_code, b.bmcu_name
      FROM trip_execution_bmcus teb JOIN bmcus b ON b.id = teb.bmcu_id
      WHERE teb.execution_id = ANY($1) AND teb.is_deleted = FALSE
      ORDER BY teb.execution_id, teb.seq_no`,
      [trips.map(t => t.execution_id)]);
    for (const r of bm.rows)
      (bmcuByExec[r.execution_id] ||= []).push(`${r.bmcu_code} - ${r.bmcu_name}`);
    // Material trips (migration 049) carry the material instead of a BMCU chain.
    const md = await query(`
      SELECT d.execution_id, m.name, m.sap_code, d.purchase_qty_litres
      FROM trip_material_data d LEFT JOIN materials m ON m.id = d.material_id
      WHERE d.execution_id = ANY($1)`, [trips.map(t => t.execution_id)]);
    for (const r of md.rows)
      bmcuByExec[r.execution_id] = [`Material: ${r.name || '—'}${r.sap_code ? ` (SAP ${r.sap_code})` : ''}${r.purchase_qty_litres ? ` · purchased ${rN(r.purchase_qty_litres)} L` : ''}`];
  }
  const bmcuDetails = execId => (bmcuByExec[execId] || []).join(' → ') || '—';

  // Group by email (not vendor_id) so distinct vendor-master rows that
  // share one mailbox (e.g. duplicate entries for the same transporter)
  // still receive a single cumulative mail covering all their tankers.
  const byVendor = new Map();
  for (const t of trips) {
    const key = t.vendor_email ? t.vendor_email.trim().toLowerCase() : (t.vendor_id ? `id:${t.vendor_id}` : 'none');
    if (!byVendor.has(key)) byVendor.set(key, { name: t.vendor_name || '— No vendor mapped —', email: t.vendor_email, trips: [] });
    byVendor.get(key).trips.push(t);
  }

  const results = [];
  for (const [key, v] of byVendor) {
    const tripTotal = v.trips.reduce((s, t) => s + (t.excluded ? 0 : (parseFloat(t.amount) || 0)), 0);
    const vendorTankers = [...new Set(v.trips.map(t => t.tanker_number))];
    const vendorTolls = vendorTankers.flatMap(tn => (tollBy.get(tn) || []).map(x => ({ tanker: tn, ...x })));
    const tollTotal = vendorTolls.reduce((s, t) => s + t.amount, 0);
    const total = tripTotal + tollTotal;
    if (!v.email) {
      results.push(`✗ ${v.name} — NOT sent (no ${key === 'none' ? 'vendor mapped' : 'email in Vendor master'}); ${v.trips.length} trips, ₹ ${nf(total)}`);
      continue;
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Trips');
    const NCOLS = 12;
    const titleRow = ws.addRow([`${v.name} — Tanker Payment ${fmtDateDisplay(run.from_date)} → ${fmtDateDisplay(run.to_date)} (Run #${runId}, ${draft ? 'DRAFT — for verification' : 'APPROVED'})`]);
    titleRow.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
    ws.mergeCells(titleRow.number, 1, titleRow.number, NCOLS);
    titleRow.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } }; });
    ws.addRow([]);
    const head = ws.addRow(['Date', 'Tanker', 'Capacity (KL)', 'Route', 'Delivery Point', 'BMCU Sequence', 'State',
      'Transport Type', 'Billed KM', 'Rate/KM (₹)', 'Amount (₹)', 'Remarks']);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF64748B' } }; });
    ws.columns.forEach(c => { c.width = 16; });
    ws.getColumn(5).width = 20;
    ws.getColumn(6).width = 40;
    ws.getColumn(12).width = 24;

    // Tanker-wise, then date-wise, with a subtotal row per tanker.
    const byTanker = new Map();
    for (const t of v.trips) {
      if (!byTanker.has(t.tanker_number)) byTanker.set(t.tanker_number, []);
      byTanker.get(t.tanker_number).push(t);
    }
    const materialTrips = v.trips.filter(t => t.trip_kind === 'material');
    for (const [tn, tTripsAll] of [...byTanker.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const tTrips = tTripsAll.filter(t => t.trip_kind !== 'material');
      if (!tTrips.length) continue;
      tTrips.sort((a, b) => (a.plan_for_date < b.plan_for_date ? -1 : a.plan_for_date > b.plan_for_date ? 1 : 0));
      tTrips.forEach(t => ws.addRow([fmtDateDisplay(t.plan_for_date), t.tanker_number,
        t.capacity_litres ? rN(t.capacity_litres / 1000, 1) : null, t.route_name, t.delivery_point,
        bmcuDetails(t.execution_id), t.state, t.transport_type, t.billed_km, t.rate_per_km,
        t.excluded ? 0 : t.amount, t.excluded ? `EXCLUDED (Sale Tanker) — ${t.remarks || ''}`.trim() : t.remarks]));
      const tankerSubtotal = tTrips.reduce((s, t) => s + (t.excluded ? 0 : (parseFloat(t.amount) || 0)), 0);
      const subRow = ws.addRow([`${tn} SUBTOTAL`, '', '', '', '', '', '', '',
        rN(tTrips.reduce((s, t) => s + (parseFloat(t.billed_km) || 0), 0)), '', rN(tankerSubtotal), '']);
      subRow.font = { bold: true };
      subRow.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } }; });
    }
    if (materialTrips.length) {
      // Sub-section: pasteurised-milk / material trips (owner request 2026-10-05)
      const secRow = ws.addRow(['MATERIAL TRIPS (pasteurised milk purchase & delivery)']);
      secRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.mergeCells(secRow.number, 1, secRow.number, NCOLS);
      secRow.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C3AED' } }; });
      materialTrips.sort((a, b) => (a.tanker_number + a.plan_for_date).localeCompare(b.tanker_number + b.plan_for_date));
      materialTrips.forEach(t => ws.addRow([fmtDateDisplay(t.plan_for_date), t.tanker_number,
        t.capacity_litres ? rN(t.capacity_litres / 1000, 1) : null, `${t.start_point || ''} → ${t.delivery_point || ''}`, t.delivery_point,
        bmcuDetails(t.execution_id), t.state, t.transport_type, t.billed_km, t.rate_per_km,
        t.excluded ? 0 : t.amount, t.excluded ? `EXCLUDED — ${t.remarks || ''}`.trim() : t.remarks]));
      const mSub = ws.addRow(['MATERIAL TRIPS SUBTOTAL', '', '', '', '', '', '', '',
        rN(materialTrips.reduce((s, t) => s + (parseFloat(t.billed_km) || 0), 0)), '',
        rN(materialTrips.reduce((s, t) => s + (t.excluded ? 0 : (parseFloat(t.amount) || 0)), 0)), '']);
      mSub.font = { bold: true };
      mSub.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3E8FF' } }; });
    }
    ws.addRow(['TRIPS TOTAL', '', '', '', '', '', '', '',
      rN(v.trips.reduce((s, t) => s + (parseFloat(t.billed_km) || 0), 0)), '', rN(tripTotal), '']).font = { bold: true };
    vendorTolls.forEach(t =>
      ws.addRow(['TOLL CHALLAN', t.tanker, '', '', '', '', '', '', '', '', rN(t.amount), t.period]));
    ws.addRow(['TOTAL PAYABLE', '', '', '', '', '', '', '', '', '', rN(total), '']).font = { bold: true };
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    let cardsBuf = null;
    try { cardsBuf = await buildTankerCardsWorkbook(run, v.name, v.trips, tollBy, bmcuDetails); }
    catch (e) { console.error('[billing] tanker cards', e.message); }

    try {
      const vendorTransport = await createVendorTransport();
      await vendorTransport.sendMail({
        from: process.env.SMTP_FROM,
        to: v.email,
        subject: `${draft ? '[DRAFT for verification] ' : ''}Shreeja Tanker Payment ${fmtDateDisplay(run.from_date)} → ${fmtDateDisplay(run.to_date)} — ${v.name} · ₹ ${nf(total)}`,
        html: draft ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;">
          <p>Dear ${esc(v.name)},</p>
          <p>Please review your <b>DRAFT</b> tanker cards for <b>${fmtDateDisplay(run.from_date)} → ${fmtDateDisplay(run.to_date)}</b> in the attached sheet
          (${v.trips.length} trips · draft payable ₹ ${nf(total)}).</p>
          <p>Reply to this email or contact the Shreeja billing team with any corrections to distance, state or trip
          details — the biller will update the run before it goes for final approval.</p>
          <p style="color:#9ca3af;font-size:11px;">Shreeja TMS — automated mail; do not reply to book corrections by phone if preferred.</p></div>`
          : `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;">
          <p>Dear ${esc(v.name)},</p>
          <p>The tanker payment for <b>${fmtDateDisplay(run.from_date)} → ${fmtDateDisplay(run.to_date)}</b> has been approved.
          Your trip sheet is attached: <b>${v.trips.length} trips · ₹ ${nf(tripTotal)}</b>${materialTrips.length ? ` (including ${materialTrips.length} material trip(s) listed in their own section)` : ''}${tollTotal > 0
            ? ` plus toll challan reimbursement <b>₹ ${nf(tollTotal)}</b> — total payable <b>₹ ${nf(total)}</b>` : ''}.</p>
          <p>The <b>Tanker Cards</b> workbook is attached for printing — one landscape page per state, tanker and transport type; please sign every page and send the signed cards back to us.</p>
          <p>For any discrepancy in distances, contact the Shreeja billing team with the trip
          date and tanker number — corrections carry remarks and go through approval.</p>
          <p style="color:#9ca3af;font-size:11px;">Shreeja TMS — automated mail; do not reply.</p></div>`,
        attachments: [{ filename: `trip_sheet_${run.from_date}_${run.to_date}.xlsx`, content: buf },
          ...(cardsBuf ? [{ filename: `${v.name.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)}_Tanker_Cards_${run.from_date}_${run.to_date}.xlsx`, content: cardsBuf }] : [])],
      });
      results.push(`✓ ${v.name} — sent to ${v.email} (${v.trips.length} trips, ₹ ${nf(total)})`);
    } catch (e) {
      results.push(`✗ ${v.name} — send FAILED to ${v.email}: ${e.message}`);
    }
  }
  return results;
}

// ── POST /api/billing/runs/:id/push-vendor — send draft tanker cards to each
// vendor for verification before finalizing. Run stays editable; biller can
// still fix corrections the vendor reports back, then Submit as normal.
router.post('/runs/:id/push-vendor', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  try {
    const runId = req.params.id;
    const run = (await query('SELECT * FROM billing_runs WHERE id=$1', [runId])).rows[0];
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!['draft', 'rejected', 'pending_vendor'].includes(run.status))
      return res.status(400).json({ error: 'Run is already submitted or approved' });

    const vendorIds = Array.isArray(req.body?.vendor_ids) ? req.body.vendor_ids.map(Number).filter(Number.isFinite) : undefined;
    const results = await publishRunToVendors(runId, { draft: true, vendorIds }); // reuses the per-vendor tanker-card mailer
    await query(`UPDATE billing_runs SET status='pending_vendor', updated_at=NOW() WHERE id=$1`, [runId]);
    res.json({ ok: true, status: 'pending_vendor', results });
  } catch (err) {
    console.error('Billing push-vendor error:', err);
    res.status(500).json({ error: 'Failed to push draft cards to vendors' });
  }
});

// ── POST /api/billing/runs/:id/recalc-distances ─────────────────────────────
// Recompute System / Google / Master / Estimated KM and the leg breakdown for
// every trip of an unsubmitted run, e.g. after plant coordinates or Distance
// Master rows were added. The biller's Billed KM, state, rate, amount,
// remarks and exclusions are left exactly as they are — only the reference
// figures move. Refuses once the run is in the approval chain.
router.post('/runs/:id/recalc-distances', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  const client = await pool.connect();
  try {
    const runId = req.params.id;
    const run = (await client.query('SELECT * FROM billing_runs WHERE id=$1', [runId])).rows[0];
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!['draft', 'rejected', 'pending_vendor'].includes(run.status))
      return res.status(400).json({ error: 'Distances can only be recalculated before the run is submitted for approval' });
    const trips = (await client.query(
      'SELECT id, execution_id FROM billing_run_trips WHERE run_id=$1 ORDER BY id', [runId])).rows;
    await client.query('BEGIN');
    const masterCache = await loadMasterDistanceCache(client);
    let changed = 0, stillMissing = 0, newCombos = 0;
    for (const t of trips) {
      const dist = await computeExecutionDistance(client, t.execution_id, req.user.id, masterCache);
      const sumBy = src => rN(dist.legs.filter(l => l.source === src).reduce((s, l) => s + l.km, 0));
      const googleRefKm = rN(dist.legs.reduce((s, l) => s + (l.google_km || 0), 0));
      newCombos += dist.legs.filter(l => l.is_new).length;
      if (dist.legs.some(l => l.source === 'missing')) stillMissing++;
      const r = await client.query(`
        UPDATE billing_run_trips
           SET system_km=$1, google_km=$2, master_km=$3, estimated_km=$4, legs=$5::jsonb, updated_at=NOW()
         WHERE id=$6 AND (system_km IS DISTINCT FROM $1 OR google_km IS DISTINCT FROM $2 OR legs::text IS DISTINCT FROM $5::text)`,
        [rN(dist.total_km), googleRefKm, sumBy('master'), sumBy('estimated'), JSON.stringify(dist.legs), t.id]);
      changed += r.rowCount;
    }
    await client.query('COMMIT');
    res.json({ ok: true, trips: trips.length, changed, still_missing_legs: stillMissing, new_combos: newCombos });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Billing recalc-distances error:', err);
    res.status(500).json({ error: 'Failed to recalculate distances' });
  } finally { client.release(); }
});

// ── POST /api/billing/runs/:id/submit — finalize & start the approval chain ─
router.post('/runs/:id/submit', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  try {
    const runId = req.params.id;
    const run = (await query('SELECT * FROM billing_runs WHERE id=$1', [runId])).rows[0];
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!['draft', 'rejected', 'pending_vendor'].includes(run.status))
      return res.status(400).json({ error: 'Run is already submitted or approved' });

    const missing = await query(`
      SELECT COUNT(*)::int AS n FROM billing_run_trips
      WHERE run_id=$1 AND excluded=FALSE AND (state IS NULL OR rate_per_km IS NULL OR billed_km IS NULL)`, [runId]);
    if (missing.rows[0].n > 0)
      return res.status(400).json({ error: `${missing.rows[0].n} trip(s) missing state / rate / billed km — complete them before submitting` });

    const noVendor = (await query(`
      SELECT DISTINCT tanker_number FROM billing_run_trips
      WHERE run_id=$1 AND excluded=FALSE AND vendor_id IS NULL`, [runId])).rows.map(r => r.tanker_number);
    if (noVendor.length > 0)
      return res.status(400).json({ error: `No vendor mapped for tanker(s): ${noVendor.join(', ')} — assign a vendor on the Vendor Wise tab before submitting` });

    // Toll challans are NOT a submit blocker (owner, 2026-09-29): a missing
    // challan never removes a tanker's trips — trip payment always goes
    // through and only the toll carries forward, to be uploaded against this
    // period in the next cycle (billing_run_tolls.for_run_id, migration 046)
    // and paid there. Submit never deletes billing_run_trips.
    const tollsPending = await pendingTollTankers(runId);
    const remaining = (await query(
      `SELECT COUNT(*)::int AS n FROM billing_run_trips WHERE run_id=$1 AND excluded=FALSE`, [runId])).rows[0].n;
    if (remaining === 0)
      return res.status(400).json({ error: 'No billable trips in this run — nothing to submit' });
    await refreshRunTotal(runId);

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
    // Under-utilised trips without a reason — a warning only (owner, 2026-10-16).
    let utilUntagged = 0;
    try { utilUntagged = (await utilisationNote(runId))?.untagged || 0; }
    catch (e) { console.warn('[billing] utilisation note skipped:', e.message); }
    res.json({ ok: true, status: 'pending_l1', tolls_pending: tollsPending, utilisation_untagged: utilUntagged });
  } catch (err) {
    console.error('Billing submit error:', err);
    res.status(500).json({ error: 'Failed to submit for approval' });
  }
});

// ── POST /api/billing/runs/:id/withdraw — take a run back from L1 ───────────
// Only while the L1 approver has not decided (no approval row decided). The
// run returns to draft so lines / tolls can be edited (e.g. re-add lost
// trips); the approval tokens are deleted, so the L1 email links die.
// Resubmit recreates the chain from L1 as usual.
router.post('/runs/:id/withdraw', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  const client = await pool.connect();
  try {
    const runId = req.params.id;
    const run = (await client.query('SELECT * FROM billing_runs WHERE id=$1', [runId])).rows[0];
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status !== 'pending_l1')
      return res.status(400).json({ error: 'Only a run awaiting Level 1 approval can be withdrawn' });
    const decided = (await client.query(
      `SELECT COUNT(*)::int AS n FROM billing_run_approvals WHERE run_id=$1 AND decided_at IS NOT NULL`, [runId])).rows[0].n;
    if (decided > 0)
      return res.status(400).json({ error: 'An approver has already decided on this run — it cannot be withdrawn' });
    await client.query('BEGIN');
    await client.query('DELETE FROM billing_run_approvals WHERE run_id=$1', [runId]);
    await client.query(`UPDATE billing_runs SET status='draft', submitted_at=NULL, updated_at=NOW() WHERE id=$1`, [runId]);
    await client.query('COMMIT');
    res.json({ ok: true, status: 'draft' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Billing withdraw error:', err);
    res.status(500).json({ error: 'Failed to withdraw the run' });
  } finally { client.release(); }
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
    // Final approval does NOT email vendors — the Push-to-Vendors step earlier
    // in the workflow (draft verification) already covers that; payment is
    // made from the approved report in the portal, not by a vendor mailer.
    await notifyBiller(ap.run_id, `Billing Run #${ap.run_id} FULLY APPROVED`,
      `<p style="font-family:sans-serif">Billing run #${ap.run_id} has received final approval. The finance team can make payments per the approved report in the portal (Billing → Run #${ap.run_id}).</p>`);
    return { ok: true, message: 'Final approval recorded. The billing run is fully APPROVED.', run_id: ap.run_id };
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

// ── GET /api/billing/decide — LEGACY link only, never mutates state ──────────
// Approval emails no longer point here (they link straight to the frontend
// /billing-decision page, whose Approve/Reject button fires the real
// POST /api/billing/decide). This GET is kept only so any already-sent email
// with the old GET-mutate link still works: it just forwards the visitor to
// the same no-login confirmation page instead of acting on the link itself.
router.get('/decide', (req, res) => {
  const { token, decision } = req.query;
  if (!token || !['approve', 'reject'].includes(decision))
    return res.send(decisionPage('Invalid link', 'This link is malformed. Use the buttons in the approval email.', false));
  res.redirect(`${BASE_URL()}/billing-decision?token=${encodeURIComponent(token)}&decision=${decision}`);
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
// Trips up to ANALYTICS_HISTORY_UNTIL come from the FY workbook loaded into
// historical_trips (migration 065, scripts/import_trip_history.js); portal
// billing lines on or before that date are left out so nothing is counted
// twice (owner, 2026-10-13: the portal is complete from 1 September 2026).

async function historyRows(from, to) {
  if (from > HISTORY_UNTIL) return [];
  const end = to < HISTORY_UNTIL ? to : HISTORY_UNTIL;
  const r = await query(`
    SELECT NULL::int AS run_id, 'FY workbook' AS run_status, report_date::text AS plan_for_date, trip_date::text AS trip_date,
           tanker_number, capacity_litres, COALESCE(vendor_name,'— No vendor mapped —') AS vendor_name, vendor_code AS vendor_sap_code,
           route_name, NULL AS start_point, plant AS delivery_point, NULL AS state, NULL AS transport_type,
           NULL AS system_km, NULL AS google_km, NULL AS master_km, NULL AS estimated_km,
           billed_km, rate_per_km, amount, CONCAT_WS('; ', 'From FY workbook (' || source_sheet || ' row ' || source_row || ')', notes) AS remarks,
           milk_litres, milk_kgs, kg_fat, kg_snf,
           CASE WHEN bmcu_coverage IS NULL THEN 0 ELSE GREATEST(array_length(string_to_array(bmcu_coverage, '-'), 1) - 2, 0) END AS bmcu_count,
           bmcu_coverage
    FROM historical_trips WHERE report_date BETWEEN $1 AND $2
    ORDER BY report_date, tanker_number`, [from, end]);
  // Portal Delivery Point names for the workbook's plants (owner, 2026-10-15).
  const toPortal = await portalPlantMap();
  for (const h of r.rows) h.delivery_point = toPortal(h.delivery_point);
  return r.rows;
}
// Add history rows into a grouped result (dates / tankers / vendors) keyed by `key`.
function mergeHistory(groups, hist, key, init) {
  const byKey = new Map(groups.map(g => [g[key], g]));
  const tankerSets = new Map();
  for (const h of hist) {
    const k = key === 'date' ? h.plan_for_date : h[key];
    let g = byKey.get(k);
    if (!g) { g = { [key]: k, ...init(h), trips: 0, billed_km: 0, amount: 0, milk_litres: 0, milk_kgs: 0, kg_fat: 0, kg_snf: 0, capacity_litres: 0 }; byKey.set(k, g); groups.push(g); }
    g.trips = (parseInt(g.trips) || 0) + 1;
    for (const c of ['billed_km', 'amount', 'milk_litres', 'milk_kgs', 'kg_fat', 'kg_snf', 'capacity_litres']) g[c] = (parseFloat(g[c]) || 0) + (parseFloat(h[c]) || 0);
    if ('tankers' in g) { const s = tankerSets.get(k) || new Set(); s.add(h.tanker_number); tankerSets.set(k, s); }
  }
  for (const [k, s] of tankerSets) { const g = byKey.get(k); g.tankers = (parseInt(g.tankers) || 0) + s.size; }
  return groups.sort((a, b) => String(a[key]).localeCompare(String(b[key])));
}

async function reportData(q) {
  const params = [q.from, q.to, HISTORY_UNTIL];
  // Tanker / vendor filters were dropped from this report (owner, 2026-10-09).
  const cond = ['t.plan_for_date BETWEEN $1 AND $2', 't.plan_for_date > $3', 't.excluded = FALSE'];
  if ((q.status || 'approved') !== 'all') { params.push('approved'); cond.push(`br.status = $${params.length}`); }
  const where = 'WHERE ' + cond.join(' AND ');
  const base = `FROM billing_run_trips t JOIN billing_runs br ON br.id = t.run_id ${where}`;

  // Milk received per trip = the plant's acknowledgement (all chambers); the
  // finance format reports it beside the payment with cost per litre and
  // utilisation (litres ÷ tanker capacity). SAP vendor code = vendors.vendor_code.
  const ackJoin = `LEFT JOIN LATERAL (
      SELECT SUM(a.qty_litres) AS litres, SUM(a.qty_kgs) AS kgs, SUM(a.kg_fat) AS kg_fat, SUM(a.kg_snf) AS kg_snf
      FROM trip_acknowledgements a WHERE a.execution_id = t.execution_id) ack ON TRUE`;
  const baseAck = `FROM billing_run_trips t JOIN billing_runs br ON br.id = t.run_id ${ackJoin} ${where}`;
  const milkCols = `SUM(ack.litres) AS milk_litres, SUM(ack.kgs) AS milk_kgs, SUM(ack.kg_fat) AS kg_fat, SUM(ack.kg_snf) AS kg_snf,
           SUM(t.capacity_litres) AS capacity_litres`;

  const trips = await query(`
    SELECT t.run_id, br.status AS run_status, t.plan_for_date::text AS plan_for_date,
           t.tanker_number, t.capacity_litres, COALESCE(t.vendor_name,'— No vendor mapped —') AS vendor_name,
           v.vendor_code AS vendor_sap_code,
           t.route_name, t.start_point, t.delivery_point, t.state, t.transport_type,
           t.system_km, t.google_km, t.master_km, t.estimated_km,
           t.billed_km, t.rate_per_km, t.amount, t.remarks,
           ack.litres AS milk_litres, ack.kgs AS milk_kgs, ack.kg_fat, ack.kg_snf,
           (SELECT COUNT(*) FROM trip_execution_bmcus teb WHERE teb.execution_id = t.execution_id AND teb.is_deleted = FALSE)::int AS bmcu_count,
           (SELECT string_agg(b.bmcu_code || ' - ' || b.bmcu_name, ' → ' ORDER BY teb.seq_no)
              FROM trip_execution_bmcus teb JOIN bmcus b ON b.id = teb.bmcu_id
             WHERE teb.execution_id = t.execution_id AND teb.is_deleted = FALSE) AS bmcu_coverage
    FROM billing_run_trips t JOIN billing_runs br ON br.id = t.run_id
    LEFT JOIN vendors v ON v.id = t.vendor_id ${ackJoin} ${where}
    ORDER BY t.plan_for_date, t.tanker_number`, params);
  const dates = await query(`
    SELECT t.plan_for_date::text AS date, COUNT(*)::int AS trips,
           COUNT(DISTINCT t.tanker_number)::int AS tankers,
           SUM(t.billed_km) AS billed_km, SUM(t.system_km) AS system_km,
           SUM(t.google_km) AS google_km, SUM(t.amount) AS amount, ${milkCols}
    ${baseAck} GROUP BY t.plan_for_date ORDER BY t.plan_for_date`, params);
  const tankers = await query(`
    SELECT t.tanker_number, MAX(t.vendor_name) AS vendor_name, COUNT(*)::int AS trips,
           SUM(t.billed_km) AS billed_km, SUM(t.system_km) AS system_km,
           SUM(t.google_km) AS google_km, SUM(t.amount) AS amount, ${milkCols}
    ${baseAck} GROUP BY t.tanker_number ORDER BY t.tanker_number`, params);
  const vendors = await query(`
    SELECT COALESCE(t.vendor_name,'— No vendor mapped —') AS vendor_name,
           COUNT(DISTINCT t.tanker_number)::int AS tankers, COUNT(*)::int AS trips,
           SUM(t.billed_km) AS billed_km, SUM(t.system_km) AS system_km,
           SUM(t.google_km) AS google_km, SUM(t.amount) AS amount
    ${base} GROUP BY COALESCE(t.vendor_name,'— No vendor mapped —') ORDER BY 1`, params);
  // Toll challans for the runs represented in the filtered trips; vendor
  // attribution follows the tanker's vendor in those trips.
  let fortnights = [];
  const runIds = [...new Set(trips.rows.map(t => t.run_id))];
  if (runIds.length) {
    const tollQ = await query(
      `SELECT run_id, tanker_number, amount FROM billing_run_tolls WHERE run_id = ANY($1)`, [runIds]);
    const tankerVendor = new Map(trips.rows.map(t => [t.tanker_number, t.vendor_name]));
    const tollByTanker = new Map(), tollByVendor = new Map();
    for (const tl of tollQ.rows) {
      const vn = tankerVendor.get(tl.tanker_number);
      if (vn === undefined) continue;             // tanker has no trips in this report
      const amt = parseFloat(tl.amount) || 0;
      tollByTanker.set(tl.tanker_number, (tollByTanker.get(tl.tanker_number) || 0) + amt);
      tollByVendor.set(vn, (tollByVendor.get(vn) || 0) + amt);
    }
    for (const t of tankers.rows) {
      t.toll_amount = rN(tollByTanker.get(t.tanker_number) || 0);
      t.total_payable = rN((parseFloat(t.amount) || 0) + t.toll_amount);
    }
    for (const v of vendors.rows) {
      v.toll_amount = rN(tollByVendor.get(v.vendor_name) || 0);
      v.total_payable = rN((parseFloat(v.amount) || 0) + v.toll_amount);
    }
    // Toll per fortnight (finance, 2026-10-08): challans are per tanker per
    // run, never per day, so the Date Wise view carries one subtotal row per
    // billing run (= fortnight) with that run's toll; day rows show no toll.
    const runInfo = (await query(`SELECT id, from_date::text AS from_date, to_date::text AS to_date FROM billing_runs WHERE id = ANY($1)`, [runIds])).rows;
    const byRun = new Map(runInfo.map(r => [r.id, { run_id: r.id, from_date: r.from_date, to_date: r.to_date, trips: 0, tankers: new Set(), billed_km: 0, amount: 0, toll_amount: 0 }]));
    for (const t of trips.rows) {
      const r = byRun.get(t.run_id); if (!r) continue;
      r.trips++; r.tankers.add(t.tanker_number); r.billed_km += parseFloat(t.billed_km) || 0; r.amount += parseFloat(t.amount) || 0;
    }
    for (const tl of tollQ.rows) {
      if (tankerVendor.get(tl.tanker_number) === undefined) continue;
      const r = byRun.get(tl.run_id); if (r) r.toll_amount += parseFloat(tl.amount) || 0;
    }
    fortnights = [...byRun.values()].sort((a, b) => a.from_date.localeCompare(b.from_date) || a.run_id - b.run_id)
      .map(r => ({ ...r, tankers: r.tankers.size, billed_km: rN(r.billed_km), amount: rN(r.amount), toll_amount: rN(r.toll_amount), total_payable: rN(r.amount + r.toll_amount) }));
  }
  const hist = await historyRows(q.from, q.to);
  if (hist.length) {
    trips.rows.push(...hist);
    trips.rows.sort((a, b) => a.plan_for_date.localeCompare(b.plan_for_date) || a.tanker_number.localeCompare(b.tanker_number));
    mergeHistory(dates.rows, hist, 'date', () => ({ tankers: 0 }));
    mergeHistory(tankers.rows, hist, 'tanker_number', h => ({ vendor_name: h.vendor_name }));
    mergeHistory(vendors.rows, hist, 'vendor_name', () => ({ tankers: 0 }));
  }
  // Minimum-km guarantee (migration 067): approved fixed cost per tanker per
  // month, attached for every whole month inside the period. Tanker Wise by
  // tanker number, Vendor Wise through the tanker's vendor in this report
  // (else the transporter named on the fixed-cost sheet).
  const fixedRows = await fixedCostsInPeriod(q.from, q.to);
  const fixedMonths = [];
  if (fixedRows.length) {
    const byTanker = new Map();
    for (const f of fixedRows) byTanker.set(normTanker(f.tanker_number), (byTanker.get(normTanker(f.tanker_number)) || 0) + f.amount);
    const vendorOfTanker = new Map(trips.rows.map(t => [normTanker(t.tanker_number), t.vendor_name]));
    const byVendor = new Map();
    for (const f of fixedRows) {
      const vn = vendorOfTanker.get(normTanker(f.tanker_number)) || f.vendor_name || '— No vendor mapped —';
      byVendor.set(vn, (byVendor.get(vn) || 0) + f.amount);
    }
    const seenT = new Set();
    for (const t of tankers.rows) { const k = normTanker(t.tanker_number); t.fixed_cost = rN(byTanker.get(k) || 0); seenT.add(k); }
    // Tankers paid a fixed cost without any trip in the period still appear.
    for (const [k, amt] of byTanker) if (!seenT.has(k)) {
      const f = fixedRows.find(x => normTanker(x.tanker_number) === k);
      tankers.rows.push({ tanker_number: f.tanker_number, vendor_name: f.vendor_name, trips: 0, billed_km: 0, amount: 0, fixed_cost: rN(amt) });
    }
    const seenV = new Set();
    for (const v of vendors.rows) { v.fixed_cost = rN(byVendor.get(v.vendor_name) || 0); seenV.add(v.vendor_name); }
    for (const [vn, amt] of byVendor) if (!seenV.has(vn)) vendors.rows.push({ vendor_name: vn, tankers: 0, trips: 0, billed_km: 0, amount: 0, fixed_cost: rN(amt) });
    for (const f of fixedRows) { const m = fixedMonths.find(x => x.month_start === f.month_start); if (m) { m.amount += f.amount; m.tankers++; } else fixedMonths.push({ month_start: f.month_start, amount: f.amount, tankers: 1 }); }
    fixedMonths.forEach(m => { m.amount = rN(m.amount); });
    for (const r of [...tankers.rows, ...vendors.rows]) r.total_cost = rN((parseFloat(r.amount) || 0) + (parseFloat(r.toll_amount) || 0) + (parseFloat(r.fixed_cost) || 0));
  }
  // Derived per row: fat / SNF %, ₹/km, cost per litre, utilisation %.
  const derive = r => {
    const kgs = parseFloat(r.milk_kgs) || 0, l = parseFloat(r.milk_litres) || 0;
    const amt = parseFloat(r.amount) || 0, km = parseFloat(r.billed_km) || 0;
    const cap = parseFloat(r.capacity_litres) || 0;
    r.fat_pct = kgs > 0 ? rN(parseFloat(r.kg_fat) / kgs * 100) : null;
    r.snf_pct = kgs > 0 ? rN(parseFloat(r.kg_snf) / kgs * 100) : null;
    r.rate_avg = km > 0 ? rN(amt / km) : null;
    r.cost_per_litre = l > 0 ? rN(amt / l) : null;
    // All-in ₹/L adds the toll and the minimum-km fixed cost (owner, 2026-10-14).
    r.cost_per_litre_all_in = l > 0 ? rN((amt + (parseFloat(r.toll_amount) || 0) + (parseFloat(r.fixed_cost) || 0)) / l, 4) : null;
    r.utilisation_pct = cap > 0 && l > 0 ? rN(l / cap * 100) : null;
    return r;
  };
  trips.rows.forEach(derive); dates.rows.forEach(derive); tankers.rows.forEach(derive);
  // FY-workbook toll is one total per month (not per tanker / trip): reported as a
  // summary line for every whole month of the history inside the period.
  const historyTolls = q.from <= HISTORY_UNTIL ? (await query(`
    SELECT month_start::text AS month_start, toll_amount, source_sheet FROM historical_month_tolls
    WHERE month_start >= $1 AND (month_start + INTERVAL '1 month' - INTERVAL '1 day')::date <= $2 ORDER BY month_start`, [q.from, q.to])).rows
    .map(t => ({ ...t, toll_amount: rN(t.toll_amount) })) : [];
  return { history_tolls: historyTolls, fixed_months: fixedMonths, trips: trips.rows, dates: dates.rows, fortnights, tankers: tankers.rows, vendors: vendors.rows };
}

// The report covers whole fortnights or whole months only (finance,
// 2026-10-08): tolls are per fortnight, so a free date range cannot be reconciled.
function reportPeriodError(from, to) {
  if (!from || !to) return 'from and to are required';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return 'from and to must be YYYY-MM-DD';
  const [fy, fm, fd] = from.split('-').map(Number), [ty, tm, td] = to.split('-').map(Number);
  const end = new Date(Date.UTC(fy, fm, 0)).getUTCDate();
  const sameMonth = fy === ty && fm === tm;
  if (sameMonth && fd === 1 && (td === 15 || td === end)) return null;
  if (sameMonth && fd === 16 && td === end) return null;
  return 'The Payment Report covers a fortnight (1–15, 16–month end) or a full month';
}
router.get('/report-data', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  const { from, to } = req.query;
  const pe = reportPeriodError(from, to);
  if (pe) return res.status(400).json({ error: pe });
  try { res.json(await reportData(req.query)); }
  catch (err) { console.error('Billing report-data error:', err); res.status(500).json({ error: 'Failed to build report' }); }
});

// Excel of the cross-run report
router.get('/report-excel', authenticate, authorizeOrModule('billing', ...canBill), async (req, res) => {
  const { from, to } = req.query;
  const pe = reportPeriodError(from, to);
  if (pe) return res.status(400).json({ error: pe });
  try {
    const d = await reportData(req.query);
    const statusLabel = (req.query.status || 'approved') === 'all' ? 'All runs' : 'APPROVED runs only';
    const wb = new ExcelJS.Workbook();
    const head = (ws, cols) => { ws.addRow(cols).font = { bold: true }; ws.columns.forEach(c => { c.width = 16; }); };

    const ws1 = wb.addWorksheet('Trip Wise');
    ws1.addRow([`Tanker Payment Report ${fmtDateDisplay(from)} → ${fmtDateDisplay(to)} · ${statusLabel}`]).font = { bold: true, size: 13 };
    ws1.addRow([]);
    const sum = (rows, k) => rN(rows.reduce((s, r) => s + (+r[k] || 0), 0));
    const pct = (rows, k, base) => { const b = rows.reduce((s, r) => s + (+r[base] || 0), 0); return b > 0 ? rN(rows.reduce((s, r) => s + (+r[k] || 0), 0) / b * 100) : null; };
    const MILK_HEADS = ['Qty in Lts', 'Qty in Kgs', 'Fat %', 'Fat Kgs', 'SNF %', 'SNF Kgs'];                      // Trip Wise wording
    const MILK_HEADS_AGG = ['Milk Received in Ltrs', "Milk Received in KG's", 'FAT %', "FAT KG's", 'SNF%', "SNF KG's"]; // Date / Tanker Wise wording
    const milkCells = r => [rN(r.milk_litres), rN(r.milk_kgs), r.fat_pct, rN(r.kg_fat), r.snf_pct, rN(r.kg_snf)];
    const milkTotals = rows => [sum(rows, 'milk_litres'), sum(rows, 'milk_kgs'), pct(rows, 'kg_fat', 'milk_kgs'), sum(rows, 'kg_fat'), pct(rows, 'kg_snf', 'milk_kgs'), sum(rows, 'kg_snf')];
    const ratio = (rows, num, den) => { const b = rows.reduce((s, r) => s + (+r[den] || 0), 0); return b > 0 ? rN(rows.reduce((s, r) => s + (+r[num] || 0), 0) / b) : null; };
    const util = rows => { const c = rows.reduce((s, r) => s + (+r.capacity_litres || 0), 0); return c > 0 ? rN(rows.reduce((s, r) => s + (+r.milk_litres || 0), 0) / c * 100) : null; };

    head(ws1, ['S.No', 'Date', 'Run #', 'Run Status', 'Tanker', 'Capacity (KL)', 'SAP Vendor Code', 'Vendor', 'Route', 'Start Point', 'Delivery Point',
      'State', 'Transport Type', 'Billed KM', 'Rate/KM (₹)', 'Amount (₹)', 'Cost Per Ltr', 'Utilization %',
      ...MILK_HEADS, 'Remarks', 'BMCU Details']);
    ws1.getColumn(26).width = 60;
    d.trips.forEach((t, i) => ws1.addRow([i + 1, fmtDateDisplay(t.plan_for_date), t.run_id, t.run_status, t.tanker_number,
      t.capacity_litres ? rN(t.capacity_litres / 1000, 1) : null, t.vendor_sap_code, t.vendor_name, t.route_name, t.start_point, t.delivery_point,
      t.state, t.transport_type, t.billed_km, t.rate_per_km, t.amount, t.cost_per_litre, t.utilisation_pct,
      ...milkCells(t), t.remarks, t.bmcu_coverage]));
    ws1.addRow(['TOTAL', '', '', '', '', '', '', '', '', '', '', '', '',
      sum(d.trips, 'billed_km'), ratio(d.trips, 'amount', 'billed_km'),
      sum(d.trips, 'amount'), ratio(d.trips, 'amount', 'milk_litres'), util(d.trips), ...milkTotals(d.trips), '', '']).font = { bold: true };
    ws1.views = [{ state: 'frozen', ySplit: 3 }];

    // Milk columns sit after Trips on Date Wise (withCost) and after Total
    // Payable on Tanker Wise (finance's marked workbook, 2026-10-08).
    // Minimum-km fixed cost columns when the period holds approved fixed-cost months.
    const withFixed = (d.fixed_months || []).length > 0;
    const sheet = (name, rows, firstHead, firstKey, secondKey, withToll = false, withMilk = false, withCost = false) => {
      const ws = wb.addWorksheet(name);
      const milkFirst = withMilk && withCost, milkLast = withMilk && !withCost;
      head(ws, [firstHead, secondKey === 'vendor_name' ? 'Vendor' : 'Tankers', 'Trips',
        ...(withCost ? ['Tankers capacity'] : []),
        ...(milkFirst ? MILK_HEADS_AGG : []),
        'Billed KM', 'Amount (₹)',
        ...(withCost ? ['Rate Per KM', 'Cost Per Ltr', 'Utilization %'] : []),
        ...(withToll ? ['Toll (₹)', 'Total Payable (₹)'] : []),
        ...(withToll && withFixed ? ['Fixed Cost 9000 km (₹)', 'Total Cost (₹)', 'Cost Per Ltr All-in'] : []),
        ...(milkLast ? MILK_HEADS_AGG : [])]);
      // Date Wise dates as DD.MM.YYYY (finance, 2026-10-08); other sheets keep DD-MM-YYYY.
      rows.forEach(r => ws.addRow([firstKey === 'date' ? fmtDateDisplay(r[firstKey]).replace(/-/g, '.') : r[firstKey], r[secondKey], r.trips,
        ...(withCost ? [rN(r.capacity_litres)] : []),
        ...(milkFirst ? milkCells(r) : []),
        rN(r.billed_km), rN(r.amount),
        ...(withCost ? [r.rate_avg, r.cost_per_litre, r.utilisation_pct] : []),
        ...(withToll ? [rN(r.toll_amount), rN(r.total_payable)] : []),
        ...(withToll && withFixed ? [rN(r.fixed_cost), rN(r.total_cost), r.cost_per_litre_all_in] : []),
        ...(milkLast ? milkCells(r) : [])]));
      ws.addRow(['TOTAL', '', rows.reduce((s, r) => s + (+r.trips || 0), 0),
        ...(withCost ? [sum(rows, 'capacity_litres')] : []),
        ...(milkFirst ? milkTotals(rows) : []),
        sum(rows, 'billed_km'), sum(rows, 'amount'),
        ...(withCost ? [ratio(rows, 'amount', 'billed_km'), ratio(rows, 'amount', 'milk_litres'), util(rows)] : []),
        ...(withToll ? [sum(rows, 'toll_amount'), sum(rows, 'total_payable')] : []),
        ...(withToll && withFixed ? [sum(rows, 'fixed_cost'), sum(rows, 'total_cost'), ratio(rows, 'total_cost', 'milk_litres')] : []),
        ...(milkLast ? milkTotals(rows) : [])]).font = { bold: true };
    };
    sheet('Date Wise', d.dates, 'Date', 'date', 'tankers', false, true, true);
    {
      // Toll per run (fortnight) and per FY-workbook month, minimum-km fixed cost per
      // month: never per day, so they are subtotal rows; TOTAL and Total Payable
      // include both (owner, 2026-10-14). Columns 16 Toll, 17 Fixed cost, 18 Total Payable.
      const wsDW = wb.getWorksheet('Date Wise');
      const totalRow = wsDW.lastRow;
      const monthLabel = m => { const [y, mo] = m.split('-').map(Number); return `${MONTH_NAMES[mo - 1]} ${y}`; };
      const blank = n => Array(n).fill('');
      for (let r = 2; r < totalRow.number; r++) {
        const row = wsDW.getRow(r);
        if (typeof row.getCell(12).value === 'number') row.getCell(18).value = row.getCell(12).value;
      }
      const subRows = [
        ...d.fortnights.map(f => [`Run #${f.run_id} · ${fmtDateDisplay(f.from_date).replace(/-/g, '.')} → ${fmtDateDisplay(f.to_date).replace(/-/g, '.')}`,
          f.tankers, f.trips, ...blank(7), f.billed_km, f.amount, ...blank(3), f.toll_amount, '', f.toll_amount]),
        ...(d.history_tolls || []).map(t => [`Toll — ${monthLabel(t.month_start)} (FY workbook, monthly total)`, ...blank(14), t.toll_amount, '', t.toll_amount]),
        ...(d.fixed_months || []).map(f => [`Fixed cost 9,000 km — ${monthLabel(f.month_start)} (${f.tankers} tankers)`, ...blank(15), f.amount, f.amount]),
      ];
      const totToll = sum(d.fortnights, 'toll_amount') + sum(d.history_tolls || [], 'toll_amount');
      const totFixed = sum(d.fixed_months || [], 'amount');
      const totalVals = totalRow.values.slice(1);
      wsDW.spliceRows(totalRow.number, 1, ...subRows, [...totalVals.slice(0, 15), rN(totToll), rN(totFixed), rN(sum(d.dates, 'amount') + totToll + totFixed)]);
      ['Toll (₹)', 'Fixed Cost (₹)', 'Total Payable (₹)'].forEach((h, i) => { const c = wsDW.getRow(1).getCell(16 + i); c.value = h; c.font = { bold: true }; });
      for (let r = totalRow.number; r <= wsDW.rowCount; r++) wsDW.getRow(r).font = { bold: true };
    }
    sheet('Tanker Wise', d.tankers, 'Tanker', 'tanker_number', 'vendor_name', true, true);
    sheet('Vendor Wise', d.vendors, 'Vendor', 'vendor_name', 'tankers', true);

    stylePortalWorkbook(wb, 'Tanker Payment Report');
    // Date Wise: the fortnight (run) subtotal rows and their toll columns in the TOTAL style.
    {
      const wsDW = wb.getWorksheet('Date Wise');
      for (let r = 4; r <= wsDW.rowCount; r++) {
        const v = String(wsDW.getRow(r).getCell(1).value || '');
        if (v.startsWith('Run #') || v.startsWith('Toll — ') || v.startsWith('Fixed cost 9,000')) wsDW.getRow(r).eachCell({ includeEmpty: true }, c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3E0' } }; c.font = { bold: true }; });
      }
    }
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
