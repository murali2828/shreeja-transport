// backend/src/services/dayOptimizerData.js
// =============================================================================
// Day Optimizer (fleet v2) — everything that turns database rows into the
// instance services/optimizerV2.js solves, plus the pieces the planner
// reviews before a run (demand forecast, fleet availability, plant
// catchments, distance coverage) and the comparison against what was
// actually planned. No HTTP here; routes/optimize.js owns the endpoints.
//
// Rules implemented (docs/OPTIMISATION_PLAN.md §3.1/§3.2):
//   Demand     per BMCU × shift = weighted mean of RMRD litres over the last
//              14 days (same weekday × 2, other days × 1) → else 60-day mean →
//              else the BMCU's latest plan quantity (halved for a single shift)
//              → else 0. Planner overrides win. Persisted in bmcu_demand_forecast.
//   Catchment  a BMCU's plant = the delivery point it went to most often in the
//              last 60 days of plans; else the nearest plant by distance.
//   Fleet      active tankers, not the SALE placeholder, with no credible
//              open MAINTENANCE gate pass covering the date (a pass is stale
//              once the tanker ran again; other pass reasons are ignored).
//              Planners exclude tankers by hand with the page's Use toggle.
//   Demand     above the largest available tanker is split into parts by
//              optimizerV2.splitOversizedNodes, never reported unserved.
//   Rate state the state most often chosen for the tanker in billing runs
//              (last 90 days) else derived from the registration prefix.
// =============================================================================

const { query } = require('../config/db');
const { saleTankerSql, saleTankerNumberSql } = require('../utils/saleTanker');
const { buildDistanceMap, makeResolver, nodeKey, distKey } = require('./optimizerCore');
const { loadRatesForDate, pickRate, loadBillingStates, stateFromRegistration } = require('./rates');
const { haversineKm } = require('../utils/geo');
const { TT_P2P, TT_BMCU, transportTypeFor } = require('./optimizerV2');
const { googleLegKm } = require('./roadDistance');
const { upsertMasterDistanceKm, loadMasterDistanceCache, normalisePair } = require('./distanceLookup');

const SHIFTS = ['AM', 'PM'];
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const r1 = v => Math.round((Number(v) || 0) * 10) / 10;
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const isoWeekday = iso => new Date(iso + 'T00:00:00Z').getUTCDay();
const shiftLabel = scope => scope === 'BOTH' ? 'AM+PM' : scope;

// ─── Plants (delivery points) with their usual starting point ───────────────
async function loadPlants() {
  const dps = (await query(
    'SELECT id, name, latitude, longitude FROM delivery_points WHERE is_active=TRUE ORDER BY name')).rows;
  const sps = (await query(
    'SELECT id, name, latitude, longitude FROM starting_points WHERE is_active=TRUE')).rows;
  // Most-used starting point per delivery point (last 60 days of plans)
  const usage = (await query(`
    SELECT delivery_point_id, start_point_id FROM (
      SELECT delivery_point_id, start_point_id, COUNT(*) n,
             ROW_NUMBER() OVER (PARTITION BY delivery_point_id ORDER BY COUNT(*) DESC, start_point_id) rn
      FROM trip_plans
      WHERE plan_for_date >= CURRENT_DATE - 60 AND status NOT IN ('cancelled','deleted')
        AND delivery_point_id IS NOT NULL AND start_point_id IS NOT NULL
      GROUP BY delivery_point_id, start_point_id) x WHERE rn = 1`)).rows;
  const spByDp = new Map(usage.map(u => [u.delivery_point_id, u.start_point_id]));
  const spById = new Map(sps.map(s => [s.id, s]));
  const plants = dps.map(dp => {
    let sp = spById.get(spByDp.get(dp.id)) || sps.find(s => s.name.trim().toLowerCase() === dp.name.trim().toLowerCase()) || null;
    return {
      id: dp.id, name: dp.name, latitude: num(dp.latitude), longitude: num(dp.longitude),
      end: { type: 'delivery_point', id: dp.id },
      start: sp ? { type: 'starting_point', id: sp.id, name: sp.name } : null,
      has_coords: num(dp.latitude) != null && num(dp.longitude) != null,
    };
  });
  return { plants, startingPoints: sps };
}

async function loadBmcus() {
  return (await query(`
    SELECT id, bmcu_code, bmcu_name, district, state, latitude, longitude, chilling_capacity_litres, lift_policy
    FROM bmcus WHERE is_active=TRUE ORDER BY bmcu_code`)).rows;
}

// ─── Distance resolver over master + coordinates ────────────────────────────
async function buildResolver(bmcus, plants, startingPoints) {
  const nodeIds = [
    ...bmcus.map(b => ({ type: 'bmcu', id: b.id })),
    ...plants.map(p => ({ type: 'delivery_point', id: p.id })),
    ...startingPoints.map(s => ({ type: 'starting_point', id: s.id })),
  ];
  const distMap = await buildDistanceMap({ query }, nodeIds);
  const nodeMap = {};
  for (const b of bmcus) nodeMap[nodeKey('bmcu', b.id)] = b;
  for (const p of plants) nodeMap[nodeKey('delivery_point', p.id)] = p;
  for (const s of startingPoints) nodeMap[nodeKey('starting_point', s.id)] = s;
  return { resolve: makeResolver(distMap, nodeMap), distMap, nodeMap };
}

// ─── Plant catchment per BMCU ───────────────────────────────────────────────
async function loadCatchments(bmcus, plants, resolve) {
  const hist = (await query(`
    SELECT bmcu_id, delivery_point_id FROM (
      SELECT pb.bmcu_id, tp.delivery_point_id, COUNT(*) n,
             ROW_NUMBER() OVER (PARTITION BY pb.bmcu_id ORDER BY COUNT(*) DESC, tp.delivery_point_id) rn
      FROM trip_plan_bmcus pb
      JOIN trip_plans tp ON tp.id = pb.trip_plan_id
      LEFT JOIN tankers t ON t.id = tp.tanker_id
      WHERE tp.plan_for_date >= CURRENT_DATE - 60 AND tp.status NOT IN ('cancelled','deleted')
        AND tp.delivery_point_id IS NOT NULL AND NOT ${saleTankerSql('tp', 't')}
      GROUP BY pb.bmcu_id, tp.delivery_point_id) x WHERE rn = 1`)).rows;
  const plantIds = new Set(plants.map(p => p.id));
  const byBmcu = new Map(hist.filter(h => plantIds.has(h.delivery_point_id)).map(h => [h.bmcu_id, h.delivery_point_id]));
  const out = {};
  for (const b of bmcus) {
    let plantId = byBmcu.get(b.id) || null, method = 'history';
    if (!plantId) {
      let best = null, bestKm = Infinity;
      for (const p of plants) {
        if (!p.has_coords) continue;
        const { km } = resolve('bmcu', b.id, 'delivery_point', p.id);
        if (km < bestKm) { bestKm = km; best = p; }
      }
      plantId = best?.id || null; method = best ? 'nearest' : 'none';
    }
    out[b.id] = { plant_id: plantId, method };
  }
  return out;
}

// ─── Fleet for the date ─────────────────────────────────────────────────────
async function loadFleet(planDate) {
  const tankers = (await query(`
    SELECT t.id, t.tanker_number, t.capacity_litres, t.vendor_id,
           COALESCE(v.vendor_name, t.vendor_name) AS vendor_name
    FROM tankers t LEFT JOIN vendors v ON v.id = t.vendor_id
    WHERE t.is_active = TRUE AND NOT ${saleTankerNumberSql('t')}
    ORDER BY t.tanker_number`)).rows;
  // Only a MAINTENANCE gate pass blocks a tanker (open, or covering the
  // date). "Tankers without driver" and the other reasons are ignored: the
  // first production run excluded 16 tankers on such passes that were never
  // returned although the tankers kept running. A maintenance pass is also
  // treated as STALE — tanker available, note shown in the preview — when
  // the tanker ran a non-cancelled trip after the pass was issued (up to the
  // planning date, or today for a future date).
  const blocked = (await query(`
    SELECT DISTINCT ON (g.tanker_id) g.tanker_id, g.reason, g.issued_at::date AS issued_on,
           (SELECT MAX(tp.plan_for_date) FROM trip_executions te
              JOIN trip_plans tp ON tp.id = te.trip_plan_id
             WHERE tp.tanker_id = g.tanker_id AND te.status <> 'cancelled'
               AND tp.plan_for_date >= g.issued_at::date
               AND tp.plan_for_date <= LEAST($1::date, CURRENT_DATE)) AS ran_on
    FROM non_trip_gate_passes g
    WHERE g.reason = 'Maintainance'
      AND g.issued_at < ($1::date + 1)
      AND (g.returned_at IS NULL OR g.returned_at >= $1::date)
    ORDER BY g.tanker_id, g.issued_at DESC`, [planDate])).rows;
  const blockedBy = new Map(blocked.map(b => [b.tanker_id, b]));
  const ddmmyyyy = iso => String(iso).slice(0, 10).split('-').reverse().join('-');
  const rates = await loadRatesForDate(planDate);
  const billingStates = await loadBillingStates(90);

  const fleet = [], excluded = [];
  for (const t of tankers) {
    const cap = parseInt(t.capacity_litres) || 0;
    const gp = blockedBy.get(t.id);
    const state = billingStates.get(t.tanker_number) || stateFromRegistration(t.tanker_number);
    const stateSource = billingStates.has(t.tanker_number) ? 'billing' : (state ? 'registration' : null);
    const rP2P = state ? pickRate(rates, state, TT_P2P, cap) : null;
    const rBmcu = state ? pickRate(rates, state, TT_BMCU, cap) : null;
    const row = {
      id: t.id, tanker_number: t.tanker_number, capacity_litres: cap, vendor_name: t.vendor_name,
      state, state_source: stateSource,
      rates: { [TT_P2P]: rP2P?.rate_per_km || null, [TT_BMCU]: rBmcu?.rate_per_km || null },
      available: true, reason: null, note: null,
    };
    if (gp && gp.ran_on) {
      row.note = `open maintenance gate pass since ${ddmmyyyy(gp.issued_on)} looks stale — tanker ran on ${ddmmyyyy(gp.ran_on)}; close the pass`;
    }
    if (gp && !gp.ran_on) {
      row.available = false;
      row.reason = `Under maintenance (gate pass open since ${ddmmyyyy(gp.issued_on)})`;
    } else if (!state) {
      row.available = false; row.reason = 'No billing state and registration prefix not recognised';
    } else if (!rP2P && !rBmcu) {
      row.available = false; row.reason = `No rate for ${cap / 1000} KL in ${state} on ${planDate}`;
    } else if (cap <= 0) {
      row.available = false; row.reason = 'Capacity not set';
    }
    fleet.push(row);
    if (!row.available) excluded.push({ tanker_id: t.id, tanker_number: t.tanker_number, reason: row.reason });
  }
  return { fleet, excluded, rates };
}

// ─── Demand forecast per BMCU × shift ───────────────────────────────────────
async function loadDemand(planDate, bmcus) {
  const hist = (await query(`
    SELECT teb.bmcu_id, s.shift, s.milk_date, SUM(s.rmrd_qty)::numeric AS qty
    FROM trip_execution_bmcu_shifts s
    JOIN trip_execution_bmcus teb ON teb.execution_id = s.execution_id AND teb.seq_no = s.bmcu_seq_no
      AND teb.is_deleted = FALSE
    JOIN trip_executions te ON te.id = s.execution_id AND te.status <> 'cancelled'
    WHERE s.milk_date >= $1::date - 60 AND s.milk_date < $1::date
      AND s.shift IN ('AM','PM') AND s.rmrd_qty > 0
    GROUP BY teb.bmcu_id, s.shift, s.milk_date`, [planDate])).rows;
  const lastPlan = (await query(`
    SELECT DISTINCT ON (pb.bmcu_id) pb.bmcu_id, pb.expected_qty
    FROM trip_plan_bmcus pb JOIN trip_plans tp ON tp.id = pb.trip_plan_id
    WHERE tp.status NOT IN ('cancelled','deleted') AND pb.expected_qty > 0
    ORDER BY pb.bmcu_id, tp.plan_for_date DESC, tp.id DESC`)).rows;
  const planQty = new Map(lastPlan.map(p => [p.bmcu_id, parseFloat(p.expected_qty)]));

  const byKey = new Map();
  for (const h of hist) {
    const k = `${h.bmcu_id}|${h.shift}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ date: h.milk_date, qty: parseFloat(h.qty) });
  }
  const targetWd = isoWeekday(planDate);
  const cutoff14 = addDays(planDate, -14), cutoff7 = addDays(planDate, -7);
  const demand = [];
  for (const b of bmcus) {
    for (const shift of SHIFTS) {
      const rows = (byKey.get(`${b.id}|${shift}`) || []).sort((a, z) => a.date < z.date ? 1 : -1);
      const last14 = rows.filter(r => r.date >= cutoff14);
      let litres = 0, method = 'none';
      if (last14.length) {
        let w = 0, s = 0;
        for (const r of last14) { const wt = isoWeekday(r.date) === targetWd ? 2 : 1; w += wt; s += wt * r.qty; }
        litres = s / w; method = 'weighted_14d';
      } else if (rows.length) {
        litres = rows.reduce((s, r) => s + r.qty, 0) / rows.length; method = 'avg_60d';
      } else if (planQty.has(b.id)) {
        litres = planQty.get(b.id) / 2; method = 'plan_qty';
      }
      demand.push({
        bmcu_id: b.id, bmcu_code: b.bmcu_code, bmcu_name: b.bmcu_name, district: b.district, state: b.state,
        shift, forecast_litres: r2(litres), method,
        last_7_days: rows.filter(r => r.date >= cutoff7).map(r => ({ date: r.date, litres: r2(r.qty) })),
        history_days: rows.length,
      });
    }
  }
  return demand;
}

function addDays(iso, d) {
  const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
}

// Persist forecasts (planner overrides keep method 'override').
async function saveForecasts(planDate, demand, overrides) {
  const ov = new Map((overrides || []).map(o => [`${o.bmcu_id}|${o.shift}`, parseFloat(o.litres)]));
  for (const d of demand) {
    const o = ov.get(`${d.bmcu_id}|${d.shift}`);
    const litres = Number.isFinite(o) ? o : d.forecast_litres;
    const method = Number.isFinite(o) ? 'override' : d.method;
    await query(`
      INSERT INTO bmcu_demand_forecast (forecast_date, bmcu_id, shift, forecast_litres, method)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (forecast_date, bmcu_id, shift)
      DO UPDATE SET forecast_litres=$4, method=$5, updated_at=NOW()`,
      [planDate, d.bmcu_id, d.shift, litres, method]);
  }
}

// Fill actual_litres for a date from executed RMRD rows. Returns row count.
async function backfillActuals(planDate) {
  const r = await query(`
    UPDATE bmcu_demand_forecast f SET actual_litres = a.qty, updated_at = NOW()
    FROM (
      SELECT teb.bmcu_id, s.shift, SUM(s.rmrd_qty)::numeric AS qty
      FROM trip_execution_bmcu_shifts s
      JOIN trip_execution_bmcus teb ON teb.execution_id = s.execution_id AND teb.seq_no = s.bmcu_seq_no
        AND teb.is_deleted = FALSE
      JOIN trip_executions te ON te.id = s.execution_id AND te.status <> 'cancelled'
      WHERE s.milk_date = $1::date AND s.shift IN ('AM','PM')
      GROUP BY teb.bmcu_id, s.shift) a
    WHERE f.forecast_date = $1::date AND f.bmcu_id = a.bmcu_id AND f.shift = a.shift`, [planDate]);
  return r.rowCount;
}

// ─── Distance coverage among the pairs that matter ──────────────────────────
// Plant ↔ BMCU for every BMCU's catchment plant, plus BMCU ↔ BMCU inside the
// same catchment within radiusKm (straight line).
function distanceCoverage(bmcus, plants, catchments, distMap, radiusKm) {
  const plantById = new Map(plants.map(p => [p.id, p]));
  const byPlant = new Map();
  let total = 0, covered = 0, noCoords = 0;
  for (const b of bmcus) {
    const pid = catchments[b.id]?.plant_id; if (!pid) continue;
    total++;
    if (distMap[distKey('bmcu', b.id, 'delivery_point', pid)] !== undefined) covered++;
    else if (num(b.latitude) == null || num(b.longitude) == null || !plantById.get(pid)?.has_coords) noCoords++;
    if (!byPlant.has(pid)) byPlant.set(pid, []);
    byPlant.get(pid).push(b);
  }
  for (const list of byPlant.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], z = list[j];
      const la = num(a.latitude), na = num(a.longitude), lz = num(z.latitude), nz = num(z.longitude);
      const hasCoords = la != null && na != null && lz != null && nz != null;
      if (hasCoords && haversineKm(la, na, lz, nz) > radiusKm) continue;
      total++;
      if (distMap[distKey('bmcu', a.id, 'bmcu', z.id)] !== undefined) covered++;
      else if (!hasCoords) noCoords++;
    }
  }
  return { pairs: total, covered, missing: total - covered, missing_without_coords: noCoords,
    coverage_pct: total ? r1(covered / total * 100) : 100 };
}

// ─── Prefetch missing pairs from Google into Distance Master ────────────────
async function prefetchDistances({ radiusKm, maxCalls, concurrency = 4, userId }) {
  const bmcus = await loadBmcus();
  const { plants, startingPoints } = await loadPlants();
  const nodes = [
    ...bmcus.map(b => ({ type: 'bmcu', id: b.id, lat: num(b.latitude), lng: num(b.longitude) })),
    ...plants.map(p => ({ type: 'delivery_point', id: p.id, lat: p.latitude, lng: p.longitude })),
    ...startingPoints.map(s => ({ type: 'starting_point', id: s.id, lat: num(s.latitude), lng: num(s.longitude) })),
  ].filter(n => n.lat != null && n.lng != null);
  const cache = await loadMasterDistanceCache({ query });
  const todo = [];
  let skippedFar = 0, cached = 0;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], z = nodes[j];
    if (a.type !== 'bmcu' && z.type !== 'bmcu') continue; // plant↔plant pairs are not trip legs
    const p = normalisePair(a.type, a.id, z.type, z.id);
    if (cache.has(`${p.fromType}:${p.fromId}|${p.toType}:${p.toId}`)) { cached++; continue; }
    if (haversineKm(a.lat, a.lng, z.lat, z.lng) > radiusKm) { skippedFar++; continue; }
    todo.push([a, z]);
  }
  const batch = todo.slice(0, maxCalls);
  let fetched = 0, failed = 0;
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    return { fetched: 0, failed: 0, cached, skipped_far: skippedFar, missing: todo.length, remaining: todo.length,
      error: 'GOOGLE_MAPS_API_KEY is not set — nothing fetched' };
  }
  for (let i = 0; i < batch.length; i += concurrency) {
    await Promise.all(batch.slice(i, i + concurrency).map(async ([a, z]) => {
      const km = await googleLegKm(a.lat, a.lng, z.lat, z.lng);
      if (km == null) { failed++; return; }
      await upsertMasterDistanceKm({ query }, a.type, a.id, z.type, z.id, Math.round(km * 100) / 100,
        'auto: Google Routes API (optimizer prefetch)', userId);
      fetched++;
    }));
  }
  return { fetched, failed, cached, skipped_far: skippedFar, missing: todo.length, remaining: todo.length - fetched };
}

// ─── Comparison: what was actually planned for the date ─────────────────────
// Km = billed km when the trip is in a billing run, else the execution's
// calculated km, else the plan's expected km. Rate = Tanker Rate Master for
// the tanker's state / transport type (same lookup the optimiser uses), else
// the plan's own total_cost. Litres = acknowledged, else executed, else planned.
async function loadActualComparison(planDate, fleet, rates) {
  const rows = (await query(`
    SELECT tp.id, tp.tanker_id, t.tanker_number, t.capacity_litres, tp.expected_km, tp.expected_total_qty, tp.total_cost,
           tp.delivery_point_id, dp.name AS plant_name,
           (SELECT COUNT(*) FROM trip_plan_bmcus pb WHERE pb.trip_plan_id = tp.id)::int AS bmcu_count,
           te.id AS execution_id, te.calculated_km, te.total_qty_litres AS exec_litres,
           (SELECT SUM(qty_litres) FROM trip_acknowledgements a WHERE a.execution_id = te.id) AS ack_litres,
           brt.billed_km, brt.amount AS billed_amount, brt.rate_per_km AS billed_rate
    FROM trip_plans tp
    LEFT JOIN tankers t ON t.id = tp.tanker_id
    LEFT JOIN delivery_points dp ON dp.id = tp.delivery_point_id
    LEFT JOIN trip_executions te ON te.trip_plan_id = tp.id AND te.status <> 'cancelled'
    LEFT JOIN billing_run_trips brt ON brt.execution_id = te.id
    WHERE tp.plan_for_date = $1::date AND tp.status NOT IN ('cancelled','deleted')
      AND NOT ${saleTankerSql('tp', 't')}
    ORDER BY tp.trip_no, tp.id`, [planDate])).rows;
  if (!rows.length) return null;
  const fleetByNo = new Map(fleet.map(f => [f.tanker_number, f]));
  let trips = 0, km = 0, cost = 0, litres = 0, cap = 0, priced = 0;
  for (const r of rows) {
    trips++;
    const tripKm = num(r.billed_km) ?? num(r.calculated_km) ?? num(r.expected_km) ?? 0;
    const tripL = num(r.ack_litres) ?? num(r.exec_litres) ?? num(r.expected_total_qty) ?? 0;
    let tripCost = null;
    if (r.billed_amount != null) tripCost = num(r.billed_amount);
    else {
      const f = fleetByNo.get(r.tanker_number);
      const state = f?.state || stateFromRegistration(r.tanker_number);
      const rate = state ? pickRate(rates, state, transportTypeFor(r.bmcu_count || 1), parseInt(r.capacity_litres) || 0) : null;
      if (rate) tripCost = tripKm * rate.rate_per_km;
      else if (r.total_cost != null) tripCost = num(r.total_cost);
    }
    if (tripCost != null) { cost += tripCost; priced++; }
    km += tripKm; litres += tripL; cap += parseInt(r.capacity_litres) || 0;
  }
  return {
    source: 'actual_plans', date: planDate,
    trips, km: r1(km), litres: r2(litres), cost: r2(cost),
    cost_per_litre: litres > 0 ? Math.round(cost / litres * 10000) / 10000 : 0,
    avg_fill_pct: cap > 0 ? r1(litres / cap * 100) : 0,
    priced_trips: priced,
    note: priced < trips ? `${trips - priced} trip(s) had no rate and are excluded from cost` : null,
  };
}

async function loadComparison(planDate, shift, fleet, rates) {
  let cmp = await loadActualComparison(planDate, fleet, rates);
  if (!cmp) {
    const lastWeek = addDays(planDate, -7);
    cmp = await loadActualComparison(lastWeek, fleet, rates);
    if (cmp) { cmp.source = 'same_weekday_last_week'; }
  }
  if (cmp && shift !== 'BOTH') cmp.note = [cmp.note, 'Actual plans cover both shifts; this run covers ' + shift].filter(Boolean).join('. ');
  return cmp;
}

// ─── Build the optimiser instance for a date + shift scope ──────────────────
async function buildInstance(planDate, shiftScope, demandOverrides) {
  const bmcus = await loadBmcus();
  const { plants, startingPoints } = await loadPlants();
  const { resolve, distMap } = await buildResolver(bmcus, plants, startingPoints);
  const catchments = await loadCatchments(bmcus, plants, resolve);
  const { fleet, excluded, rates } = await loadFleet(planDate);
  const demand = await loadDemand(planDate, bmcus);
  const ov = new Map((demandOverrides || []).map(o => [`${o.bmcu_id}|${o.shift}`, parseFloat(o.litres)]));
  const litresFor = (bmcuId, shift) => {
    const o = ov.get(`${bmcuId}|${shift}`);
    if (Number.isFinite(o)) return o;
    return demand.find(d => d.bmcu_id === bmcuId && d.shift === shift)?.forecast_litres || 0;
  };
  const nodes = bmcus.map(b => {
    const litres = shiftScope === 'BOTH' ? litresFor(b.id, 'AM') + litresFor(b.id, 'PM') : litresFor(b.id, shiftScope);
    return { bmcu_id: b.id, bmcu_code: b.bmcu_code, bmcu_name: b.bmcu_name, district: b.district,
      litres: r2(litres), plant_id: catchments[b.id]?.plant_id || null, shift: shiftLabel(shiftScope) };
  });
  const usedPlantIds = new Set(nodes.filter(n => n.litres > 0).map(n => n.plant_id));
  const instance = {
    plants: plants.filter(p => usedPlantIds.has(p.id)),
    nodes, tankers: fleet.filter(f => f.available), resolve,
  };
  return { instance, bmcus, plants, catchments, fleet, excluded, rates, demand, distMap };
}

module.exports = {
  SHIFTS, shiftLabel, loadPlants, loadBmcus, buildResolver, loadCatchments, loadFleet, loadDemand,
  saveForecasts, backfillActuals, distanceCoverage, prefetchDistances, loadComparison, buildInstance,
};
