// backend/src/routes/optimize.js
// =============================================================================
// Shreeja Route Optimizer — HTTP endpoints.
// Core algorithms (Clarke-Wright savings, nearest-neighbour ordering, distance
// resolution) live in services/optimizerCore.js and are shared with offline
// analysis scripts. Distance cascade per leg:
//   distance_master (exact road km) → coordinates Haversine × road factor →
//   district constants (flagged 'fallback').
// =============================================================================

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/db');
const { authenticate, authorizeOrModule } = require('../middleware/auth');
const { saleTankerSql, saleTankerNumberSql } = require('../utils/saleTanker');
const {
  buildDistanceMap, makeResolver, nodeKey,
  nearestNeighbourOrder, computeRouteKm, clarkeWrightSavings,
  assignTankers, effectiveRate,
} = require('../services/optimizerCore');
const { runFleetOptimizer, DEFAULT_CONSTRAINTS } = require('../services/optimizerV2');
const dayData = require('../services/dayOptimizerData');

const canPlan = authorizeOrModule('planning', 'admin', 'planner');

// ─── Day Optimizer (fleet v2) gate — OPTIMIZER_V2_ENABLED=true mounts it ─────
const V2_ENABLED = () => process.env.OPTIMIZER_V2_ENABLED === 'true';
function v2Gate(_req, res, next) {
  if (!V2_ENABLED()) return res.status(503).json({ error: 'Day Optimizer is not enabled in this environment', code: 'FEATURE_DISABLED' });
  next();
}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHIFT_SCOPES = ['AM', 'PM', 'BOTH'];
function parseDayParams(src) {
  const plan_for_date = String(src.plan_for_date || '').slice(0, 10);
  const shift = String(src.shift || 'BOTH').toUpperCase();
  if (!ISO_DATE.test(plan_for_date) || isNaN(Date.parse(plan_for_date + 'T00:00:00Z')))
    return { error: 'plan_for_date must be YYYY-MM-DD' };
  if (!SHIFT_SCOPES.includes(shift)) return { error: 'shift must be AM, PM or BOTH' };
  return { plan_for_date, shift };
}

// =============================================================================
// GET /api/optimize/day/preview?plan_for_date&shift — inputs the planner reviews
// =============================================================================
router.get('/day/preview', authenticate, canPlan, v2Gate, async (req, res) => {
  const p = parseDayParams(req.query);
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const radius = parseFloat(process.env.OPTIMIZER_PREFETCH_RADIUS_KM || '80') || 80;
    const { bmcus, plants, catchments, fleet, excluded, demand, distMap } = await dayData.buildInstance(p.plan_for_date, p.shift, []);
    const plantById = Object.fromEntries(plants.map(pl => [pl.id, pl]));
    res.json({
      plan_for_date: p.plan_for_date, shift: p.shift,
      constraints: DEFAULT_CONSTRAINTS,
      demand: demand.filter(d => p.shift === 'BOTH' || d.shift === p.shift).map(d => ({
        ...d, plant_id: catchments[d.bmcu_id]?.plant_id || null,
        plant_name: plantById[catchments[d.bmcu_id]?.plant_id]?.name || null,
        catchment_method: catchments[d.bmcu_id]?.method,
      })),
      fleet, excluded_tankers: excluded,
      plants: plants.map(pl => ({ id: pl.id, name: pl.name, has_coords: pl.has_coords, start_point: pl.start?.name || null,
        bmcu_count: bmcus.filter(b => catchments[b.id]?.plant_id === pl.id).length })),
      distance_coverage: dayData.distanceCoverage(bmcus, plants, catchments, distMap, radius),
    });
  } catch (err) {
    console.error('[optimizer-v2] preview error:', err);
    res.status(500).json({ error: 'Failed to build Day Optimizer preview' });
  }
});

// =============================================================================
// POST /api/optimize/day  { plan_for_date, shift, constraints?, demand_overrides?, exclude_tanker_ids? }
// =============================================================================
router.post('/day', authenticate, canPlan, v2Gate, async (req, res) => {
  const p = parseDayParams(req.body || {});
  if (p.error) return res.status(400).json({ error: p.error });
  const { constraints = {}, demand_overrides = [], exclude_tanker_ids = [] } = req.body || {};
  if (!Array.isArray(demand_overrides) || !Array.isArray(exclude_tanker_ids))
    return res.status(400).json({ error: 'demand_overrides and exclude_tanker_ids must be arrays' });
  const overrides = demand_overrides.filter(o => o && o.bmcu_id && ['AM', 'PM'].includes(o.shift) && Number.isFinite(parseFloat(o.litres)));
  const excludeIds = new Set(exclude_tanker_ids.map(Number));
  try {
    const built = await dayData.buildInstance(p.plan_for_date, p.shift, overrides);
    const { instance, plants, fleet, excluded, rates, demand } = built;
    for (const t of instance.tankers.filter(t => excludeIds.has(t.id)))
      excluded.push({ tanker_id: t.id, tanker_number: t.tanker_number, reason: 'Excluded by planner' });
    instance.tankers = instance.tankers.filter(t => !excludeIds.has(t.id));
    const demandNodes = instance.nodes.filter(n => n.litres > 0);
    if (!demandNodes.length) return res.status(400).json({ error: `No demand for ${p.plan_for_date} ${p.shift}: no RMRD history, plan quantities or overrides for any active BMCU` });
    if (!instance.tankers.length) return res.status(400).json({ error: 'No available tankers with a valid rate for this date — see excluded tankers in the preview' });
    if (!instance.plants.length) return res.status(400).json({ error: 'No plant catchment could be resolved — check delivery point coordinates' });

    // Cap the time budget so the request stays well inside proxy/DB timeouts
    const c = { ...constraints };
    c.time_budget_ms = Math.min(Math.max(parseInt(c.time_budget_ms) || DEFAULT_CONSTRAINTS.time_budget_ms, 500), 20000);
    const result = runFleetOptimizer(instance, c);

    await dayData.saveForecasts(p.plan_for_date, demand, overrides);
    const comparison = await dayData.loadComparison(p.plan_for_date, p.shift, fleet, rates);
    if (comparison) {
      const d = (a, b) => a == null || b == null ? null : Math.round((a - b) * 100) / 100;
      comparison.delta = {
        trips: d(result.totals.trips, comparison.trips), km: d(result.totals.km, comparison.km),
        cost: d(result.totals.cost, comparison.cost), litres: d(result.totals.litres, comparison.litres),
        cost_per_litre: d(result.totals.cost_per_litre, comparison.cost_per_litre),
        avg_fill_pct: d(result.totals.avg_fill_pct, comparison.avg_fill_pct),
      };
    }
    if (excluded.length) result.warnings.push(`${excluded.length} tanker(s) excluded — see Excluded tankers.`);

    // Persist the session in the existing optimizer tables
    const client = await pool.connect();
    let sessionId;
    try {
      await client.query('BEGIN');
      const shiftsMilk = dayData.shiftLabel(p.shift);
      const sess = await client.query(
        `INSERT INTO optimization_sessions
           (plan_for_date, delivery_point_id, start_point_id, shifts_milk, strategy, algorithm, constraints, shift_scope,
            input_bmcu_count, input_total_qty, result_trip_count, result_total_km, result_total_cost, km_coverage_pct,
            comparison, summary, status, created_by)
         VALUES ($1,NULL,NULL,$2,'fleet_v2','fleet_v2',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'completed',$13) RETURNING id`,
        [p.plan_for_date, shiftsMilk, JSON.stringify(result.constraints), p.shift,
         demandNodes.length, result.totals.litres, result.totals.trips, result.totals.km, result.totals.cost,
         result.totals.estimated_legs ? null : 100,
         comparison ? JSON.stringify(comparison) : null,
         JSON.stringify({ totals: result.totals, unserved: result.unserved, excluded_tankers: excluded, warnings: result.warnings, stats: result.stats }),
         req.user.id]);
      sessionId = sess.rows[0].id;
      for (const n of demandNodes)
        await client.query(
          'INSERT INTO optimization_inputs (session_id, bmcu_id, expected_qty_litres, shift_code) VALUES ($1,$2,$3,$4)',
          [sessionId, n.bmcu_id, n.litres, shiftsMilk]);
      for (const t of result.trips) {
        const tr = await client.query(
          `INSERT INTO optimization_trips
             (session_id, trip_seq, tanker_id, tanker_number, capacity_litres, per_km_rate, total_qty_litres, utilization_pct,
              estimated_km, estimated_cost, per_liter_cost, km_is_estimated, delivery_point_id, start_point_id,
              transport_type, rate_state, flags, shift_code)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
          [sessionId, t.trip_seq, t.tanker_id, t.tanker_number, t.capacity_litres, t.rate_per_km, t.total_qty_litres, t.fill_pct,
           t.km, t.cost, t.cost_per_litre, t.flags.estimated_legs > 0, t.delivery_point_id, t.start_point_id,
           t.transport_type, t.rate_state, JSON.stringify(t.flags), shiftsMilk.slice(0, 5)]);
        t.opt_trip_id = tr.rows[0].id;
        for (const b of t.bmcus)
          await client.query(
            `INSERT INTO optimization_trip_bmcus (opt_trip_id, seq_no, bmcu_id, expected_qty_litres, leg_km, leg_is_estimated)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [t.opt_trip_id, b.seq_no, b.bmcu_id, b.expected_qty_litres, b.leg_km, b.leg_is_estimated]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }

    res.json({
      session_id: sessionId, plan_for_date: p.plan_for_date, shift: p.shift,
      constraints: result.constraints,
      plants: plants.filter(pl => instance.plants.some(ip => ip.id === pl.id)).map(pl => ({ id: pl.id, name: pl.name })),
      trips: result.trips, totals: result.totals, unserved: result.unserved,
      excluded_tankers: excluded, warnings: result.warnings, comparison, stats: result.stats,
    });
  } catch (err) {
    console.error('[optimizer-v2] run error:', err);
    res.status(500).json({ error: 'Day Optimizer run failed' });
  }
});

// =============================================================================
// POST /api/optimize/prefetch-distances — Google-fetch missing nearby pairs
// =============================================================================
router.post('/prefetch-distances', authenticate, canPlan, v2Gate, async (req, res) => {
  try {
    const radiusKm = parseFloat(process.env.OPTIMIZER_PREFETCH_RADIUS_KM || '80') || 80;
    const maxCalls = Math.max(1, parseInt(process.env.OPTIMIZER_PREFETCH_MAX || '3000') || 3000);
    const out = await dayData.prefetchDistances({ radiusKm, maxCalls, concurrency: 4, userId: req.user.id });
    console.log(`[optimizer-v2] prefetch fetched=${out.fetched} failed=${out.failed} remaining=${out.remaining}`);
    res.json({ radius_km: radiusKm, max_calls: maxCalls, ...out });
  } catch (err) {
    console.error('[optimizer-v2] prefetch error:', err);
    res.status(500).json({ error: 'Prefetch failed' });
  }
});

// =============================================================================
// POST /api/optimize/forecast/backfill?date=YYYY-MM-DD — fill actual_litres
// =============================================================================
router.post('/forecast/backfill', authenticate, canPlan, v2Gate, async (req, res) => {
  const date = String(req.query.date || req.body?.date || '').slice(0, 10);
  if (!ISO_DATE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  try {
    const updated = await dayData.backfillActuals(date);
    res.json({ date, updated });
  } catch (err) {
    console.error('[optimizer-v2] backfill error:', err);
    res.status(500).json({ error: 'Backfill failed' });
  }
});

// =============================================================================
// POST /api/optimize/run
// =============================================================================
router.post('/run', authenticate, authorizeOrModule('planning', 'admin', 'planner'), async (req, res) => {
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
      'SELECT id, name, latitude, longitude FROM delivery_points WHERE id=$1 AND is_active=TRUE', [delivery_point_id]
    );
    if (!dpRes.rows.length) return res.status(404).json({ error: 'Delivery point not found' });
    const depot = { type: 'delivery_point', id: parseInt(delivery_point_id), name: dpRes.rows[0].name };

    // 2. Load BMCU details (incl. coordinates for geo-distance fallback)
    const bmcuIds = inputBmcus.map(b => b.bmcu_id);
    const bmcuRes = await client.query(
      'SELECT id, bmcu_code, bmcu_name, district, state, latitude, longitude FROM bmcus WHERE id=ANY($1) AND is_active=TRUE',
      [bmcuIds]
    );
    const bmcuDetailsMap = {};
    bmcuRes.rows.forEach(b => { bmcuDetailsMap[b.id] = b; });

    const missingBmcus = inputBmcus.filter(b => !bmcuDetailsMap[b.bmcu_id]);
    if (missingBmcus.length) {
      return res.status(400).json({ error: `BMCUs not found: ${missingBmcus.map(b=>b.bmcu_id).join(', ')}` });
    }

    // 3. Load active tankers (rate_per_km_bmcu is the maintained collection rate).
    //    The "SALE…" placeholder is not a fleet vehicle — never assign it.
    const tankerRes = await client.query(
      `SELECT id, tanker_number, capacity_litres, per_km_rate, rate_per_km_bmcu FROM tankers
       WHERE is_active=TRUE AND NOT ${saleTankerNumberSql('tankers')} ORDER BY capacity_litres DESC`
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

    // 4b. Node map (coords + district) → distance resolver:
    //     distance_master → Haversine × road factor → district constants
    const spRes = await client.query(
      'SELECT id, latitude, longitude FROM starting_points WHERE id=$1', [start_point_id]
    );
    const nodeMap = {};
    nodeMap[nodeKey('delivery_point', depot.id)] = dpRes.rows[0];
    if (spRes.rows.length) nodeMap[nodeKey('starting_point', parseInt(start_point_id))] = spRes.rows[0];
    bmcuRes.rows.forEach(b => { nodeMap[nodeKey('bmcu', b.id)] = b; });
    const resolve = makeResolver(distMap, nodeMap);

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
        const groupRoutes = clarkeWrightSavings(depot, groupItems, resolve, maxCapacity);
        rawRoutes.push(...groupRoutes);
      }
    } else {
      // distance_savings, best_fit, cheapest all use full savings
      rawRoutes = clarkeWrightSavings(depot, items, resolve, maxCapacity);
    }

    const routeLoads = rawRoutes.map(route =>
      route.reduce((s, bm) => s + bm.expected_qty_litres, 0)
    );

    // 8. Assign tankers (effective rate = rate_per_km_bmcu → per_km_rate)
    const assignments = assignTankers(rawRoutes, routeLoads, tankers, strategy, effectiveRate);

    // 9. For each route: nearest-neighbour reorder + compute km
    let totalEstimatedKm   = 0;
    let totalEstimatedCost = 0;
    let totalFallbackLegs  = 0; // legs on crude district constants (no master km, no coords)
    let totalLegs          = 0;

    const trips = assignments.map((asgn, i) => {
      // Re-order BMCUs within trip using the distance resolver
      const ordered = nearestNeighbourOrder(depot, asgn.route, resolve);
      const { totalKm, legs, anyEstimated, returnLeg } = computeRouteKm(depot, ordered, resolve);

      const estimatedCost = totalKm * effectiveRate(asgn.tanker);
      const perLitreCost  = asgn.load > 0 ? estimatedCost / asgn.load : 0;
      const utilPct       = asgn.tanker.capacity_litres > 0
        ? (asgn.load / asgn.tanker.capacity_litres) * 100 : 0;

      totalEstimatedKm   += totalKm;
      totalEstimatedCost += estimatedCost;
      totalLegs          += legs.length + 1; // +1 for return leg
      totalFallbackLegs  += legs.filter(l => l.leg_source === 'fallback').length
                          + (returnLeg.leg_source === 'fallback' ? 1 : 0);

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
            leg_source: legInfo.leg_source,
          };
        })
      };
    });

    // Coverage = % of legs resolved with usable distances (master road km or
    // coordinate-based geo estimate); only crude district-constant legs count against it.
    const kmCoverage = totalLegs > 0
      ? Math.round((1 - totalFallbackLegs / totalLegs) * 100 * 10) / 10
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
         trip.tanker.capacity_litres, effectiveRate(trip.tanker),
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
      warning: totalFallbackLegs > 0
        ? `${totalFallbackLegs} leg(s) had no road km or coordinates and used crude district estimates (marked with ⚠). Add Distance Master entries or BMCU coordinates for precise KM.`
        : (estimatedLegsExist
            ? 'Distances are coordinate-based estimates (straight-line × road factor). Add Distance Master entries for exact road KM.'
            : null),
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
router.post('/:sessionId/save-as-plans', authenticate, authorizeOrModule('planning', 'admin', 'planner'), async (req, res) => {
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
        'SELECT per_km_rate, rate_per_km_bmcu, capacity_litres FROM tankers WHERE id=$1', [tankerId]
      );
      const tanker       = tRes.rows[0];
      // Fleet v2 priced the trip from the Tanker Rate Master — keep that rate
      // unless the planner swapped the tanker; v1 keeps the tanker-master rate.
      const isV2         = session.algorithm === 'fleet_v2';
      const keepV2Rate   = isV2 && String(tankerId) === String(optTrip.tanker_id) && parseFloat(optTrip.per_km_rate) > 0;
      const perKmRate    = keepV2Rate ? parseFloat(optTrip.per_km_rate)
                         : tanker ? (effectiveRate(tanker) || parseFloat(optTrip.per_km_rate) || 0)
                                  : (parseFloat(optTrip.per_km_rate) || 0);
      // Multi-plant (v2) sessions carry the plant per trip; v1 uses the session's.
      const deliveryPointId = optTrip.delivery_point_id || session.delivery_point_id;
      const startPointId    = optTrip.start_point_id    || session.start_point_id;
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
          tankerId, startPointId, deliveryPointId,
          session.shifts_milk, expectedKm,
          Math.round(utilPct * 10) / 10,
          optTrip.total_qty_litres,
          Math.round(totalCost * 100) / 100,
          Math.round(perLitreCost * 10000) / 10000,
          ov.driver_name || null,
          ov.loader_name || null,
          ov.remarks || (isV2 ? `Day Optimizer — Session #${sessionId}` : `Optimizer (${session.strategy}) — Session #${sessionId}`),
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
router.get('/sessions', authenticate, authorizeOrModule('planning', 'admin', 'planner'), async (req, res) => {
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
router.get('/sessions/:id', authenticate, authorizeOrModule('planning', 'admin', 'planner'), async (req, res) => {
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
router.get('/compare', authenticate, authorizeOrModule('planning', 'admin', 'planner'), async (req, res) => {
  try {
    const { plan_for_date } = req.query;
    if (!plan_for_date) return res.status(400).json({ error: 'plan_for_date required' });

    const manual = await pool.query(
      `SELECT COUNT(*)::int AS trip_count,
              COALESCE(SUM(expected_total_qty),0)::numeric AS total_qty,
              COALESCE(SUM(expected_km),0)::numeric        AS total_km,
              COALESCE(SUM(total_cost),0)::numeric         AS total_cost,
              ROUND((AVG(tp.expected_utilization_pct) FILTER (WHERE NOT ${saleTankerSql('tp', 't')}))::numeric,1) AS avg_utilization
       FROM trip_plans tp
       LEFT JOIN tankers t ON t.id = tp.tanker_id
       WHERE tp.plan_for_date=$1 AND tp.status != 'cancelled'`, [plan_for_date]
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
