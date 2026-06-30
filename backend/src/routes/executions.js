// backend/src/routes/executions.js
const express = require('express');
const router  = express.Router();
const { pool, query } = require('../config/db');
const { authenticate } = require('../middleware/auth');

const KG_FACTOR = 1.0285;

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
    await query(`CREATE INDEX IF NOT EXISTS tebe_exec_idx ON trip_execution_bmcu_entries (execution_id)`);
    await query(`CREATE INDEX IF NOT EXISTS tebe_bmcu_idx ON trip_execution_bmcu_entries (bmcu_id)`);
  } catch (err) {
    console.error('Migration error (trip_execution_bmcu_entries):', err.message);
  }
})();

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
        tpt.name AS testing_point_name, rm.route_name
      FROM trip_executions te
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
      'SELECT * FROM trip_acknowledgements WHERE execution_id=$1 ORDER BY chamber',
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
  const { actual_km, delivery_point_id, start_point_id, bmcus, shift_rows, entries } = req.body;
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
               dps_qty_litres=$12,dps_qty_kgs=$13,is_deleted=FALSE
             WHERE id=$14 AND execution_id=$15`,
            [bm.milk_date||null, bm.shift||null,
             bm.qty_litres||null, kgs||null, bm.fat_pct||null, bm.snf_pct||null,
             kgFat||null, kgSnf||null, bm.description||'RMRD',
             bm.source_bmcu_id||null, bm.chamber||null,
             bm.dps_qty_litres||0, dpsKgs||0,
             bm.id, req.params.id]
          );
        } else {
          // Insert new row
          await client.query(
            `INSERT INTO trip_execution_bmcus
               (execution_id,seq_no,bmcu_id,milk_date,shift,qty_litres,qty_kgs,
                fat_pct,snf_pct,kg_fat,kg_snf,description,source_bmcu_id,chamber,
                dps_qty_litres,dps_qty_kgs)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [req.params.id, bm.seq_no, bm.bmcu_id, bm.milk_date||null, bm.shift||null,
             bm.qty_litres||null, kgs||null, bm.fat_pct||null, bm.snf_pct||null,
             kgFat||null, kgSnf||null, bm.description||'RMRD',
             bm.source_bmcu_id||null, bm.chamber||null,
             bm.dps_qty_litres||0, dpsKgs||0]
          );
        }
      }
    }

    // Save shift rows
    if (shift_rows !== undefined) {
      await client.query(
        'DELETE FROM trip_execution_bmcu_shifts WHERE execution_id=$1', [req.params.id]
      );
      for (const sr of (shift_rows || [])) {
        await client.query(
          `INSERT INTO trip_execution_bmcu_shifts
             (execution_id, bmcu_seq_no, milk_date, shift, rmrd_qty, rmrd_fat_pct, rmrd_snf_pct)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [req.params.id, sr.bmcu_seq_no, sr.milk_date||null, sr.shift||null,
           sr.rmrd_qty||null, sr.rmrd_fat_pct||null, sr.rmrd_snf_pct||null]
        );
      }
    }

    // Save sub-entries (balance milk / new MPP / internal shifting)
    if (entries !== undefined) {
      // Map seq_no → bmcu_id from the submitted BMCU rows so each entry is tied
      // to its BMCU line item (durable across reorders, used for reports later).
      const seqToBmcu = {};
      for (const bm of (bmcus || [])) {
        if (bm.bmcu_id && bm.seq_no != null) seqToBmcu[bm.seq_no] = bm.bmcu_id;
      }
      await client.query(
        'DELETE FROM trip_execution_bmcu_entries WHERE execution_id=$1', [req.params.id]
      );
      for (const e of (entries || [])) {
        const bmcuId = seqToBmcu[e.bmcu_seq_no] || e.bmcu_id || null;
        await client.query(
          `INSERT INTO trip_execution_bmcu_entries
             (execution_id, bmcu_seq_no, bmcu_id, kind, category, source_bmcu_id, qty_litres, fat_pct, snf_pct)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [req.params.id, e.bmcu_seq_no, bmcuId, e.kind, e.category||null,
           e.source_bmcu_id||null, e.qty_litres||null, e.fat_pct||null, e.snf_pct||null]
        );
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
        [delivery_point_id || null, exec.rows[0].trip_plan_id]
      );
    }
    if (start_point_id != null) {
      await client.query(
        'UPDATE trip_plans SET start_point_id=$1 WHERE id=$2',
        [start_point_id || null, exec.rows[0].trip_plan_id]
      );
    }

    const r = await client.query(
      `UPDATE trip_executions SET
         actual_km=$1,
         total_qty_litres=$2, total_qty_kgs=$3,
         avg_fat=$4, avg_snf=$5, total_kg_fat=$6, total_kg_snf=$7,
         status='saved', updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [actual_km||null,
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

// POST /api/executions/:id/cancel  — admin only, any status except closed
router.post('/:id/cancel', authenticate, async (req, res) => {
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
