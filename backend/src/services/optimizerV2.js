// backend/src/services/optimizerV2.js
// =============================================================================
// Day Optimizer (fleet v2) — docs/OPTIMISATION_PLAN.md §3.2.
//
// Plans ONE date for ALL BMCUs across ALL plants with the WHOLE available
// fleet, minimising   Σ over trips of  km × per-km rate of the tanker driving it
//                   + Σ over unserved BMCUs of a penalty (see penaltyFor)
// subject to: tanker capacity (with a fill floor), max BMCUs per trip, max km
// per trip, max trips per tanker per day, and a BMCU's plant catchment (a BMCU
// may only move to another plant when allow_plant_switch is set).
//
// Method:
//   1. Seed: Clarke-Wright savings per plant (optimizerCore.clarkeWrightSavings)
//      at SEVERAL capacities (every capacity class in the fleet, plus 22 KL),
//      split to honour max BMCUs / max km, nearest-neighbour order within each
//      trip, then cost-aware assignment; the cheapest seed wins.
//   2. Cost-aware assignment: for every trip (largest load first) the tanker
//      minimising km × rate among those with capacity ≥ load, a rate for the
//      trip's transport type ('Point to Point' for 1 BMCU, else 'BMCU/CC to
//      Dairy/CC') and trips left in its daily budget; tankers meeting the fill
//      floor are preferred, otherwise the trip is flagged below_fill_floor. A
//      trip no tanker can take is split in two and retried; a single BMCU no
//      tanker can take goes to the unserved pool.
//   3. Local search (insert-unserved, relocate, swap, 2-opt, merge, split).
//      A candidate is checked and re-assigned LOCALLY: only the trips the move
//      touched are rebuilt and given a tanker from the budget the removed
//      trips freed; every other trip keeps its tanker. Accepted on a strict
//      cost decrease (the cost includes the unserved penalty, so serving more
//      milk always pays). Random restarts perturb the best solution; a global
//      re-assignment runs after each round and is kept only when cheaper.
//      Deterministic for a given seed and iteration cap (the time budget only
//      cuts the run short).
//
// First production run (2026-09-09) accepted 0 of 150,000 moves: the seed
// held single-BMCU trips whose round trip alone exceeds max_trip_km, and the
// old whole-solution feasibility check vetoed every candidate because those
// untouched trips were still "infeasible". A single-BMCU trip over the limit
// is now allowed (flagged over_max_km) and feasibility is checked per touched
// trip. scripts/optimizer_v2_replay.js reproduces that run offline.
//
// This module has NO database access: routes/optimize.js builds the instance
// (nodes, plants, fleet, rates, distance resolver) and calls runFleetOptimizer.
// scripts/optimizer_v2_selftest.js runs it on a synthetic instance.
// =============================================================================

const { clarkeWrightSavings, nearestNeighbourOrder } = require('./optimizerCore');

const DEFAULT_CONSTRAINTS = Object.freeze({
  fill_floor: 0.85,                // preferred minimum load / capacity
  max_trips_per_tanker_per_day: 2,
  // Calibrated on 90 days of production plans (scripts/optimizer_v2_replay.js):
  // planners run up to 8 BMCUs per trip and 4–6 trips a day beyond 450 km.
  // At 6 / 450 the far BMCUs become forced solo trips and the optimiser
  // cannot beat the planners; at 8 / 550 it does on every replayed date.
  max_bmcus_per_trip: 8,
  max_trip_km: 550,
  allow_plant_switch: false,
  time_budget_ms: 8000,
  max_iterations: 600000,          // hard cap so a seed reproduces exactly (the time budget usually cuts first)
  restarts: 3,
  seed: 1,
});

const TT_P2P  = 'Point to Point';
const TT_BMCU = 'BMCU/CC to Dairy/CC';
function transportTypeFor(bmcuCount) { return bmcuCount <= 1 ? TT_P2P : TT_BMCU; }

// Penalty (₹ per litre) for milk the fleet cannot carry — far above any real
// cost per litre (~₹0.7) so the search always prefers serving a BMCU. It is
// capped per BMCU at the cost of the most expensive feasible trip that could
// serve it (max_trip_km at the dearest rate) so the search does not accept a
// silly detour just to clear a penalty, and floored above the BMCU's solo trip
// so serving it alone always wins.
const UNSERVED_PENALTY_PER_LITRE = 5;
const SEED_EXTRA_CAPACITY = 22000;   // always tried as a seed capacity

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
const pick = (rng, arr) => arr[randInt(rng, arr.length)];

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
  const penaltyCache = new Map();
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
    penaltyFor(node) {
      const key = `${node.plant_id}|${node.bmcu_id}|${node.litres}`;
      let v = penaltyCache.get(key);
      if (v === undefined) {
        const soloKm = plantsById.has(node.plant_id) ? ctx.routeKm(node.plant_id, [node]).km : constraints.max_trip_km;
        const soloCost = soloKm * maxRate;
        const cap = Math.max(constraints.max_trip_km, soloKm) * maxRate;
        v = r2(Math.max(soloCost * 1.25 + 1, Math.min(node.litres * UNSERVED_PENALTY_PER_LITRE, cap)));
        penaltyCache.set(key, v);
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

// A single-BMCU trip whose round trip alone exceeds max_trip_km is unavoidable
// (the BMCU still has to be lifted) — allowed, flagged over_max_km in output.
function tripFeasible(ctx, trip) {
  const C = ctx.C;
  if (trip.nodes.length === 0 || trip.nodes.length > C.max_bmcus_per_trip) return false;
  if (trip.load > ctx.maxCapacity) return false;
  if (trip.km > C.max_trip_km && trip.nodes.length > 1) return false;
  return true;
}

// ─── Cost-aware tanker choice for ONE trip against a budget ─────────────────
// Returns a new trip object with tanker / rate / cost set and the budget
// decremented, or null when no tanker fits (budget untouched).
function assignOne(ctx, trip, budget) {
  const C = ctx.C;
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
  if (!chosen) return null;
  budget.set(chosen.id, budget.get(chosen.id) - 1);
  return { ...trip, transport_type: tt, tanker: chosen, rate: chosen.rates[tt], cost: r2(trip.km * chosen.rates[tt]), below_fill_floor: !bestFloor };
}

const byLoadDesc = (a, b) => b.load - a.load || b.km - a.km || a.plant_id - b.plant_id || a.nodes[0].bmcu_id - b.nodes[0].bmcu_id;

// Split a trip in two halves (route order kept), for when no tanker can take it.
function halves(ctx, trip) {
  const h = Math.ceil(trip.nodes.length / 2);
  return [makeTrip(ctx, trip.plant_id, trip.nodes.slice(0, h)), makeTrip(ctx, trip.plant_id, trip.nodes.slice(h))];
}

// ─── Solution = { trips (all assigned), pool (unserved nodes), budget, cost } ─
function solutionCost(ctx, trips, pool) {
  let c = 0;
  for (const t of trips) c += t.cost;
  for (const n of pool) c += ctx.penaltyFor(n);
  return r2(c);
}

// Global assignment from scratch (largest load first), splitting trips no
// tanker can take and pooling single BMCUs nobody can carry.
function assignAll(ctx, rawTrips, pool = []) {
  const budget = new Map(ctx.tankers.map(t => [t.id, ctx.C.max_trips_per_tanker_per_day]));
  const queue = [...rawTrips].sort(byLoadDesc);
  const trips = [], outPool = [...pool];
  while (queue.length) {
    const trip = queue.shift();
    const a = assignOne(ctx, trip, budget);
    if (a) { trips.push(a); continue; }
    if (trip.nodes.length > 1) { queue.push(...halves(ctx, trip)); queue.sort(byLoadDesc); }
    else outPool.push(...trip.nodes);
  }
  return { trips, pool: outPool, budget, cost: solutionCost(ctx, trips, outPool) };
}

// Apply a move delta locally: free the removed trips' tankers, assign only the
// added trips, keep every other tanker. Returns the candidate or null when an
// added trip is infeasible.
//   delta = { removed: Set<index>, added: [rawTrip], poolRemoved: Set<index>, poolAdded: [node] }
function applyDelta(ctx, sol, delta) {
  for (const t of delta.added) if (!tripFeasible(ctx, t)) return null;
  const budget = new Map(sol.budget);
  for (const i of delta.removed) budget.set(sol.trips[i].tanker.id, budget.get(sol.trips[i].tanker.id) + 1);
  const trips = sol.trips.filter((_, i) => !delta.removed.has(i));
  const pool = sol.pool.filter((_, i) => !delta.poolRemoved.has(i));
  pool.push(...delta.poolAdded);
  for (const t of [...delta.added].sort(byLoadDesc)) {
    const a = assignOne(ctx, t, budget);
    if (a) trips.push(a); else pool.push(...t.nodes);   // penalised; the move will lose
  }
  return { trips, pool, budget, cost: solutionCost(ctx, trips, pool) };
}

// ─── Seed: Clarke-Wright per plant at a capacity, constraint splits, NN order ─
function seedSolution(ctx, nodes, cap) {
  const byPlant = new Map();
  for (const n of nodes) {
    if (!byPlant.has(n.plant_id)) byPlant.set(n.plant_id, []);
    byPlant.get(n.plant_id).push(n);
  }
  const trips = [];
  for (const [plantId, list] of [...byPlant.entries()].sort((a, b) => a[0] - b[0])) {
    const plant = ctx.plantsById.get(plantId);
    const items = list.map(n => ({ bmcu_id: n.bmcu_id, expected_qty_litres: n.litres, node: n }));
    const routes = clarkeWrightSavings(plant.end, items, ctx.resolve, cap);
    for (const route of routes) {
      for (let i = 0; i < route.length; i += ctx.C.max_bmcus_per_trip) {
        const queue = [route.slice(i, i + ctx.C.max_bmcus_per_trip)];
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

// Seed capacities: every capacity class in the fleet plus 22 KL (and the
// median class), so a fleet of mostly 20–23 KL tankers is not seeded with
// 30 KL loads only three tankers can carry.
function seedCapacities(ctx) {
  const caps = [...new Set(ctx.tankers.map(t => t.capacity_litres))].sort((a, b) => a - b);
  const set = new Set(caps);
  set.add(caps[Math.floor(caps.length / 2)]);
  if (SEED_EXTRA_CAPACITY <= ctx.maxCapacity) set.add(SEED_EXTRA_CAPACITY);
  return [...set].sort((a, b) => b - a);
}

// ─── Local search moves: each returns a delta or null ────────────────────────
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
  return { nodes: best, km: bestKm };
}

const emptyDelta = () => ({ removed: new Set(), added: [], poolRemoved: new Set(), poolAdded: [] });

// Put an unserved BMCU into the trip where it adds the least km (sometimes a
// random host, sometimes a fresh trip) — tried first and often while the
// pool is not empty.
function moveInsertUnserved(ctx, sol, rng) {
  if (!sol.pool.length) return null;
  const pi = randInt(rng, sol.pool.length);
  const node = sol.pool[pi];
  const d = emptyDelta(); d.poolRemoved.add(pi);
  const hosts = sol.trips.map((t, i) => i).filter(i => {
    const t = sol.trips[i];
    return canHost(ctx, t, node) && t.nodes.length < ctx.C.max_bmcus_per_trip && t.load + node.litres <= ctx.maxCapacity;
  });
  const plantIds = ctx.C.allow_plant_switch ? [...ctx.plantsById.keys()] : [node.plant_id];
  const openNew = !hosts.length || rng() < 0.2;
  if (openNew) {
    const plantId = pick(rng, plantIds);
    d.added.push(makeTrip(ctx, plantId, [{ ...node, plant_id: plantId }]));
    return d;
  }
  let ti;
  if (rng() < 0.3) ti = pick(rng, hosts);
  else {
    let bestInc = Infinity;
    for (const i of hosts) {
      const t = sol.trips[i];
      const inc = bestInsertion(ctx, t, { ...node, plant_id: t.plant_id }).km - t.km;
      if (inc < bestInc) { bestInc = inc; ti = i; }
    }
  }
  const tgt = sol.trips[ti];
  d.removed.add(ti);
  d.added.push(makeTrip(ctx, tgt.plant_id, bestInsertion(ctx, tgt, { ...node, plant_id: tgt.plant_id }).nodes));
  return d;
}

function moveRelocate(ctx, sol, rng) {
  const trips = sol.trips;
  if (!trips.length) return null;
  const from = randInt(rng, trips.length);
  const src = trips[from];
  const ni = randInt(rng, src.nodes.length);
  const node = src.nodes[ni];
  const rest = src.nodes.filter((_, i) => i !== ni);
  const d = emptyDelta(); d.removed.add(from);
  if (rest.length) d.added.push(makeTrip(ctx, src.plant_id, rest));
  const targets = trips.map((t, i) => i).filter(i => i !== from && canHost(ctx, trips[i], node)
    && trips[i].nodes.length < ctx.C.max_bmcus_per_trip && trips[i].load + node.litres <= ctx.maxCapacity);
  const openNew = rng() < 0.1 || !targets.length;
  const plantIds = ctx.C.allow_plant_switch ? [...ctx.plantsById.keys()] : [node.plant_id];
  if (openNew) {
    if (!rest.length) return null; // would recreate the same trip
    const plantId = pick(rng, plantIds);
    d.added.push(makeTrip(ctx, plantId, [{ ...node, plant_id: plantId }]));
  } else {
    // mostly the host where the BMCU adds the least km, sometimes a random one
    let ti;
    if (rng() < 0.3) ti = pick(rng, targets);
    else {
      let bestInc = Infinity;
      for (const i of targets) {
        const t = trips[i];
        const inc = bestInsertion(ctx, t, { ...node, plant_id: t.plant_id }).km - t.km;
        if (inc < bestInc) { bestInc = inc; ti = i; }
      }
    }
    const tgt = trips[ti];
    d.removed.add(ti);
    d.added.push(makeTrip(ctx, tgt.plant_id, bestInsertion(ctx, tgt, { ...node, plant_id: tgt.plant_id }).nodes));
  }
  return d;
}

// Swap one BMCU of trip a with one of trip b (same plant unless plant switch
// is allowed); the partner in b is the one giving the shortest combined km.
function moveSwap(ctx, sol, rng) {
  const trips = sol.trips;
  if (trips.length < 2) return null;
  const a = randInt(rng, trips.length);
  const ta = trips[a];
  const cands = trips.map((t, i) => i).filter(i => i !== a && (ctx.C.allow_plant_switch || trips[i].plant_id === ta.plant_id));
  if (!cands.length) return null;
  const b = pick(rng, cands);
  const tb = trips[b];
  const ia = randInt(rng, ta.nodes.length);
  const na = ta.nodes[ia];
  let best = null, bestKm = Infinity;
  for (let ib = 0; ib < tb.nodes.length; ib++) {
    const nb = tb.nodes[ib];
    if (nb.bmcu_id === na.bmcu_id) continue;
    if (ta.load - na.litres + nb.litres > ctx.maxCapacity || tb.load - nb.litres + na.litres > ctx.maxCapacity) continue;
    const nodesA = [...ta.nodes], nodesB = [...tb.nodes];
    nodesA[ia] = { ...nb, plant_id: ta.plant_id };
    nodesB[ib] = { ...na, plant_id: tb.plant_id };
    const km = ctx.routeKm(ta.plant_id, nodesA).km + ctx.routeKm(tb.plant_id, nodesB).km;
    if (km < bestKm) { bestKm = km; best = [nodesA, nodesB]; }
  }
  if (!best) return null;
  const d = emptyDelta(); d.removed.add(a); d.removed.add(b);
  d.added.push(makeTrip(ctx, ta.plant_id, best[0]), makeTrip(ctx, tb.plant_id, best[1]));
  return d;
}

// Cross-exchange: two trips of one plant swap their tails after random cuts.
function moveCross(ctx, sol, rng) {
  const trips = sol.trips;
  if (trips.length < 2) return null;
  const a = randInt(rng, trips.length);
  const ta = trips[a];
  const cands = trips.map((t, i) => i).filter(i => i !== a && trips[i].plant_id === ta.plant_id);
  if (!cands.length) return null;
  const b = pick(rng, cands);
  const tb = trips[b];
  const ca = randInt(rng, ta.nodes.length + 1), cb = randInt(rng, tb.nodes.length + 1);
  const nodesA = [...ta.nodes.slice(0, ca), ...tb.nodes.slice(cb)];
  const nodesB = [...tb.nodes.slice(0, cb), ...ta.nodes.slice(ca)];
  if (!nodesA.length || !nodesB.length) return null;
  if (nodesA.length === ta.nodes.length && ca === ta.nodes.length) return null; // nothing exchanged
  const d = emptyDelta(); d.removed.add(a); d.removed.add(b);
  d.added.push(makeTrip(ctx, ta.plant_id, nodesA), makeTrip(ctx, tb.plant_id, nodesB));
  return d;
}

function moveTwoOpt(ctx, sol, rng) {
  const trips = sol.trips;
  const cands = trips.map((t, i) => i).filter(i => trips[i].nodes.length >= 3);
  if (!cands.length) return null;
  const ti = pick(rng, cands);
  const t = trips[ti];
  const n = t.nodes.length;
  const i = randInt(rng, n - 1), j = i + 1 + randInt(rng, n - i - 1);
  const nodes = [...t.nodes.slice(0, i), ...t.nodes.slice(i, j + 1).reverse(), ...t.nodes.slice(j + 1)];
  const d = emptyDelta(); d.removed.add(ti);
  d.added.push(makeTrip(ctx, t.plant_id, nodes));
  return d;
}

function moveMerge(ctx, sol, rng) {
  const trips = sol.trips;
  if (trips.length < 2) return null;
  const a = randInt(rng, trips.length);
  const ta = trips[a];
  const cands = trips.map((t, i) => i).filter(i => i !== a && trips[i].plant_id === ta.plant_id
    && trips[i].nodes.length + ta.nodes.length <= ctx.C.max_bmcus_per_trip
    && trips[i].load + ta.load <= ctx.maxCapacity);
  if (!cands.length) return null;
  const b = pick(rng, cands);
  const plant = ctx.plantsById.get(ta.plant_id);
  const items = [...ta.nodes, ...trips[b].nodes].map(n => ({ bmcu_id: n.bmcu_id, node: n }));
  const ordered = nearestNeighbourOrder(plant.end, items, ctx.resolve).map(it => it.node);
  const d = emptyDelta(); d.removed.add(a); d.removed.add(b);
  d.added.push(makeTrip(ctx, ta.plant_id, ordered));
  return d;
}

function moveSplit(ctx, sol, rng) {
  const trips = sol.trips;
  const cands = trips.map((t, i) => i).filter(i => trips[i].nodes.length >= 2);
  if (!cands.length) return null;
  const ti = pick(rng, cands);
  const t = trips[ti];
  const at = 1 + randInt(rng, t.nodes.length - 1);
  const d = emptyDelta(); d.removed.add(ti);
  d.added.push(makeTrip(ctx, t.plant_id, t.nodes.slice(0, at)), makeTrip(ctx, t.plant_id, t.nodes.slice(at)));
  return d;
}

const MOVES = [
  ['relocate', moveRelocate], ['relocate', moveRelocate], ['swap', moveSwap], ['cross', moveCross],
  ['two_opt', moveTwoOpt], ['merge', moveMerge], ['split', moveSplit],
];
const INSERT_UNSERVED = ['insert_unserved', moveInsertUnserved];

function pickMove(sol, rng) {
  if (sol.pool.length && rng() < 0.5) return INSERT_UNSERVED;
  return pick(rng, MOVES);
}

// Iterated local search: strict-descent moves; when nothing has been accepted
// for STALE_ITERATIONS the search kicks off again from a lightly perturbed
// copy of the best solution (a plain descent on real instances converges in
// a few thousand iterations and would waste the rest of the budget).
const STALE_ITERATIONS = 3000;

function localSearch(ctx, start, rng, deadline, maxIter, stats) {
  let cur = start, best = start;
  let iter = 0, stale = 0;
  while (iter < maxIter && Date.now() < deadline) {
    iter++; stats.iterations++;
    const [name, move] = pickMove(cur, rng);
    const delta = move(ctx, cur, rng);
    if (!delta) continue;
    const cand = applyDelta(ctx, cur, delta);
    if (!cand) continue;
    const m = stats.moves[name]; m.tried++;
    if (cand.cost < cur.cost) {
      cur = cand; m.accepted++; stats.accepted++; stale = 0;
      if (cur.cost < best.cost) best = reassignGlobal(ctx, cur);
    } else if (++stale >= STALE_ITERATIONS) {
      stats.kicks++; stale = 0;
      cur = perturb(ctx, best, rng, 2 + randInt(rng, 3));
    }
  }
  return best;
}

function perturb(ctx, sol, rng, k) {
  let cur = sol;
  for (let i = 0; i < k * 4 && k > 0; i++) {
    const [, move] = pickMove(cur, rng);
    const delta = move(ctx, cur, rng);
    const cand = delta && applyDelta(ctx, cur, delta);
    if (cand) { cur = cand; k--; }
  }
  return cur;
}

// Global re-assignment of a solution; kept only when cheaper.
function reassignGlobal(ctx, sol) {
  const g = assignAll(ctx, sol.trips.map(t => makeTrip(ctx, t.plant_id, t.nodes)), sol.pool);
  return g.cost < sol.cost ? g : sol;
}

// ─── Demand larger than the biggest tanker: split into equal parts ──────────
// Each part keeps the bmcu_id; parts that land in the same trip are merged
// back into one stop on output.
function splitOversizedNodes(nodes, maxCapacity) {
  const out = [];
  for (const n of nodes) {
    if (!(maxCapacity > 0) || n.litres <= maxCapacity) { out.push(n); continue; }
    const parts = Math.ceil(n.litres / maxCapacity);
    const each = r2(n.litres / parts);
    for (let i = 0; i < parts; i++)
      out.push({ ...n, litres: i === parts - 1 ? r2(n.litres - each * (parts - 1)) : each, split_part: `${i + 1}/${parts}` });
  }
  return out;
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
  const stats = { iterations: 0, accepted: 0, restarts: 0, kicks: 0, moves: {}, seed_candidates: [] };
  for (const [name] of [...MOVES, INSERT_UNSERVED]) stats.moves[name] = { tried: 0, accepted: 0 };

  const unserved = [];
  let nodes = [];
  for (const n of instance.nodes) {
    const litres = Number(n.litres) || 0;
    if (litres <= 0) { unserved.push({ ...n, litres, reason: 'No demand for this shift' }); continue; }
    if (!ctx.plantsById.has(n.plant_id)) { unserved.push({ ...n, litres, reason: 'No plant catchment' }); continue; }
    nodes.push({ ...n, litres });
  }
  const splitCount = nodes.filter(n => n.litres > ctx.maxCapacity).length;
  nodes = splitOversizedNodes(nodes, ctx.maxCapacity);

  let best = { trips: [], pool: [], cost: 0 }, seedCost = 0;
  if (nodes.length && ctx.tankers.length) {
    for (const cap of seedCapacities(ctx)) {
      const s = assignAll(ctx, seedSolution(ctx, nodes, cap));
      stats.seed_candidates.push({ capacity: cap, cost: s.cost, trips: s.trips.length, unserved: s.pool.length, chosen: false });
      if (!best.trips.length || s.cost < best.cost) best = s;
    }
    const chosen = stats.seed_candidates.find(s => s.cost === best.cost); if (chosen) chosen.chosen = true;
    seedCost = best.cost;
    const rng = makeRng(C.seed);
    const rounds = 1 + C.restarts;
    const perRound = Math.max(50, Math.floor(C.time_budget_ms / rounds));
    const iterPerRound = Math.max(100, Math.floor(C.max_iterations / rounds));
    best = reassignGlobal(ctx, localSearch(ctx, best, rng, Date.now() + perRound, iterPerRound, stats));
    for (let r = 0; r < C.restarts; r++) {
      stats.restarts++;
      const k = Math.max(2, Math.floor(nodes.length / 10));
      const start = perturb(ctx, best, rng, k);
      const res = reassignGlobal(ctx, localSearch(ctx, start, rng, Date.now() + perRound, iterPerRound, stats));
      if (res.cost < best.cost) best = res;
    }
  } else if (nodes.length) {
    best = { trips: [], pool: nodes, cost: 0 };
  }

  // ── Output ───────────────────────────────────────────────────────────────
  for (const n of best.pool) unserved.push({ ...n, reason: 'No available tanker with enough capacity, a valid rate and trips left for the day' });
  const trips = [];
  let totKm = 0, totCost = 0, totLitres = 0, totCap = 0, estLegs = 0, belowFloor = 0, overKm = 0;
  const sorted = [...best.trips].sort((a, b) => a.plant_id - b.plant_id || b.load - a.load);
  let seq = 1;
  for (const t of sorted) {
    const plant = ctx.plantsById.get(t.plant_id);
    const fill = t.tanker.capacity_litres > 0 ? t.load / t.tanker.capacity_litres * 100 : 0;
    const overMax = t.km > C.max_trip_km;
    totKm += t.km; totCost += t.cost; totLitres += t.load; totCap += t.tanker.capacity_litres;
    estLegs += t.estimated_legs; if (t.below_fill_floor) belowFloor++; if (overMax) overKm++;
    // merge split parts of one BMCU that ended up consecutive in the same trip
    const stops = [];
    t.nodes.forEach((n, i) => {
      const prev = stops[stops.length - 1];
      if (prev && prev.bmcu_id === n.bmcu_id) { prev.expected_qty_litres = r2(prev.expected_qty_litres + n.litres); return; }
      stops.push({ bmcu_id: n.bmcu_id, bmcu_code: n.bmcu_code, bmcu_name: n.bmcu_name, shift: n.shift, expected_qty_litres: r2(n.litres),
        leg_km: t.legs[i].leg_km, leg_is_estimated: t.legs[i].leg_is_estimated, leg_source: t.legs[i].leg_source });
    });
    trips.push({
      trip_seq: seq++,
      plant_id: plant.id, plant_name: plant.name,
      start_point_id: plant.start?.id || null, delivery_point_id: plant.end.id,
      shift: t.nodes[0].shift,
      tanker_id: t.tanker.id, tanker_number: t.tanker.tanker_number, vendor_name: t.tanker.vendor_name || null,
      capacity_litres: t.tanker.capacity_litres, rate_state: t.tanker.state || null,
      bmcus: stops.map((s, i) => ({ seq_no: i + 1, ...s })),
      return_leg: t.return_leg,
      total_qty_litres: r2(t.load), fill_pct: r1(fill), km: t.km,
      rate_per_km: t.rate, transport_type: t.transport_type,
      cost: t.cost, cost_per_litre: t.load > 0 ? r4(t.cost / t.load) : 0,
      flags: { below_fill_floor: t.below_fill_floor, estimated_legs: t.estimated_legs, over_max_km: overMax },
      tanker_reason: `${t.tanker.tanker_number} is the cheapest tanker that fits: ${t.tanker.capacity_litres} L at ₹${t.rate}/km (${t.transport_type})`
        + (t.below_fill_floor ? `; no tanker reaches the ${Math.round(C.fill_floor * 100)} % fill floor` : '')
        + (overMax ? `; single BMCU whose round trip exceeds ${C.max_trip_km} km` : ''),
    });
  }
  const warnings = [];
  if (estLegs) warnings.push(`${estLegs} leg(s) use estimated distances (no Distance Master / Google km). Run Prefetch missing distances.`);
  if (belowFloor) warnings.push(`${belowFloor} trip(s) run below the ${Math.round(C.fill_floor * 100)} % fill floor.`);
  if (overKm) warnings.push(`${overKm} single-BMCU trip(s) exceed ${C.max_trip_km} km — the round trip alone is longer than the limit.`);
  if (splitCount) warnings.push(`${splitCount} BMCU(s) had more milk than the largest available tanker (${ctx.maxCapacity} L) and were split over two pickups.`);
  if (unserved.length) warnings.push(`${unserved.length} BMCU pickup(s) could not be served — see Unserved. Raise max trips per tanker or check excluded tankers.`);

  return {
    constraints: C,
    trips,
    totals: {
      trips: trips.length, km: r1(totKm), litres: r2(totLitres), cost: r2(totCost),
      cost_per_litre: totLitres > 0 ? r4(totCost / totLitres) : 0,
      avg_fill_pct: totCap > 0 ? r1(totLitres / totCap * 100) : 0,
      estimated_legs: estLegs, below_fill_floor_trips: belowFloor, over_max_km_trips: overKm,
    },
    unserved,
    warnings,
    stats: { ...stats, seed_cost: seedCost, search_cost: r2(best.cost), final_cost: r2(totCost), unserved_penalty: r2(best.cost - totCost), elapsed_ms: Date.now() - t0 },
  };
}

module.exports = {
  DEFAULT_CONSTRAINTS, TT_P2P, TT_BMCU, transportTypeFor, mergeConstraints,
  routeKm, splitOversizedNodes, runFleetOptimizer,
};
