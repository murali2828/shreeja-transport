// backend/src/services/optimizerCore.js
// =============================================================================
// Shreeja Route Optimizer — core algorithms (shared by the /api/optimize route
// and offline analysis scripts, e.g. scripts/compare-plan-report.js).
//
// ALGORITHM: Clarke-Wright Savings + nearest-neighbour re-ordering.
//
// Distance resolution order for any pair (A, B):
//   1. Exact entry in distance_master (planner-entered / Google-cached road km)
//        → source 'master',   estimated: false
//   2. Both nodes have coordinates → Haversine great-circle × ROAD_FACTOR
//        → source 'geo',      estimated: true (good approximation, ±10-15%)
//   3. District constants (same district 20 km, different 50 km, hard 30 km)
//        → source 'fallback', estimated: true (crude — flag prominently)
// =============================================================================

const { haversineKm, ROAD_FACTOR } = require('../utils/geo');

// ─── Default fallback km values (tunable) ────────────────────────────────────
const SAME_DISTRICT_FALLBACK_KM  = 20;
const DIFF_DISTRICT_FALLBACK_KM  = 50;
const HARD_FALLBACK_KM           = 30;

// Key: "type:id||type:id" (always normalised so lower key first)
function distKey(typeA, idA, typeB, idB) {
  const a = `${typeA}:${idA}`;
  const b = `${typeB}:${idB}`;
  return a <= b ? `${a}||${b}` : `${b}||${a}`;
}

function nodeKey(type, id) { return `${type}:${id}`; }

// Loads all relevant distances from distance_master into an in-memory map.
async function buildDistanceMap(client, nodeIds) {
  if (!nodeIds.length) return {};
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
    map[distKey(row.from_type, row.from_id, row.to_type, row.to_id)] = parseFloat(row.distance_km);
  }
  return map;
}

const coord = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

// makeResolver(distMap, nodeMap) → resolve(typeA, idA, typeB, idB)
//   nodeMap: { 'bmcu:5': {district, state, latitude, longitude}, 'delivery_point:2': {...} }
//   returns { km, estimated, source: 'master'|'geo'|'fallback' }
function makeResolver(distMap, nodeMap) {
  return function resolve(typeA, idA, typeB, idB) {
    const key = distKey(typeA, idA, typeB, idB);
    if (distMap[key] !== undefined) return { km: distMap[key], estimated: false, source: 'master' };

    const a = nodeMap[nodeKey(typeA, idA)];
    const b = nodeMap[nodeKey(typeB, idB)];

    // Coordinate-based estimate (straight line × road factor)
    const aLat = coord(a?.latitude), aLng = coord(a?.longitude);
    const bLat = coord(b?.latitude), bLng = coord(b?.longitude);
    if (aLat != null && aLng != null && bLat != null && bLng != null) {
      const km = haversineKm(aLat, aLng, bLat, bLng) * ROAD_FACTOR;
      return { km: Math.round(km * 100) / 100, estimated: true, source: 'geo' };
    }

    // District constants
    if (typeA === 'bmcu' && typeB === 'bmcu' && a && b) {
      if (a.district && b.district && a.district === b.district) {
        return { km: SAME_DISTRICT_FALLBACK_KM, estimated: true, source: 'fallback' };
      }
      return { km: DIFF_DISTRICT_FALLBACK_KM, estimated: true, source: 'fallback' };
    }
    return { km: HARD_FALLBACK_KM, estimated: true, source: 'fallback' };
  };
}

// ─── Nearest-neighbour TSP within a single route ─────────────────────────────
function nearestNeighbourOrder(depot, bmcus, resolve) {
  if (bmcus.length <= 1) return bmcus;

  const remaining = [...bmcus];
  const ordered   = [];
  let current     = depot;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestKm  = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const { km } = resolve(current.type, current.id, 'bmcu', remaining[i].bmcu_id);
      if (km < bestKm) { bestKm = km; bestIdx = i; }
    }
    ordered.push(remaining[bestIdx]);
    current = { type: 'bmcu', id: remaining[bestIdx].bmcu_id };
    remaining.splice(bestIdx, 1);
  }
  return ordered;
}

// ─── Route km: depot → bmcu1 → … → bmcuN → depot ────────────────────────────
// Returns { totalKm, legs:[{bmcu_id, leg_km, leg_is_estimated, leg_source}], anyEstimated, returnLeg }
function computeRouteKm(depot, orderedBmcus, resolve) {
  const legs = [];
  let totalKm = 0;
  let anyEstimated = false;
  let prev = depot;

  for (const bm of orderedBmcus) {
    const { km, estimated, source } = resolve(prev.type, prev.id, 'bmcu', bm.bmcu_id);
    legs.push({ bmcu_id: bm.bmcu_id, leg_km: km, leg_is_estimated: estimated, leg_source: source });
    totalKm += km;
    if (estimated) anyEstimated = true;
    prev = { type: 'bmcu', id: bm.bmcu_id };
  }

  const last = orderedBmcus[orderedBmcus.length - 1];
  const ret  = resolve('bmcu', last?.bmcu_id, depot.type, depot.id);
  totalKm += ret.km;
  if (ret.estimated) anyEstimated = true;

  return {
    totalKm: Math.round(totalKm * 10) / 10,
    legs,
    anyEstimated,
    returnLeg: { leg_km: ret.km, leg_is_estimated: ret.estimated, leg_source: ret.source },
  };
}

// ─── Clarke-Wright savings — groups BMCUs into routes ────────────────────────
function clarkeWrightSavings(depot, bmcus, resolve, tankerCapacity) {
  const n = bmcus.length;
  if (n === 0) return [];

  const savings = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dA  = resolve(depot.type, depot.id, 'bmcu', bmcus[i].bmcu_id);
      const dB  = resolve(depot.type, depot.id, 'bmcu', bmcus[j].bmcu_id);
      const dAB = resolve('bmcu', bmcus[i].bmcu_id, 'bmcu', bmcus[j].bmcu_id);
      savings.push({ i, j, saving: dA.km + dB.km - dAB.km });
    }
  }
  savings.sort((a, b) => b.saving - a.saving);

  const routes    = bmcus.map(bm => [bm]);
  const routeLoad = bmcus.map(bm => parseFloat(bm.expected_qty_litres) || 0);
  const routeOf   = bmcus.map((_, i) => i);

  for (const { i, j, saving } of savings) {
    if (saving <= 0) break;

    const ri = routeOf[i];
    const rj = routeOf[j];
    if (ri === rj || ri === -1 || rj === -1) continue;

    const routeI = routes[ri];
    const routeJ = routes[rj];
    if (!routeI || !routeJ) continue;

    if (routeLoad[ri] + routeLoad[rj] > tankerCapacity) continue;

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
    for (const bm of merged) {
      const origIdx = bmcus.findIndex(b => b.bmcu_id === bm.bmcu_id);
      if (origIdx !== -1) routeOf[origIdx] = newIdx;
    }
    routes[ri] = null;
    routes[rj] = null;
  }

  return routes.filter(r => r !== null && r.length > 0);
}

// ─── Tanker assignment (best-fit; 'cheapest' sorts by rate first) ────────────
// rateOf lets callers choose the effective per-km rate (e.g. rate_per_km_bmcu
// with per_km_rate fallback); defaults to per_km_rate for back-compat.
function assignTankers(routes, routeLoads, tankers, strategy, rateOf) {
  const rate = rateOf || (t => parseFloat(t.per_km_rate) || 0);
  const sorter = strategy === 'cheapest'
    ? (a, b) => rate(a) - rate(b) || b.capacity_litres - a.capacity_litres
    : (a, b) => b.capacity_litres - a.capacity_litres;

  const sorted = [...tankers].sort(sorter);

  return routes.map((route, idx) => {
    const load = routeLoads[idx];
    const fit = sorted.filter(t => t.capacity_litres >= load)
      .sort((a, b) => a.capacity_litres - b.capacity_litres)[0]
      || sorted[0]; // overflow fallback
    return { route, load, tanker: fit };
  });
}

// Effective per-km rate for BMCU-collection costing:
// rate_per_km_bmcu → per_km_rate → 0 (tanker master maintains the real rates).
function effectiveRate(tanker) {
  const bmcuRate = parseFloat(tanker?.rate_per_km_bmcu);
  if (Number.isFinite(bmcuRate) && bmcuRate > 0) return bmcuRate;
  const baseRate = parseFloat(tanker?.per_km_rate);
  if (Number.isFinite(baseRate) && baseRate > 0) return baseRate;
  return 0;
}

module.exports = {
  SAME_DISTRICT_FALLBACK_KM,
  DIFF_DISTRICT_FALLBACK_KM,
  HARD_FALLBACK_KM,
  distKey,
  nodeKey,
  buildDistanceMap,
  makeResolver,
  nearestNeighbourOrder,
  computeRouteKm,
  clarkeWrightSavings,
  assignTankers,
  effectiveRate,
};
