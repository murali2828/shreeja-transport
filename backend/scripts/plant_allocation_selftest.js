#!/usr/bin/env node
// backend/scripts/plant_allocation_selftest.js
// Runnable check for services/plantAllocation.js ("Plan to plant requirements")
// — no database, no network. Same synthetic geography as optimizer_v2_selftest
// (3 plants at the corners of a 40 × 40 km grid, 40 BMCUs), requirements that
// force about eight BMCUs away from their usual plant, then the fleet
// optimiser run on the allocation to confirm every trip honours it.
//   node backend/scripts/plant_allocation_selftest.js
const assert = require('assert');
const { allocatePlants, mergeAllocationOptions, normaliseRequirements } = require('../src/services/plantAllocation');
const { runFleetOptimizer, TT_P2P, TT_BMCU } = require('../src/services/optimizerV2');

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
  let best = null, bestD = Infinity;
  for (const p of plants) { const d = Math.hypot(p.x - x, p.y - y); if (d < bestD) { bestD = d; best = p; } }
  nodes.push({ bmcu_id: i + 1, bmcu_code: `B${String(i + 1).padStart(3, '0')}`, bmcu_name: `BMCU ${i + 1}`,
    litres: Math.round(1500 + rnd() * 6000), plant_id: best.id, shift: 'BOTH' });
}
function resolve(ta, ia, tb, ib) {
  const a = coords[`${ta}:${ia}`], b = coords[`${tb}:${ib}`];
  return { km: Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]) * 1.3 * 100) / 100, estimated: false, source: 'master' };
}
const supplyBy = id => nodes.filter(n => n.plant_id === id).reduce((s, n) => s + n.litres, 0);
const supply = { 1: supplyBy(1), 2: supplyBy(2), 3: supplyBy(3) };
const total = supply[1] + supply[2] + supply[3];
const RATE = 30;

// ── Case 1: shift ~40 % of Plant C's milk to A and B (balanced totals) ───────
const shiftL = Math.round(supply[3] * 0.4);
const req1 = [
  { id: 1, name: 'Plant A', end: plants[0].end, required_litres: supply[1] + Math.floor(shiftL / 2), priority: 1 },
  { id: 2, name: 'Plant B', end: plants[1].end, required_litres: supply[2] + Math.ceil(shiftL / 2), priority: 2 },
  { id: 3, name: 'Plant C', end: plants[2].end, required_litres: supply[3] - shiftL, priority: 3 },
];
const a1 = allocatePlants({ nodes, plants: req1, resolve, ratePerKm: RATE, options: { max_extra_km_per_bmcu: 60 } });
const a1b = allocatePlants({ nodes, plants: req1, resolve, ratePerKm: RATE, options: { max_extra_km_per_bmcu: 60 } });
assert.strictEqual(a1.assignments.size, nodes.length, 'every node assigned');
for (const n of nodes) assert.ok([1, 2, 3].includes(a1.assignments.get(n.bmcu_id)), 'assigned to a listed plant');
assert.ok(a1.moves.length >= 4 && a1.moves.length <= 12, `expected a handful of moves, got ${a1.moves.length}`);
for (const m of a1.moves) { assert.strictEqual(m.from_plant_id, 3); assert.ok([1, 2].includes(m.to_plant_id)); assert.ok(m.extra_km <= 60); }
const biggest = Math.max(...nodes.map(n => n.litres));
for (const p of a1.plants) {
  if (p.oversupplied > 0) assert.ok(p.oversupplied < biggest, `${p.name} over its requirement by more than one node (${p.oversupplied})`);
  assert.strictEqual(p.allocated, nodes.filter(n => a1.assignments.get(n.bmcu_id) === p.id).reduce((s, n) => s + n.litres, 0), 'allocated = Σ node litres');
}
assert.ok(a1.plants.reduce((s, p) => s + p.unmet, 0) < biggest, 'residual unmet is below one node');
assert.ok(a1.flagged_bmcu_ids.length === 0, 'no forced placements when totals balance');
assert.deepStrictEqual(a1.moves, a1b.moves, 'deterministic');
// moves are sorted by cost per litre: the first move is the cheapest
assert.ok(a1.moves[0].marginal_cost / a1.moves[0].litres <= a1.moves[a1.moves.length - 1].marginal_cost / a1.moves[a1.moves.length - 1].litres + 1e-9, 'cheapest move first');

// ── Case 2: pins are honoured ────────────────────────────────────────────────
const pinIds = a1.moves.slice(0, 2).map(m => m.bmcu_id);
const a2 = allocatePlants({ nodes, plants: req1, resolve, ratePerKm: RATE, options: {}, pinnedBmcuIds: pinIds });
for (const id of pinIds) assert.strictEqual(a2.assignments.get(id), 3, `pinned BMCU ${id} kept its usual plant`);
assert.ok(!a2.moves.some(m => pinIds.includes(m.bmcu_id)), 'pinned BMCUs are never moved');
assert.strictEqual(a2.assignments.size, nodes.length);

// ── Case 3: total requirement above supply — lowest priority is left short ──
const req3 = [
  { id: 1, name: 'Plant A', end: plants[0].end, required_litres: supply[1] + 20000, priority: 1 },
  { id: 2, name: 'Plant B', end: plants[1].end, required_litres: supply[2], priority: 2 },
  { id: 3, name: 'Plant C', end: plants[2].end, required_litres: supply[3] + 5000, priority: 3 },
];
const a3 = allocatePlants({ nodes, plants: req3, resolve, ratePerKm: RATE, options: { shortfall_rule: 'priority', max_extra_km_per_bmcu: 100 } });
const p3 = Object.fromEntries(a3.plants.map(p => [p.id, p]));
assert.ok(p3[3].shortfall >= 5000, 'lowest priority absorbs the shortfall first');
assert.strictEqual(p3[1].shortfall, 0, 'highest priority keeps its requirement');
assert.ok(p3[3].unmet >= 5000, 'Plant C is left short');
assert.strictEqual(a3.assignments.size, nodes.length, 'every node still assigned');
assert.ok(a3.notes.some(n => /shortfall/.test(n)), 'shortfall note');
const a3p = allocatePlants({ nodes, plants: req3, resolve, ratePerKm: RATE, options: { shortfall_rule: 'proportional' } });
assert.ok(a3p.plants.every(p => p.shortfall > 0), 'proportional rule trims every plant');
assert.ok(Math.abs(a3p.plants.reduce((s, p) => s + p.effective_required, 0) - total) < 1, 'proportional targets sum to the supply');

// ── Case 4: a plant that requires nothing — its milk is placed, never dropped ─
const req4 = [
  { id: 1, name: 'Plant A', end: plants[0].end, required_litres: supply[1] + supply[3], priority: 1 },
  { id: 2, name: 'Plant B', end: plants[1].end, required_litres: supply[2], priority: 2 },
  { id: 3, name: 'Plant C', end: plants[2].end, required_litres: 0, priority: 3 },
];
const a4 = allocatePlants({ nodes, plants: req4, resolve, ratePerKm: RATE, options: { max_extra_km_per_bmcu: 30 } });
assert.strictEqual(a4.assignments.size, nodes.length);
assert.ok(![...a4.assignments.values()].includes(3), 'nothing left at the plant that requires nothing');
const far = a4.moves.filter(m => m.flag === 'beyond_max_extra_km');
assert.ok(far.length > 0, 'far BMCUs are placed anyway and flagged');
assert.ok(a4.flagged_bmcu_ids.length === far.length + a4.moves.filter(m => m.flag === 'oversupplied').length);

// ── Case 5: locked plant only receives ──────────────────────────────────────
const req5 = req1.map(p => p.id === 3 ? { ...p, locked: true } : p);
const a5 = allocatePlants({ nodes, plants: req5, resolve, ratePerKm: RATE, options: {} });
assert.ok(!a5.moves.some(m => m.from_plant_id === 3), 'locked plant keeps its catchment BMCUs');
assert.ok(a5.plants.find(p => p.id === 2).unmet > 0, 'Plant B stays short when its only source is locked');

// ── Case 6: options / requirement parsing ───────────────────────────────────
assert.deepStrictEqual(mergeAllocationOptions({ max_extra_km_per_bmcu: '80', shortfall_rule: 'bogus', keep_history_bonus_pct: -1 }),
  { max_extra_km_per_bmcu: 80, keep_history_bonus_pct: 5, shortfall_rule: 'priority' });
const nr = normaliseRequirements([{ delivery_point_id: '2', required_litres: '1000', priority: '0', locked: 'true' }, { delivery_point_id: 'x' }]);
assert.deepStrictEqual([...nr.entries()], [[2, { required_litres: 1000, priority: 99, locked: true }]]);

// ── Routing honours the allocation ──────────────────────────────────────────
const sizes = [{ cap: 10000, p2p: 24.5, bmcu: 26.2 }, { cap: 15000, p2p: 29.16, bmcu: 31.0 }, { cap: 30000, p2p: 49.78, bmcu: 52.1 }];
const tankers = [];
for (let i = 0; i < 12; i++) {
  const s = sizes[i % 3];
  tankers.push({ id: 100 + i, tanker_number: `AP39T${1000 + i}`, capacity_litres: s.cap, vendor_name: 'V' + (i % 4), state: 'Andhra Pradesh', rates: { [TT_P2P]: s.p2p, [TT_BMCU]: s.bmcu } });
}
const routed = nodes.map(n => ({ ...n, plant_id: a1.assignments.get(n.bmcu_id) }));
const out = runFleetOptimizer({ plants, nodes: routed, tankers, resolve },
  { seed: 42, time_budget_ms: 20000, max_iterations: 8000, restarts: 1, max_bmcus_per_trip: 6, max_trip_km: 450, max_trips_per_tanker_per_day: 2, allow_plant_switch: true });
assert.strictEqual(out.constraints.allow_plant_switch, true, 'core accepts the flag; the route forces it false in requirements mode');
const out2 = runFleetOptimizer({ plants, nodes: routed, tankers, resolve },
  { seed: 42, time_budget_ms: 20000, max_iterations: 8000, restarts: 1, max_bmcus_per_trip: 6, max_trip_km: 450, max_trips_per_tanker_per_day: 2, allow_plant_switch: false });
assert.strictEqual(out2.unserved.length, 0);
for (const t of out2.trips) for (const b of t.bmcus) assert.strictEqual(a1.assignments.get(b.bmcu_id), t.plant_id, 'trip plant = allocated plant');
const delivered = {};
for (const t of out2.trips) delivered[t.plant_id] = (delivered[t.plant_id] || 0) + t.total_qty_litres;
for (const p of a1.plants) assert.ok(Math.abs((delivered[p.id] || 0) - p.allocated) < 1, `plan delivers the allocation at ${p.name}`);

console.log('plant_allocation_selftest: OK');
console.log(`  supply A ${supply[1]} / B ${supply[2]} / C ${supply[3]} L; case 1 shifts ${shiftL} L from C to A + B`);
console.log(`  case 1: ${a1.moves.length} moves, ${a1.totals.moved_litres} L moved, unmet ${a1.totals.unmet} L`);
for (const m of a1.moves) console.log(`    ${m.bmcu_code} ${m.litres} L  ${m.from_plant_name} → ${m.to_plant_name}  +${m.extra_km} km  ₹${m.marginal_cost}`);
for (const p of a1.plants) console.log(`    ${p.name}: required ${p.required} allocated ${p.allocated} unmet ${p.unmet} over ${p.oversupplied} (${p.bmcu_count} BMCUs)`);
console.log(`  case 3 (priority): ${a3.plants.map(p => `${p.name} short ${p.unmet}`).join(', ')}`);
console.log(`  case 4 (Plant C requires 0): ${a4.moves.length} moves, ${far.length} beyond km limit`);
console.log(`  routing on case 1: ${out2.totals.trips} trips, ₹${out2.totals.cost}, fill ${out2.totals.avg_fill_pct} %`);
