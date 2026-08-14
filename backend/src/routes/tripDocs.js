// backend/src/routes/tripDocs.js
// Gate Pass / COA print logging against planned trips.
// First print per (trip, doc_type) is the operational timestamp:
//   gate_pass → trip start; coa → tanker arrived at delivery point.
// Reprints are allowed and get an increasing print_no (frontend marks DUPLICATE).
const express = require('express');
const router  = express.Router();
const { query, pool } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trip-docs/status?plan_for_date=YYYY-MM-DD
// Bulk print status per plan of the date (for Active Trips buttons).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', authenticate, async (req, res) => {
  const { plan_for_date } = req.query;
  if (!plan_for_date) return res.status(400).json({ error: 'plan_for_date required' });
  try {
    const r = await query(`
      SELECT p.trip_plan_id, p.doc_type, MIN(p.printed_at) AS first_printed_at, COUNT(*)::int AS count
      FROM trip_document_prints p
      JOIN trip_plans tp ON tp.id = p.trip_plan_id
      WHERE tp.plan_for_date = $1
      GROUP BY p.trip_plan_id, p.doc_type`, [plan_for_date]);
    const out = {};
    for (const row of r.rows) {
      (out[row.trip_plan_id] ||= {})[row.doc_type] = {
        first_printed_at: row.first_printed_at, count: row.count,
      };
    }
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trip-docs/:planId — print status for one plan (execution form).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:planId(\\d+)', authenticate, async (req, res) => {
  try {
    const r = await query(`
      SELECT doc_type, MIN(printed_at) AS first_printed_at, COUNT(*)::int AS count
      FROM trip_document_prints WHERE trip_plan_id=$1 GROUP BY doc_type`, [req.params.planId]);
    const out = {};
    for (const row of r.rows) out[row.doc_type] = { first_printed_at: row.first_printed_at, count: row.count };
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/trip-docs/:planId/print  { doc_type: 'gate_pass' | 'coa' }
// Logs the print and returns document data + duplicate info.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:planId(\\d+)/print', authenticate, authorize('admin','planner','executor','biller'), async (req, res) => {
  const planId = req.params.planId;
  const { doc_type, printed_at } = req.body;
  if (!['gate_pass', 'coa', 'unloading'].includes(doc_type))
    return res.status(400).json({ error: 'doc_type must be gate_pass, coa or unloading' });
  let manualPrinted;
  try { manualPrinted = parseManualTs(printed_at, 'Manual date/time'); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const client = await pool.connect();
  try {
    const pr = await client.query(`
      SELECT tp.id, tp.trip_no, tp.plan_for_date, tp.status,
             t.tanker_number, rm.route_name,
             sp.name AS starting_point, dp.name AS delivery_point
      FROM trip_plans tp
      LEFT JOIN tankers t          ON t.id=tp.tanker_id
      LEFT JOIN route_masters rm   ON rm.id=tp.route_id
      LEFT JOIN starting_points sp ON sp.id=tp.start_point_id
      LEFT JOIN delivery_points dp ON dp.id=tp.delivery_point_id
      WHERE tp.id=$1`, [planId]);
    if (!pr.rows.length) return res.status(404).json({ error: 'Trip plan not found' });
    const plan = pr.rows[0];
    if (['cancelled', 'deleted'].includes(plan.status))
      return res.status(400).json({ error: `Trip plan is ${plan.status}` });

    if (doc_type === 'coa') {
      const gp = await client.query(
        `SELECT 1 FROM trip_document_prints WHERE trip_plan_id=$1 AND doc_type='gate_pass' LIMIT 1`,
        [planId]);
      if (!gp.rows.length)
        return res.status(400).json({ error: 'Trip not started — print the Gate Pass first' });
    }
    if (doc_type === 'unloading') {
      const coa = await client.query(
        `SELECT 1 FROM trip_document_prints WHERE trip_plan_id=$1 AND doc_type='coa' LIMIT 1`,
        [planId]);
      if (!coa.rows.length)
        return res.status(400).json({ error: 'Tanker not arrived — print the COA first' });
    }

    await client.query('BEGIN');
    const ins = await client.query(`
      INSERT INTO trip_document_prints (trip_plan_id, doc_type, print_no, printed_by, printed_by_name, printed_at)
      VALUES ($1, $2,
        COALESCE((SELECT MAX(print_no) FROM trip_document_prints WHERE trip_plan_id=$1::int AND doc_type=$2::varchar), 0) + 1,
        $3, $4, COALESCE($5::timestamptz, NOW()))
      RETURNING print_no, printed_at`, [planId, doc_type, req.user.id, req.user.full_name, manualPrinted]);
    await client.query('COMMIT');

    const fp = await client.query(
      `SELECT MIN(printed_at) AS first FROM trip_document_prints WHERE trip_plan_id=$1 AND doc_type=$2`,
      [planId, doc_type]);

    res.json({
      print_no: ins.rows[0].print_no,
      printed_at: ins.rows[0].printed_at,
      first_printed_at: fp.rows[0].first,
      is_duplicate: ins.rows[0].print_no > 1,
      data: {
        trip_no: plan.trip_no,
        plan_for_date: String(plan.plan_for_date).slice(0, 10),
        tanker_number: plan.tanker_number,
        route_name: plan.route_name,
        starting_point: plan.starting_point,
        delivery_point: plan.delivery_point,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-trip gate passes — tanker goes out WITHOUT a planned trip.
// Reasons: Maintainance / Hot water / RMT / Tankers without driver / Others.
// RMT carries billing data (reimbursed from Balaji vendor, paid to tanker
// vendor at different rates).
// ─────────────────────────────────────────────────────────────────────────────
const NTGP_REASONS = ['Maintainance', 'Hot water', 'RMT', 'Tankers without driver', 'Others'];

// Optional manual timestamp ('YYYY-MM-DDTHH:mm' from a datetime-local input;
// DB runs Asia/Kolkata so the local string binds correctly via ::timestamptz).
// Returns null when absent; throws {code:400} when invalid or in the future.
function parseManualTs(v, label) {
  const s = String(v || '').trim();
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d)) throw Object.assign(new Error(`${label}: invalid date/time`), { code: 400 });
  if (d.getTime() > Date.now() + 5 * 60 * 1000)
    throw Object.assign(new Error(`${label} cannot be in the future`), { code: 400 });
  return s;
}

// GET /api/trip-docs/non-trip?from_date=&to_date=
router.get('/non-trip', authenticate, async (req, res) => {
  const { from_date, to_date } = req.query;
  if (!from_date || !to_date) return res.status(400).json({ error: 'from_date and to_date required' });
  try {
    const r = await query(`
      SELECT g.*, t.tanker_number, t.vendor_name, dp.name AS delivery_point_name
      FROM non_trip_gate_passes g
      JOIN tankers t ON t.id=g.tanker_id
      LEFT JOIN delivery_points dp ON dp.id=g.delivery_point_id
      WHERE g.issued_at::date BETWEEN $1 AND $2
      ORDER BY g.issued_at DESC`, [from_date, to_date]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/trip-docs/non-trip
router.post('/non-trip', authenticate, authorize('admin','planner','executor','biller'), async (req, res) => {
  const { tanker_id, delivery_point_id, reason, other_text, billing, remarks, km, tanker_vendor_rate, balaji_dairy_rate, issued_at } = req.body;
  if (!tanker_id) return res.status(400).json({ error: 'tanker_id required' });
  if (!delivery_point_id) return res.status(400).json({ error: 'Issuing delivery point required' });
  if (!NTGP_REASONS.includes(reason)) return res.status(400).json({ error: 'Invalid reason' });
  if (reason === 'Others' && !String(other_text || '').trim())
    return res.status(400).json({ error: 'Please describe the reason (Others)' });
  if (reason === 'RMT' && (!km || !tanker_vendor_rate || !balaji_dairy_rate))
    return res.status(400).json({ error: 'RMT requires KM, Tanker Vendor Rate and Balaji Dairy Rate' });
  try {
    const manualIssued = parseManualTs(issued_at, 'Issue date/time');
    const isRmt = reason === 'RMT';
    const r = await query(`
      INSERT INTO non_trip_gate_passes
        (tanker_id, delivery_point_id, reason, other_text, billing, remarks, km, tanker_vendor_rate, balaji_dairy_rate, issued_by, issued_by_name, issued_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12::timestamptz, NOW()))
      RETURNING *`,
      [tanker_id, delivery_point_id, reason, reason === 'Others' ? other_text.trim() : null,
       isRmt ? billing || null : null, isRmt ? remarks || null : null,
       isRmt ? km : null, isRmt ? tanker_vendor_rate : null, isRmt ? balaji_dairy_rate : null,
       req.user.id, req.user.full_name, manualIssued]);
    const t = await query('SELECT tanker_number, vendor_name FROM tankers WHERE id=$1', [tanker_id]);
    const dp = await query('SELECT name AS delivery_point_name FROM delivery_points WHERE id=$1', [delivery_point_id]);
    res.json({ ...r.rows[0], ...t.rows[0], ...dp.rows[0] });
  } catch (err) { res.status(err.code === 400 ? 400 : 500).json({ error: err.message }); }
});

// POST /api/trip-docs/non-trip/:id/return — tanker reported back (e.g. from
// maintenance). Frees the tanker for trip planning again. Optional manual
// returned_at in the body (blank = now); must not precede issue time.
router.post('/non-trip/:id(\\d+)/return', authenticate, authorize('admin','planner','executor','biller'), async (req, res) => {
  try {
    const manualReturned = parseManualTs(req.body?.returned_at, 'Return date/time');
    if (manualReturned) {
      const chk = await query(
        'SELECT 1 FROM non_trip_gate_passes WHERE id=$1 AND issued_at <= $2::timestamptz', [req.params.id, manualReturned]);
      if (!chk.rows.length)
        return res.status(400).json({ error: 'Return date/time cannot be before the issue date/time' });
    }
    const r = await query(`
      UPDATE non_trip_gate_passes
      SET returned_at=COALESCE($3::timestamptz, NOW()), returned_by_name=$2
      WHERE id=$1 AND returned_at IS NULL
      RETURNING id, returned_at`, [req.params.id, req.user.full_name, manualReturned]);
    if (!r.rows.length) return res.status(409).json({ error: 'Gate pass not found or already marked returned' });
    res.json(r.rows[0]);
  } catch (err) { res.status(err.code === 400 ? 400 : 500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trip-docs/tanker-position — live tanker status/position dashboard.
// Status per tanker from its LATEST event:
//   trip cycle:  gate pass → Running · COA → Unloading Point ·
//                unloading → Cleaning · (next gate pass starts a new cycle)
//   non-trip GP: Maintainance → maintenance · Tankers without driver →
//                without_driver · Hot water / RMT / Others → running (out)
//   no events   → idle
// Location = delivery point of the tanker's latest trip (else 'Unassigned').
// ─────────────────────────────────────────────────────────────────────────────
router.get('/tanker-position', authenticate, async (req, res) => {
  try {
    const tankers = (await query(
      `SELECT id, tanker_number, is_active FROM tankers ORDER BY tanker_number`)).rows;
    const active = tankers.filter(t => t.is_active);

    // Latest trip-cycle prints per tanker: newest gate-pass cycle and its stage.
    const trips = (await query(`
      SELECT DISTINCT ON (tp.tanker_id)
        tp.tanker_id, tp.id AS plan_id, tp.trip_no, dp.name AS delivery_point,
        (SELECT MIN(printed_at) FROM trip_document_prints WHERE trip_plan_id=tp.id AND doc_type='gate_pass') AS gp_at,
        (SELECT MIN(printed_at) FROM trip_document_prints WHERE trip_plan_id=tp.id AND doc_type='coa')       AS coa_at,
        (SELECT MIN(printed_at) FROM trip_document_prints WHERE trip_plan_id=tp.id AND doc_type='unloading') AS unload_at
      FROM trip_plans tp
      LEFT JOIN delivery_points dp ON dp.id=tp.delivery_point_id
      WHERE tp.tanker_id IS NOT NULL AND tp.status NOT IN ('cancelled','deleted')
        AND EXISTS (SELECT 1 FROM trip_document_prints p WHERE p.trip_plan_id=tp.id)
      ORDER BY tp.tanker_id,
        (SELECT MAX(printed_at) FROM trip_document_prints p WHERE p.trip_plan_id=tp.id) DESC`)).rows;
    const tripBy = Object.fromEntries(trips.map(t => [t.tanker_id, t]));

    // Latest delivery point per tanker (for location even when idle/non-trip).
    const lastDp = (await query(`
      SELECT DISTINCT ON (tp.tanker_id) tp.tanker_id, dp.name AS delivery_point
      FROM trip_plans tp
      LEFT JOIN delivery_points dp ON dp.id=tp.delivery_point_id
      WHERE tp.tanker_id IS NOT NULL AND tp.status NOT IN ('cancelled','deleted')
      ORDER BY tp.tanker_id, tp.plan_for_date DESC, tp.id DESC`)).rows;
    const dpBy = Object.fromEntries(lastDp.map(t => [t.tanker_id, t.delivery_point]));

    // Latest non-trip gate pass per tanker.
    // Only passes not yet marked returned hold a tanker's status.
    const ntgp = (await query(`
      SELECT DISTINCT ON (g.tanker_id) g.tanker_id, g.reason, g.other_text, g.issued_at,
             dp.name AS delivery_point_name
      FROM non_trip_gate_passes g
      LEFT JOIN delivery_points dp ON dp.id=g.delivery_point_id
      WHERE g.returned_at IS NULL
      ORDER BY g.tanker_id, g.issued_at DESC`)).rows;
    const ntgpBy = Object.fromEntries(ntgp.map(g => [g.tanker_id, g]));

    const STATUSES = ['unloading', 'running', 'cleaning', 'maintenance', 'without_driver', 'idle'];
    const rows = active.map(t => {
      const trip = tripBy[t.id];
      const gp = ntgpBy[t.id];

      // Trip-cycle candidate status + its defining event time
      let tripStatus = null, tripAt = null;
      if (trip) {
        if (trip.unload_at)   { tripStatus = 'cleaning';  tripAt = trip.unload_at; }
        else if (trip.coa_at) { tripStatus = 'unloading'; tripAt = trip.coa_at; }
        else if (trip.gp_at)  { tripStatus = 'running';   tripAt = trip.gp_at; }
      }
      // Non-trip candidate
      let ntStatus = null, ntAt = null, ntLabel = null;
      if (gp) {
        ntAt = gp.issued_at;
        ntLabel = gp.reason + (gp.other_text ? ` — ${gp.other_text}` : '');
        ntStatus = gp.reason === 'Maintainance' ? 'maintenance'
          : gp.reason === 'Tankers without driver' ? 'without_driver'
          : 'running';
      }
      // Latest event wins
      let status = 'idle', since = null, detail = null, trip_no = null;
      let location = dpBy[t.id] || 'Unassigned';
      if (tripAt && (!ntAt || new Date(tripAt) >= new Date(ntAt))) {
        status = tripStatus; since = tripAt; trip_no = trip.trip_no;
        detail = `Trip #${trip.trip_no}`;
        location = trip.delivery_point || location;
      } else if (ntAt) {
        status = ntStatus; since = ntAt; detail = ntLabel;
        location = gp.delivery_point_name || location; // issuing dairy of the gate pass
      }
      return { tanker_number: t.tanker_number, status, since, detail, trip_no, location };
    });

    const locations = {};
    for (const r of rows) {
      const loc = locations[r.location] ||= { name: r.location, total: 0, tankers: [] };
      loc.total++;
      loc.tankers.push(r);
      loc[r.status] = (loc[r.status] || 0) + 1;
    }
    for (const loc of Object.values(locations))
      for (const s of STATUSES) loc[s] = loc[s] || 0;

    res.json({
      total_tankers: tankers.length,
      active_tankers: active.length,
      last_updated: new Date().toISOString(),
      statuses: STATUSES,
      locations: Object.values(locations).sort((a, b) => b.total - a.total),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
