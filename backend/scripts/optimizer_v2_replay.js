#!/usr/bin/env node
// backend/scripts/optimizer_v2_replay.js
// Offline replay of the Day Optimizer (services/optimizerV2.js) against a
// production extract, so a bad run can be reproduced and fixed without a
// database. No DB, no network: every distance is Haversine × ROAD_FACTOR,
// for the optimiser AND for pricing the actual plans, so the comparison is
// fair (the absolute km differ from Google km, the ranking does not).
//
//   node backend/scripts/optimizer_v2_replay.js <extract.csv> [YYYY-MM-DD] [--all-fleet] [--json]
//
// CSV columns (one row per BMCU stop): plan_for_date, shifts_milk, trip_no,
// tanker_number, capacity_litres, vendor, route_name, start_point,
// delivery_point, seq_no, bmcu_code, bmcu_name, district, latitude, longitude,
// milk_date, shift, disp_litres, rmrd_litres, trip_ack_litres, trip_km,
// billed_km, google_km, state, rate_per_km, amount, is_sale
//
// Instance built for the chosen date:
//   demand   per BMCU = Σ rmrd_litres (fallback disp_litres) of its stops that
//            day; plant = the delivery point the BMCU went to that day
//   fleet    every non-sale tanker seen in the extract; capacity from the
//            extract; available = ran on the date (or every tanker with
//            --all-fleet); max_trips_per_tanker_per_day from the page default
//   rates    learned from the extract: capacity × state × transport type
//            ('Point to Point' when the trip had one BMCU, else 'BMCU/CC to
//            Dairy/CC'), mode of rate_per_km; a tanker's state = the state it
//            was billed in most often, else its registration prefix
//   plants   approximate coordinates hardcoded below (the extract has none)
const fs = require('fs');
const path = require('path');
const { runFleetOptimizer, DEFAULT_CONSTRAINTS, TT_P2P, TT_BMCU, transportTypeFor, routeKm } = require('../src/services/optimizerV2');
const { haversineKm, ROAD_FACTOR } = require('../src/utils/geo');
const { stateFromRegistration } = require('../src/services/rates');

// ─── Plant coordinates (approximate; the extract carries none) ──────────────
const PLANT_COORDS = {
  'Balaji Dairy': [13.6525, 79.4192],
  'S K A Dairy': [12.7500, 78.6800],
  'Bathalapalli': [14.5180, 77.7800],
  'ARVAIS Dairy(HYD)': [17.3850, 78.4867],
  'KMF, Kanakapura': [12.5460, 77.4200],
  'Jersey Milk Processing Unit, Madanapalli.': [13.3802, 78.3320],
};
const normName = s => String(s || '').replace(/\s+/g, ' ').trim();

// ─── CSV (quoted fields with embedded commas/newlines) ──────────────────────
function parseCsv(txt) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const h = rows[0];
  return rows.slice(1).filter(r => r.length === h.length).map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const mode = arr => { const m = new Map(); for (const v of arr) m.set(v, (m.get(v) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0]; };
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
const pct = v => `${r1(v)} %`;

// ─── Build everything the replay needs from the extract ─────────────────────
function buildReplay(rows, date, opts) {
  const nonSale = rows.filter(r => r.is_sale !== 't');
  // trips: key date|trip_no|tanker
  const tripsByKey = new Map();
  for (const r of nonSale) {
    const k = `${r.plan_for_date}|${r.trip_no}|${r.tanker_number}`;
    if (!tripsByKey.has(k)) tripsByKey.set(k, []);
    tripsByKey.get(k).push(r);
  }
  const distinctBmcus = stops => new Set(stops.map(s => s.bmcu_code)).size;

  // Rates learned from the extract
  const rateSamples = new Map(); // cap|state|tt → [rate]
  const stateSamples = new Map(); // tanker → [state]
  for (const stops of tripsByKey.values()) {
    const r = stops[0], rate = num(r.rate_per_km), cap = parseInt(r.capacity_litres) || 0;
    if (!(rate > 0) || !r.state || !cap) continue;
    const tt = transportTypeFor(distinctBmcus(stops));
    const k = `${cap}|${r.state}|${tt}`;
    if (!rateSamples.has(k)) rateSamples.set(k, []);
    rateSamples.get(k).push(rate);
    if (!stateSamples.has(r.tanker_number)) stateSamples.set(r.tanker_number, []);
    stateSamples.get(r.tanker_number).push(r.state);
  }
  const rateTable = new Map([...rateSamples].map(([k, v]) => [k, mode(v)]));
  let rateFallbacks = 0;
  const rateFor = (cap, state, tt) => {
    const exact = rateTable.get(`${cap}|${state}|${tt}`);
    if (exact) return exact;
    const other = rateTable.get(`${cap}|${state}|${tt === TT_P2P ? TT_BMCU : TT_P2P}`);
    if (other) { rateFallbacks++; return other; }
    const anyState = [...rateTable].find(([k]) => k.startsWith(`${cap}|`) && k.endsWith(`|${tt}`));
    if (anyState) { rateFallbacks++; return anyState[1]; }
    return null;
  };

  // BMCUs
  const bmcuById = new Map();
  for (const r of rows) {
    const id = parseInt(r.bmcu_code); if (!id) continue;
    if (!bmcuById.has(id) || bmcuById.get(id).latitude == null)
      bmcuById.set(id, { id, bmcu_code: r.bmcu_code, bmcu_name: r.bmcu_name, district: r.district, latitude: num(r.latitude), longitude: num(r.longitude) });
  }

  // Plants (delivery points seen on the date)
  const plantIdByName = new Map(); const plants = [];
  const plantFor = name => {
    const n = normName(name);
    if (!plantIdByName.has(n)) {
      const c = PLANT_COORDS[n];
      plants.push({ id: plants.length + 1, name: n, latitude: c?.[0] ?? null, longitude: c?.[1] ?? null,
        start: null, end: { type: 'delivery_point', id: plants.length + 1 }, has_coords: !!c });
      plantIdByName.set(n, plants.length);
    }
    return plants[plantIdByName.get(n) - 1];
  };

  // Resolver: Haversine × ROAD_FACTOR for every pair (a plant without
  // coordinates cannot be modelled — its trips are dropped on both sides)
  const coordOf = (type, id) => {
    if (type === 'bmcu') { const b = bmcuById.get(id); return b && b.latitude != null ? [b.latitude, b.longitude] : null; }
    const p = plants[id - 1]; return p && p.has_coords ? [p.latitude, p.longitude] : null;
  };
  const resolve = (ta, ia, tb, ib) => {
    const a = coordOf(ta, ia), b = coordOf(tb, ib);
    if (!a || !b) return { km: 50, estimated: true, source: 'fallback' };
    return { km: r2(haversineKm(a[0], a[1], b[0], b[1]) * ROAD_FACTOR), estimated: false, source: 'geo' };
  };

  // Day trips → demand nodes + actual plan pricing
  const dayTrips = [...tripsByKey.values()].filter(s => s[0].plan_for_date === date);
  const demand = new Map(); // bmcu id → { litres, plant }
  const dropped = [];
  const actual = { trips: 0, km: 0, litres: 0, cost: 0, cap: 0, billed_amount: 0, billed_km: 0, unpriced: 0, over_max_km: 0, max_bmcus: 0 };
  const tankerOnDate = new Set();
  for (const stops of dayTrips) {
    const r = stops[0];
    const plant = plantFor(r.delivery_point);
    if (!plant.has_coords) { dropped.push(`${r.tanker_number} → ${plant.name} (no plant coordinates)`); continue; }
    tankerOnDate.add(r.tanker_number);
    const cap = parseInt(r.capacity_litres) || 0;
    // demand
    const byBmcu = new Map();
    for (const s of stops) {
      const id = parseInt(s.bmcu_code); if (!id) continue;
      const l = num(s.rmrd_litres) ?? num(s.disp_litres) ?? 0;
      byBmcu.set(id, (byBmcu.get(id) || 0) + l);
    }
    for (const [id, l] of byBmcu) {
      const d = demand.get(id) || { litres: 0, plant_id: plant.id };
      d.litres += l; demand.set(id, d);
    }
    // price the actual trip with the same distance model: plant → stops in
    // recorded order → plant (billing pays the round trip from the plant, and
    // the optimiser models the same, whatever start point the plan recorded)
    const orderedIds = [...new Set(stops.sort((a, b) => parseInt(a.seq_no) - parseInt(b.seq_no)).map(s => parseInt(s.bmcu_code)))];
    const km = routeKm({ start: null, end: plant.end }, orderedIds.map(id => ({ bmcu_id: id })), resolve).km;
    const nB = orderedIds.length;
    const state = mode(stateSamples.get(r.tanker_number) || []) || r.state || stateFromRegistration(r.tanker_number);
    const rate = rateFor(cap, state, transportTypeFor(nB));
    const litres = [...byBmcu.values()].reduce((a, b) => a + b, 0);
    actual.trips++; actual.km += km; actual.litres += litres; actual.cap += cap;
    if (rate) actual.cost += km * rate; else actual.unpriced++;
    actual.billed_amount += num(r.amount) || 0; actual.billed_km += num(r.billed_km) || 0;
    if (km > DEFAULT_CONSTRAINTS.max_trip_km) actual.over_max_km++;
    actual.max_bmcus = Math.max(actual.max_bmcus, nB);
  }
  actual.avg_fill_pct = actual.cap ? actual.litres / actual.cap * 100 : 0;

  // Fleet
  const tankerRows = new Map();
  for (const stops of tripsByKey.values()) {
    const r = stops[0];
    if (!tankerRows.has(r.tanker_number)) tankerRows.set(r.tanker_number, { caps: [], vendor: r.vendor });
    tankerRows.get(r.tanker_number).caps.push(parseInt(r.capacity_litres) || 0);
  }
  const fleet = []; let excludedNoRate = 0, notOnDate = 0;
  let tid = 1;
  for (const [no, t] of [...tankerRows].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    const cap = mode(t.caps);
    const state = mode(stateSamples.get(no) || []) || stateFromRegistration(no);
    const rates = { [TT_P2P]: state ? rateFor(cap, state, TT_P2P) : null, [TT_BMCU]: state ? rateFor(cap, state, TT_BMCU) : null };
    const row = { id: tid++, tanker_number: no, capacity_litres: cap, vendor_name: t.vendor, state, rates, available: true };
    if (!cap || (!rates[TT_P2P] && !rates[TT_BMCU])) { row.available = false; excludedNoRate++; }
    else if (!opts.allFleet && !tankerOnDate.has(no)) { row.available = false; notOnDate++; }
    fleet.push(row);
  }

  const nodes = [...demand].map(([id, d]) => {
    const b = bmcuById.get(id);
    return { bmcu_id: id, bmcu_code: b.bmcu_code, bmcu_name: b.bmcu_name, district: b.district, litres: r2(d.litres), plant_id: d.plant_id, shift: 'AM+PM' };
  });
  const usedPlantIds = new Set(nodes.map(n => n.plant_id));
  const instance = { plants: plants.filter(p => usedPlantIds.has(p.id)), nodes, tankers: fleet.filter(f => f.available), resolve };
  return { instance, actual, fleet, dropped, rateFallbacks, excludedNoRate, notOnDate, plants };
}

// ─── Checks against the actual plans ────────────────────────────────────────
function evaluate(result, actual, C, nodes) {
  const perTanker = {};
  let overKm = 0, overBmcus = 0, overCap = 0;
  for (const t of result.trips) {
    perTanker[t.tanker_id] = (perTanker[t.tanker_id] || 0) + 1;
    if (t.km > C.max_trip_km && t.bmcus.length > 1) overKm++;
    if (t.bmcus.length > C.max_bmcus_per_trip) overBmcus++;
    if (t.total_qty_litres > t.capacity_litres + 1e-6) overCap++;
  }
  const overTrips = Object.values(perTanker).filter(n => n > C.max_trips_per_tanker_per_day).length;
  const served = new Set(result.trips.flatMap(t => t.bmcus.map(b => b.bmcu_id)));
  const checks = [
    ['all BMCUs served', result.unserved.length === 0 && served.size === nodes.length],
    ['cost ≤ actual', result.totals.cost <= actual.cost + 0.01],
    ['avg fill ≥ actual − 2', result.totals.avg_fill_pct >= actual.avg_fill_pct - 2],
    ['no multi-BMCU trip > max_trip_km', overKm === 0],
    ['≤ max_trips_per_tanker', overTrips === 0],
    ['≤ max_bmcus_per_trip', overBmcus === 0],
    ['capacity respected', overCap === 0],
  ];
  return checks;
}

// ─── Main ───────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--') && a.endsWith('.csv')) || path.join(__dirname, 'fixtures', 'cal.csv');
  const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || '2026-09-09';
  const opts = { allFleet: args.includes('--all-fleet'), json: args.includes('--json') };
  // --max-bmcus=N --max-km=N --time=ms --iters=N override the page defaults (e.g. to
  // compare at the planners' actual practice: up to 8 BMCUs and 550 km trips)
  const over = {};
  for (const [flag, key] of [['--max-bmcus=', 'max_bmcus_per_trip'], ['--max-km=', 'max_trip_km'], ['--time=', 'time_budget_ms'], ['--iters=', 'max_iterations'], ['--trips-per-tanker=', 'max_trips_per_tanker_per_day']]) {
    const a = args.find(x => x.startsWith(flag)); if (a) over[key] = Number(a.slice(flag.length));
  }
  if (!fs.existsSync(file)) { console.error(`extract not found: ${file}`); process.exit(2); }
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const { instance, actual, fleet, dropped, rateFallbacks, excludedNoRate, notOnDate } = buildReplay(rows, date, opts);
  if (!instance.nodes.length) { console.error(`no non-sale trips on ${date} in ${file}`); process.exit(2); }

  const C = { ...DEFAULT_CONSTRAINTS, ...over }; // the page defaults unless overridden
  const t0 = Date.now();
  const result = runFleetOptimizer(instance, C);
  const ms = Date.now() - t0;
  const R = result.totals, S = result.stats;
  const demandL = instance.nodes.reduce((s, n) => s + n.litres, 0);

  if (opts.json) { console.log(JSON.stringify({ date, actual, result: { totals: R, stats: S, unserved: result.unserved.length } }, null, 1)); return; }
  console.log(`Replay ${date} — ${instance.nodes.length} BMCUs, ${r2(demandL)} L demand, ${instance.plants.length} plants, ` +
    `${instance.tankers.length} tankers available (${fleet.length} in extract; ${notOnDate} not on the date, ${excludedNoRate} without a rate)` +
    `; distances Haversine × ${ROAD_FACTOR}; ${rateFallbacks} rate fallbacks`);
  if (dropped.length) console.log(`  dropped (plant without coordinates): ${dropped.join(', ')}`);
  console.log(`  ACTUAL plans : trips ${actual.trips}, km ${r1(actual.km)}, litres ${r2(actual.litres)}, cost ₹${r2(actual.cost)}, fill ${pct(actual.avg_fill_pct)}` +
    ` (billed: ${r1(actual.billed_km)} km ₹${r2(actual.billed_amount)}; ${actual.over_max_km} trips > ${C.max_trip_km} km; up to ${actual.max_bmcus} BMCUs/trip; ${actual.unpriced} unpriced)`);
  console.log(`  OPTIMISER    : trips ${R.trips}, km ${R.km}, litres ${R.litres}, cost ₹${R.cost}, fill ${pct(R.avg_fill_pct)}, unserved ${result.unserved.length}, ` +
    `below floor ${R.below_fill_floor_trips}, est. legs ${R.estimated_legs}`);
  console.log(`  stats        : seed ₹${S.seed_cost} → search ₹${S.search_cost}; ${S.iterations} iterations, ${S.accepted} accepted, ${S.restarts} restarts, ${S.kicks ?? 0} kicks, ${ms} ms` +
    (S.moves ? '\n  moves        : ' + Object.entries(S.moves).map(([k, v]) => `${k} ${v.accepted}/${v.tried}`).join(', ') : '') +
    (S.seed_candidates ? '\n  seeds        : ' + S.seed_candidates.map(s => `${s.capacity} L → ₹${s.cost}${s.chosen ? ' *' : ''}`).join(', ') : ''));
  if (result.unserved.length) {
    const byReason = {}; for (const u of result.unserved) byReason[u.reason] = (byReason[u.reason] || 0) + 1;
    console.log('  unserved     : ' + Object.entries(byReason).map(([k, v]) => `${v} × "${k}"`).join('; '));
  }
  const checks = evaluate(result, actual, C, instance.nodes);
  for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (args.includes('--trips')) for (const t of result.trips)
    console.log(`  #${t.trip_seq} ${t.plant_name} ${t.tanker_number} ${t.capacity_litres}L fill ${t.fill_pct}% km ${t.km} ₹${t.cost} [${t.bmcus.map(b => `${b.bmcu_code}(${Math.round(b.expected_qty_litres)})`).join(' → ')}]`);
  process.exitCode = checks.every(c => c[1]) ? 0 : 1;
}

if (require.main === module) main();
module.exports = { parseCsv, buildReplay };
