// backend/src/services/optimizerV2.js
// =============================================================================
// Day Optimizer (fleet v2) — docs/OPTIMISATION_PLAN.md §3.2.
//
// Plans ONE date for ALL BMCUs across ALL plants with the WHOLE available
// fleet, minimising   Σ over trips of  km × per-km rate of the tanker driving it
// subject to: tanker capacity (with a fill floor), max BMCUs per trip, max km
// per trip, max trips per tanker per day, and a BMCU's plant catchment (a BMCU
// may only move to another plant when allow_plant_switch is set).
//
// Method:
//   1. Seed: Clarke-Wright savings per plant (optimizerCore.clarkeWrightSavings,
//      capacity = largest available tanker), split to honour max BMCUs / max km,
//      nearest-neighbour order within each trip.
//   2. Cost-aware assignment: for every trip (largest load first) the tanker
//      minimising km × rate among those with capacity ≥ load, a rate for the
//      trip's transport type ('Point to Point' for 1 BMCU, else 'BMCU/CC to
//      Dairy/CC') and trips left in its daily budget; tankers meeting the fill
//      floor are preferred, otherwise the trip is flagged below_fill_floor.
//   3. Local search (relocate, swap, 2-opt, merge, split) accepting only cost
//      reductions, with random restarts after a perturbation of the best
//      solution. Deterministic for a given seed and iteration cap (the time
//      budget only cuts the run short).
//
// This module has NO database access: routes/optimize.js builds the instance
// (nodes, plants, fleet, rates, distance resolver) and calls runFleetOptimizer.
// scripts/optimizer_v2_selftest.js runs it on a synthetic instance.
// =============================================================================

const { clarkeWrightSavings, nearestNeighbourOrder } = require('./optimizerCore');

const DEFAULT_CONSTRAINTS = Object.freeze({
  fill_floor: 0.85,                // preferred minimum load / capacity
  max_trips_per_tanker_per_day: 2,
  max_bmcus_per_trip: 6,
  max_trip_km: 450,
  allow_plant_switch: false,
  time_budget_ms: 8000,
  max_iterations: 150000,          // hard cap so a seed reproduces exactly
  restarts: 3,
  seed: 1,
});

const TT_P2P  = 'Point to Point';
const TT_BMCU = 'BMCU/CC to Dairy/CC';
function transportTypeFor(bmcuCount) { return bmcuCount <= 1 ? TT_P2P : TT_BMCU; }

// Penalty (₹ per litre) for milk the fleet cannot carry — far above any real
// cost per litre (~₹0.7) so the search always prefers serving a BMCU.
const UNSERVED_PENALTY_PER_LITRE = 5;

const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const r4 = v => Math.round(v * 10000) / 10000;

// mulberry32 — small deterministic PRNG
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const randInt = (rng, n) => Math.floor(rng() * n);

function mergeConstraints(overrides) {
  const c = { ...DEFAULT_CONSTRAINTS };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (!(k in DEFAULT_CONSTRAINTS) || v === undefined || v === null || v === '') continue;
    if (k === 'allow_plant_switch') c[k] = v === true || v === 'true';
    else { const n = Number(v); if (Number.isFinite(n)) c[k] = n; }
  }
  if (c.fill_floor > 1) c.fill_floor = c.fill_floor / 100; // accept 85 as 85 %
  c.max_bmcus_per_trip = Math.max(1, Math.floor(c.max_bmcus_per_trip));
  c.max_trips_per_tanker_per_day = Math.max(1, Math.floor(c.max_trips_per_tanker_per_day));
  c.restarts = Math.max(0, Math.floor(c.restarts));
  return c;
}

// ─── Route km with a start point that may differ from the end (plant) ────────
function routeKm(plant, nodes, resolve) {
  const legs = [];
  let total = 0, estimated = 0;
  let prev = plant.start || plant.end;
  for (const n of nodes) {
    const r = resolve(prev.type, prev.id, 'bmcu', n.bmcu_id);
    legs.push({ bmcu_id: n.bmcu_id, leg_km: r2(r.km), leg_is_estimated: !!r.estimated, leg_source: r.source });
    total += r.km; if (r.estimated) estimated++;
    prev = { type: 'bmcu', id: n.bmcu_id };
  }
  const ret = nodes.length ? resolve(prev.type, prev.id, plant.end.type, plant.end.id) : { km: 0, estimated: false, source: 'none' };
  total += ret.km; if (ret.estimated) estimated++;
  return {
    km: r1(total), legs, estimated_legs: estimated,
    return_leg: { leg_km: r2(ret.km), leg_is_estimated: !!ret.estimated, leg_source: ret.source },
  };
}

// ─── Context: instance + constraints + caches ────────────────────────────────
function makeContext(instance, constraints) {
  const plantsById = new Map(instance.plants.map(p => [p.id, p]));
  const tankers = instance.tankers
    .filter(t => t.capacity_litres > 0 && (t.rates?.[TT_P2P] > 0 || t.rates?.[TT_BMCU] > 0))
    .sort((a, b) => a.id - b.id);
  const maxCapacity = tankers.reduce((m, t) => Math.max(m, t.capacity_litres), 0);
  const maxRate = tankers.reduce((m, t) => Math.max(m, t.rates[TT_P2P] || 0, t.rates[TT_BMCU] || 0), 0);
  const kmCache = new Map();
  const ctx = {
    C: constraints, plantsById, tankers, maxCapacity, maxRate, resolve: instance.resolve,
    routeKm(plantId, nodes) {
      const key = plantId + '|' + nodes.map(n => n.bmcu_id).join(',');
      let v = kmCache.get(key);
      if (!v) {
        if (kmCache.size > 200000) kmCache.clear();
        v = routeKm(plantsById.get(plantId), nodes, instance.resolve);
        kmCache.set(key, v);
      }
      return v;
    },
  };
  return ctx;
}

function makeTrip(ctx, plantId, nodes) {
  const r = ctx.routeKm(plantId, nodes);
  return {
    plant_id: plantId, nodes,
    load: nodes.reduce((s, n) => s + n.litres, 0),
    km: r.km, legs: r.legs, return_leg: r.return_leg, estimated_legs: r.estimated_legs,
    tanker: null, rate: null, transport_type: transportTypeFor(nodes.length), cost: 0,
    below_fill_floor: false,
  };
}

function tripFeasible(ctx, trip) {
  const C = ctx.C;
  if (trip.nodes.length === 0 || trip.nodes.length > C.max_bmcus_per_trip) return false;
  if (trip.load > ctx.maxCapacity) return false;
  if (trip.km > C.max_trip_km) return false;
  return true;
}

// ─── Cost-aware tanker assignment for a whole solution ───────────────────────
// Mutates trip.tanker / rate / cost / below_fill_floor; returns total cost.
function assignFleet(ctx, trips) {
  const C = ctx.C;
  const budget = new Map(ctx.tankers.map(t => [t.id, C.max_trips_per_tanker_per_day]));
  const order = trips.map((t, i) => i).sort((a, b) =>
    trips[b].load - trips[a].load || trips[b].km - trips[a].km || trips[a].plant_id - trips[b].plant_id
    || trips[a].nodes[0].bmcu_id - trips[b].nodes[0].bmcu_id);
  let total = 0;
  for (const i of order) {
    const trip = trips[i];
    const tt = transportTypeFor(trip.nodes.length);
    let best = null, bestFloor = null, bestCost = Infinity, bestFloorCost = Infinity;
    for (const t of ctx.tankers) {
      if (budget.get(t.id) <= 0 || t.capacity_litres < trip.load) continue;
      const rate = t.rates[tt];
      if (!(rate > 0)) continue;
      const cost = trip.km * rate;
      const better = (c, bc, cur) => c < bc - 1e-9 || (Math.abs(c - bc) <= 1e-9 && cur && t.capacity_litres < cur.capacity_litres);
      if (trip.load / t.capacity_litres >= C.fill_floor - 1e-9) {
        if (better(cost, bestFloorCost, bestFloor)) { bestFloor = t; bestFloorCost = cost; }
      }
      if (better(cost, bestCost, best)) { best = t; bestCost = cost; }
    }
    const chosen = bestFloor || best;
    trip.transport_type = tt;
    if (chosen) {
      budget.set(chosen.id, budget.get(chosen.id) - 1);
      trip.tanker = chosen; trip.rate = chosen.rates[tt];
      trip.cost = r2(trip.km * trip.rate);
      trip.below_fill_floor = !bestFloor;
    } else {
      trip.tanker = null; trip.rate = null; trip.below_fill_floor = false;
      trip.cost = r2(trip.km * ctx.maxRate + trip.load * UNSERVED_PENALTY_PER_LITRE);
    }
    total += trip.cost;
  }
  return r2(total);
}

// ─── Seed: Clarke-Wright per plant, then constraint splits + NN order ────────
function seedSolution(ctx, nodes) {
  const byPlant = new Map();
  for (const n of nodes) {
    if (!byPlant.has(n.plant_id)) byPlant.set(n.plant_id, []);
    byPlant.get(n.plant_id).push(n);
  }
  const trips = [];
  const cap = ctx.maxCapacity > 0 ? ctx.maxCapacity : Infinity;
  for (const [plantId, list] of [...byPlant.entries()].sort((a, b) => a[0] - b[0])) {
    const plant = ctx.plantsById.get(plantId);
    const items = list.map(n => ({ bmcu_id: n.bmcu_id, expected_qty_litres: n.litres, node: n }));
    const routes = clarkeWrightSavings(plant.end, items, ctx.resolve, cap);
    for (const route of routes) {
      // honour max BMCUs per trip
      for (let i = 0; i < route.length; i += ctx.C.max_bmcus_per_trip) {
        let chunk = route.slice(i, i + ctx.C.max_bmcus_per_trip);
        const queue = [chunk];
        while (queue.length) {
          const part = queue.shift();
          const ordered = nearestNeighbourOrder(plant.end, part, ctx.resolve).map(it => it.node);
          const trip = makeTrip(ctx, plantId, ordered);
          if (trip.km > ctx.C.max_trip_km && part.length > 1) {
            const h = Math.ceil(part.length / 2);
            queue.push(part.slice(0, h), part.slice(h));
          } else trips.push(trip);
        }
      }
    }
  }
  return trips;
}

// ─── Local search moves (each returns a new trips array or null) ─────────────
function cloneTrips(trips) { return trips.map(t => ({ ...t, nodes: [...t.nodes] })); }

function canHost(ctx, trip, node) {
  return ctx.C.allow_plant_switch || trip.plant_id === node.plant_id;
}

function bestInsertion(ctx, trip, node) {
  let best = null, bestKm = Infinity;
  for (let pos = 0; pos <= trip.nodes.length; pos++) {
    const nodes = [...trip.nodes.slice(0, pos), node, ...trip.nodes.slice(pos)];
    const km = ctx.routeKm(trip.plant_id, nodes).km;
    if (km < bestKm) { bestKm = km; best = nodes; }
  }
  return best;
}

function moveRelocate(ctx, trips, rng) {
  if (!trips.length) return null;
  const from = randInt(rng, trips.length);
  const src = trips[from];
  const ni = randInt(rng, src.nodes.length);
  const node = src.nodes[ni];
  const out = cloneTrips(trips);
  out[from].nodes.splice(ni, 1);
  // target: an existing trip (same shift) or a fresh trip
  const targets = out.map((t, i) => i).filter(i => i !== from && canHost(ctx, out[i], node) && out[i].nodes.length < ctx.C.max_bmcus_per_trip);
  const openNew = rng() < 0.15 || !targets.length;
  const plantIds = ctx.C.allow_plant_switch ? [...ctx.plantsById.keys()] : [node.plant_id];
  if (openNew) {
    const plantId = plantIds[randInt(rng, plantIds.length)];
    out.push(makeTrip(ctx, plantId, [{ ...node, plant_id: plantId }]));
  } else {
    const ti = targets[randInt(rng, targets.length)];
    const tgt = out[ti];
    const moved = { ...node, plant_id: tgt.plant_id };
    out[ti] = makeTrip(ctx, tgt.plant_id, bestInsertion(ctx, tgt, moved));
  }
  if (out[from].nodes.length === 0) out.splice(from, 1);
  else out[from] = makeTrip(ctx, out[from].plant_id, out[from].nodes);
  return out;
}

function moveSwap(ctx, trips, rng) {
  if (trips.length < 2) return null;
  const a = randInt(rng, trips.length);
  let b = randInt(rng, trips.length - 1); if (b >= a) b++;
  const ta = trips[a], tb = trips[b];
  const ia = randInt(rng, ta.nodes.length), ib = randInt(rng, tb.nodes.length);
  const na = ta.nodes[ia], nb = tb.nodes[ib];
  if (!canHost(ctx, tb, na) || !canHost(ctx, ta, nb)) return null;
  const out = cloneTrips(trips);
  out[a].nodes[ia] = { ...nb, plant_id: ta.plant_id };
  out[b].nodes[ib] = { ...na, plant_id: tb.plant_id };
  out[a] = makeTrip(ctx, ta.plant_id, out[a].nodes);
  out[b] = makeTrip(ctx, tb.plant_id, out[b].nodes);
  return out;
}

function moveTwoOpt(ctx, trips, rng) {
  const cands = trips.map((t, i) => i).filter(i => trips[i].nodes.length >= 3);
  if (!cands.length) return null;
  const ti = cands[randInt(rng, cands.length)];
  const t = trips[ti];
  const n = t.nodes.length;
  let i = randInt(rng, n - 1), j = i + 1 + randInt(rng, n - i - 1);
  const nodes = [...t.nodes.slice(0, i), ...t.nodes.slice(i, j + 1).reverse(), ...t.nodes.slice(j + 1)];
  const out = cloneTrips(trips);
  out[ti] = makeTrip(ctx, t.plant_id, nodes);
  return out;
}

function moveMerge(ctx, trips, rng) {
  if (trips.length < 2) return null;
  const a = randInt(rng, trips.length);
  const ta = trips[a];
  const cands = trips.map((t, i) => i).filter(i => i !== a && trips[i].plant_id === ta.plant_id
    && trips[i].nodes.length + ta.nodes.length <= ctx.C.max_bmcus_per_trip);
  if (!cands.length) return null;
  const b = cands[randInt(rng, cands.length)];
  const plant = ctx.plantsById.get(ta.plant_id);
  const items = [...ta.nodes, ...trips[b].nodes].map(n => ({ bmcu_id: n.bmcu_id, node: n }));
  const ordered = nearestNeighbourOrder(plant.end, items, ctx.resolve).map(it => it.node);
  const out = cloneTrips(trips);
  const merged = makeTrip(ctx, ta.plant_id, ordered);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  out.splice(hi, 1); out.splice(lo, 1); out.push(merged);
  return out;
}

function moveSplit(ctx, trips, rng) {
  const cands = trips.map((t, i) => i).filter(i => trips[i].nodes.length >= 2);
  if (!cands.length) return null;
  const ti = cands[randInt(rng, cands.length)];
  const t = trips[ti];
  const at = 1 + randInt(rng, t.nodes.length - 1);
  const out = cloneTrips(trips);
  out[ti] = makeTrip(ctx, t.plant_id, t.nodes.slice(0, at));
  out.push(makeTrip(ctx, t.plant_id, t.nodes.slice(at)));
  return out;
}

const MOVES = [moveRelocate, moveRelocate, moveSwap, moveTwoOpt, moveMerge, moveSplit];

function feasibleSolution(ctx, trips) {
  for (const t of trips) if (!tripFeasible(ctx, t)) return false;
  return true;
}

function localSearch(ctx, start, rng, deadline, maxIter, stats) {
  let cur = cloneTrips(start);
  let curCost = assignFleet(ctx, cur);
  let iter = 0;
  while (iter < maxIter && Date.now() < deadline) {
    iter++; stats.iterations++;
    const move = MOVES[randInt(rng, MOVES.length)];
    const cand = move(ctx, cur, rng);
    if (!cand || !feasibleSolution(ctx, cand)) continue;
    const cost = assignFleet(ctx, cand);
    if (cost < curCost - 1e-6) { cur = cand; curCost = cost; stats.accepted++; }
  }
  assignFleet(ctx, cur);
  return { trips: cur, cost: curCost };
}

function perturb(ctx, trips, rng, k) {
  let cur = trips;
  for (let i = 0; i < k * 4 && k > 0; i++) {
    const cand = moveRelocate(ctx, cur, rng);
    if (cand && feasibleSolution(ctx, cand)) { cur = cand; k--; }
  }
  return cur;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────
// instance = {
//   plants:  [{ id, name, start: {type,id}|null, end: {type:'delivery_point', id} }],
//   nodes:   [{ bmcu_id, bmcu_code, bmcu_name, litres, plant_id, shift }],
//   tankers: [{ id, tanker_number, capacity_litres, vendor_name, state,
//               rates: { 'Point to Point': n|null, 'BMCU/CC to Dairy/CC': n|null } }],
//   resolve: (typeA, idA, typeB, idB) → { km, estimated, source }
// }
function runFleetOptimizer(instance, constraintOverrides = {}) {
  const C = mergeConstraints(constraintOverrides);
  const ctx = makeContext(instance, C);
  const t0 = Date.now();
  const stats = { iterations: 0, accepted: 0, restarts: 0 };

  const unserved = [];
  const nodes = [];
  for (const n of instance.nodes) {
    const litres = Number(n.litres) || 0;
    if (litres <= 0) { unserved.push({ ...n, litres, reason: 'No demand for this shift' }); continue; }
    if (!ctx.plantsById.has(n.plant_id)) { unserved.push({ ...n, litres, reason: 'No plant catchment' }); continue; }
    if (ctx.maxCapacity > 0 && litres > ctx.maxCapacity) {
      unserved.push({ ...n, litres, reason: `Demand ${r1(litres)} L exceeds the largest available tanker (${ctx.maxCapacity} L)` });
      continue;
    }
    nodes.push({ ...n, litres });
  }

  let best = { trips: [], cost: 0 }, seedCost = 0;
  if (nodes.length && ctx.tankers.length) {
    const seed = seedSolution(ctx, nodes);
    seedCost = assignFleet(ctx, seed);
    const rng = makeRng(C.seed);
    const rounds = 1 + C.restarts;
    const perRound = Math.max(50, Math.floor(C.time_budget_ms / rounds));
    const iterPerRound = Math.max(100, Math.floor(C.max_iterations / rounds));
    best = localSearch(ctx, seed, rng, Date.now() + perRound, iterPerRound, stats);
    for (let r = 0; r < C.restarts; r++) {
      stats.restarts++;
      const k = Math.max(2, Math.floor(nodes.length / 10));
      const start = perturb(ctx, best.trips, rng, k);
      const res = localSearch(ctx, start, rng, Date.now() + perRound, iterPerRound, stats);
      if (res.cost < best.cost - 1e-6) best = res;
    }
    assignFleet(ctx, best.trips);
  }

  // ── Output ───────────────────────────────────────────────────────────────
  const trips = [];
  let totKm = 0, totCost = 0, totLitres = 0, totCap = 0, estLegs = 0, belowFloor = 0;
  const sorted = [...best.trips].sort((a, b) => a.plant_id - b.plant_id || b.load - a.load);
  let seq = 1;
  for (const t of sorted) {
    if (!t.tanker) {
      for (const n of t.nodes) unserved.push({ ...n, reason: 'No available tanker with enough capacity, a valid rate and trips left for the day' });
      continue;
    }
    const plant = ctx.plantsById.get(t.plant_id);
    const fill = t.tanker.capacity_litres > 0 ? t.load / t.tanker.capacity_litres * 100 : 0;
    totKm += t.km; totCost += t.cost; totLitres += t.load; totCap += t.tanker.capacity_litres;
    estLegs += t.estimated_legs; if (t.below_fill_floor) belowFloor++;
    trips.push({
      trip_seq: seq++,
      plant_id: plant.id, plant_name: plant.name,
      start_point_id: plant.start?.id || null, delivery_point_id: plant.end.id,
      shift: t.nodes[0].shift,
      tanker_id: t.tanker.id, tanker_number: t.tanker.tanker_number, vendor_name: t.tanker.vendor_name || null,
      capacity_litres: t.tanker.capacity_litres, rate_state: t.tanker.state || null,
      bmcus: t.nodes.map((n, i) => ({
        seq_no: i + 1, bmcu_id: n.bmcu_id, bmcu_code: n.bmcu_code, bmcu_name: n.bmcu_name,
        shift: n.shift, expected_qty_litres: r2(n.litres),
        leg_km: t.legs[i].leg_km, leg_is_estimated: t.legs[i].leg_is_estimated, leg_source: t.legs[i].leg_source,
      })),
      return_leg: t.return_leg,
      total_qty_litres: r2(t.load), fill_pct: r1(fill), km: t.km,
      rate_per_km: t.rate, transport_type: t.transport_type,
      cost: t.cost, cost_per_litre: t.load > 0 ? r4(t.cost / t.load) : 0,
      flags: { below_fill_floor: t.below_fill_floor, estimated_legs: t.estimated_legs },
      tanker_reason: `${t.tanker.tanker_number} is the cheapest tanker that fits: ${t.tanker.capacity_litres} L at ₹${t.rate}/km (${t.transport_type})`
        + (t.below_fill_floor ? `; no tanker reaches the ${Math.round(C.fill_floor * 100)} % fill floor` : ''),
    });
  }
  const warnings = [];
  if (estLegs) warnings.push(`${estLegs} leg(s) use estimated distances (no Distance Master / Google km). Run Prefetch missing distances.`);
  if (belowFloor) warnings.push(`${belowFloor} trip(s) run below the ${Math.round(C.fill_floor * 100)} % fill floor.`);
  if (unserved.length) warnings.push(`${unserved.length} BMCU pickup(s) could not be served — see Unserved.`);

  return {
    constraints: C,
    trips,
    totals: {
      trips: trips.length, km: r1(totKm), litres: r2(totLitres), cost: r2(totCost),
      cost_per_litre: totLitres > 0 ? r4(totCost / totLitres) : 0,
      avg_fill_pct: totCap > 0 ? r1(totLitres / totCap * 100) : 0,
      estimated_legs: estLegs, below_fill_floor_trips: belowFloor,
    },
    unserved,
    warnings,
    stats: { ...stats, seed_cost: seedCost, search_cost: r2(best.cost), final_cost: r2(totCost), elapsed_ms: Date.now() - t0 },
  };
}

module.exports = {
  DEFAULT_CONSTRAINTS, TT_P2P, TT_BMCU, transportTypeFor, mergeConstraints,
  routeKm, runFleetOptimizer,
};
