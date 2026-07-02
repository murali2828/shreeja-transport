// backend/scripts/compare-plan-report.js
// =============================================================================
// Manual-plan vs Optimized-plan comparison report (READ-ONLY — SELECTs only).
//
// Takes the trip plans of a given date, re-optimizes the SAME BMCUs and
// quantities with the Clarke-Wright optimizer (coordinate-aware distances),
// and writes a detailed Excel comparison + prints a summary to stdout.
//
// Both sides are measured with ONE distance model (Distance Master → Haversine
// × road factor → district constants) and ONE cost model (effective tanker
// rate = rate_per_km_bmcu → per_km_rate), so the comparison is apples-to-apples.
//
// Usage (inside the backend container):
//   node scripts/compare-plan-report.js --date 2026-07-01 [--out /app/reports/plan-comparison-2026-07-01.xlsx] [--strategy distance_savings]
//
// Server runbook (QA):
//   docker exec shreeja-qa-backend node scripts/compare-plan-report.js --date 2026-07-01
//   docker cp shreeja-qa-backend:/app/reports/plan-comparison-2026-07-01.xlsx .
// =============================================================================

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { pool } = require('../src/config/db');
const {
  buildDistanceMap, makeResolver, nodeKey,
  nearestNeighbourOrder, computeRouteKm, clarkeWrightSavings,
  effectiveRate,
} = require('../src/services/optimizerCore');

// ─── args ─────────────────────────────────────────────────────────────────────
function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const DATE     = arg('date');
const STRATEGY = arg('strategy', 'distance_savings');
if (!DATE || !/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error('Usage: node scripts/compare-plan-report.js --date YYYY-MM-DD [--out file.xlsx]');
  process.exit(1);
}
const OUT = arg('out', path.join(__dirname, '../reports', `plan-comparison-${DATE}.xlsx`));

const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const r4 = v => Math.round(v * 10000) / 10000;
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

// Fleet-FEASIBLE assignment: each tanker is used at most once while the pool
// lasts, and any route too big for the remaining tankers is SPLIT (along its
// nearest-neighbour order, so splits stay geographically contiguous) until
// every trip fits the tanker actually assigned to it. Overflow can only remain
// if a single BMCU's quantity exceeds every tanker in the fleet.
function assignTankersFleetFeasible(rawRoutes, tankers, resolve, depot) {
  const pool_ = [...tankers].sort((a, b) => a.capacity_litres - b.capacity_litres);
  const used  = new Set();
  const loadOf = r => r.reduce((s, b) => s + b.expected_qty_litres, 0);

  // Work queue, always taking the heaviest pending route first.
  const queue = rawRoutes.map(r => [...r]);
  const out = [];

  while (queue.length) {
    queue.sort((a, b) => loadOf(b) - loadOf(a));
    const route = queue.shift();
    const load  = loadOf(route);

    // Smallest unused tanker that fits the whole route.
    let pick = pool_.find(t => !used.has(t.id) && t.capacity_litres >= load);
    if (pick) {
      used.add(pick.id);
      out.push({ route, load, tanker: pick, reused: false, overflow: false });
      continue;
    }

    const unused = pool_.filter(t => !used.has(t.id));
    if (unused.length) {
      // Split: fill the largest unused tanker along the route's NN order,
      // push the remainder back for assignment to another tanker.
      const big = unused[unused.length - 1];
      const ordered = nearestNeighbourOrder(depot, route, resolve);
      const prefix = [];
      let cum = 0;
      for (const bm of ordered) {
        if (prefix.length > 0 && cum + bm.expected_qty_litres > big.capacity_litres) break;
        prefix.push(bm);
        cum += bm.expected_qty_litres;
      }
      const rest = ordered.slice(prefix.length);
      used.add(big.id);
      out.push({
        route: prefix, load: cum, tanker: big,
        reused: false, overflow: cum > big.capacity_litres, // single-BMCU > capacity only
      });
      if (rest.length) queue.push(rest);
      continue;
    }

    // Pool exhausted → reuse best-fit (flagged).
    pick = pool_.find(t => t.capacity_litres >= load) || pool_[pool_.length - 1];
    out.push({ route, load, tanker: pick, reused: true, overflow: pick.capacity_litres < load });
  }
  return out;
}

async function main() {
  const client = await pool.connect();
  try {
    // ── 1. Manual plans of the date ──────────────────────────────────────────
    const plansRes = await client.query(`
      SELECT tp.id, tp.trip_no, tp.tanker_id, tp.start_point_id, tp.delivery_point_id,
             tp.shifts_milk, tp.expected_km, tp.expected_utilization_pct,
             tp.expected_total_qty, tp.total_cost, tp.per_liter_cost, tp.status,
             t.tanker_number, t.capacity_litres, t.per_km_rate, t.rate_per_km_bmcu,
             dp.name AS delivery_point_name
      FROM trip_plans tp
      LEFT JOIN tankers t          ON t.id = tp.tanker_id
      LEFT JOIN delivery_points dp ON dp.id = tp.delivery_point_id
      WHERE tp.plan_for_date = $1 AND tp.status NOT IN ('cancelled','deleted')
      ORDER BY tp.trip_no`, [DATE]);
    const plans = plansRes.rows;
    if (!plans.length) {
      console.error(`No trip plans found for ${DATE} (excluding cancelled/deleted).`);
      process.exit(2);
    }

    const planBmcusRes = await client.query(`
      SELECT tpb.trip_plan_id, tpb.seq_no, tpb.bmcu_id, tpb.expected_qty, tpb.shift_code,
             b.bmcu_code, b.bmcu_name, b.district, b.state, b.latitude, b.longitude
      FROM trip_plan_bmcus tpb
      JOIN trip_plans tp ON tp.id = tpb.trip_plan_id
      JOIN bmcus b       ON b.id = tpb.bmcu_id
      WHERE tp.plan_for_date = $1 AND tp.status NOT IN ('cancelled','deleted')
      ORDER BY tpb.trip_plan_id, tpb.seq_no`, [DATE]);
    const planBmcus = planBmcusRes.rows;
    const bmcusByPlan = {};
    for (const row of planBmcus) (bmcusByPlan[row.trip_plan_id] ||= []).push(row);

    // ── 2. Depot & nodes ─────────────────────────────────────────────────────
    // Depot for the optimized run = dominant delivery point of the day's plans.
    const dpCount = {};
    plans.forEach(p => { if (p.delivery_point_id) dpCount[p.delivery_point_id] = (dpCount[p.delivery_point_id] || 0) + 1; });
    const depotId = parseInt(Object.entries(dpCount).sort((a, b) => b[1] - a[1])[0][0]);
    const dpRes = await client.query('SELECT id, name, latitude, longitude FROM delivery_points WHERE id = ANY($1)',
      [Object.keys(dpCount).map(Number)]);
    const dpById = Object.fromEntries(dpRes.rows.map(d => [d.id, d]));
    const depot = { type: 'delivery_point', id: depotId, name: dpById[depotId]?.name };

    const tankersRes = await client.query(
      `SELECT id, tanker_number, capacity_litres, per_km_rate, rate_per_km_bmcu
       FROM tankers WHERE is_active = TRUE ORDER BY capacity_litres DESC`);
    const tankers = tankersRes.rows;

    // Aggregate optimizer input: same BMCUs, same quantities (summed per BMCU).
    const inputByBmcu = {};
    for (const row of planBmcus) {
      if (!inputByBmcu[row.bmcu_id]) {
        inputByBmcu[row.bmcu_id] = { ...row, bmcu_id: row.bmcu_id, expected_qty_litres: 0 };
      }
      inputByBmcu[row.bmcu_id].expected_qty_litres += num(row.expected_qty);
    }
    const items = Object.values(inputByBmcu);
    const totalQty = items.reduce((s, b) => s + b.expected_qty_litres, 0);

    // Distance resolver over every node we may touch.
    const allNodes = [
      ...dpRes.rows.map(d => ({ type: 'delivery_point', id: d.id })),
      ...items.map(b => ({ type: 'bmcu', id: b.bmcu_id })),
    ];
    const distMap = await buildDistanceMap(client, allNodes);
    const nodeMap = {};
    dpRes.rows.forEach(d => { nodeMap[nodeKey('delivery_point', d.id)] = d; });
    items.forEach(b => { nodeMap[nodeKey('bmcu', b.bmcu_id)] = b; });
    const resolve = makeResolver(distMap, nodeMap);

    const legCounter = () => ({ master: 0, geo: 0, fallback: 0 });
    const countLegs = (counter, legs, returnLeg) => {
      for (const l of legs) counter[l.leg_source] = (counter[l.leg_source] || 0) + 1;
      counter[returnLeg.leg_source] = (counter[returnLeg.leg_source] || 0) + 1;
    };

    // ── 3. Re-model the MANUAL plans with the same distance/cost model ──────
    const manualLegSources = legCounter();
    const manualTrips = plans.map(p => {
      const rows = bmcusByPlan[p.id] || [];
      const seq  = rows.map(r => ({ bmcu_id: r.bmcu_id, expected_qty_litres: num(r.expected_qty) }));
      const ownDepot = { type: 'delivery_point', id: p.delivery_point_id || depotId };
      let modelKm = 0;
      if (seq.length) {
        const { totalKm, legs, returnLeg } = computeRouteKm(ownDepot, seq, resolve);
        modelKm = totalKm;
        countLegs(manualLegSources, legs, returnLeg);
      }
      const qty  = num(p.expected_total_qty) || seq.reduce((s, b) => s + b.expected_qty_litres, 0);
      const rate = effectiveRate(p);
      const cap  = num(p.capacity_litres);
      return {
        trip_no: p.trip_no, tanker_number: p.tanker_number, capacity: cap,
        qty, util: cap > 0 ? qty / cap * 100 : 0,
        stored_km: num(p.expected_km), model_km: modelKm,
        rate, model_cost: modelKm * rate, stored_cost: num(p.total_cost),
        bmcu_count: seq.length,
        bmcus: rows,
        delivery_point: dpById[p.delivery_point_id]?.name || p.delivery_point_name || '',
      };
    });

    // ── 4. Optimize the same input ───────────────────────────────────────────
    const maxCapacity = tankers[0].capacity_litres;
    let rawRoutes;
    if (STRATEGY === 'district') {
      const groups = {};
      for (const it of items) (groups[it.district || it.state || 'other'] ||= []).push(it);
      rawRoutes = Object.values(groups).flatMap(g => clarkeWrightSavings(depot, g, resolve, maxCapacity));
    } else {
      rawRoutes = clarkeWrightSavings(depot, items, resolve, maxCapacity);
    }
    const assignments = assignTankersFleetFeasible(rawRoutes, tankers, resolve, depot);

    const optLegSources = legCounter();
    const optTrips = assignments.map((asgn, i) => {
      const ordered = nearestNeighbourOrder(depot, asgn.route, resolve);
      const { totalKm, legs, returnLeg } = computeRouteKm(depot, ordered, resolve);
      countLegs(optLegSources, legs, returnLeg);
      const rate = effectiveRate(asgn.tanker);
      return {
        trip_no: i + 1, tanker_number: asgn.tanker.tanker_number,
        capacity: num(asgn.tanker.capacity_litres),
        qty: asgn.load, util: asgn.tanker.capacity_litres > 0 ? asgn.load / asgn.tanker.capacity_litres * 100 : 0,
        model_km: totalKm, rate, model_cost: totalKm * rate,
        bmcu_count: ordered.length,
        ordered, legs, returnLeg,
        reused: asgn.reused, overflow: asgn.overflow,
      };
    });

    // ── 5. Coverage assertion ────────────────────────────────────────────────
    const inputIds  = new Set(items.map(b => b.bmcu_id));
    const outputIds = new Set(optTrips.flatMap(t => t.ordered.map(b => b.bmcu_id)));
    const dropped   = [...inputIds].filter(id => !outputIds.has(id));
    const duplicated = optTrips.flatMap(t => t.ordered.map(b => b.bmcu_id))
      .filter((id, i, arr) => arr.indexOf(id) !== i);
    if (dropped.length || duplicated.length) {
      console.error(`COVERAGE FAILURE — dropped: [${dropped}], duplicated: [${duplicated}]`);
      process.exit(3);
    }

    // ── 6. Totals ────────────────────────────────────────────────────────────
    const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
    const side = trips => ({
      trips: trips.length,
      qty: sum(trips, t => t.qty),
      km: sum(trips, t => t.model_km),
      cost: sum(trips, t => t.model_cost),
      cap: sum(trips, t => t.capacity),
    });
    const M = side(manualTrips);
    const O = side(optTrips);
    M.util = M.cap > 0 ? M.qty / M.cap * 100 : 0;            // weighted (capacity-based)
    O.util = O.cap > 0 ? O.qty / O.cap * 100 : 0;
    M.rpl  = M.qty > 0 ? M.cost / M.qty : 0;
    O.rpl  = O.qty > 0 ? O.cost / O.qty : 0;
    M.stored_km   = sum(manualTrips, t => t.stored_km);
    M.stored_cost = sum(manualTrips, t => t.stored_cost);

    // ── 7. Data quality ──────────────────────────────────────────────────────
    const noCoordBmcus = items.filter(b => !(num(b.latitude) && num(b.longitude)));
    const noRateTankers = tankers.filter(t => effectiveRate(t) === 0);
    const reusedCount   = optTrips.filter(t => t.reused).length;
    const overflowCount = optTrips.filter(t => t.overflow).length;

    // Manual assignment map for the changes sheet
    const manualTripOfBmcu = {};
    manualTrips.forEach(t => t.bmcus.forEach(b => { manualTripOfBmcu[b.bmcu_id] = t.trip_no; }));
    const optTripOfBmcu = {};
    optTrips.forEach(t => t.ordered.forEach(b => { optTripOfBmcu[b.bmcu_id] = t.trip_no; }));

    // ── 8. Excel ─────────────────────────────────────────────────────────────
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const wb = new ExcelJS.Workbook();
    const bold = { font: { bold: true } };

    const ws = wb.addWorksheet('Summary');
    ws.columns = [{ width: 34 }, { width: 18 }, { width: 18 }, { width: 20 }];
    ws.addRow([`Plan Comparison — ${DATE}`]).font = { bold: true, size: 14 };
    ws.addRow([`Depot (delivery point): ${depot.name || depotId} · Strategy: ${STRATEGY} · Distance model: DistanceMaster → Haversine×road-factor → district constants`]);
    ws.addRow([]);
    const hdr = ws.addRow(['Metric', 'Manual plan', 'Optimized plan', 'Delta (Opt − Manual)']);
    hdr.eachCell(c => (c.font = { bold: true }));
    const rows = [
      ['Trips',                       M.trips,            O.trips,            O.trips - M.trips],
      ['Total quantity (L)',          r2(M.qty),          r2(O.qty),          r2(O.qty - M.qty)],
      ['BMCUs covered',               inputIds.size,      outputIds.size,     0],
      ['Total KM (same model)',       r1(M.km),           r1(O.km),           r1(O.km - M.km)],
      ['Total KM (as stored in plan)', r1(M.stored_km),   '—',                '—'],
      ['Weighted utilization %',      r1(M.util),         r1(O.util),         r1(O.util - M.util)],
      ['Total cost ₹ (effective rates)', r2(M.cost),      r2(O.cost),         r2(O.cost - M.cost)],
      ['Cost ₹/L',                    r4(M.rpl),          r4(O.rpl),          r4(O.rpl - M.rpl)],
      ['Total cost ₹ (as stored)',    r2(M.stored_cost),  '—',                '—'],
      ['KM saved %',                  '', '', M.km > 0 ? r1((M.km - O.km) / M.km * 100) + '%' : '—'],
      ['Cost saved %',                '', '', M.cost > 0 ? r1((M.cost - O.cost) / M.cost * 100) + '%' : '—'],
    ];
    rows.forEach(r => ws.addRow(r));

    const mws = wb.addWorksheet('Manual Trips');
    mws.columns = [
      { header: 'Trip', width: 6 }, { header: 'Tanker', width: 14 }, { header: 'Capacity L', width: 11 },
      { header: 'Qty L', width: 10 }, { header: 'Util %', width: 8 }, { header: 'BMCUs', width: 7 },
      { header: 'KM (stored)', width: 11 }, { header: 'KM (model)', width: 11 },
      { header: 'Rate ₹/km', width: 10 }, { header: 'Cost ₹ (model)', width: 13 },
      { header: 'Cost ₹ (stored)', width: 13 }, { header: 'Delivery point', width: 20 },
      { header: 'BMCU sequence', width: 70 },
    ];
    mws.getRow(1).font = bold.font;
    manualTrips.forEach(t => mws.addRow([
      t.trip_no, t.tanker_number, t.capacity, r2(t.qty), r1(t.util), t.bmcu_count,
      r1(t.stored_km), r1(t.model_km), r2(t.rate), r2(t.model_cost), r2(t.stored_cost),
      t.delivery_point, t.bmcus.map(b => b.bmcu_code).join(' → '),
    ]));

    const ows = wb.addWorksheet('Optimized Trips');
    ows.columns = [
      { header: 'Trip', width: 6 }, { header: 'Tanker', width: 14 }, { header: 'Capacity L', width: 11 },
      { header: 'Qty L', width: 10 }, { header: 'Util %', width: 8 }, { header: 'BMCUs', width: 7 },
      { header: 'KM (model)', width: 11 }, { header: 'Rate ₹/km', width: 10 }, { header: 'Cost ₹', width: 12 },
      { header: 'Flags', width: 16 }, { header: 'BMCU sequence (leg km · source)', width: 90 },
    ];
    ows.getRow(1).font = bold.font;
    optTrips.forEach(t => ows.addRow([
      t.trip_no, t.tanker_number, t.capacity, r2(t.qty), r1(t.util), t.bmcu_count,
      r1(t.model_km), r2(t.rate), r2(t.model_cost),
      [t.reused ? 'tanker reused' : '', t.overflow ? 'OVERFLOW' : ''].filter(Boolean).join(', '),
      t.ordered.map((b, i) => {
        const nm = nodeMap[nodeKey('bmcu', b.bmcu_id)] || {};
        const leg = t.legs[i] || {};
        return `${nm.bmcu_code}(${r1(leg.leg_km)}km·${leg.leg_source})`;
      }).join(' → ') + ` → depot(${r1(t.returnLeg.leg_km)}km·${t.returnLeg.leg_source})`,
    ]));

    const cws = wb.addWorksheet('BMCU Assignment Changes');
    cws.columns = [
      { header: 'BMCU code', width: 12 }, { header: 'BMCU name', width: 30 }, { header: 'District', width: 16 },
      { header: 'Qty L', width: 10 }, { header: 'Manual trip', width: 11 }, { header: 'Optimized trip', width: 13 },
      { header: 'Changed', width: 9 },
    ];
    cws.getRow(1).font = bold.font;
    items
      .sort((a, b) => (a.bmcu_code || '').localeCompare(b.bmcu_code || ''))
      .forEach(b => cws.addRow([
        b.bmcu_code, b.bmcu_name, b.district || '', r2(b.expected_qty_litres),
        manualTripOfBmcu[b.bmcu_id] ?? '—', optTripOfBmcu[b.bmcu_id] ?? '—',
        manualTripOfBmcu[b.bmcu_id] !== optTripOfBmcu[b.bmcu_id] ? 'YES' : '',
      ]));

    const dws = wb.addWorksheet('Data Quality');
    dws.columns = [{ width: 44 }, { width: 22 }, { width: 60 }];
    dws.addRow(['Check', 'Value', 'Detail']).font = bold.font;
    const legPct = (c) => {
      const tot = (c.master || 0) + (c.geo || 0) + (c.fallback || 0);
      return tot ? `master ${c.master || 0} · geo ${c.geo || 0} · fallback ${c.fallback || 0} (of ${tot})` : '—';
    };
    dws.addRow(['Manual legs by distance source', '', legPct(manualLegSources)]);
    dws.addRow(['Optimized legs by distance source', '', legPct(optLegSources)]);
    dws.addRow(['BMCUs missing coordinates', noCoordBmcus.length,
      noCoordBmcus.map(b => b.bmcu_code).join(', ') || 'none']);
    dws.addRow(['Active tankers with NO per-km rate', noRateTankers.length,
      noRateTankers.map(t => t.tanker_number).join(', ') || 'none']);
    dws.addRow(['Optimized trips with tanker reused', reusedCount, reusedCount ? 'fleet smaller than trip count' : 'none']);
    dws.addRow(['Optimized trips over tanker capacity', overflowCount, overflowCount ? 'check flagged trips' : 'none']);
    dws.addRow(['Delivery points across manual plans', Object.keys(dpCount).length,
      Object.entries(dpCount).map(([id, n]) => `${dpById[id]?.name || id}: ${n} trips`).join(' · ')]);
    dws.addRow(['Distance model note', '',
      'geo = straight-line × road factor (±10–15%). Add Distance Master road km (or run trips so Google caches them) for exact figures.']);

    await wb.xlsx.writeFile(OUT);

    // ── 9. stdout summary ────────────────────────────────────────────────────
    const line = (label, m, o, d) => console.log(
      label.padEnd(30), String(m).padStart(12), String(o).padStart(12), String(d).padStart(12));
    console.log(`\n=== Plan comparison ${DATE} (strategy: ${STRATEGY}) ===`);
    console.log(''.padEnd(30), 'Manual'.padStart(12), 'Optimized'.padStart(12), 'Delta'.padStart(12));
    line('Trips',            M.trips,      O.trips,      O.trips - M.trips);
    line('Total qty (L)',    r2(M.qty),    r2(O.qty),    r2(O.qty - M.qty));
    line('BMCUs covered',    inputIds.size, outputIds.size, 0);
    line('Total KM (model)', r1(M.km),     r1(O.km),     r1(O.km - M.km));
    line('Weighted util %',  r1(M.util),   r1(O.util),   r1(O.util - M.util));
    line('Total cost ₹',     r2(M.cost),   r2(O.cost),   r2(O.cost - M.cost));
    line('Cost ₹/L',         r4(M.rpl),    r4(O.rpl),    r4(O.rpl - M.rpl));
    console.log(`\nManual legs:    ${legPct(manualLegSources)}`);
    console.log(`Optimized legs: ${legPct(optLegSources)}`);
    console.log(`BMCUs missing coords: ${noCoordBmcus.length}  ·  tankers w/o rate: ${noRateTankers.length}  ·  reused tankers: ${reusedCount}  ·  overflow trips: ${overflowCount}`);
    console.log(`\nReport written: ${OUT}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error('Report failed:', err); process.exit(1); });
