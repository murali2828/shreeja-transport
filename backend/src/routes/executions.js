// backend/src/routes/executions.js
const express = require('express');
const router  = express.Router();
const { pool, query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const {
  calcKgs, calcKgFat, calcKgSnf,
  computeExecutionDistance, applyExecutionData, assertWithinCapacity,
} = require('../services/executionData');

// Ensure the sub-entries table (balance milk / new MPP / internal shifting) exists.
(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS trip_execution_bmcu_entries (
        id             SERIAL PRIMARY KEY,
        execution_id   INTEGER NOT NULL REFERENCES trip_executions(id) ON DELETE CASCADE,
        bmcu_seq_no    INTEGER NOT NULL,
        bmcu_id        INTEGER REFERENCES bmcus(id),
        kind           TEXT NOT NULL,            -- 'balance_milk' | 'new_mpp' | 'internal_shifting'
        category       TEXT,                     -- balance_milk: 'Balance milk' | 'Left Over milk' | 'Lifted milk'
        source_bmcu_id INTEGER REFERENCES bmcus(id),
        qty_litres     NUMERIC,
        fat_pct        NUMERIC,
        snf_pct        NUMERIC,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`ALTER TABLE trip_execution_bmcu_entries ADD COLUMN IF NOT EXISTS bmcu_id INTEGER REFERENCES bmcus(id)`);
    // Free-text remarks on balance-milk entries (Left Over / Lifted) — used in reports.
    await query(`ALTER TABLE trip_execution_bmcu_entries ADD COLUMN IF NOT EXISTS remarks TEXT`);
    await query(`CREATE INDEX IF NOT EXISTS tebe_exec_idx ON trip_execution_bmcu_entries (execution_id)`);
    await query(`CREATE INDEX IF NOT EXISTS tebe_bmcu_idx ON trip_execution_bmcu_entries (bmcu_id)`);
  } catch (err) {
    console.error('Migration error (trip_execution_bmcu_entries):', err.message);
  }
})();

// GET /api/executions
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, execution_date, from_date, to_date, tanker_id } = req.query;
    let sql = `
      SELECT te.*,
        tp.trip_no, tp.expected_km, tp.expected_total_qty, tp.plan_for_date,
        tp.shifts_milk, tp.driver_name, tp.loader_name,
        t.tanker_number, t.capacity_litres,
        sp.name AS start_point_name, dp.name AS delivery_point_name,
        u.full_name AS executor_name,
        COALESCE(u2.user_id, u.user_id) AS entered_by_user_id
      FROM trip_executions te
      JOIN trip_plans tp      ON tp.id=te.trip_plan_id
      LEFT JOIN tankers t     ON t.id=tp.tanker_id
      LEFT JOIN starting_points sp ON sp.id=tp.start_point_id
      LEFT JOIN delivery_points dp ON dp.id=tp.delivery_point_id
      LEFT JOIN users u       ON u.id=te.executed_by
      LEFT JOIN users u2      ON u2.id=te.updated_by
      WHERE 1=1`;
    const params = [];
    if (status)         { params.push(status);         sql += ` AND te.status=$${params.length}`; }
    if (execution_date) { params.push(execution_date); sql += ` AND te.execution_date=$${params.length}`; }
    if (from_date)      { params.push(from_date);      sql += ` AND te.execution_date>=$${params.length}`; }
    if (to_date)        { params.push(to_date);        sql += ` AND te.execution_date<=$${params.length}`; }
    if (tanker_id)      { params.push(tanker_id);      sql += ` AND t.id=$${params.length}`; }
    sql += ' ORDER BY te.execution_date DESC, tp.trip_no';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/executions/coverage?date=YYYY-MM-DD
// Execution-truth coverage for the date's plans: trip status split, BMCUs with
// milk actually recorded (dispatch qty > 0 or RMRD > 0), and the missed list
// split into planned-but-not-collected vs not-planned.
// NOTE: must be registered before GET /:id.
router.get('/coverage', authenticate, async (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    // Trip counts by (latest non-cancelled) execution status.
    const tripsRes = await query(`
      SELECT COALESCE(te.status, 'not_started') AS status, COUNT(*)::int AS n
      FROM trip_plans tp
      LEFT JOIN LATERAL (
        SELECT status FROM trip_executions x
        WHERE x.trip_plan_id=tp.id AND x.status != 'cancelled'
        ORDER BY x.id DESC LIMIT 1
      ) te ON TRUE
      WHERE tp.plan_for_date=$1 AND tp.status NOT IN ('cancelled','deleted')
      GROUP BY 1`, [date]);
    const trips = { planned: 0, not_started: 0, in_progress: 0, saved: 0, pending_ack: 0, closed: 0 };
    for (const r of tripsRes.rows) { trips[r.status] = r.n; trips.planned += r.n; }

    // BMCUs with milk actually recorded on the date's executions.
    const collectedRes = await query(`
      SELECT DISTINCT teb.bmcu_id
      FROM trip_execution_bmcus teb
      JOIN trip_executions te ON te.id=teb.execution_id AND te.status != 'cancelled'
      JOIN trip_plans tp      ON tp.id=te.trip_plan_id
      WHERE tp.plan_for_date=$1 AND teb.is_deleted=FALSE
        AND (COALESCE(teb.qty_litres,0) > 0 OR EXISTS (
          SELECT 1 FROM trip_execution_bmcu_shifts s
          WHERE s.execution_id=teb.execution_id AND s.bmcu_seq_no=teb.seq_no
            AND COALESCE(s.rmrd_qty,0) > 0))`, [date]);
    const collected = new Set(collectedRes.rows.map(r => r.bmcu_id));

    // All active BMCUs, annotated with the trip they were planned on (if any).
    const bmcusRes = await query(`
      SELECT b.id, b.bmcu_code, b.bmcu_name, b.district,
             pl.trip_no, pl.tanker_number, pl.exec_status
      FROM bmcus b
      LEFT JOIN LATERAL (
        SELECT tp.trip_no, t.tanker_number, COALESCE(te.status, 'not started') AS exec_status
        FROM trip_plan_bmcus tpb
        JOIN trip_plans tp ON tp.id=tpb.trip_plan_id
          AND tp.plan_for_date=$1 AND tp.status NOT IN ('cancelled','deleted')
        LEFT JOIN tankers t ON t.id=tp.tanker_id
        LEFT JOIN LATERAL (
          SELECT status FROM trip_executions x
          WHERE x.trip_plan_id=tp.id AND x.status != 'cancelled'
          ORDER BY x.id DESC LIMIT 1
        ) te ON TRUE
        WHERE tpb.bmcu_id=b.id
        LIMIT 1
      ) pl ON TRUE
      WHERE b.is_active=TRUE
      ORDER BY (pl.trip_no IS NULL), b.bmcu_code`, [date]);

    const missed = bmcusRes.rows
      .filter(b => !collected.has(b.id))
      .map(b => ({
        bmcu_code: b.bmcu_code, bmcu_name: b.bmcu_name, district: b.district,
        planned: b.trip_no != null, trip_no: b.trip_no,
        tanker_number: b.tanker_number, exec_status: b.exec_status,
      }));

    const totalActive = bmcusRes.rows.length;
    res.json({
      date, trips,
      bmcus_collected: collected.size,
      total_active_bmcus: totalActive,
      coverage_pct: totalActive > 0 ? Math.round(collected.size / totalActive * 1000) / 10 : 0,
      missed_planned: missed.filter(m => m.planned).length,
      missed_unplanned: missed.filter(m => !m.planned).length,
      missed,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/executions/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const exec = await query(`
      SELECT te.*,
        tp.trip_no, tp.expected_km, tp.expected_total_qty, tp.plan_for_date,
        tp.shifts_milk, tp.driver_name, tp.loader_name,
        tp.start_point_id, tp.delivery_point_id, tp.testing_point_id,
        t.tanker_number, t.capacity_litres, t.compartments, t.per_km_rate,
        sp.name AS start_point_name, dp.name AS delivery_point_name,
        tpt.name AS testing_point_name, rm.route_name,
        COALESCE(u2.user_id, u1.user_id) AS entered_by_user_id
      FROM trip_executions te
      LEFT JOIN users u1            ON u1.id=te.executed_by
      LEFT JOIN users u2            ON u2.id=te.updated_by
      JOIN trip_plans tp            ON tp.id=te.trip_plan_id
      LEFT JOIN tankers t           ON t.id=tp.tanker_id
      LEFT JOIN starting_points sp  ON sp.id=tp.start_point_id
      LEFT JOIN delivery_points dp  ON dp.id=tp.delivery_point_id
      LEFT JOIN testing_points tpt  ON tpt.id=tp.testing_point_id
      LEFT JOIN route_masters rm    ON rm.id=tp.route_id
      WHERE te.id=$1`, [req.params.id]
    );
    if (!exec.rows.length) return res.status(404).json({ error: 'Not found' });

    const bmcus = await query(`
      SELECT teb.*, b.bmcu_code, b.bmcu_name, sb.bmcu_code AS source_bmcu_code
      FROM trip_execution_bmcus teb
      JOIN bmcus b ON b.id=teb.bmcu_id
      LEFT JOIN bmcus sb ON sb.id=teb.source_bmcu_id
      WHERE teb.execution_id=$1 AND teb.is_deleted=FALSE
      ORDER BY teb.seq_no`, [req.params.id]
    );

    const acks = await query(
      `SELECT ta.*, ua.user_id AS entered_by_user_id
       FROM trip_acknowledgements ta
       LEFT JOIN users ua ON ua.id=ta.entered_by
       WHERE ta.execution_id=$1 ORDER BY ta.chamber`,
      [req.params.id]
    );

    const shiftRows = await query(
      'SELECT * FROM trip_execution_bmcu_shifts WHERE execution_id=$1 ORDER BY bmcu_seq_no, id',
      [req.params.id]
    );

    const entries = await query(`
      SELECT e.*,
        b.bmcu_code  AS bmcu_code,  b.bmcu_name  AS bmcu_name,
        sb.bmcu_code AS source_bmcu_code, sb.bmcu_name AS source_bmcu_name
      FROM trip_execution_bmcu_entries e
      LEFT JOIN bmcus b  ON b.id  = e.bmcu_id
      LEFT JOIN bmcus sb ON sb.id = e.source_bmcu_id
      WHERE e.execution_id=$1 ORDER BY e.bmcu_seq_no, e.id`,
      [req.params.id]
    );

    res.json({ ...exec.rows[0], bmcus: bmcus.rows, acknowledgements: acks.rows, shift_rows: shiftRows.rows, entries: entries.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/executions  — create execution from a published plan
router.post('/', authenticate, authorize('admin','planner','executor','biller'), async (req, res) => {
  const { trip_plan_id, execution_date, dc_number } = req.body;
  if (!trip_plan_id || !execution_date)
    return res.status(400).json({ error: 'trip_plan_id and execution_date required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify plan exists and is published
    const plan = await client.query(
      "SELECT * FROM trip_plans WHERE id=$1 AND status='published'", [trip_plan_id]
    );
    if (!plan.rows.length)
      return res.status(400).json({ error: 'Plan not found or not published' });

    // Check not already started
    const existing = await client.query(
      "SELECT id FROM trip_executions WHERE trip_plan_id=$1 AND status NOT IN ('closed')",
      [trip_plan_id]
    );
    if (existing.rows.length)
      return res.status(409).json({ error: 'Execution already in progress for this plan' });

    const r = await client.query(
      `INSERT INTO trip_executions (trip_plan_id,execution_date,dc_number,executed_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [trip_plan_id, execution_date, dc_number||null, req.user.id]
    );
    const execId = r.rows[0].id;

    // Copy plan BMCUs preserving description (RMRD or Balance Milk)
    const planBmcus = await client.query(
      'SELECT * FROM trip_plan_bmcus WHERE trip_plan_id=$1 ORDER BY seq_no', [trip_plan_id]
    );
    for (const bm of planBmcus.rows) {
      await client.query(
        `INSERT INTO trip_execution_bmcus
           (execution_id,seq_no,bmcu_id,milk_date,description)
         VALUES ($1,$2,$3,$4,$5)`,
        [execId, bm.seq_no, bm.bmcu_id, execution_date, bm.description||'RMRD']
      );
    }

    // Auto-calculate road distance and seed Actual KM from it.
    const dist = await computeExecutionDistance(client, execId, req.user.id);
    await client.query('UPDATE trip_executions SET actual_km=$1 WHERE id=$2', [dist.total_km, execId]);
    r.rows[0].actual_km             = dist.total_km;
    r.rows[0].calculated_km         = dist.total_km;
    r.rows[0].km_estimated_leg_count = dist.estimated_leg_count;
    r.rows[0].km_incomplete         = dist.incomplete;

    await client.query('COMMIT');
    res.status(201).json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// PUT /api/executions/:id  — save BMCU data, recalc totals
// (write logic shared with the change-request approval flow — services/executionData.js)
router.put('/:id', authenticate, authorize('admin','planner','executor','biller'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const exec = await client.query(
      "SELECT id FROM trip_executions WHERE id=$1 AND status NOT IN ('closed')", [req.params.id]
    );
    if (!exec.rows.length) return res.status(404).json({ error: 'Execution not found or already closed' });

    // Once a trip is pulled into a billing run (any status, including
    // draft), its data is frozen for direct edits — billing math must stay
    // consistent with what the run was executed against. Corrections go
    // through the Request Changes approval flow instead, or the biller
    // deletes the billing run first.
    const inRun = await client.query(
      `SELECT br.id, br.status FROM billing_run_trips brt
       JOIN billing_runs br ON br.id = brt.run_id
       WHERE brt.execution_id = $1 LIMIT 1`, [req.params.id]);
    if (inRun.rows.length)
      return res.status(400).json({
        error: `This trip is part of Billing Run #${inRun.rows[0].id} (${inRun.rows[0].status}) — it can't be edited directly. `
          + `Use "Request Changes" for an approved correction, or ask the biller to delete/exclude it from the billing run first.`
      });

    const { execution, dist } = await applyExecutionData(
      client, req.params.id, req.body, req.user.id, { setSavedStatus: true }
    );
    execution.calculated_km          = dist.total_km;
    execution.km_estimated_leg_count = dist.estimated_leg_count;
    execution.km_incomplete          = dist.incomplete;

    await client.query('COMMIT');
    res.json({ ...execution, distance: dist });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.code === 400 ? 400 : 500).json({ error: err.message });
  } finally { client.release(); }
});

// GET /api/executions/:id/distance — per-leg road-distance breakdown
router.get('/:id/distance', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dist = await computeExecutionDistance(client, req.params.id, req.user.id);
    await client.query('COMMIT');
    res.json(dist);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// POST /api/executions/:id/cancel  — admin only, any status except closed
router.post('/:id/cancel', authenticate, authorize('admin','planner','executor','biller'), async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Admin only' });
  const { reason } = req.body;
  try {
    const exec = await query(
      "SELECT * FROM trip_executions WHERE id=$1 AND status != 'closed'", [req.params.id]
    );
    if (!exec.rows.length)
      return res.status(404).json({ error: 'Execution not found or already closed' });

    await query(
      "UPDATE trip_executions SET status='cancelled', cancel_reason=$1, updated_at=NOW() WHERE id=$2",
      [reason || null, req.params.id]
    );
    // Also cancel the associated trip plan
    await query(
      "UPDATE trip_plans SET status='cancelled' WHERE id=$1",
      [exec.rows[0].trip_plan_id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/executions/:id/submit-ack  — saved → pending_ack
router.post('/:id/submit-ack', authenticate, authorize('admin','planner','executor','biller'), async (req, res) => {
  try {
    const r = await query(
      "UPDATE trip_executions SET status='pending_ack',updated_at=NOW() WHERE id=$1 AND status='saved' RETURNING *",
      [req.params.id]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Execution not in saved state' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/executions/:id/acknowledgements  — save chamber acks → closed
router.post('/:id/acknowledgements', authenticate, authorize('admin','planner','executor','biller'), async (req, res) => {
  const { ack_date, chambers } = req.body;
  if (!chambers?.length) return res.status(400).json({ error: 'chambers array required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const exec = await client.query(
      "SELECT * FROM trip_executions WHERE id=$1 AND status='pending_ack'", [req.params.id]
    );
    if (!exec.rows.length)
      return res.status(400).json({ error: 'Execution not in pending_ack state' });

    // Delete existing acks and re-insert
    await client.query('DELETE FROM trip_acknowledgements WHERE execution_id=$1', [req.params.id]);

    for (const ch of chambers) {
      // Preserve the user-ENTERED kgs — deriving it back from the 2-dp-rounded
      // litres drifts by ±0.01 kg (e.g. entered 19,900 stored as 19,899.99).
      const kgs    = parseFloat(ch.qty_kgs) || calcKgs(ch.qty_litres);
      const kgFat  = calcKgFat(kgs, ch.fat_pct);
      const kgSnf  = calcKgSnf(kgs, ch.snf_pct);
      await client.query(
        `INSERT INTO trip_acknowledgements
           (execution_id,ack_date,chamber,qty_litres,qty_kgs,fat_pct,snf_pct,kg_fat,kg_snf,temperature,description,entered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [req.params.id, ack_date||null, ch.chamber, ch.qty_litres||null,
         kgs||null, ch.fat_pct||null, ch.snf_pct||null, kgFat||null, kgSnf||null,
         ch.temperature||null, ch.description||null, req.user.id]
      );
    }

    // 110% capacity guard on acknowledgement totals (throws code 400)
    await assertWithinCapacity(client, req.params.id);

    const r = await client.query(
      "UPDATE trip_executions SET status='closed',updated_at=NOW() WHERE id=$1 RETURNING *",
      [req.params.id]
    );

    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.code === 400 ? 400 : 500).json({ error: err.message });
  } finally { client.release(); }
});

module.exports = router;
