// backend/src/routes/optimize.js
// =============================================================================
// Shreeja Route Optimizer
//
// ALGORITHM: Clarke-Wright Savings with manual distance matrix
//
// Distance resolution order for any pair (A, B):
//   1. Exact entry in distance_master table (planner-entered road km)
//   2. Fallback: district-based estimate (if same district → 20 km avg, else 50 km)
//   3. Hard fallback: configurable default (15 km)
//   Any leg that used fallback is flagged km_is_estimated = TRUE on the trip.
//
// The algorithm:
//   Phase 1 – Build distance matrix for depot + all selected BMCUs
//   Phase 2 – Clarke-Wright: compute savings s(i,j) = d(depot,i)+d(depot,j)−d(i,j)
//   Phase 3 – Sort savings descending; merge routes greedily respecting capacity
//   Phase 4 – Assign best-fit tanker to each route
//   Phase 5 – Within each route: re-order by nearest-neighbour using distance matrix
//   Phase 6 – Compute final KM per leg, total cost, utilisation
// =============================================================================

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// ─── Default fallback km values (tunable) ────────────────────────────────────
const SAME_DISTRICT_FALLBACK_KM  = 20;
const DIFF_DISTRICT_FALLBACK_KM  = 50;
const HARD_FALLBACK_KM           = 30;

// =============================================================================
// DISTANCE MATRIX BUILDER
// Loads all relevant distances from distance_master into an in-memory map.
// Key: "type:id — type:id" (always normalised so lower key first)
// =============================================================================
function distKey(typeA, idA, typeB, idB) {
  const a = `${typeA}:${idA}`;
  const b = `${typeB}:${idB}`;
  return a <= b ? `${a}||${b}` : `${b}||${a}`;
}

async function buildDistanceMap(client, nodeIds) {
  // nodeIds: [{ type, id }]
  if (!nodeIds.length) return {};

  // Pull all relevant pairs from DB in one query using ANY
  const types = [...new Set(nodeIds.map(n => n.type))];
  const ids   = [...new Set(nodeIds.map(n => n.id))];

  const r = await client.query(
    `SELECT from_type, from_id, to_type, to_id, distance_km
     FROM distance_master
     WHERE (from_type = ANY($1) AND from_id = ANY($2))
        OR (to_type   = ANY($1) AND to_id   = ANY($2))`,
    [types, ids]
  );

  const map = {};
  for (const row of r.rows) {
    const key = distKey(row.from_type, row.from_id, row.to_type, row.to_id);
    map[key] = parseFloat(row.distance_km);
  }
  return map;
}

function getDistance(distMap, typeA, idA, typeB, idB, nodeA, nodeB) {
  const key = distKey(typeA, idA, typeB, idB);
  if (distMap[key] !== undefined) return { km: distMap[key], estimated: false };

  // Fallback by district match
  if (typeA === 'bmcu' && typeB === 'bmcu' && nodeA && nodeB) {
    if (nodeA.district && nodeB.district && nodeA.district === nodeB.district) {
      return { km: SAME_DISTRICT_FALLBACK_KM, estimated: true };
    }
    return { km: DIFF_DISTRICT_FALLBACK_KM, estimated: true };
  }
  return { km: HARD_FALLBACK_KM, estimated: true };
}

// =============================================================================
// NEAREST-NEIGHBOUR TSP within a single route
// Reorders the BMCU list to minimise total leg distance
// =============================================================================
function nearestNeighbourOrder(depot, bmcus, distMap) {
  if (bmcus.length <= 1) return bmcus;

  const remaining = [...bmcus];
  const ordered   = [];
  let current     = depot; // start at depot

  while (remaining.length > 0) {
    let bestIdx  = 0;
    let bestKm   = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const bm = remaining[i];
      const { km } = getDistance(distMap, current.type, current.id, 'bmcu', bm.bmcu_id, null, bm);
      if (km < bestKm) { bestKm = km; bestIdx = i; }
    }

    ordered.push(remaining[bestIdx]);
    current = { type: 'bmcu', id: remaining[bestIdx].bmcu_id };
    remaining.splice(bestIdx, 1);
  }

  return ordered;
}

// =============================================================================
// COMPUTE ROUTE KM
// depot → bmcu1 → bmcu2 → … → bmcuN → depot (depot = delivery point)
// Returns { totalKm, legs, anyEstimated }
// =============================================================================
function computeRouteKm(depot, orderedBmcus, distMap, bmcuDetailsMap) {
  const legs = [];
  let totalKm = 0;
  let anyEstimated = false;

  let prev = depot;

  for (const bm of orderedBmcus) {
    const bmNode = bmcuDetailsMap[bm.bmcu_id] || {};
    const { km, estimated } = getDistance(distMap, prev.type, prev.id, 'bmcu', bm.bmcu_id, null, bmNode);
    legs.push({ bmcu_id: bm.bmcu_id, leg_km: km, leg_is_estimated: estimated });
    totalKm += km;
    if (estimated) anyEstimated = true;
    prev = { type: 'bmcu', id: bm.bmcu_id };
  }

  // Return leg (last BMCU → delivery point)
  const lastBmcu = orderedBmcus[orderedBmcus.length - 1];
  const lastBmNode = bmcuDetailsMap[lastBmcu?.bmcu_id] || {};
  const { km: returnKm, estimated: returnEst } =
    getDistance(distMap, 'bmcu', lastBmcu?.bmcu_id, depot.type, depot.id, lastBmNode, null);
  totalKm += returnKm;
  if (returnEst) anyEstimated = true;

  return { totalKm: Math.round(totalKm * 10) / 10, legs, anyEstimated };
}

// =============================================================================
// CLARKE-WRIGHT SAVINGS
// Returns array of routes (each route = array of bmcu items)
// =============================================================================
function clarkeWrightSavings(depot, bmcus, distMap, bmcuDetailsMap, tankerCapacity) {
  const n = bmcus.length;
  if (n === 0) return [];

  // Compute savings for all pairs
  const savings = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const bmA = bmcus[i];
      const bmB = bmcus[j];
      const dA  = getDistance(distMap, depot.type, depot.id, 'bmcu', bmA.bmcu_id, null, bmcuDetailsMap[bmA.bmcu_id]);
      const dB  = getDistance(distMap, depot.type, depot.id, 'bmcu', bmB.bmcu_id, null, bmcuDetailsMap[bmB.bmcu_id]);
      const dAB = getDistance(distMap, 'bmcu', bmA.bmcu_id, 'bmcu', bmB.bmcu_id, bmcuDetailsMap[bmA.bmcu_id], bmcuDetailsMap[bmB.bmcu_id]);
      const saving = dA.km + dB.km - dAB.km;
      savings.push({ i, j, saving });
    }
  }
  savings.sort((a, b) => b.saving - a.saving); // descending

  // Each BMCU starts in its own route
  const routes    = bmcus.map(bm => [bm]);
  const routeLoad = bmcus.map(bm => parseFloat(bm.expected_qty_litres) || 0);
  const routeOf   = bmcus.map((_, i) => i); // routeOf[i] = route index

  for (const { i, j, saving } of savings) {
    if (saving <= 0) break; // no more beneficial merges

    const ri = routeOf[i];
    const rj = routeOf[j];
    if (ri === rj || ri === -1 || rj === -1) continue;

    const routeI = routes[ri];
    const routeJ = routes[rj];
    if (!routeI || !routeJ) continue;

    // Check capacity
    if (routeLoad[ri] + routeLoad[rj] > tankerCapacity) continue;

    // i must be at a route end, j must be at a route end
    const iAtEnd   = routeI[routeI.length - 1].bmcu_id === bmcus[i].bmcu_id;
    const iAtStart = routeI[0].bmcu_id === bmcus[i].bmcu_id;
    const jAtStart = routeJ[0].bmcu_id === bmcus[j].bmcu_id;
    const jAtEnd   = routeJ[routeJ.length - 1].bmcu_id === bmcus[j].bmcu_id;

    let merged = null;
    if (iAtEnd   && jAtStart) merged = [...routeI, ...routeJ];
    else if (jAtEnd   && iAtStart) merged = [...routeJ, ...routeI];
    else if (iAtEnd   && jAtEnd)   merged = [...routeI, ...[...routeJ].reverse()];
    else if (iAtStart && jAtStart) merged = [...[...routeI].reverse(), ...routeJ];
    else continue;

    const newIdx = routes.length;
    routes.push(merged);
    routeLoad.push(routeLoad[ri] + routeLoad[rj]);

    // Update routeOf for all nodes in merged routes
    for (const bm of merged) {
      const origIdx = bmcus.findIndex(b => b.bmcu_id === bm.bmcu_id);
      if (origIdx !== -1) routeOf[origIdx] = newIdx;
    }
    routes[ri] = null;
    routes[rj] = null;
  }

  return routes.filter(r => r !== null && r.length > 0);
}

// =============================================================================
// TANKER ASSIGNMENT
// Given a set of routes with known loads, pick the cheapest feasible tanker
// =============================================================================
function assignTankers(routes, routeLoads, tankers, strategy) {
  const sorter = strategy === 'cheapest'
    ? (a, b) => a.per_km_rate - b.per_km_rate || b.capacity_litres - a.capacity_litres
    : (a, b) => b.capacity_litres - a.capacity_litres; // best_fit: largest first

  const sorted = [...tankers].sort(sorter);

  return routes.map((route, idx) => {
    const load = routeLoads[idx];
    // Best-fit: smallest tanker that still fits
    const fit = sorted.filter(t => t.capacity_litres >= load)
      .sort((a, b) => a.capacity_litres - b.capacity_litres)[0]
      || sorted[0]; // overflow fallback
    return { route, load, tanker: fit };
  });
}

// =============================================================================
// POST /api/optimize/run
// =============================================================================
router.post('/run', authenticate, authorize('admin', 'planner'), async (req, res) => {
  const {
    plan_for_date, delivery_point_id, start_point_id,
    shifts_milk, strategy = 'distance_savings',
    bmcus: inputBmcus
  } = req.body;

  if (!plan_for_date || !delivery_point_id || !start_point_id || !inputBmcus?.length) {
    return res.status(400).json({ error: 'Missing: plan_for_date, delivery_point_id, start_point_id, bmcus' });
  }

  const client = await pool.connect();
  try {
    // 1. Load delivery point (the "depot" for routing — tankers end here)
    const dpRes = await client.query(
      'SELECT id, name FROM delivery_points WHERE id=$1 AND is_active=TRUE', [delivery_point_id]
    );
    if (!dpRes.rows.length) return res.status(404).json({ error: 'Delivery point not found' });
    const depot = { type: 'delivery_point', id: parseInt(delivery_point_id), name: dpRes.rows[0].name };

    // 2. Load BMCU details
    const bmcuIds = inputBmcus.map(b => b.bmcu_id);
    const bmcuRes = await client.query(
      'SELECT id, bmcu_code, bmcu_name, district, state FROM bmcus WHERE id=ANY($1) AND is_active=TRUE',
      [bmcuIds]
    );
    const bmcuDetailsMap = {};
    bmcuRes.rows.forEach(b => { bmcuDetailsMap[b.id] = b; });

    const missingBmcus = inputBmcus.filter(b => !bmcuDetailsMap[b.bmcu_id]);
    if (missingBmcus.length) {
      return res.status(400).json({ error: `BMCUs not found: ${missingBmcus.map(b=>b.bmcu_id).join(', ')}` });
    }

    // 3. Load active tankers
    const tankerRes = await client.query(
      'SELECT id, tanker_number, capacity_litres, per_km_rate FROM tankers WHERE is_active=TRUE ORDER BY capacity_litres DESC'
    );
    if (!tankerRes.rows.length) return res.status(400).json({ error: 'No active tankers' });
    const tankers = tankerRes.rows;

    // 4. Build distance map — all relevant node pairs
    const allNodes = [
      { type: 'delivery_point', id: parseInt(delivery_point_id) },
      { type: 'starting_point', id: parseInt(start_point_id) },
      ...bmcuIds.map(id => ({ type: 'bmcu', id }))
    ];
    const distMap = await buildDistanceMap(client, allNodes);

    // 5. Enrich input items
    const items = inputBmcus.map(inp => ({
      ...bmcuDetailsMap[inp.bmcu_id],
      bmcu_id: inp.bmcu_id,
      expected_qty_litres: parseFloat(inp.expected_qty_litres) || 0,
      shift_code: inp.shift_code || shifts_milk,
    }));

    const totalQty = items.reduce((s, b) => s + b.expected_qty_litres, 0);

    // 6. Determine capacity for savings algorithm
    // Use the largest available tanker as the routing capacity
    const maxCapacity = tankers[0].capacity_litres;

    // 7. Run optimizer
    let rawRoutes;
    if (strategy === 'district') {
      // Pre-group by district, then run savings within each group
      const groups = {};
      for (const item of items) {
        const key = item.district || item.state || 'other';
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
      }
      rawRoutes = [];
      for (const groupItems of Object.values(groups)) {
        const groupRoutes = clarkeWrightSavings(depot, groupItems, distMap, bmcuDetailsMap, maxCapacity);
        rawRoutes.push(...groupRoutes);
      }
    } else {
      // distance_savings, best_fit, cheapest all use full savings
      rawRoutes = clarkeWrightSavings(depot, items, distMap, bmcuDetailsMap, maxCapacity);
    }

    const routeLoads = rawRoutes.map(route =>
      route.reduce((s, bm) => s + bm.expected_qty_litres, 0)
    );

    // 8. Assign tankers
    const assignments = assignTankers(rawRoutes, routeLoads, tankers, strategy);

    // 9. For each route: nearest-neighbour reorder + compute km
    let totalEstimatedKm   = 0;
    let totalEstimatedCost = 0;
    let totalEstimatedLegs = 0;
    let totalLegs          = 0;

    const trips = assignments.map((asgn, i) => {
      // Re-order BMCUs within trip using distance matrix
      const ordered = nearestNeighbourOrder(depot, asgn.route, distMap);
      const { totalKm, legs, anyEstimated } = computeRouteKm(depot, ordered, distMap, bmcuDetailsMap);

      const estimatedCost = totalKm * parseFloat(asgn.tanker.per_km_rate);
      const perLitreCost  = asgn.load > 0 ? estimatedCost / asgn.load : 0;
      const utilPct       = asgn.tanker.capacity_litres > 0
        ? (asgn.load / asgn.tanker.capacity_litres) * 100 : 0;

      totalEstimatedKm   += totalKm;
      totalEstimatedCost += estimatedCost;
      totalLegs          += legs.length + 1; // +1 for return leg
      totalEstimatedLegs += legs.filter(l => l.leg_is_estimated).length + (anyEstimated ? 1 : 0);

      return {
        trip_seq: i + 1,
        tanker: asgn.tanker,
        total_qty_litres: Math.round(asgn.load * 100) / 100,
        utilization_pct: Math.round(utilPct * 10) / 10,
        estimated_km: Math.round(totalKm * 10) / 10,
        estimated_cost: Math.round(estimatedCost * 100) / 100,
        per_liter_cost: Math.round(perLitreCost * 10000) / 10000,
        km_is_estimated: anyEstimated,
        legs,
        bmcus: ordered.map((bm, seq) => {
          const legInfo = legs[seq] || {};
          return {
            seq_no: seq + 1,
            bmcu_id: bm.bmcu_id,
            bmcu_code: bmcuDetailsMap[bm.bmcu_id]?.bmcu_code,
            bmcu_name: bmcuDetailsMap[bm.bmcu_id]?.bmcu_name,
            district: bmcuDetailsMap[bm.bmcu_id]?.district,
            state: bmcuDetailsMap[bm.bmcu_id]?.state,
            expected_qty_litres: bm.expected_qty_litres,
            shift_code: bm.shift_code,
            leg_km: legInfo.leg_km,
            leg_is_estimated: legInfo.leg_is_estimated || false,
          };
        })
      };
    });

    const kmCoverage = totalLegs > 0
      ? Math.round((1 - totalEstimatedLegs / totalLegs) * 100 * 10) / 10
      : 0;

    // 10. Persist session
    await client.query('BEGIN');

    const sessRes = await client.query(
      `INSERT INTO optimization_sessions
         (plan_for_date, delivery_point_id, start_point_id, shifts_milk, strategy,
          input_bmcu_count, input_total_qty, result_trip_count,
          result_total_km, result_total_cost, km_coverage_pct, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'completed',$12) RETURNING id`,
      [plan_for_date, delivery_point_id, start_point_id, shifts_milk, strategy,
       items.length, totalQty, trips.length,
       Math.round(totalEstimatedKm * 10) / 10,
       Math.round(totalEstimatedCost * 100) / 100,
       kmCoverage, req.user.id]
    );
    const sessionId = sessRes.rows[0].id;

    for (const inp of inputBmcus) {
      await client.query(
        `INSERT INTO optimization_inputs (session_id, bmcu_id, expected_qty_litres, shift_code)
         VALUES ($1,$2,$3,$4)`,
        [sessionId, inp.bmcu_id, inp.expected_qty_litres, inp.shift_code || shifts_milk]
      );
    }

    const tripIds = [];
    for (const trip of trips) {
      const tRes = await client.query(
        `INSERT INTO optimization_trips
           (session_id, trip_seq, tanker_id, tanker_number, capacity_litres, per_km_rate,
            total_qty_litres, utilization_pct, estimated_km, estimated_cost, per_liter_cost, km_is_estimated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [sessionId, trip.trip_seq, trip.tanker.id, trip.tanker.tanker_number,
         trip.tanker.capacity_litres, trip.tanker.per_km_rate,
         trip.total_qty_litres, trip.utilization_pct,
         trip.estimated_km, trip.estimated_cost, trip.per_liter_cost, trip.km_is_estimated]
      );
      const tripId = tRes.rows[0].id;
      tripIds.push(tripId);

      for (const bm of trip.bmcus) {
        await client.query(
          `INSERT INTO optimization_trip_bmcus
             (opt_trip_id, seq_no, bmcu_id, expected_qty_litres, leg_km, leg_is_estimated)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [tripId, bm.seq_no, bm.bmcu_id, bm.expected_qty_litres,
           bm.leg_km || null, bm.leg_is_estimated || false]
        );
      }
    }

    await client.query('COMMIT');

    // 11. Response
    const estimatedLegsExist = trips.some(t => t.km_is_estimated);

    res.json({
      session_id: sessionId,
      strategy,
      km_coverage_pct: kmCoverage,
      has_estimated_legs: estimatedLegsExist,
      warning: estimatedLegsExist
        ? `Some distances used fallback estimates (marked with ⚠). Add more entries in Distance Master for precise KM calculations.`
        : null,
      summary: {
        trip_count: trips.length,
        total_qty_litres: Math.round(totalQty * 100) / 100,
        total_km: Math.round(totalEstimatedKm * 10) / 10,
        total_cost: Math.round(totalEstimatedCost * 100) / 100,
        per_litre_cost: totalQty > 0
          ? Math.round(totalEstimatedCost / totalQty * 10000) / 10000 : 0,
        avg_utilization: trips.length
          ? Math.round(trips.reduce((s,t) => s+t.utilization_pct, 0) / trips.length * 10) / 10 : 0
      },
      trips: trips.map((t, i) => ({ ...t, opt_trip_id: tripIds[i] }))
    });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Optimizer error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// =============================================================================
// POST /api/optimize/:sessionId/save-as-plans
// =============================================================================
router.post('/:sessionId/save-as-plans', authenticate, authorize('admin', 'planner'), async (req, res) => {
  const { sessionId } = req.params;
  const { trips: overrides = [] } = req.body;

  const client = await pool.connect();
  try {
    const sessRes = await client.query('SELECT * FROM optimization_sessions WHERE id=$1', [sessionId]);
    if (!sessRes.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = sessRes.rows[0];

    const tripsRes = await client.query(
      'SELECT * FROM optimization_trips WHERE session_id=$1 ORDER BY trip_seq', [sessionId]
    );

    await client.query('BEGIN');
    const createdPlanIds = [];
    let tripNo = 1;

    for (const optTrip of tripsRes.rows) {
      const ov = overrides.find(o => o.opt_trip_id === optTrip.id) || {};
      if (ov.accepted === false) continue;

      const tankerId   = ov.tanker_id   || optTrip.tanker_id;
      const expectedKm = parseFloat(ov.expected_km || optTrip.estimated_km);

      const tRes = await client.query(
        'SELECT per_km_rate, capacity_litres FROM tankers WHERE id=$1', [tankerId]
      );
      const tanker       = tRes.rows[0];
      const perKmRate    = parseFloat(tanker?.per_km_rate   || optTrip.per_km_rate);
      const totalCost    = expectedKm * perKmRate;
      const perLitreCost = optTrip.total_qty_litres > 0 ? totalCost / optTrip.total_qty_litres : 0;
      const utilPct      = tanker?.capacity_litres > 0
        ? (optTrip.total_qty_litres / tanker.capacity_litres) * 100 : 0;

      const planRes = await client.query(
        `INSERT INTO trip_plans
           (plan_date, plan_for_date, trip_no, tanker_id,
            start_point_id, delivery_point_id, shifts_milk,
            expected_km, expected_utilization_pct, expected_total_qty,
            total_cost, per_liter_cost, driver_name, loader_name, remarks,
            status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'draft',$16)
         RETURNING id`,
        [
          new Date().toISOString().slice(0, 10),
          session.plan_for_date, tripNo++,
          tankerId, session.start_point_id, session.delivery_point_id,
          session.shifts_milk, expectedKm,
          Math.round(utilPct * 10) / 10,
          optTrip.total_qty_litres,
          Math.round(totalCost * 100) / 100,
          Math.round(perLitreCost * 10000) / 10000,
          ov.driver_name || null,
          ov.loader_name || null,
          ov.remarks || `Optimizer (${session.strategy}) — Session #${sessionId}`,
          req.user.id
        ]
      );
      const planId = planRes.rows[0].id;

      const bmcusRes = await client.query(
        `SELECT otb.seq_no, otb.bmcu_id, otb.expected_qty_litres, oi.shift_code
         FROM optimization_trip_bmcus otb
         LEFT JOIN optimization_inputs oi ON oi.session_id=$2 AND oi.bmcu_id=otb.bmcu_id
         WHERE otb.opt_trip_id=$1 ORDER BY otb.seq_no`,
        [optTrip.id, sessionId]
      );

      for (const bm of bmcusRes.rows) {
        await client.query(
          `INSERT INTO trip_plan_bmcus (trip_plan_id, seq_no, bmcu_id, shift_code, expected_qty)
           VALUES ($1,$2,$3,$4,$5)`,
          [planId, bm.seq_no, bm.bmcu_id, bm.shift_code || session.shifts_milk, bm.expected_qty_litres]
        );
      }

      await client.query(
        'UPDATE optimization_trips SET converted_to_plan_id=$1 WHERE id=$2', [planId, optTrip.id]
      );
      createdPlanIds.push(planId);
    }

    await client.query(
      "UPDATE optimization_sessions SET status='saved_as_plans' WHERE id=$1", [sessionId]
    );
    await client.query('COMMIT');

    res.json({
      message: `${createdPlanIds.length} draft trip plan(s) created`,
      plan_ids: createdPlanIds
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/optimize/sessions
router.get('/sessions', authenticate, authorize('admin', 'planner'), async (req, res) => {
  try {
    const { plan_for_date } = req.query;
    let q = `
      SELECT os.*, dp.name AS delivery_point_name, sp.name AS start_point_name, u.full_name AS created_by_name
      FROM optimization_sessions os
      LEFT JOIN delivery_points dp ON dp.id=os.delivery_point_id
      LEFT JOIN starting_points sp ON sp.id=os.start_point_id
      LEFT JOIN users u ON u.id=os.created_by`;
    const params = [];
    if (plan_for_date) { q += ' WHERE os.plan_for_date=$1'; params.push(plan_for_date); }
    q += ' ORDER BY os.created_at DESC LIMIT 50';
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/optimize/sessions/:id
router.get('/sessions/:id', authenticate, authorize('admin', 'planner'), async (req, res) => {
  try {
    const sessRes = await pool.query(
      `SELECT os.*, dp.name AS delivery_point_name, sp.name AS start_point_name
       FROM optimization_sessions os
       LEFT JOIN delivery_points dp ON dp.id=os.delivery_point_id
       LEFT JOIN starting_points sp ON sp.id=os.start_point_id
       WHERE os.id=$1`, [req.params.id]
    );
    if (!sessRes.rows.length) return res.status(404).json({ error: 'Not found' });

    const tripsRes = await pool.query(
      'SELECT * FROM optimization_trips WHERE session_id=$1 ORDER BY trip_seq', [req.params.id]
    );
    const trips = [];
    for (const trip of tripsRes.rows) {
      const bRes = await pool.query(
        `SELECT otb.*, b.bmcu_code, b.bmcu_name, b.district, b.state
         FROM optimization_trip_bmcus otb JOIN bmcus b ON b.id=otb.bmcu_id
         WHERE otb.opt_trip_id=$1 ORDER BY otb.seq_no`, [trip.id]
      );
      trips.push({ ...trip, bmcus: bRes.rows });
    }
    res.json({ ...sessRes.rows[0], trips });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/optimize/compare?plan_for_date=YYYY-MM-DD
router.get('/compare', authenticate, authorize('admin', 'planner'), async (req, res) => {
  try {
    const { plan_for_date } = req.query;
    if (!plan_for_date) return res.status(400).json({ error: 'plan_for_date required' });

    const manual = await pool.query(
      `SELECT COUNT(*)::int AS trip_count,
              COALESCE(SUM(expected_total_qty),0)::numeric AS total_qty,
              COALESCE(SUM(expected_km),0)::numeric        AS total_km,
              COALESCE(SUM(total_cost),0)::numeric         AS total_cost,
              ROUND(AVG(expected_utilization_pct)::numeric,1) AS avg_utilization
       FROM trip_plans WHERE plan_for_date=$1 AND status != 'cancelled'`, [plan_for_date]
    );
    const optimized = await pool.query(
      `SELECT result_trip_count, input_total_qty, result_total_km, result_total_cost,
              km_coverage_pct, strategy, created_at
       FROM optimization_sessions
       WHERE plan_for_date=$1 AND status IN ('completed','saved_as_plans')
       ORDER BY created_at DESC LIMIT 1`, [plan_for_date]
    );
    res.json({ date: plan_for_date, manual: manual.rows[0], optimized: optimized.rows[0] || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
