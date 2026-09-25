// backend/src/services/plantAllocation.js
// =============================================================================
// Day Optimizer — "Plan to plant requirements" (docs/OPTIMISATION_PLAN.md §3.2b).
//
// Decides WHICH BMCUs supply WHICH plant for a day when the planner enters the
// litres every plant requires, instead of sending each BMCU to its usual
// (catchment) plant. The routing itself is unchanged: the caller replaces the
// nodes' plant_id with the allocation and runs services/optimizerV2.js with
// plant switching disabled.
//
// Method (greedy, deterministic, DB-free):
//   0. Start from the catchments. Nodes whose plant is unknown or not in the
//      list are attached to the nearest listed plant. Requirements are trimmed
//      when the day's milk cannot cover them (shortfall_rule: 'priority' cuts
//      the lowest-priority plants first, 'proportional' scales every plant).
//   1. While a plant is short and another has more than it needs: among every
//      (node in a surplus plant → short plant) pair — the node not pinned, its
//      plant not locked — extra_km = d(node, new plant) − d(node, old plant);
//      skip beyond max_extra_km_per_bmcu; marginal cost = extra_km × ₹/km proxy
//      plus keep_history_bonus_pct % of the node's usual delivery leg; choose
//      the lowest marginal cost per litre that actually reduces the total
//      deficit (a node bigger than the deficit gets credit for the deficit
//      only). Ties: larger node. A node moves at most once, so the loop ends.
//   2. Nodes left in a plant that requires nothing are placed anyway: the
//      cheapest plant that still has room, else the cheapest plant of all,
//      flagged oversupplied; beyond max_extra_km they are placed and flagged
//      too. Milk is never dropped.
//
// Distances: d(node, plant) is the delivery leg BMCU → plant (resolve on the
// plant's `end` node), which is the part of a trip that changes with the plant.
// The ₹/km proxy only ranks candidate moves; real cost comes from the routing.
// scripts/plant_allocation_selftest.js exercises this file without a DB.
// =============================================================================

const DEFAULT_ALLOCATION = Object.freeze({
  max_extra_km_per_bmcu: 60,
  keep_history_bonus_pct: 5,
  shortfall_rule: 'priority',      // 'priority' | 'proportional'
});
const DEFAULT_PRIORITY = 99;

const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;

function mergeAllocationOptions(overrides) {
  const o = { ...DEFAULT_ALLOCATION };
  const src = overrides || {};
  const km = Number(src.max_extra_km_per_bmcu);
  if (Number.isFinite(km) && km >= 0) o.max_extra_km_per_bmcu = km;
  const pct = Number(src.keep_history_bonus_pct);
  if (Number.isFinite(pct) && pct >= 0) o.keep_history_bonus_pct = pct;
  if (src.shortfall_rule === 'proportional' || src.shortfall_rule === 'priority') o.shortfall_rule = src.shortfall_rule;
  return o;
}

// Normalise the planner's requirement rows: one entry per plant id.
function normaliseRequirements(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const id = Number(r?.delivery_point_id);
    if (!Number.isFinite(id)) continue;
    const litres = Number(r.required_litres);
    const priority = Number(r.priority);
    out.set(id, {
      required_litres: Number.isFinite(litres) && litres > 0 ? litres : 0,
      priority: Number.isFinite(priority) && priority >= 1 ? Math.floor(priority) : DEFAULT_PRIORITY,
      locked: r.locked === true || r.locked === 'true',
    });
  }
  return out;
}

// ─── Allocation ─────────────────────────────────────────────────────────────
// nodes:   [{ bmcu_id, bmcu_code, bmcu_name, litres, plant_id (catchment) }]
// plants:  [{ id, name, end: {type,id}, required_litres, priority, locked }]
// resolve: (typeA, idA, typeB, idB) → { km }
// ratePerKm: ₹/km proxy for ranking moves (litre-weighted fleet mean)
// options: { max_extra_km_per_bmcu, keep_history_bonus_pct, shortfall_rule }
// pinnedBmcuIds: BMCUs that must keep their catchment plant
function allocatePlants({ nodes, plants, resolve, ratePerKm, options, pinnedBmcuIds }) {
  const O = mergeAllocationOptions(options);
  const rate = Number(ratePerKm) > 0 ? Number(ratePerKm) : 1;
  const pinned = new Set((pinnedBmcuIds || []).map(Number));
  const notes = [];
  const plantList = plants.map(p => ({
    id: p.id, name: p.name, end: p.end,
    required: Math.max(0, Number(p.required_litres) || 0),
    priority: Number(p.priority) >= 1 ? Math.floor(Number(p.priority)) : DEFAULT_PRIORITY,
    locked: !!p.locked,
    effective_required: 0, allocated: 0, moved_in: 0, moved_out: 0, oversupplied: 0, unmet: 0, shortfall: 0,
  }));
  const P = new Map(plantList.map(p => [p.id, p]));
  if (!plantList.length) return { assignments: new Map(), moves: [], plants: [], notes: ['No plants to allocate to'], options: O };

  const distCache = new Map();
  const d = (node, plant) => {
    const k = `${node.bmcu_id}|${plant.id}`;
    let v = distCache.get(k);
    if (v === undefined) { v = resolve('bmcu', node.bmcu_id, plant.end.type, plant.end.id).km; distCache.set(k, v); }
    return v;
  };
  const nearestPlant = node => {
    let best = null, bestKm = Infinity;
    for (const p of plantList) { const km = d(node, p); if (km < bestKm) { bestKm = km; best = p; } }
    return best;
  };

  // ── 0. Catchments as the starting point ────────────────────────────────────
  const items = [];
  let reattached = 0;
  for (const n of nodes) {
    const litres = Number(n.litres) || 0;
    if (litres <= 0) continue;
    let plantId = P.has(n.plant_id) ? n.plant_id : null;
    if (plantId == null) { plantId = nearestPlant(n).id; reattached++; }
    items.push({ node: n, litres, home: plantId, plant: plantId, moved: false, flags: [] });
    P.get(plantId).allocated += litres;
  }
  if (reattached) notes.push(`${reattached} BMCU(s) had no usual plant among the listed plants and start from the nearest one`);
  const supplyTotal = items.reduce((s, it) => s + it.litres, 0);
  const requiredTotal = plantList.reduce((s, p) => s + p.required, 0);

  // Trim requirements the milk cannot cover, so the greedy step chases
  // reachable targets and the shortfall lands where the rule says.
  for (const p of plantList) p.effective_required = p.required;
  if (requiredTotal > supplyTotal + 1e-6) {
    let gap = requiredTotal - supplyTotal;
    if (O.shortfall_rule === 'proportional') {
      const f = requiredTotal > 0 ? supplyTotal / requiredTotal : 0;
      for (const p of plantList) { p.effective_required = r2(p.required * f); p.shortfall = r2(p.required - p.effective_required); }
      notes.push(`Total requirement ${Math.round(requiredTotal)} L exceeds the day's forecast supply ${Math.round(supplyTotal)} L — every plant's requirement scaled to ${Math.round(f * 1000) / 10} %`);
    } else {
      // lowest priority (largest number) absorbs first; ties: smaller plant first
      const order = [...plantList].sort((a, b) => b.priority - a.priority || a.required - b.required || b.id - a.id);
      for (const p of order) {
        if (gap <= 1e-6) break;
        const cut = Math.min(p.required, gap);
        p.effective_required = r2(p.required - cut); p.shortfall = r2(cut); gap -= cut;
      }
      const cutNames = plantList.filter(p => p.shortfall > 0).map(p => `${p.name} −${Math.round(p.shortfall)} L (priority ${p.priority})`);
      notes.push(`Total requirement ${Math.round(requiredTotal)} L exceeds the day's forecast supply ${Math.round(supplyTotal)} L — shortfall absorbed by the lowest-priority plant(s): ${cutNames.join(', ')}`);
    }
  }

  const deficitOf = p => Math.max(0, p.effective_required - p.allocated);
  const surplusOf = p => Math.max(0, p.allocated - p.effective_required);
  const histPenalty = it => O.keep_history_bonus_pct / 100 * d(it.node, P.get(it.home)) * rate;

  // ── 1. Greedy min-cost reassignment ────────────────────────────────────────
  const moves = [];
  for (let guard = 0; guard <= items.length; guard++) {
    const deficits = plantList.filter(p => deficitOf(p) > 1e-6);
    if (!deficits.length) break;
    let best = null;
    for (const it of items) {
      if (it.moved || pinned.has(Number(it.node.bmcu_id))) continue;
      const from = P.get(it.plant);
      if (from.locked) continue;
      const fromSurplus = surplusOf(from);
      if (fromSurplus <= 1e-6) continue;
      const kmOld = d(it.node, from);
      for (const to of deficits) {
        if (to.id === from.id) continue;
        const kmNew = d(it.node, to);
        const extraKm = kmNew - kmOld;
        if (extraKm > O.max_extra_km_per_bmcu) continue;
        // useful litres: what the short plant gains minus the deficit this opens at the old plant
        const gain = Math.min(it.litres, deficitOf(to)) - Math.max(0, it.litres - fromSurplus);
        if (gain <= 1e-6) continue;
        const marginal = extraKm * rate + (it.plant === it.home ? histPenalty(it) : 0);
        const score = marginal / gain;
        if (!best || score < best.score - 1e-9
          || (Math.abs(score - best.score) <= 1e-9 && (it.litres > best.it.litres
            || (it.litres === best.it.litres && (to.priority < best.to.priority || it.node.bmcu_id < best.it.node.bmcu_id))))) {
          best = { it, from, to, extraKm, marginal, score };
        }
      }
    }
    if (!best) break;
    const { it, from, to, extraKm, marginal } = best;
    from.allocated -= it.litres; from.moved_out += it.litres;
    to.allocated += it.litres; to.moved_in += it.litres;
    it.plant = to.id; it.moved = true;
    moves.push({
      bmcu_id: it.node.bmcu_id, bmcu_code: it.node.bmcu_code || null, bmcu_name: it.node.bmcu_name || null,
      litres: r2(it.litres), from_plant_id: from.id, from_plant_name: from.name, to_plant_id: to.id, to_plant_name: to.name,
      extra_km: r1(extraKm), marginal_cost: r2(marginal), reason: 'fills requirement',
    });
  }

  // ── 2. Milk stranded at plants that require nothing ────────────────────────
  for (const it of items) {
    const cur = P.get(it.plant);
    if (cur.effective_required > 0 || pinned.has(Number(it.node.bmcu_id))) continue;
    if (it.moved) continue;
    const kmOld = d(it.node, cur);
    const candidates = plantList.filter(p => p.id !== cur.id && p.effective_required > 0);
    if (!candidates.length) { it.flags.push('oversupplied'); continue; }   // nowhere else takes milk today
    const scored = candidates.map(p => ({ p, extraKm: d(it.node, p) - kmOld }))
      .sort((a, b) => a.extraKm - b.extraKm || a.p.priority - b.p.priority || a.p.id - b.p.id);
    let choice = scored.find(c => c.extraKm <= O.max_extra_km_per_bmcu && deficitOf(c.p) > 1e-6);
    let flag = null;
    if (!choice) { choice = scored.find(c => c.extraKm <= O.max_extra_km_per_bmcu); flag = 'oversupplied'; }
    if (!choice) { choice = scored[0]; flag = 'beyond_max_extra_km'; }
    cur.allocated -= it.litres; cur.moved_out += it.litres;
    choice.p.allocated += it.litres; choice.p.moved_in += it.litres;
    it.plant = choice.p.id; it.moved = true; if (flag) it.flags.push(flag);
    moves.push({
      bmcu_id: it.node.bmcu_id, bmcu_code: it.node.bmcu_code || null, bmcu_name: it.node.bmcu_name || null,
      litres: r2(it.litres), from_plant_id: cur.id, from_plant_name: cur.name, to_plant_id: choice.p.id, to_plant_name: choice.p.name,
      extra_km: r1(choice.extraKm), marginal_cost: r2(choice.extraKm * rate + histPenalty(it)),
      reason: flag === 'beyond_max_extra_km' ? `${cur.name} requires nothing; nearest plant that takes milk is beyond ${O.max_extra_km_per_bmcu} km`
        : flag === 'oversupplied' ? `${cur.name} requires nothing; placed at the nearest plant, which is already covered`
        : `${cur.name} requires nothing`,
      flag,
    });
  }

  // ── Output ─────────────────────────────────────────────────────────────────
  const assignments = new Map(items.map(it => [it.node.bmcu_id, it.plant]));
  const plantsOut = plantList.map(p => {
    const unmet = r2(Math.max(0, p.required - p.allocated));
    const over = r2(Math.max(0, p.allocated - p.required));
    let unmetReason = null;
    if (unmet > 0) {
      unmetReason = p.shortfall > 0 && p.allocated >= p.effective_required - 1e-6
        ? `day's supply below total requirement (${O.shortfall_rule} rule)`
        : p.locked ? 'no BMCU within reach; plant is locked so only additions were tried'
        : `no BMCU could be moved in within ${O.max_extra_km_per_bmcu} km without opening a gap elsewhere`;
    }
    return {
      id: p.id, name: p.name, priority: p.priority, locked: p.locked,
      required: r2(p.required), effective_required: r2(p.effective_required), shortfall: r2(p.shortfall),
      allocated: r2(p.allocated), unmet, oversupplied: over,
      moved_in: r2(p.moved_in), moved_out: r2(p.moved_out),
      bmcu_count: items.filter(it => it.plant === p.id).length,
      unmet_reason: unmetReason,
    };
  });
  const flagged = items.filter(it => it.flags.length);
  if (flagged.length) notes.push(`${flagged.length} BMCU(s) placed outside the requirements (plant already covered or beyond the km limit) — milk is never dropped`);
  const unmetTotal = plantsOut.reduce((s, p) => s + p.unmet, 0);
  if (unmetTotal > 0) notes.push(`${Math.round(unmetTotal)} L of requirement unmet in total`);
  if (pinned.size) notes.push(`${pinned.size} BMCU(s) pinned to their usual plant by the planner`);

  return {
    assignments, moves, plants: plantsOut, notes, options: O,
    totals: { supply: r2(supplyTotal), required: r2(requiredTotal), allocated: r2(items.reduce((s, it) => s + it.litres, 0)),
      moves: moves.length, moved_litres: r2(moves.reduce((s, m) => s + m.litres, 0)), unmet: r2(unmetTotal) },
    flagged_bmcu_ids: flagged.map(it => it.node.bmcu_id),
  };
}

module.exports = { DEFAULT_ALLOCATION, DEFAULT_PRIORITY, mergeAllocationOptions, normaliseRequirements, allocatePlants };
