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
const { runFleetOptimizer, DEFAULT_CONSTRAINTS, TT_BMCU, TT_P2P } = require('../services/optimizerV2');
const dayData = require('../services/dayOptimizerData');
const { allocatePlants, normaliseRequirements, mergeAllocationOptions, DEFAULT_ALLOCATION } = require('../services/plantAllocation');

const ExcelJS = require('exceljs');

const canPlan = authorizeOrModule('planning', 'admin', 'planner');

// ─── Suggested route name per optimised trip ────────────────────────────────
// Primary source is plan history: for every route_id used by a trip plan in
// the last ROUTE_HISTORY_DAYS (not cancelled/deleted), the BMCUs those plans
// carried, weighted 2 when the plan is within the last 30 days else 1. A
// route's share = the fraction of the trip's BMCUs that ever appeared in its
// plans; the highest share wins, ties broken by the weighted BMCU score, then
// by how often the route's plans went to the trip's delivery point. Below
// 50 % coverage the Route Master's own route_bmcus set is tried the same way
// (production has 66 routes but only 3 route_bmcus rows, so it rarely
// helps); below 50 % on both the trip is a "New combination".
const NEW_COMBINATION = 'New combination';
const ROUTE_HISTORY_DAYS = 120;
const ROUTE_MIN_SHARE = 0.5;
async function suggestRouteNames(trips) {
  const hist = await pool.query(`
    SELECT tp.route_id, rm.route_name, pb.bmcu_id, tp.delivery_point_id,
           SUM(CASE WHEN tp.plan_for_date >= CURRENT_DATE - 30 THEN 2 ELSE 1 END)::int AS w
    FROM trip_plans tp
    JOIN route_masters rm ON rm.id = tp.route_id
    JOIN trip_plan_bmcus pb ON pb.trip_plan_id = tp.id
    WHERE tp.plan_for_date >= CURRENT_DATE - $1::int AND tp.status NOT IN ('cancelled','deleted')
    GROUP BY tp.route_id, rm.route_name, pb.bmcu_id, tp.delivery_point_id`, [ROUTE_HISTORY_DAYS]);
  const histRoutes = new Map();
  for (const x of hist.rows) {
    let rt = histRoutes.get(x.route_id);
    if (!rt) { rt = { id: x.route_id, name: x.route_name, bmcu: new Map(), dp: new Map() }; histRoutes.set(x.route_id, rt); }
    rt.bmcu.set(x.bmcu_id, (rt.bmcu.get(x.bmcu_id) || 0) + x.w);
    if (x.delivery_point_id != null) rt.dp.set(x.delivery_point_id, (rt.dp.get(x.delivery_point_id) || 0) + x.w);
  }
  const master = await pool.query(`
    SELECT rm.id, rm.route_name, ARRAY_AGG(rb.bmcu_id) AS bmcu_ids
    FROM route_masters rm JOIN route_bmcus rb ON rb.route_id = rm.id
    WHERE rm.is_active = TRUE GROUP BY rm.id, rm.route_name`);
  const masterRoutes = master.rows.map(x => ({ id: x.id, name: x.route_name, bmcu: new Map(x.bmcu_ids.map(id => [id, 1])), dp: new Map() }));

  // Best route from a candidate list: share, then weighted score, then delivery-point usage
  const pick = (routes, ids, dpId) => {
    let best = null, bestShare = 0, bestScore = 0, bestDp = 0;
    for (const rt of routes) {
      let hit = 0, score = 0;
      for (const id of ids) { const w = rt.bmcu.get(id); if (w) { hit++; score += w; } }
      if (!hit) continue;
      const share = hit / ids.size, dpUse = dpId != null ? (rt.dp.get(dpId) || 0) : 0;
      if (share > bestShare || (share === bestShare && (score > bestScore || (score === bestScore && dpUse > bestDp)))) {
        best = rt; bestShare = share; bestScore = score; bestDp = dpUse;
      }
    }
    return { best, share: bestShare };
  };
  for (const t of trips) {
    const ids = new Set(t.bmcus.map(b => b.bmcu_id));
    let { best, share } = pick([...histRoutes.values()], ids, t.delivery_point_id);
    let source = 'history';
    if (!best || share < ROUTE_MIN_SHARE) {
      const m = pick(masterRoutes, ids, t.delivery_point_id);
      if (m.best && m.share >= ROUTE_MIN_SHARE) { best = m.best; share = m.share; source = 'route_master'; }
    }
    const ok = best && share >= ROUTE_MIN_SHARE;
    t.route_name = ok ? best.name : NEW_COMBINATION;
    t.route_id = ok ? best.id : null;
    t.route_source = ok ? source : null;
    t.route_overlap_pct = Math.round(share * 100);
  }
}

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
    const radius = parseFloat(process.env.OPTIMIZER_PREFETCH_RADIUS_KM || '150') || 150;
    const includeSale = String(req.query.include_sale || '') === 'true';
    const { instance, bmcus, plants, catchments, fleet, excluded, demand, distMap } = await dayData.buildInstance(p.plan_for_date, p.shift, [], { includeSale });
    const plantById = Object.fromEntries(plants.map(pl => [pl.id, pl]));
    // Past dates: how the forecast compares with the executed RMRD, before a run
    const forecastAccuracy = await dayData.loadForecastAccuracy(p.plan_for_date, instance.nodes, includeSale,
      { shift: p.shift, plantNameById: Object.fromEntries(plants.map(pl => [pl.id, pl.name])) });
    res.json({
      forecast_accuracy: forecastAccuracy,
      plan_for_date: p.plan_for_date, shift: p.shift,
      constraints: DEFAULT_CONSTRAINTS,
      allocation_defaults: DEFAULT_ALLOCATION,
      demand: demand.filter(d => p.shift === 'BOTH' || d.shift === p.shift).map(d => ({
        ...d, plant_id: catchments[d.bmcu_id]?.plant_id || null,
        plant_name: plantById[catchments[d.bmcu_id]?.plant_id]?.name || null,
        catchment_method: catchments[d.bmcu_id]?.method,
      })),
      fleet, excluded_tankers: excluded,
      // catchment_forecast_litres = what the plant's usual BMCUs forecast for
      // this shift scope — the default for the "Plan to plant requirements" table
      plants: plants.map(pl => ({ id: pl.id, name: pl.name, has_coords: pl.has_coords, start_point: pl.start?.name || null,
        bmcu_count: bmcus.filter(b => catchments[b.id]?.plant_id === pl.id).length,
        catchment_forecast_litres: Math.round(instance.nodes.filter(n => n.plant_id === pl.id).reduce((s, n) => s + n.litres, 0) * 100) / 100 })),
      distance_coverage: dayData.distanceCoverage(bmcus, plants, catchments, distMap, radius),
    });
  } catch (err) {
    console.error('[optimizer-v2] preview error:', err);
    res.status(500).json({ error: 'Failed to build Day Optimizer preview' });
  }
});

// =============================================================================
// POST /api/optimize/day  { plan_for_date, shift, constraints?, demand_overrides?, exclude_tanker_ids?,
//   mode? ('catchment' | 'plant_requirements'), plant_requirements?, allocation?, pinned_bmcu_ids? }
// mode 'plant_requirements' (docs/OPTIMISATION_PLAN.md §3.2b): the planner
// gives the litres each plant requires; services/plantAllocation.js decides
// which BMCUs go where (plants not listed require nothing), then the same
// routing runs on the allocation with plant switching off.
// =============================================================================
const MODES = ['catchment', 'plant_requirements'];
router.post('/day', authenticate, canPlan, v2Gate, async (req, res) => {
  const p = parseDayParams(req.body || {});
  if (p.error) return res.status(400).json({ error: p.error });
  const { constraints = {}, demand_overrides = [], exclude_tanker_ids = [], plant_requirements = [], pinned_bmcu_ids = [] } = req.body || {};
  const mode = req.body?.mode || 'catchment';
  if (!Array.isArray(demand_overrides) || !Array.isArray(exclude_tanker_ids) || !Array.isArray(plant_requirements) || !Array.isArray(pinned_bmcu_ids))
    return res.status(400).json({ error: 'demand_overrides, exclude_tanker_ids, plant_requirements and pinned_bmcu_ids must be arrays' });
  if (!MODES.includes(mode)) return res.status(400).json({ error: 'mode must be catchment or plant_requirements' });
  const overrides = demand_overrides.filter(o => o && o.bmcu_id && ['AM', 'PM'].includes(o.shift) && Number.isFinite(parseFloat(o.litres)));
  const excludeIds = new Set(exclude_tanker_ids.map(Number));
  const reqMode = mode === 'plant_requirements';
  const reqs = reqMode ? normaliseRequirements(plant_requirements) : new Map();
  const allocOptions = mergeAllocationOptions(req.body?.allocation);
  const pinnedIds = pinned_bmcu_ids.map(Number).filter(Number.isFinite);
  if (reqMode && ![...reqs.values()].some(r => r.required_litres > 0))
    return res.status(400).json({ error: 'plant_requirements must list at least one plant with required_litres > 0' });
  try {
    const built = await dayData.buildInstance(p.plan_for_date, p.shift, overrides, { includeSale: req.body?.include_sale === true });
    const { instance, plants, fleet, excluded, rates, demand } = built;
    for (const t of instance.tankers.filter(t => excludeIds.has(t.id)))
      excluded.push({ tanker_id: t.id, tanker_number: t.tanker_number, reason: 'Excluded by planner' });
    instance.tankers = instance.tankers.filter(t => !excludeIds.has(t.id));
    let demandNodes = instance.nodes.filter(n => n.litres > 0);
    if (!demandNodes.length) return res.status(400).json({ error: `No demand for ${p.plan_for_date} ${p.shift}: no RMRD history, plan quantities or overrides for any active BMCU` });
    if (!instance.tankers.length) return res.status(400).json({ error: 'No available tankers with a valid rate for this date — see excluded tankers in the preview' });

    // Cap the time budget so the request stays well inside proxy/DB timeouts
    const c = { ...constraints };
    c.time_budget_ms = Math.min(Math.max(parseInt(c.time_budget_ms) || DEFAULT_CONSTRAINTS.time_budget_ms, 500), 20000);

    let allocation = null;
    if (reqMode) {
      const plantById = new Map(plants.map(pl => [pl.id, pl]));
      const missing = [...reqs.entries()].filter(([id, r]) => r.required_litres > 0 && !plantById.get(id)?.has_coords)
        .map(([id]) => plantById.get(id)?.name || `#${id}`);
      if (missing.length) return res.status(400).json({ error: `Plant(s) without coordinates cannot take a requirement: ${missing.join(', ')} — fill lat/lng in Masters → Delivery Points` });
      // ₹/km proxy for ranking moves: litre-weighted mean of the fleet's BMCU rate
      let wSum = 0, capSum = 0;
      for (const t of instance.tankers) { const r = t.rates[TT_BMCU] || t.rates[TT_P2P]; if (r > 0) { wSum += t.capacity_litres * r; capSum += t.capacity_litres; } }
      const ratePerKm = capSum > 0 ? wSum / capSum : 30;
      const allocPlants = plants.filter(pl => pl.has_coords || reqs.has(pl.id)).map(pl => {
        const r = reqs.get(pl.id);
        return { id: pl.id, name: pl.name, end: pl.end, required_litres: r?.required_litres || 0, priority: r?.priority, locked: !!r?.locked };
      });
      const alloc = allocatePlants({ nodes: demandNodes, plants: allocPlants, resolve: instance.resolve, ratePerKm, options: allocOptions, pinnedBmcuIds: pinnedIds });
      demandNodes = demandNodes.map(n => ({ ...n, catchment_plant_id: n.plant_id, plant_id: alloc.assignments.get(n.bmcu_id) ?? n.plant_id }));
      const byId = new Map(demandNodes.map(d => [d.bmcu_id, d]));
      instance.nodes = instance.nodes.map(n => byId.get(n.bmcu_id) || n);
      const usedPlantIds = new Set(demandNodes.map(n => n.plant_id));
      instance.plants = plants.filter(pl => usedPlantIds.has(pl.id));
      c.allow_plant_switch = false;   // the allocation decided the plants
      allocation = {
        mode, options: alloc.options, rate_per_km_proxy: Math.round(ratePerKm * 100) / 100,
        plants: alloc.plants, moves: alloc.moves, notes: alloc.notes, totals: alloc.totals,
        flagged_bmcu_ids: alloc.flagged_bmcu_ids, pinned_bmcu_ids: pinnedIds,
        requirements: [...reqs.entries()].map(([delivery_point_id, r]) => ({ delivery_point_id, ...r })),
      };
    }
    if (!instance.plants.length) return res.status(400).json({ error: 'No plant catchment could be resolved — check delivery point coordinates' });
    const result = runFleetOptimizer(instance, c);
    if (allocation) {
      // What the routed plan actually delivers per plant (unserved pickups drop out here)
      const delivered = new Map();
      for (const t of result.trips) delivered.set(t.plant_id, (delivered.get(t.plant_id) || 0) + t.total_qty_litres);
      for (const pl of allocation.plants) pl.delivered_by_plan = Math.round((delivered.get(pl.id) || 0) * 100) / 100;
      if (allocation.moves.length) result.warnings.push(`${allocation.moves.length} BMCU(s) sent to a plant other than their usual one — see Plant allocation.`);
      for (const n of allocation.notes) result.warnings.push(n);
    }

    await dayData.saveForecasts(p.plan_for_date, demand, overrides);
    const comparison = await dayData.loadComparison(p.plan_for_date, p.shift, fleet, rates);
    const forecastAccuracy = await dayData.loadForecastAccuracy(p.plan_for_date, instance.nodes, req.body?.include_sale === true,
      { shift: p.shift, plantNameById: Object.fromEntries(plants.map(pl => [pl.id, pl.name])) });
    if (comparison) {
      comparison.forecast_accuracy = forecastAccuracy;
      // Deltas are optimiser − actual; the executed block is the primary one
      // (₹/L and fill use executed RMRD litres), the flat fields mirror it.
      const d = (a, b) => a == null || b == null ? null : Math.round((a - b) * 100) / 100;
      const deltaFor = blk => ({
        trips: d(result.totals.trips, blk.trips), km: d(result.totals.km, blk.km),
        cost: d(result.totals.cost, blk.cost), litres: d(result.totals.litres, blk.litres),
        cost_per_litre: d(result.totals.cost_per_litre, blk.cost_per_litre),
        avg_fill_pct: d(result.totals.avg_fill_pct, blk.avg_fill_pct),
        tankers_used: d(new Set(result.trips.map(t => t.tanker_id)).size, blk.tankers_used),
      });
      if (comparison.actual_executed) comparison.actual_executed.delta = deltaFor(comparison.actual_executed);
      if (comparison.actual_planned) comparison.actual_planned.delta = deltaFor(comparison.actual_planned);
      comparison.delta = deltaFor(comparison);
    }
    if (excluded.length) result.warnings.push(`${excluded.length} tanker(s) excluded — see Excluded tankers.`);
    await suggestRouteNames(result.trips);

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
        [p.plan_for_date, shiftsMilk,
         JSON.stringify({ ...result.constraints, mode, ...(allocation ? { plant_requirements: allocation.requirements, allocation: allocation.options, pinned_bmcu_ids: pinnedIds } : {}) }),
         p.shift,
         demandNodes.length, result.totals.litres, result.totals.trips, result.totals.km, result.totals.cost,
         result.totals.estimated_legs ? null : 100,
         comparison ? JSON.stringify(comparison) : null,
         JSON.stringify({ totals: result.totals, unserved: result.unserved, excluded_tankers: excluded, warnings: result.warnings, stats: result.stats, allocation }),
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
              transport_type, rate_state, flags, shift_code, route_name, vendor_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
          [sessionId, t.trip_seq, t.tanker_id, t.tanker_number, t.capacity_litres, t.rate_per_km, t.total_qty_litres, t.fill_pct,
           t.km, t.cost, t.cost_per_litre, t.flags.estimated_legs > 0, t.delivery_point_id, t.start_point_id,
           t.transport_type, t.rate_state, JSON.stringify(t.flags), shiftsMilk.slice(0, 5), t.route_name, t.vendor_name]);
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
      session_id: sessionId, plan_for_date: p.plan_for_date, shift: p.shift, mode, allocation,
      constraints: result.constraints,
      plants: plants.filter(pl => instance.plants.some(ip => ip.id === pl.id)).map(pl => ({ id: pl.id, name: pl.name })),
      trips: result.trips, totals: result.totals, unserved: result.unserved,
      excluded_tankers: excluded, warnings: result.warnings, comparison, forecast_accuracy: forecastAccuracy, stats: result.stats,
    });
  } catch (err) {
    console.error('[optimizer-v2] run error:', err);
    res.status(500).json({ error: 'Day Optimizer run failed' });
  }
});

// =============================================================================
// GET /api/optimize/:sessionId/report — Excel of a Day Optimizer session
// Sheets: Summary (inputs, constraints, totals, comparison, unserved,
// excluded tankers), Trip Wise, BMCU Pickups, Tanker Wise.
// =============================================================================
const XL_THIN = { style: 'thin', color: { argb: 'FFD1D5DB' } };
const XL_BORDER = { top: XL_THIN, bottom: XL_THIN, left: XL_THIN, right: XL_THIN };
const xlFill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const INR_FMT = '#,##0.00', INT_FMT = '#,##0', KM_FMT = '#,##0.0';
function xlHeader(ws, row, headers, fill = 'FFE0F2FE') {
  headers.forEach((h, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = h; c.font = { bold: true, color: { argb: 'FF1F2937' } }; c.fill = xlFill(fill); c.border = XL_BORDER;
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  ws.getRow(row).height = 28;
}
function xlTitle(ws, text, span) {
  ws.mergeCells(1, 1, 1, span);
  const c = ws.getCell(1, 1); c.value = text; c.font = { bold: true, size: 13, color: { argb: 'FF0C4A6E' } };
  c.alignment = { horizontal: 'left', vertical: 'middle' }; ws.getRow(1).height = 22;
}
function xlRow(ws, row, values, fmts = {}, opts = {}) {
  values.forEach((v, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = v == null ? '' : v; c.border = XL_BORDER;
    if (fmts[i]) c.numFmt = fmts[i];
    if (opts.bold) c.font = { bold: true };
    if (opts.fill) c.fill = xlFill(opts.fill);
  });
}
const fmtDdMm = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('-') : '';

router.get('/:sessionId(\\d+)/report', authenticate, canPlan, v2Gate, async (req, res) => {
  const sessionId = parseInt(req.params.sessionId);
  try {
    const s = (await pool.query(`
      SELECT os.*, u.full_name AS created_by_name FROM optimization_sessions os
      LEFT JOIN users u ON u.id = os.created_by WHERE os.id = $1 AND os.algorithm = 'fleet_v2'`, [sessionId])).rows[0];
    if (!s) return res.status(404).json({ error: 'Day Optimizer session not found' });
    const trips = (await pool.query(`
      SELECT ot.*, dp.name AS plant_name, t.vendor_id, COALESCE(ot.vendor_name, v.vendor_name, t.vendor_name) AS vendor
      FROM optimization_trips ot
      LEFT JOIN delivery_points dp ON dp.id = ot.delivery_point_id
      LEFT JOIN tankers t ON t.id = ot.tanker_id
      LEFT JOIN vendors v ON v.id = t.vendor_id
      WHERE ot.session_id = $1 ORDER BY dp.name, ot.trip_seq`, [sessionId])).rows;
    const pickups = (await pool.query(`
      SELECT otb.opt_trip_id, otb.seq_no, otb.bmcu_id, otb.expected_qty_litres, otb.leg_km, otb.leg_is_estimated,
             b.bmcu_code, b.bmcu_name, oi.shift_code
      FROM optimization_trip_bmcus otb
      JOIN optimization_trips ot ON ot.id = otb.opt_trip_id
      JOIN bmcus b ON b.id = otb.bmcu_id
      LEFT JOIN optimization_inputs oi ON oi.session_id = ot.session_id AND oi.bmcu_id = otb.bmcu_id
      WHERE ot.session_id = $1 ORDER BY ot.trip_seq, otb.seq_no`, [sessionId])).rows;
    const byTrip = new Map();
    for (const p of pickups) { if (!byTrip.has(p.opt_trip_id)) byTrip.set(p.opt_trip_id, []); byTrip.get(p.opt_trip_id).push(p); }
    const summary = s.summary || {}, cmp = s.comparison || null, C = s.constraints || {};
    const n = v => (v == null ? null : Number(v));

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Shreeja TMS';
    // ── Summary ─────────────────────────────────────────────────────────────
    const ws = wb.addWorksheet('Summary');
    ws.columns = [{ width: 34 }, { width: 20 }, { width: 20 }, { width: 20 }, { width: 20 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 60 }];
    xlTitle(ws, `Day Optimizer — ${fmtDdMm(s.plan_for_date)} (${s.shifts_milk})  ·  Session #${s.id}`, 5);
    let r = 3;
    const kv = (k, v, fmt) => { xlRow(ws, r, [k, v], { 1: fmt }); r++; };
    kv('Plan date', fmtDdMm(s.plan_for_date)); kv('Shift', s.shifts_milk); kv('Run by', s.created_by_name || '');
    kv('Run at', s.created_at ? new Date(s.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '');
    r++; xlRow(ws, r, ['Constraints'], {}, { bold: true, fill: 'FFF1F5F9' }); r++;
    kv('Fill floor', C.fill_floor != null ? `${Math.round(C.fill_floor * 100)} %` : ''); kv('Max trips per tanker per day', C.max_trips_per_tanker_per_day);
    kv('Max BMCUs per trip', C.max_bmcus_per_trip); kv('Max km per trip', C.max_trip_km);
    kv('Plant switch allowed', C.allow_plant_switch ? 'Yes' : 'No'); kv('Time budget (ms) / iterations', `${C.time_budget_ms} / ${C.max_iterations}`);
    const alloc = summary.allocation || null;
    kv('Mode', alloc ? 'Plan to plant requirements (see sheet "Plant Allocation")' : 'Plan by usual catchments');
    if (alloc) { kv('Max extra km per BMCU / shortfall rule', `${alloc.options?.max_extra_km_per_bmcu} km / ${alloc.options?.shortfall_rule}`); }
    r++;
    const tot = summary.totals || {};
    // Comparison blocks: sessions before 2026-09-25 stored one flat block
    // (mixed planned/executed figures) — treat it as the executed column.
    const ex = cmp ? (cmp.actual_executed || (cmp.actual_planned ? null : cmp)) : null;
    const pl = cmp?.actual_planned || null;
    const dateLabel = cmp ? (cmp.source === 'actual_plans' ? `Actual = trips of ${fmtDdMm(cmp.date)}` : `Actual = same weekday last week (${fmtDdMm(cmp.date)})`) : 'No actual trips to compare';
    xlHeader(ws, r, ['Totals', 'Optimizer (forecast)', 'Actual (executed)', 'Δ (opt − executed)', 'Planned', '', '', '', dateLabel]); r++;
    const lines = [
      ['Trips', tot.trips, ex?.trips, pl?.trips, INT_FMT], ['Litres (optimizer = forecast; actual = RMRD)', tot.litres, ex?.litres, pl?.litres, INT_FMT],
      ['Km', tot.km, ex?.km, pl?.km, KM_FMT],
      ['Cost ₹', tot.cost, ex?.cost, pl?.cost, INR_FMT], ['Cost per litre ₹', tot.cost_per_litre, ex?.cost_per_litre, pl?.cost_per_litre, '0.0000'],
      ['Average fill %', tot.avg_fill_pct, ex?.avg_fill_pct, pl?.avg_fill_pct, KM_FMT],
      ['Tankers used', new Set(trips.map(t => t.tanker_id)).size, ex?.tankers_used, pl?.tankers_used, INT_FMT],
      ['Acknowledged litres', null, ex?.ack_litres, null, INT_FMT],
      ['Trips below fill floor', tot.below_fill_floor_trips, null, null, INT_FMT], ['Estimated legs', tot.estimated_legs, null, null, INT_FMT],
      ['Unserved BMCU pickups', (summary.unserved || []).length, null, null, INT_FMT],
    ];
    for (const [k, a, b, c, fmt] of lines) {
      const d = a != null && b != null ? Math.round((n(a) - n(b)) * 10000) / 10000 : null;
      xlRow(ws, r, [k, n(a), n(b), d, n(c)], { 1: fmt, 2: fmt, 3: fmt, 4: fmt });
      if (d != null && d !== 0 && !k.startsWith('Litres') && k !== 'Average fill %') ws.getCell(r, 4).font = { color: { argb: d < 0 ? 'FF1E8449' : 'FFC0392B' }, bold: true };
      ws.getCell(r, 5).font = { color: { argb: 'FF6B7280' } };
      r++;
    }
    const fa = cmp?.forecast_accuracy || null;
    if (fa) {
      const pct = fa.error_pct == null ? '' : ` (${fa.error_pct > 0 ? '+' : ''}${fa.error_pct} %)`;
      xlRow(ws, r, ['Forecast vs actual RMRD',
        `Forecast ${Math.round(fa.forecast_litres).toLocaleString('en-IN')} L · Actual RMRD vendor ${Math.round(fa.actual_rmrd_vendor).toLocaleString('en-IN')} L · sale ${Math.round(fa.actual_rmrd_sale).toLocaleString('en-IN')} L · all ${Math.round(fa.actual_rmrd_all).toLocaleString('en-IN')} L · error ${fa.error_litres > 0 ? '+' : ''}${Math.round(fa.error_litres).toLocaleString('en-IN')} L${pct} — see sheet "Forecast vs RMRD"`]);
      const ap = Math.abs(fa.error_pct ?? 0);
      ws.getCell(r, 2).font = { bold: true, color: { argb: ap <= 5 ? 'FF1E8449' : ap <= 10 ? 'FFB7791F' : 'FFC0392B' } };
      r++;
    }
    if (ex?.basis) { xlRow(ws, r, ['Actual basis', ex.basis]); r++; }
    if (pl?.basis) { xlRow(ws, r, ['Planned basis', pl.basis]); r++; }
    if (cmp?.note) { xlRow(ws, r, ['Note', cmp.note]); r++; }
    if (ex?.trip_list?.length) {
      r++; xlHeader(ws, r, ['Executed trip — Tanker', 'Plant', 'Route', 'BMCUs', 'Litres (RMRD)', 'Km', 'Cost ₹', 'Cost source', 'BMCU chain']); r++;
      for (const t of ex.trip_list) {
        xlRow(ws, r, [t.tanker_number, t.plant_name || '', t.route_name || '', t.bmcu_count, n(t.litres), n(t.km), n(t.cost), t.cost_source === 'billed' ? 'Billed' : t.cost_source === 'rate' ? `Km × rate (${t.km_source} km)` : 'No rate', t.bmcus || ''],
          { 4: INT_FMT, 5: KM_FMT, 6: INR_FMT });
        r++;
      }
      xlRow(ws, r, ['TOTAL', '', '', ex.trip_list.reduce((s, t) => s + (t.bmcu_count || 0), 0), n(ex.litres), n(ex.km), n(ex.cost), `${ex.billed_trips} billed / ${ex.priced_trips} priced of ${ex.trips}`],
        { 4: INT_FMT, 5: KM_FMT, 6: INR_FMT }, { bold: true, fill: 'FFF1F5F9' });
      r++;
    }
    const st = summary.stats;
    if (st) { r++; kv('Search', `seed ₹${st.seed_cost} → ₹${st.search_cost}; ${st.iterations} iterations, ${st.accepted} accepted, ${st.restarts} restarts, ${st.elapsed_ms} ms`); }
    for (const w of summary.warnings || []) { kv('Warning', w); }
    const unserved = summary.unserved || [];
    r++; xlHeader(ws, r, ['Unserved BMCU', 'Litres', 'Reason', '', '']); r++;
    if (!unserved.length) { xlRow(ws, r, ['None — every BMCU pickup is served']); r++; }
    for (const u of unserved) { xlRow(ws, r, [`${u.bmcu_code || ''} ${u.bmcu_name || ''}`.trim(), n(u.litres), u.reason], { 1: INT_FMT }); r++; }
    const excluded = summary.excluded_tankers || [];
    r++; xlHeader(ws, r, ['Excluded tanker', 'Reason', '', '', '']); r++;
    if (!excluded.length) { xlRow(ws, r, ['None']); r++; }
    for (const e of excluded) { xlRow(ws, r, [e.tanker_number, e.reason]); r++; }

    // ── Trip Wise ───────────────────────────────────────────────────────────
    const wt = wb.addWorksheet('Trip Wise');
    const tripHead = ['#', 'Plant', 'Route', 'Tanker', 'Vendor', 'Capacity L', 'State', 'Transport type', 'BMCUs', 'Litres', 'Fill %', 'Km', 'Rate ₹/km', 'Cost ₹', '₹/L', 'Flags', 'BMCU chain'];
    wt.columns = [6, 18, 22, 14, 18, 11, 16, 20, 8, 11, 8, 9, 10, 12, 8, 24, 60].map(w => ({ width: w }));
    xlTitle(wt, `Trip Wise — ${fmtDdMm(s.plan_for_date)} (${s.shifts_milk})`, tripHead.length);
    xlHeader(wt, 3, tripHead); wt.views = [{ state: 'frozen', ySplit: 3 }];
    const tripFmts = { 5: INT_FMT, 9: INT_FMT, 10: KM_FMT, 11: KM_FMT, 12: INR_FMT, 13: INR_FMT, 14: '0.0000' };
    let tr = 4;
    const flagsOf = t => { const f = t.flags || {}; return [f.below_fill_floor && 'below fill floor', f.estimated_legs > 0 && `${f.estimated_legs} est. leg(s)`, f.over_max_km && 'over km limit'].filter(Boolean).join(', '); };
    let curPlant = null, plantAgg = null;
    const aggRow = (label, a) => {
      xlRow(wt, tr, [label, '', '', `${a.tankers.size} tankers`, '', '', '', '', a.bmcus, a.litres, a.cap ? a.litres / a.cap * 100 : null, a.km, '', a.cost, a.litres ? a.cost / a.litres : null], tripFmts, { bold: true, fill: 'FFF1F5F9' });
      tr++;
    };
    const newAgg = () => ({ trips: 0, tankers: new Set(), bmcus: 0, litres: 0, cap: 0, km: 0, cost: 0 });
    const all = newAgg();
    for (const t of trips) {
      if (t.plant_name !== curPlant) { if (plantAgg) aggRow(`${curPlant} total (${plantAgg.trips} trips)`, plantAgg); curPlant = t.plant_name; plantAgg = newAgg(); }
      const ps = byTrip.get(t.id) || [];
      xlRow(wt, tr, [t.trip_seq, t.plant_name, t.route_name || '', t.tanker_number, t.vendor || '', n(t.capacity_litres), t.rate_state || '', t.transport_type || '',
        ps.length, n(t.total_qty_litres), n(t.utilization_pct), n(t.estimated_km), n(t.per_km_rate), n(t.estimated_cost), n(t.per_liter_cost), flagsOf(t),
        ps.map(p => `${p.bmcu_code} (${Math.round(p.expected_qty_litres)} L, ${Number(p.leg_km || 0).toFixed(1)} km)`).join(' → ')], tripFmts);
      tr++;
      for (const a of [plantAgg, all]) { a.trips++; a.tankers.add(t.tanker_id); a.bmcus += ps.length; a.litres += n(t.total_qty_litres) || 0; a.cap += n(t.capacity_litres) || 0; a.km += n(t.estimated_km) || 0; a.cost += n(t.estimated_cost) || 0; }
    }
    if (plantAgg) aggRow(`${curPlant} total (${plantAgg.trips} trips)`, plantAgg);
    aggRow(`GRAND TOTAL (${all.trips} trips)`, all);

    // ── BMCU Pickups ────────────────────────────────────────────────────────
    const wp = wb.addWorksheet('BMCU Pickups');
    const pHead = ['Trip #', 'Plant', 'Route', 'Tanker', 'Seq', 'BMCU code', 'BMCU name', 'Shift', 'Litres', 'Leg km', 'Cumulative litres', 'Fill so far %'];
    wp.columns = [8, 18, 22, 14, 6, 11, 28, 8, 11, 9, 14, 11].map(w => ({ width: w }));
    xlTitle(wp, `BMCU Pickups — ${fmtDdMm(s.plan_for_date)} (${s.shifts_milk})`, pHead.length);
    xlHeader(wp, 3, pHead); wp.views = [{ state: 'frozen', ySplit: 3 }];
    let pr = 4;
    for (const t of trips) {
      let cum = 0;
      for (const p of byTrip.get(t.id) || []) {
        cum += n(p.expected_qty_litres) || 0;
        xlRow(wp, pr, [t.trip_seq, t.plant_name, t.route_name || '', t.tanker_number, p.seq_no, p.bmcu_code, p.bmcu_name, p.shift_code || s.shifts_milk,
          n(p.expected_qty_litres), p.leg_km == null ? null : n(p.leg_km), cum, t.capacity_litres ? cum / n(t.capacity_litres) * 100 : null],
        { 8: INT_FMT, 9: KM_FMT, 10: INT_FMT, 11: KM_FMT });
        if (p.leg_is_estimated) wp.getCell(pr, 10).font = { italic: true, color: { argb: 'FF92400E' } };
        pr++;
      }
    }

    // ── Tanker Wise ─────────────────────────────────────────────────────────
    const wk = wb.addWorksheet('Tanker Wise');
    const kHead = ['Tanker', 'Vendor', 'Capacity L', 'State', 'Trips', 'Litres', 'Avg fill %', 'Km', 'Cost ₹', '₹/L', 'Routes'];
    wk.columns = [14, 20, 11, 16, 7, 11, 10, 9, 12, 8, 50].map(w => ({ width: w }));
    xlTitle(wk, `Tanker Wise — ${fmtDdMm(s.plan_for_date)} (${s.shifts_milk})`, kHead.length);
    xlHeader(wk, 3, kHead); wk.views = [{ state: 'frozen', ySplit: 3 }];
    const perTanker = new Map();
    for (const t of trips) {
      const k = perTanker.get(t.tanker_id) || { tanker: t.tanker_number, vendor: t.vendor, cap: n(t.capacity_litres), state: t.rate_state, trips: 0, litres: 0, km: 0, cost: 0, routes: [] };
      k.trips++; k.litres += n(t.total_qty_litres) || 0; k.km += n(t.estimated_km) || 0; k.cost += n(t.estimated_cost) || 0; k.routes.push(`#${t.trip_seq} ${t.route_name || ''}`);
      perTanker.set(t.tanker_id, k);
    }
    let kr = 4;
    for (const k of [...perTanker.values()].sort((a, b) => a.tanker < b.tanker ? -1 : 1)) {
      xlRow(wk, kr, [k.tanker, k.vendor || '', k.cap, k.state || '', k.trips, k.litres, k.cap ? k.litres / (k.cap * k.trips) * 100 : null, k.km, k.cost, k.litres ? k.cost / k.litres : null, k.routes.join('; ')],
        { 2: INT_FMT, 5: INT_FMT, 6: KM_FMT, 7: KM_FMT, 8: INR_FMT, 9: '0.0000' });
      kr++;
    }
    xlRow(wk, kr, ['TOTAL', '', '', '', all.trips, all.litres, all.cap ? all.litres / all.cap * 100 : null, all.km, all.cost, all.litres ? all.cost / all.litres : null, `${perTanker.size} tankers`],
      { 5: INT_FMT, 6: KM_FMT, 7: KM_FMT, 8: INR_FMT, 9: '0.0000' }, { bold: true, fill: 'FFF1F5F9' });

    // ── Forecast vs RMRD (only when the date was executed) ──────────────────
    if (fa) {
      const wf = wb.addWorksheet('Forecast vs RMRD');
      wf.columns = [30, 16, 16, 16, 14, 24].map(w => ({ width: w }));
      xlTitle(wf, `Forecast vs actual RMRD — ${fmtDdMm(fa.date)} (${fa.shift === 'BOTH' ? 'AM+PM' : fa.shift})`, 6);
      let fr = 3;
      const fkv = (k, v, fmt) => { xlRow(wf, fr, [k, v], { 1: fmt }); fr++; };
      fkv('Basis', fa.basis_label || fa.basis);
      fkv('Forecast litres (after planner overrides)', n(fa.forecast_litres), INT_FMT);
      fkv('Actual RMRD — vendor tankers', n(fa.actual_rmrd_vendor), INT_FMT);
      fkv('Actual RMRD — sale tankers', n(fa.actual_rmrd_sale), INT_FMT);
      fkv('Actual RMRD — all', n(fa.actual_rmrd_all), INT_FMT);
      fkv(`Error litres (forecast − ${fa.basis} RMRD)`, n(fa.error_litres), INT_FMT);
      fkv('Error %', fa.error_pct == null ? '' : n(fa.error_pct), KM_FMT);
      const ap = Math.abs(fa.error_pct ?? 0);
      wf.getCell(fr - 1, 2).font = { bold: true, color: { argb: ap <= 5 ? 'FF1E8449' : ap <= 10 ? 'FFB7791F' : 'FFC0392B' } };
      fkv('BMCUs forecast', fa.bmcus_forecast, INT_FMT); fkv('BMCUs lifted', fa.bmcus_lifted, INT_FMT);
      fkv('Forecast but not lifted', fa.bmcus_forecast_not_lifted, INT_FMT); fkv('Lifted but not forecast', fa.bmcus_lifted_not_forecast, INT_FMT);
      fr++;
      xlHeader(wf, fr, ['BMCU', 'Plant', 'Forecast L', 'Actual RMRD L', 'Diff L', 'Lifted by / note']); fr++;
      wf.views = [{ state: 'frozen', ySplit: fr - 1 }];
      for (const b of fa.per_bmcu || []) {
        const note = [b.lifted_by, b.flag === 'forecast_not_lifted' ? 'forecast but not lifted' : b.flag === 'lifted_not_forecast' ? 'lifted but not forecast' : null].filter(Boolean).join(' · ');
        xlRow(wf, fr, [`${b.bmcu_code || ''} ${b.bmcu_name || ''}`.trim(), b.plant_name || '', n(b.forecast), n(b.actual), n(b.diff), note], { 2: INT_FMT, 3: INT_FMT, 4: INT_FMT });
        if (b.diff) wf.getCell(fr, 5).font = { color: { argb: b.diff > 0 ? 'FFC0392B' : 'FF1E8449' } };
        fr++;
      }
      xlRow(wf, fr, ['TOTAL', '', n(fa.forecast_litres), n(fa.basis === 'all' ? fa.actual_rmrd_all : fa.actual_rmrd_vendor), n(fa.error_litres), ''], { 2: INT_FMT, 3: INT_FMT, 4: INT_FMT }, { bold: true, fill: 'FFF1F5F9' });
    }

    // ── Plant Allocation (only for "Plan to plant requirements" sessions) ───
    if (alloc) {
      const wa = wb.addWorksheet('Plant Allocation');
      wa.columns = [26, 10, 9, 14, 14, 14, 14, 14, 14, 14, 10, 50].map(w => ({ width: w }));
      xlTitle(wa, `Plant allocation — ${fmtDdMm(s.plan_for_date)} (${s.shifts_milk})  ·  max extra ${alloc.options?.max_extra_km_per_bmcu} km per BMCU, shortfall rule ${alloc.options?.shortfall_rule}, keep-history ${alloc.options?.keep_history_bonus_pct} %`, 12);
      let ar = 3;
      xlHeader(wa, ar, ['Plant', 'Priority', 'Locked', 'Required L', 'Target L (after shortfall)', 'Allocated L', 'Delivered by plan L', 'Unmet L', 'Oversupplied L', 'Moved in L', 'Moved out L', 'Note']); ar++;
      const aF = { 3: INT_FMT, 4: INT_FMT, 5: INT_FMT, 6: INT_FMT, 7: INT_FMT, 8: INT_FMT, 9: INT_FMT, 10: INT_FMT };
      const tot = { required: 0, eff: 0, allocated: 0, delivered: 0, unmet: 0, over: 0, in: 0, out: 0 };
      for (const pl of alloc.plants || []) {
        xlRow(wa, ar, [pl.name, pl.priority, pl.locked ? 'Yes' : '', n(pl.required), n(pl.effective_required), n(pl.allocated), n(pl.delivered_by_plan), n(pl.unmet), n(pl.oversupplied), n(pl.moved_in), n(pl.moved_out), pl.unmet_reason || ''], aF);
        if (pl.unmet > 0) wa.getCell(ar, 8).font = { bold: true, color: { argb: 'FFC0392B' } };
        if (pl.oversupplied > 0) wa.getCell(ar, 9).font = { color: { argb: 'FFB7791F' } };
        tot.required += n(pl.required) || 0; tot.eff += n(pl.effective_required) || 0; tot.allocated += n(pl.allocated) || 0; tot.delivered += n(pl.delivered_by_plan) || 0;
        tot.unmet += n(pl.unmet) || 0; tot.over += n(pl.oversupplied) || 0; tot.in += n(pl.moved_in) || 0; tot.out += n(pl.moved_out) || 0;
        ar++;
      }
      xlRow(wa, ar, ['TOTAL', '', '', tot.required, tot.eff, tot.allocated, tot.delivered, tot.unmet, tot.over, tot.in, tot.out, `forecast supply ${Math.round(alloc.totals?.supply || 0).toLocaleString('en-IN')} L`], aF, { bold: true, fill: 'FFF1F5F9' });
      ar += 2;
      xlHeader(wa, ar, ['BMCU reassigned', 'Litres', '', 'From plant', 'To plant', 'Extra km', 'Marginal cost ₹', 'Flag', '', '', '', 'Reason']); ar++;
      if (!(alloc.moves || []).length) { xlRow(wa, ar, ['None — every BMCU goes to its usual plant']); ar++; }
      for (const m of alloc.moves || []) {
        xlRow(wa, ar, [`${m.bmcu_code || ''} ${m.bmcu_name || ''}`.trim(), n(m.litres), '', m.from_plant_name, m.to_plant_name, n(m.extra_km), n(m.marginal_cost),
          m.flag === 'beyond_max_extra_km' ? 'beyond km limit' : m.flag === 'oversupplied' ? 'oversupplies' : '', '', '', '', m.reason || ''], { 1: INT_FMT, 5: KM_FMT, 6: INR_FMT });
        if (m.flag) wa.getCell(ar, 8).font = { color: { argb: 'FFC0392B' } };
        ar++;
      }
      if ((alloc.pinned_bmcu_ids || []).length) { ar++; xlRow(wa, ar, ['Pinned to usual plant (planner)', alloc.pinned_bmcu_ids.length + ' BMCU(s)']); ar++; }
      for (const note of alloc.notes || []) { xlRow(wa, ar, ['Note', note]); ar++; }
    }

    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Disposition', `attachment; filename=day_optimizer_${s.plan_for_date}_session${s.id}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('[optimizer-v2] report error:', err);
    res.status(500).json({ error: 'Failed to build the Day Optimizer report' });
  }
});

// =============================================================================
// POST /api/optimize/prefetch-distances — Google-fetch missing nearby pairs
// =============================================================================
router.post('/prefetch-distances', authenticate, canPlan, v2Gate, async (req, res) => {
  try {
    const radiusKm = parseFloat(process.env.OPTIMIZER_PREFETCH_RADIUS_KM || '150') || 150;
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
