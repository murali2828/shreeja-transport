// backend/src/routes/executions.js
const express = require('express');
const router  = express.Router();
const { pool, query } = require('../config/db');
const { authenticate } = require('../middleware/auth');

const KG_FACTOR = 1.0285;

function calcKgs(litres)          { return litres ? parseFloat(litres) * KG_FACTOR : 0; }
function calcKgFat(kgs, fatPct)   { return kgs && fatPct ? parseFloat(kgs) * parseFloat(fatPct) / 100 : 0; }
function calcKgSnf(kgs, snfPct)   { return kgs && snfPct ? parseFloat(kgs) * parseFloat(snfPct) / 100 : 0; }

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
        u.full_name AS executor_name
      FROM trip_executions te
      JOIN trip_plans tp      ON tp.id=te.trip_plan_id
      LEFT JOIN tankers t     ON t.id=tp.tanker_id
      LEFT JOIN starting_points sp ON sp.id=tp.start_point_id
      LEFT JOIN delivery_points dp ON dp.id=tp.delivery_point_id
      LEFT JOIN users u       ON u.id=te.executed_by
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
        tpt.name AS testing_point_name
      FROM trip_executions te
      JOIN trip_plans tp           ON tp.id=te.trip_plan_id
      LEFT JOIN tankers t          ON t.id=tp.tanker_id
      LEFT JOIN starting_points sp ON sp.id=tp.start_point_id
      LEFT JOIN delivery_points dp ON dp.id=tp.delivery_point_id
      LEFT JOIN testing_points tpt ON tpt.id=tp.testing_point_id
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
      'SELECT * FROM trip_acknowledgements WHERE execution_id=$1 ORDER BY chamber',
      [req.params.id]
    );

    res.json({ ...exec.rows[0], bmcus: bmcus.rows, acknowledgements: acks.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/executions  — create execution from a published plan
router.post('/', authenticate, async (req, res) => {
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

    await client.query('COMMIT');
    res.status(201).json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// PUT /api/executions/:id  — save BMCU data, recalc totals
router.put('/:id', authenticate, async (req, res) => {
  const { dc_number, actual_km, delivery_point_id, bmcus } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const exec = await client.query(
      "SELECT * FROM trip_executions WHERE id=$1 AND status NOT IN ('closed')", [req.params.id]
    );
    if (!exec.rows.length) return res.status(404).json({ error: 'Execution not found or already closed' });

    if (bmcus?.length) {
      for (const bm of bmcus) {
        if (bm.is_deleted) {
          await client.query(
            'UPDATE trip_execution_bmcus SET is_deleted=TRUE WHERE id=$1', [bm.id]
          );
          continue;
        }
        const kgs    = calcKgs(bm.qty_litres);
        const kgFat  = calcKgFat(kgs, bm.fat_pct);
        const kgSnf  = calcKgSnf(kgs, bm.snf_pct);
        const dpsKgs = calcKgs(bm.dps_qty_litres);

        if (bm.id) {
          // Update existing row
          await client.query(
            `UPDATE trip_execution_bmcus SET
               milk_date=$1,shift=$2,qty_litres=$3,qty_kgs=$4,fat_pct=$5,snf_pct=$6,
               kg_fat=$7,kg_snf=$8,description=$9,source_bmcu_id=$10,chamber=$11,
               dps_qty_litres=$12,dps_qty_kgs=$13,rmrd_qty=$14,is_deleted=FALSE
             WHERE id=$15 AND execution_id=$16`,
            [bm.milk_date||null, bm.shift||null,
             bm.qty_litres||null, kgs||null, bm.fat_pct||null, bm.snf_pct||null,
             kgFat||null, kgSnf||null, bm.description||'RMRD',
             bm.source_bmcu_id||null, bm.chamber||null,
             bm.dps_qty_litres||0, dpsKgs||0, bm.rmrd_qty||0,
             bm.id, req.params.id]
          );
        } else {
          // Insert new row
          await client.query(
            `INSERT INTO trip_execution_bmcus
               (execution_id,seq_no,bmcu_id,milk_date,shift,qty_litres,qty_kgs,
                fat_pct,snf_pct,kg_fat,kg_snf,description,source_bmcu_id,chamber,
                dps_qty_litres,dps_qty_kgs,rmrd_qty)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [req.params.id, bm.seq_no, bm.bmcu_id, bm.milk_date||null, bm.shift||null,
             bm.qty_litres||null, kgs||null, bm.fat_pct||null, bm.snf_pct||null,
             kgFat||null, kgSnf||null, bm.description||'RMRD',
             bm.source_bmcu_id||null, bm.chamber||null,
             bm.dps_qty_litres||0, dpsKgs||0, bm.rmrd_qty||0]
          );
        }
      }
    }

    // Recalculate execution totals (exclude Balance Milk)
    const totals = await client.query(`
      SELECT
        COALESCE(SUM(qty_litres),0) AS total_litres,
        COALESCE(SUM(qty_kgs),0)    AS total_kgs,
        COALESCE(SUM(kg_fat),0)     AS total_kg_fat,
        COALESCE(SUM(kg_snf),0)     AS total_kg_snf
      FROM trip_execution_bmcus
      WHERE execution_id=$1 AND is_deleted=FALSE AND description != 'Balance Milk'`,
      [req.params.id]
    );
    const t = totals.rows[0];
    const avgFat = t.total_kgs > 0 ? (t.total_kg_fat / t.total_kgs) * 100 : 0;
    const avgSnf = t.total_kgs > 0 ? (t.total_kg_snf / t.total_kgs) * 100 : 0;

    if (delivery_point_id != null) {
      await client.query(
        'UPDATE trip_plans SET delivery_point_id=$1 WHERE id=$2',
        [delivery_point_id, exec.rows[0].trip_plan_id]
      );
    }

    const r = await client.query(
      `UPDATE trip_executions SET
         dc_number=$1, actual_km=$2,
         total_qty_litres=$3, total_qty_kgs=$4,
         avg_fat=$5, avg_snf=$6, total_kg_fat=$7, total_kg_snf=$8,
         status='saved', updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [dc_number||null, actual_km||null,
       t.total_litres, t.total_kgs,
       Math.round(avgFat * 10000) / 10000, Math.round(avgSnf * 10000) / 10000,
       t.total_kg_fat, t.total_kg_snf,
       req.params.id]
    );

    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// POST /api/executions/:id/submit-ack  — saved → pending_ack
router.post('/:id/submit-ack', authenticate, async (req, res) => {
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
router.post('/:id/acknowledgements', authenticate, async (req, res) => {
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
      const kgs    = calcKgs(ch.qty_litres);
      const kgFat  = calcKgFat(kgs, ch.fat_pct);
      const kgSnf  = calcKgSnf(kgs, ch.snf_pct);
      await client.query(
        `INSERT INTO trip_acknowledgements
           (execution_id,ack_date,chamber,qty_litres,qty_kgs,fat_pct,snf_pct,kg_fat,kg_snf,temperature,description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [req.params.id, ack_date||null, ch.chamber, ch.qty_litres||null,
         kgs||null, ch.fat_pct||null, ch.snf_pct||null, kgFat||null, kgSnf||null,
         ch.temperature||null, ch.description||null]
      );
    }

    const r = await client.query(
      "UPDATE trip_executions SET status='closed',updated_at=NOW() WHERE id=$1 RETURNING *",
      [req.params.id]
    );

    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

module.exports = router;
