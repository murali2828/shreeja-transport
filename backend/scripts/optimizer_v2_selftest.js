#!/usr/bin/env node
// backend/scripts/optimizer_v2_selftest.js
// Runnable check for services/optimizerV2.js — no database, no network.
// Builds a synthetic instance (3 plants, 40 BMCUs on a grid, 12 tankers of
// 3 sizes with per-km rates), runs the fleet optimiser with an in-memory
// distance resolver and asserts the invariants the planner relies on.
//   node backend/scripts/optimizer_v2_selftest.js
const assert = require('assert');
const { runFleetOptimizer, TT_P2P, TT_BMCU } = require('../src/services/optimizerV2');

// ── Synthetic geography: a 40 × 40 km grid, plants at three corners ─────────
const plants = [
  { id: 1, name: 'Plant A', start: null, end: { type: 'delivery_point', id: 1 }, x: 0,  y: 0 },
  { id: 2, name: 'Plant B', start: null, end: { type: 'delivery_point', id: 2 }, x: 40, y: 0 },
  { id: 3, name: 'Plant C', start: null, end: { type: 'delivery_point', id: 3 }, x: 20, y: 40 },
];
const coords = { 'delivery_point:1': [0, 0], 'delivery_point:2': [40, 0], 'delivery_point:3': [20, 40] };

const nodes = [];
let seed = 7;
const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
for (let i = 0; i < 40; i++) {
  const x = (i % 8) * 5 + 2.5, y = Math.floor(i / 8) * 8 + 4;
  coords[`bmcu:${i + 1}`] = [x, y];
  // nearest plant is the catchment
  let best = null, bestD = Infinity;
  for (const p of plants) { const d = Math.hypot(p.x - x, p.y - y); if (d < bestD) { bestD = d; best = p; } }
  nodes.push({ bmcu_id: i + 1, bmcu_code: `B${String(i + 1).padStart(3, '0')}`, bmcu_name: `BMCU ${i + 1}`,
    litres: Math.round(1500 + rnd() * 6000), plant_id: best.id, shift: 'BOTH' });
}

const sizes = [{ cap: 10000, p2p: 24.5, bmcu: 26.2 }, { cap: 15000, p2p: 29.16, bmcu: 31.0 }, { cap: 30000, p2p: 49.78, bmcu: 52.1 }];
const tankers = [];
for (let i = 0; i < 12; i++) {
  const s = sizes[i % 3];
  tankers.push({ id: 100 + i, tanker_number: `AP39T${1000 + i}`, capacity_litres: s.cap, vendor_name: 'V' + (i % 4),
    state: 'Andhra Pradesh', rates: { [TT_P2P]: s.p2p, [TT_BMCU]: s.bmcu } });
}

function resolve(ta, ia, tb, ib) {
  const a = coords[`${ta}:${ia}`], b = coords[`${tb}:${ib}`];
  const km = Math.hypot(a[0] - b[0], a[1] - b[1]) * 1.3;
  return { km: Math.round(km * 100) / 100, estimated: false, source: 'master' };
}

const instance = { plants, nodes, tankers, resolve };
const constraints = { seed: 42, time_budget_ms: 60000, max_iterations: 20000, restarts: 2,
  max_bmcus_per_trip: 6, max_trip_km: 450, max_trips_per_tanker_per_day: 2, fill_floor: 0.85 };

const t0 = Date.now();
const out = runFleetOptimizer(instance, constraints);
const out2 = runFleetOptimizer(instance, constraints);
const ms = Date.now() - t0;

// ── Assertions ──────────────────────────────────────────────────────────────
const served = new Set(out.trips.flatMap(t => t.bmcus.map(b => b.bmcu_id)));
assert.strictEqual(out.unserved.length, 0, 'unserved BMCUs: ' + JSON.stringify(out.unserved.map(u => [u.bmcu_id, u.reason])));
assert.strictEqual(served.size, nodes.length, 'every BMCU is served exactly once');

const perTanker = {};
for (const t of out.trips) {
  assert.ok(t.total_qty_litres <= t.capacity_litres + 1e-6, `capacity breach on trip ${t.trip_seq}`);
  assert.ok(t.bmcus.length <= constraints.max_bmcus_per_trip, `too many BMCUs on trip ${t.trip_seq}`);
  assert.ok(t.km <= constraints.max_trip_km, `trip ${t.trip_seq} above max km`);
  assert.strictEqual(t.transport_type, t.bmcus.length === 1 ? TT_P2P : TT_BMCU, 'transport type rule');
  assert.ok(Math.abs(t.cost - Math.round(t.km * t.rate_per_km * 100) / 100) < 0.011, 'cost = km × rate');
  for (const b of t.bmcus) assert.strictEqual(nodes.find(n => n.bmcu_id === b.bmcu_id).plant_id, t.plant_id, 'no plant switch by default');
  perTanker[t.tanker_id] = (perTanker[t.tanker_id] || 0) + 1;
}
for (const [id, n] of Object.entries(perTanker))
  assert.ok(n <= constraints.max_trips_per_tanker_per_day, `tanker ${id} has ${n} trips`);

assert.ok(out.stats.search_cost <= out.stats.seed_cost + 1e-6, `local search worsened cost: ${out.stats.search_cost} > ${out.stats.seed_cost}`);
assert.deepStrictEqual(
  out.trips.map(t => [t.tanker_id, t.bmcus.map(b => b.bmcu_id)]),
  out2.trips.map(t => [t.tanker_id, t.bmcus.map(b => b.bmcu_id)]),
  'deterministic with a fixed seed');
assert.strictEqual(out.totals.cost, out2.totals.cost, 'deterministic cost');

// ── Report ──────────────────────────────────────────────────────────────────
console.log('optimizer_v2_selftest: OK');
console.log(`  BMCUs ${nodes.length}, tankers ${tankers.length}, plants ${plants.length}`);
console.log(`  seed cost ₹${out.stats.seed_cost}  →  after local search ₹${out.stats.search_cost}  (${out.stats.iterations} iterations, ${out.stats.accepted} accepted, ${out.stats.restarts} restarts, ${ms} ms for two runs)`);
console.log(`  trips ${out.totals.trips}, km ${out.totals.km}, litres ${out.totals.litres}, cost/litre ₹${out.totals.cost_per_litre}, avg fill ${out.totals.avg_fill_pct} %, below floor ${out.totals.below_fill_floor_trips}`);
for (const t of out.trips)
  console.log(`  #${t.trip_seq} ${t.plant_name} ${t.tanker_number} ${t.capacity_litres}L fill ${t.fill_pct}% km ${t.km} ₹${t.cost} [${t.bmcus.map(b => b.bmcu_code).join(' → ')}]`);
