// Restore the biller's keyed values (state, transport type, billed km, remarks)
// into an existing draft billing run from a CSV, re-deriving rate and amount
// exactly as the trip editor does. Used after run #14's trips were dropped by
// Submit (missing toll challans, 2026-09-21) and the run was re-executed.
//
//   docker exec -i shreeja-backend node scripts/restore_run_keyed.js <run_id> < keyed.csv
//
// CSV header: plan_for_date,tanker_number,state,transport_type,billed_km,remarks
// Rows are matched on (plan_for_date, tanker_number); when a tanker has two
// trips on one date they are matched in CSV order by ascending execution id.
// Only draft / rejected / pending_vendor runs are touched; excluded rows and
// sale tankers are skipped. Prints a summary and the run total at the end.
const { pool, query } = require('../src/config/db');

const rN = (v, d = 2) => v == null || v === '' ? null : Math.round(parseFloat(v) * 10 ** d) / 10 ** d;
const STATES = ['Andhra Pradesh', 'Karnataka', 'Tamil Nadu', 'Telangana'];

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const head = lines.shift().split(',').map(s => s.trim());
  return lines.map(l => {
    const cells = []; let cur = '', q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] || '').trim()]));
  });
}

async function findRate(state, transportType, capacityLitres, planDate) {
  if (!state || !transportType || !capacityLitres || !planDate) return null;
  const r = await query(`
    SELECT id, rate_per_km FROM tanker_rates
    WHERE state = $1 AND transport_type = $2
      AND ABS(capacity_kl - $3::numeric / 1000.0) < 0.051
      AND $4::date BETWEEN effective_from AND effective_to
    ORDER BY ABS(capacity_kl - $3::numeric / 1000.0) LIMIT 1`, [state, transportType, capacityLitres, planDate]);
  return r.rows[0] || null;
}

(async () => {
  const runId = parseInt(process.argv[2], 10);
  if (!runId) { console.error('usage: node scripts/restore_run_keyed.js <run_id> < keyed.csv'); process.exit(2); }
  const csv = require('fs').readFileSync(0, 'utf8');
  const rows = parseCsv(csv);
  const run = (await query('SELECT id, status FROM billing_runs WHERE id=$1', [runId])).rows[0];
  if (!run) { console.error(`run ${runId} not found`); process.exit(1); }
  if (!['draft', 'rejected', 'pending_vendor'].includes(run.status)) { console.error(`run ${runId} is ${run.status} — refusing`); process.exit(1); }

  const trips = (await query(`
    SELECT id, execution_id, plan_for_date::text AS plan_for_date, tanker_number, capacity_litres, excluded, is_sale_tanker
    FROM billing_run_trips WHERE run_id=$1 ORDER BY execution_id`, [runId])).rows;
  const byKey = new Map();
  for (const t of trips) {
    const k = `${t.plan_for_date}|${t.tanker_number.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  let updated = 0, unmatched = [], noRate = [], skipped = 0;
  for (const r of rows) {
    const k = `${r.plan_for_date}|${(r.tanker_number || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`;
    const cands = byKey.get(k) || [];
    const t = cands.shift();
    if (!t) { unmatched.push(`${r.plan_for_date} ${r.tanker_number}`); continue; }
    if (t.excluded || t.is_sale_tanker) { skipped++; continue; }
    const state = r.state && STATES.includes(r.state) ? r.state : null;
    const transportType = ['BMCU/CC to Dairy/CC', 'Point to Point'].includes(r.transport_type) ? r.transport_type : null;
    const billedKm = rN(r.billed_km);
    const rate = await findRate(state, transportType, t.capacity_litres, t.plan_for_date);
    const ratePerKm = rate ? rate.rate_per_km : null;
    const amount = billedKm != null && ratePerKm != null ? rN(billedKm * parseFloat(ratePerKm)) : null;
    if (state && !rate) noRate.push(`${r.plan_for_date} ${r.tanker_number} (${state}, ${transportType})`);
    await query(`
      UPDATE billing_run_trips
         SET state=COALESCE($1, state), transport_type=COALESCE($2, transport_type),
             billed_km=COALESCE($3, billed_km), remarks=COALESCE(NULLIF($4,''), remarks),
             rate_id=$5, rate_per_km=$6, amount=$7, updated_at=NOW()
       WHERE id=$8`,
      [state, transportType, billedKm, r.remarks || '', rate ? rate.id : null, ratePerKm, amount, t.id]);
    updated++;
  }
  await query(`UPDATE billing_runs SET total_amount =
      COALESCE((SELECT SUM(amount) FROM billing_run_trips WHERE run_id=$1 AND excluded=FALSE), 0)
    + COALESCE((SELECT SUM(amount) FROM billing_run_tolls WHERE run_id=$1), 0), updated_at=NOW() WHERE id=$1`, [runId]);
  const tot = (await query('SELECT total_amount FROM billing_runs WHERE id=$1', [runId])).rows[0].total_amount;
  const left = (await query(`SELECT COUNT(*)::int AS n FROM billing_run_trips WHERE run_id=$1 AND excluded=FALSE AND NOT is_sale_tanker AND (state IS NULL OR rate_per_km IS NULL OR billed_km IS NULL)`, [runId])).rows[0].n;
  console.log(`run ${runId}: csv rows ${rows.length}, updated ${updated}, skipped (excluded/sale) ${skipped}, unmatched ${unmatched.length}, no rate ${noRate.length}`);
  if (unmatched.length) console.log('UNMATCHED:\n  ' + unmatched.join('\n  '));
  if (noRate.length) console.log('NO RATE FOUND:\n  ' + noRate.join('\n  '));
  console.log(`vendor trips still missing state/rate/km: ${left}`);
  console.log(`run total now: ₹ ${Number(tot).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
