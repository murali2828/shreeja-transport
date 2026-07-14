// backend/src/routes/tripDocs.js
// Gate Pass / COA print logging against planned trips.
// First print per (trip, doc_type) is the operational timestamp:
//   gate_pass → trip start; coa → tanker arrived at delivery point.
// Reprints are allowed and get an increasing print_no (frontend marks DUPLICATE).
const express = require('express');
const router  = express.Router();
const { query, pool } = require('../config/db');
const { authenticate } = require('../middleware/auth');

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
router.post('/:planId(\\d+)/print', authenticate, async (req, res) => {
  const planId = req.params.planId;
  const { doc_type } = req.body;
  if (!['gate_pass', 'coa'].includes(doc_type))
    return res.status(400).json({ error: 'doc_type must be gate_pass or coa' });

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

    await client.query('BEGIN');
    const ins = await client.query(`
      INSERT INTO trip_document_prints (trip_plan_id, doc_type, print_no, printed_by, printed_by_name)
      VALUES ($1, $2,
        COALESCE((SELECT MAX(print_no) FROM trip_document_prints WHERE trip_plan_id=$1 AND doc_type=$2), 0) + 1,
        $3, $4)
      RETURNING print_no, printed_at`, [planId, doc_type, req.user.id, req.user.full_name]);
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

module.exports = router;
