const router = require('express').Router();
const { query, pool } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const KG_FACTOR = 1.0285;

function calcKgs(litres) { return litres ? parseFloat((parseFloat(litres) * KG_FACTOR).toFixed(4)) : 0; }
function calcKgFat(fat, kgs) { return (fat && kgs) ? parseFloat((parseFloat(fat) * parseFloat(kgs) / 100).toFixed(4)) : 0; }
function calcKgSnf(snf, kgs) { return (snf && kgs) ? parseFloat((parseFloat(snf) * parseFloat(kgs) / 100).toFixed(4)) : 0; }

// List executions
router.get('/', authenticate, async (req, res) => {
  const { status, execution_date, from_date, to_date, tanker_id } = req.query;
  let sql = `
    SELECT te.*,
      tp.plan_for_date, tp.trip_no, tp.driver_name, tp.loader_name,
      t.tanker_number, t.capacity_litres, t.compartments,
      rm.route_name,
      sp.name AS start_point_name,
      dp.name AS delivery_point_name
    FROM trip_executions te
    JOIN trip_plans tp ON te.trip_plan_id=tp.id
    LEFT JOIN tankers t ON tp.tanker_id=t.id
    LEFT JOIN route_masters rm ON tp.route_id=rm.id
    LEFT JOIN starting_points sp ON tp.start_point_id=sp.id
    LEFT JOIN delivery_points dp ON tp.delivery_point_id=dp.id
    WHERE 1=1`;
  const params = [];
  if (status) { params.push(status); sql += ` AND te.status=$${params.length}`; }
  if (execution_date) { params.push(execution_date); sql += ` AND te.execution_date=$${params.length}`; }
  if (from_date) { params.push(from_date); sql += ` AND te.execution_date>=$${params.length}`; }
  if (to_date) { params.push(to_date); sql += ` AND te.execution_date<=$${params.length}`; }
  if (tanker_id) { params.push(tanker_id); sql += ` AND tp.tanker_id=$${params.length}`; }
  sql += ' ORDER BY te.execution_date DESC, tp.trip_no';
  const r = await query(sql, params);
  res.json(r.rows);
});

// Get execution detail
router.get('/:id', authenticate, async (req, res) => {
  const exec = await query(`
    SELECT te.*,
      tp.plan_for_date,tp.trip_no,tp.driver_name,tp.loader_name,tp.remarks,tp.shifts_milk,tp.expected_km,
      t.tanker_number,t.capacity_litres,t.compartments,t.per_km_rate,
      rm.route_name,sp.name AS start_point_name,tsp.name AS testing_point_name,dp.name AS delivery_point_name
    FROM trip_executions te
    JOIN trip_plans tp ON te.trip_plan_id=tp.id
    LEFT JOIN tankers t ON tp.tanker_id=t.id
    LEFT JOIN route_masters rm ON tp.route_id=rm.id
    LEFT JOIN starting_points sp ON tp.start_point_id=sp.id
    LEFT JOIN testing_points tsp ON tp.testing_point_id=tsp.id
    LEFT JOIN delivery_points dp ON tp.delivery_point_id=dp.id
    WHERE te.id=$1`,[req.params.id]);
  if (!exec.rows[0]) return res.status(404).json({ error: 'Not found' });

  const bmcus = await query(`
    SELECT teb.*,b.bmcu_code,b.bmcu_name,
      sb.bmcu_code AS source_bmcu_code, sb.bmcu_name AS source_bmcu_name
    FROM trip_execution_bmcus teb
    JOIN bmcus b ON teb.bmcu_id=b.id
    LEFT JOIN bmcus sb ON teb.source_bmcu_id=sb.id
    WHERE teb.execution_id=$1 AND teb.is_deleted=FALSE
    ORDER BY teb.seq_no`,[req.params.id]);

  const acks = await query(`
    SELECT * FROM trip_acknowledgements WHERE execution_id=$1 ORDER BY chamber`,[req.params.id]);

  res.json({ ...exec.rows[0], bmcu_rows: bmcus.rows, acknowledgements: acks.rows });
});

// Create execution from plan
router.post('/', authenticate, async (req, res) => {
  const { trip_plan_id, execution_date, dc_number } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Check not already created
    const existing = await client.query('SELECT id FROM trip_executions WHERE trip_plan_id=$1',[trip_plan_id]);
    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Execution already exists for this plan' });
    }
    const execR = await client.query(
      'INSERT INTO trip_executions(trip_plan_id,execution_date,dc_number,executed_by) VALUES($1,$2,$3,$4) RETURNING *',
      [trip_plan_id, execution_date, dc_number, req.user.id]);
    const execId = execR.rows[0].id;

    // Copy planned BMCUs as starting rows
    const planBmcus = await client.query(
      'SELECT * FROM trip_plan_bmcus WHERE trip_plan_id=$1 ORDER BY seq_no',[trip_plan_id]);
    for (const pb of planBmcus.rows) {
      await client.query(
        'INSERT INTO trip_execution_bmcus(execution_id,seq_no,bmcu_id,description) VALUES($1,$2,$3,$4)',
        [execId, pb.seq_no, pb.bmcu_id, 'RMRD']);
    }
    await client.query('COMMIT');
    res.status(201).json(execR.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally { client.release(); }
});

// Save execution data (BMCU rows)
router.put('/:id', authenticate, async (req, res) => {
  const { dc_number, actual_km, bmcu_rows } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Calculate totals from non-deleted rows
    let totalLitres = 0, totalKgs = 0, totalKgFat = 0, totalKgSnf = 0;
    const validRows = (bmcu_rows || []).filter(r => !r.is_deleted && r.description !== 'Balance Milk');

    for (const row of validRows) {
      const kgs = row.qty_kgs || calcKgs(row.qty_litres);
      const kgFat = row.kg_fat || calcKgFat(row.fat_pct, kgs);
      const kgSnf = row.kg_snf || calcKgSnf(row.snf_pct, kgs);
      totalLitres += parseFloat(row.qty_litres || 0);
      totalKgs += parseFloat(kgs || 0);
      totalKgFat += parseFloat(kgFat || 0);
      totalKgSnf += parseFloat(kgSnf || 0);
    }
    const avgFat = totalKgs > 0 ? (totalKgFat / totalKgs * 100) : 0;
    const avgSnf = totalKgs > 0 ? (totalKgSnf / totalKgs * 100) : 0;

    await client.query(`
      UPDATE trip_executions SET dc_number=$1,actual_km=$2,total_qty_litres=$3,total_qty_kgs=$4,
        avg_fat=$5,avg_snf=$6,total_kg_fat=$7,total_kg_snf=$8,status='saved',updated_at=NOW()
      WHERE id=$9`,
      [dc_number, actual_km, totalLitres, totalKgs, avgFat, avgSnf, totalKgFat, totalKgSnf, req.params.id]);

    // Update/insert BMCU rows
    for (const row of (bmcu_rows || [])) {
      const kgs = calcKgs(row.qty_litres);
      const kgFat = calcKgFat(row.fat_pct, kgs);
      const kgSnf = calcKgSnf(row.snf_pct, kgs);
      const dpsKgs = calcKgs(row.dps_qty_litres);

      if (row.id) {
        await client.query(`
          UPDATE trip_execution_bmcus SET seq_no=$1,bmcu_id=$2,milk_date=$3,shift=$4,qty_litres=$5,qty_kgs=$6,
            fat_pct=$7,snf_pct=$8,kg_fat=$9,kg_snf=$10,description=$11,source_bmcu_id=$12,chamber=$13,
            dps_qty_litres=$14,dps_qty_kgs=$15,rmrd_qty=$16,is_deleted=$17
          WHERE id=$18`,
          [row.seq_no,row.bmcu_id,row.milk_date,row.shift,row.qty_litres,kgs,row.fat_pct,row.snf_pct,
           kgFat,kgSnf,row.description,row.source_bmcu_id||null,row.chamber,
           row.dps_qty_litres||0, dpsKgs, row.rmrd_qty||0, row.is_deleted||false, row.id]);
      } else {
        await client.query(`
          INSERT INTO trip_execution_bmcus(execution_id,seq_no,bmcu_id,milk_date,shift,qty_litres,qty_kgs,
            fat_pct,snf_pct,kg_fat,kg_snf,description,source_bmcu_id,chamber,dps_qty_litres,dps_qty_kgs,rmrd_qty)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [req.params.id,row.seq_no,row.bmcu_id,row.milk_date,row.shift,row.qty_litres,kgs,row.fat_pct,row.snf_pct,
           kgFat,kgSnf,row.description,row.source_bmcu_id||null,row.chamber,
           row.dps_qty_litres||0,dpsKgs,row.rmrd_qty||0]);
      }
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally { client.release(); }
});

// Submit for acknowledgement
router.post('/:id/submit-ack', authenticate, async (req, res) => {
  const exec = await query('SELECT status FROM trip_executions WHERE id=$1',[req.params.id]);
  if (!exec.rows[0]) return res.status(404).json({ error: 'Not found' });
  if (!['saved','in_progress'].includes(exec.rows[0].status))
    return res.status(400).json({ error: 'Execution must be saved before submitting for acknowledgement' });
  await query('UPDATE trip_executions SET status=$1,updated_at=NOW() WHERE id=$2',['pending_ack',req.params.id]);
  res.json({ success: true });
});

// Save acknowledgements
router.post('/:id/acknowledgements', authenticate, async (req, res) => {
  const { ack_date, acknowledgements } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM trip_acknowledgements WHERE execution_id=$1',[req.params.id]);
    let totalLitres=0, totalKgs=0, totalKgFat=0, totalKgSnf=0;
    for (const ack of (acknowledgements || [])) {
      const kgs = calcKgs(ack.qty_litres);
      const kgFat = calcKgFat(ack.fat_pct, kgs);
      const kgSnf = calcKgSnf(ack.snf_pct, kgs);
      await client.query(`
        INSERT INTO trip_acknowledgements(execution_id,ack_date,chamber,qty_litres,qty_kgs,fat_pct,snf_pct,kg_fat,kg_snf,temperature,description)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [req.params.id, ack_date, ack.chamber, ack.qty_litres, kgs, ack.fat_pct, ack.snf_pct, kgFat, kgSnf, ack.temperature, ack.description]);
      totalLitres += parseFloat(ack.qty_litres || 0);
      totalKgs += parseFloat(kgs || 0);
      totalKgFat += parseFloat(kgFat || 0);
      totalKgSnf += parseFloat(kgSnf || 0);
    }
    await client.query(
      'UPDATE trip_executions SET status=$1,updated_at=NOW() WHERE id=$2',
      ['closed', req.params.id]);
    await client.query('COMMIT');
    res.json({ success: true, totals: { totalLitres, totalKgs, totalKgFat, totalKgSnf } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally { client.release(); }
});

module.exports = router;
