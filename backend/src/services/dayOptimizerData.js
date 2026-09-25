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
// includeSale=false (default): lifts made by sale tankers (Milma collections,
// utils/saleTanker.js) are left out, so a BMCU that Milma always collects
// forecasts 0 and one collected by both contributes only its vendor share —
// the optimiser then plans the milk Shreeja actually transports. On
// 08-09-2026 the day's RMRD was 8.51 lakh L of which ~1.5 lakh went by sale
// tanker; forecasting all of it over-planned by five trips.
async function loadDemand(planDate, bmcus, includeSale = false) {
  const hist = (await query(`
    SELECT teb.bmcu_id, s.shift, s.milk_date, SUM(s.rmrd_qty)::numeric AS qty
    FROM trip_execution_bmcu_shifts s
    JOIN trip_execution_bmcus teb ON teb.execution_id = s.execution_id AND teb.seq_no = s.bmcu_seq_no
      AND teb.is_deleted = FALSE
    JOIN trip_executions te ON te.id = s.execution_id AND te.status <> 'cancelled'
    JOIN trip_plans tp ON tp.id = te.trip_plan_id
    LEFT JOIN tankers t ON t.id = tp.tanker_id
    WHERE s.milk_date >= $1::date - 60 AND s.milk_date < $1::date
      AND s.shift IN ('AM','PM') AND s.rmrd_qty > 0
      AND ($2::boolean OR NOT ${saleTankerSql('tp', 't')})
    GROUP BY teb.bmcu_id, s.shift, s.milk_date`, [planDate, !!includeSale])).rows;
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
  const cutoff14 = addDays(planDate, -14), cutoff7 = addDays(planDate, -7);
  const demand = [];
  for (const b of bmcus) {
    for (const shift of SHIFTS) {
      const rows = (byKey.get(`${b.id}|${shift}`) || []).sort((a, z) => a.date < z.date ? 1 : -1);
      const last14 = rows.filter(r => r.date >= cutoff14);
      let litres = 0, method = 'none', liftProb = null;
      if (last14.length) {
        // Median litres per lift × probability of a lift on any given day
        // (lifts in the last 14 days / 14). Calibrated on 11 production days
        // (02–14 Sep 2026): the previous weighted mean over-forecast the day's
        // milk by 17.5 % on average (it counted every BMCU as lifted every
        // day and let single big lifts pull the mean up); median × lift
        // probability brings the error to 6.5 % — see docs/OPTIMISATION_PLAN.md.
        const sorted = last14.map(r => r.qty).sort((a, z) => a - z);
        const mid = sorted.length >> 1;
        const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        liftProb = Math.min(1, last14.length / 14);
        litres = median * liftProb; method = 'median_x_p14';
      } else if (rows.length) {
        litres = rows.reduce((s, r) => s + r.qty, 0) / rows.length; method = 'avg_60d';
      } else if (planQty.has(b.id)) {
        litres = planQty.get(b.id) / 2; method = 'plan_qty';
      }
      demand.push({
        bmcu_id: b.id, bmcu_code: b.bmcu_code, bmcu_name: b.bmcu_name, district: b.district, state: b.state,
        shift, forecast_litres: r2(litres), method,
        lift_probability: liftProb == null ? null : Math.round(liftProb * 100) / 100,
        lifts_last_14d: last14.length,
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

// ─── Comparison: what actually happened on the date ─────────────────────────
// Two blocks, both per non-sale trip with plan_for_date = date:
//   actual_executed (primary) — one row per live (non-cancelled) execution.
//     Litres = Σ RMRD from trip_execution_bmcu_shifts joined to live
//     trip_execution_bmcus (the same rows the demand forecast is built from),
//     else Σ dispatch qty_litres of the live BMCU rows. Ack litres alongside.
//     Km = billed km when the execution is in a billing run, else the
//     execution's actual km, else its calculated km, else the plan's expected km.
//     Cost = billed amount when billed, else km × Tanker Rate Master rate
//     (state from billing history / registration prefix, transport type by
//     BMCU count — the optimiser's own lookup); a trip with neither is
//     counted but unpriced. Fill = litres / capacity, litre-weighted.
//   actual_planned (secondary) — the plan rows themselves: expected_total_qty,
//     expected_km, total_cost (else expected_km × rate). Plans under-state the
//     milk that is lifted, so ₹/L and fill on this block are not comparable
//     with the optimiser; it is shown muted for reference only.
const EXECUTED_BASIS = 'RMRD litres · billed km/amount where billed, else execution km × Tanker Rate Master rate';
const PLANNED_BASIS = 'Plan expected litres, km and cost as entered by the planner';

function rateStateFor(tankerNumber, fleetByNo, billingStates) {
  return fleetByNo.get(tankerNumber)?.state || billingStates.get(tankerNumber) || stateFromRegistration(tankerNumber) || null;
}

async function loadExecutedComparison(planDate, fleet, rates, billingStates) {
  const rows = (await query(`
    SELECT te.id AS execution_id, te.status, tp.id AS plan_id, tp.trip_no, t.tanker_number, t.capacity_litres,
           tp.expected_km, rm.route_name, dp.name AS plant_name, te.actual_km, te.calculated_km,
           (SELECT COUNT(*) FROM trip_execution_bmcus eb WHERE eb.execution_id = te.id AND eb.is_deleted = FALSE)::int AS bmcu_count,
           (SELECT STRING_AGG(b.bmcu_code, ' → ' ORDER BY eb.seq_no)
              FROM trip_execution_bmcus eb JOIN bmcus b ON b.id = eb.bmcu_id
             WHERE eb.execution_id = te.id AND eb.is_deleted = FALSE) AS bmcu_chain,
           (SELECT SUM(s.rmrd_qty) FROM trip_execution_bmcu_shifts s
              JOIN trip_execution_bmcus eb ON eb.execution_id = s.execution_id AND eb.seq_no = s.bmcu_seq_no AND eb.is_deleted = FALSE
             WHERE s.execution_id = te.id) AS rmrd_litres,
           (SELECT SUM(eb.qty_litres) FROM trip_execution_bmcus eb WHERE eb.execution_id = te.id AND eb.is_deleted = FALSE) AS dispatch_litres,
           (SELECT SUM(a.qty_litres) FROM trip_acknowledgements a WHERE a.execution_id = te.id) AS ack_litres,
           brt.billed_km, brt.amount AS billed_amount, brt.rate_per_km AS billed_rate
    FROM trip_executions te
    JOIN trip_plans tp ON tp.id = te.trip_plan_id
    LEFT JOIN tankers t ON t.id = tp.tanker_id
    LEFT JOIN route_masters rm ON rm.id = tp.route_id
    LEFT JOIN delivery_points dp ON dp.id = tp.delivery_point_id
    LEFT JOIN LATERAL (
      SELECT b.billed_km, b.amount, b.rate_per_km FROM billing_run_trips b
      WHERE b.execution_id = te.id ORDER BY b.id DESC LIMIT 1) brt ON TRUE
    WHERE tp.plan_for_date = $1::date AND te.status <> 'cancelled'
      AND NOT ${saleTankerSql('tp', 't')}
    ORDER BY tp.trip_no, tp.id`, [planDate])).rows;
  if (!rows.length) return null;
  const fleetByNo = new Map(fleet.map(f => [f.tanker_number, f]));
  const tankers = new Set();
  let km = 0, cost = 0, litres = 0, ackLitres = 0, cap = 0, priced = 0, billed = 0;
  const tripList = [];
  for (const r of rows) {
    tankers.add(r.tanker_number);
    const capL = parseInt(r.capacity_litres) || 0;
    const tripL = num(r.rmrd_litres) ?? num(r.dispatch_litres) ?? 0;
    const tripAck = num(r.ack_litres) ?? 0;
    let tripKm, kmSource;
    if (r.billed_km != null) { tripKm = num(r.billed_km); kmSource = 'billed'; }
    else if (r.actual_km != null) { tripKm = num(r.actual_km); kmSource = 'execution'; }
    else if (r.calculated_km != null) { tripKm = num(r.calculated_km); kmSource = 'execution'; }
    else { tripKm = num(r.expected_km) ?? 0; kmSource = 'plan'; }
    let tripCost = null, costSource = 'none', ratePerKm = null;
    if (r.billed_amount != null) { tripCost = num(r.billed_amount); costSource = 'billed'; ratePerKm = num(r.billed_rate); billed++; }
    else {
      const state = rateStateFor(r.tanker_number, fleetByNo, billingStates);
      const rate = state ? pickRate(rates, state, transportTypeFor(r.bmcu_count || 1), capL) : null;
      if (rate) { ratePerKm = Number(rate.rate_per_km); tripCost = tripKm * ratePerKm; costSource = 'rate'; }
    }
    if (tripCost != null) { cost += tripCost; priced++; }
    km += tripKm; litres += tripL; ackLitres += tripAck; cap += capL;
    tripList.push({
      execution_id: r.execution_id, plan_id: r.plan_id, status: r.status, tanker_number: r.tanker_number,
      capacity_litres: capL, plant_name: r.plant_name, route_name: r.route_name, bmcu_count: r.bmcu_count,
      bmcus: r.bmcu_chain || '', litres: r2(tripL), ack_litres: r2(tripAck), km: r1(tripKm), km_source: kmSource,
      cost: tripCost == null ? null : r2(tripCost), cost_source: costSource, rate_per_km: ratePerKm,
      fill_pct: capL > 0 ? r1(tripL / capL * 100) : null,
    });
  }
  const trips = rows.length;
  // Milk that left by sale tanker that day (not transported by Shreeja) —
  // shown so the optimiser's vendor-only forecast and the executed vendor
  // litres are visibly on the same basis.
  const sale = (await query(`
    SELECT COUNT(DISTINCT te.id)::int AS trips, COALESCE(SUM(s.rmrd_qty), 0) AS litres
    FROM trip_executions te JOIN trip_plans tp ON tp.id = te.trip_plan_id
    LEFT JOIN tankers t ON t.id = tp.tanker_id
    JOIN trip_execution_bmcu_shifts s ON s.execution_id = te.id
    JOIN trip_execution_bmcus eb ON eb.execution_id = s.execution_id AND eb.seq_no = s.bmcu_seq_no AND eb.is_deleted = FALSE
    WHERE tp.plan_for_date = $1::date AND te.status <> 'cancelled' AND ${saleTankerSql('tp', 't')}`, [planDate])).rows[0];
  const notes = [];
  if (parseFloat(sale.litres) > 0) notes.push(`${sale.trips} sale-tanker trip(s) carried ${Math.round(parseFloat(sale.litres)).toLocaleString('en-IN')} L that day at no transport cost to Shreeja — not counted here or in the forecast`);
  if (priced < trips) notes.push(`${trips - priced} executed trip(s) had no billed amount and no rate — excluded from cost`);
  if (billed < trips) notes.push(`${trips - billed} of ${trips} trips not yet billed: their cost is execution km × rate`);
  return {
    basis: EXECUTED_BASIS, date: planDate,
    trips, tankers_used: tankers.size, km: r1(km), litres: r2(litres), ack_litres: r2(ackLitres), cost: r2(cost),
    sale_trips: sale.trips, sale_litres: r2(parseFloat(sale.litres)),
    cost_per_litre: litres > 0 ? Math.round(cost / litres * 10000) / 10000 : 0,
    avg_fill_pct: cap > 0 ? r1(litres / cap * 100) : 0,
    priced_trips: priced, billed_trips: billed,
    note: notes.length ? notes.join('. ') : null,
    trip_list: tripList,
  };
}

async function loadPlannedComparison(planDate, fleet, rates, billingStates) {
  const rows = (await query(`
    SELECT tp.id, tp.tanker_id, t.tanker_number, t.capacity_litres, tp.expected_km, tp.expected_total_qty, tp.total_cost,
           (SELECT COUNT(*) FROM trip_plan_bmcus pb WHERE pb.trip_plan_id = tp.id)::int AS bmcu_count
    FROM trip_plans tp
    LEFT JOIN tankers t ON t.id = tp.tanker_id
    WHERE tp.plan_for_date = $1::date AND tp.status NOT IN ('cancelled','deleted')
      AND NOT ${saleTankerSql('tp', 't')}
    ORDER BY tp.trip_no, tp.id`, [planDate])).rows;
  if (!rows.length) return null;
  const fleetByNo = new Map(fleet.map(f => [f.tanker_number, f]));
  const tankers = new Set();
  let trips = 0, km = 0, cost = 0, litres = 0, cap = 0, priced = 0;
  for (const r of rows) {
    trips++; tankers.add(r.tanker_number);
    const tripKm = num(r.expected_km) ?? 0;
    const tripL = num(r.expected_total_qty) ?? 0;
    let tripCost = num(r.total_cost);
    if (tripCost == null) {
      const state = rateStateFor(r.tanker_number, fleetByNo, billingStates);
      const rate = state ? pickRate(rates, state, transportTypeFor(r.bmcu_count || 1), parseInt(r.capacity_litres) || 0) : null;
      if (rate) tripCost = tripKm * rate.rate_per_km;
    }
    if (tripCost != null) { cost += tripCost; priced++; }
    km += tripKm; litres += tripL; cap += parseInt(r.capacity_litres) || 0;
  }
  return {
    basis: PLANNED_BASIS, date: planDate,
    trips, tankers_used: tankers.size, km: r1(km), litres: r2(litres), cost: r2(cost),
    cost_per_litre: litres > 0 ? Math.round(cost / litres * 10000) / 10000 : 0,
    avg_fill_pct: cap > 0 ? r1(litres / cap * 100) : 0,
    priced_trips: priced,
    note: priced < trips ? `${trips - priced} planned trip(s) had no cost and no rate — excluded from cost` : null,
  };
}

// Shape stored in optimization_sessions.comparison (since 2026-09-25):
//   { source, date, basis, note, actual_executed: {...}, actual_planned: {...},
//     trips, km, litres, cost, cost_per_litre, avg_fill_pct }   ← flat fields
// mirror actual_executed (or actual_planned when nothing was executed) so
// readers of the older flat shape keep working. routes/optimize.js adds
// `delta` (flat + actual_executed.delta) against the optimiser totals.
async function loadComparisonFor(planDate, fleet, rates, billingStates) {
  const executed = await loadExecutedComparison(planDate, fleet, rates, billingStates);
  const planned = await loadPlannedComparison(planDate, fleet, rates, billingStates);
  if (!executed && !planned) return null;
  const primary = executed || planned;
  return {
    source: 'actual_plans', date: planDate,
    basis: executed ? 'executed' : 'planned',
    actual_executed: executed, actual_planned: planned,
    trips: primary.trips, tankers_used: primary.tankers_used, km: primary.km, litres: primary.litres, cost: primary.cost,
    cost_per_litre: primary.cost_per_litre, avg_fill_pct: primary.avg_fill_pct, priced_trips: primary.priced_trips,
    note: executed ? executed.note : [planned.note, 'No executions recorded for this date — showing planned figures'].filter(Boolean).join('. '),
  };
}

async function loadComparison(planDate, shift, fleet, rates) {
  const billingStates = await loadBillingStates().catch(() => new Map());
  let cmp = await loadComparisonFor(planDate, fleet, rates, billingStates);
  if (!cmp) {
    const lastWeek = addDays(planDate, -7);
    cmp = await loadComparisonFor(lastWeek, fleet, rates, billingStates);
    if (cmp) { cmp.source = 'same_weekday_last_week'; }
  }
  if (cmp && shift !== 'BOTH') cmp.note = [cmp.note, 'Actual trips cover both shifts; this run covers ' + shift].filter(Boolean).join('. ');
  return cmp;
}

// ─── Forecast accuracy: forecast vs the day's actual RMRD ───────────────────
// Only meaningful once the date is executed. `demandRows` are the per-BMCU
// nodes the run used (instance.nodes: litres after planner overrides and the
// shift scope). Actual RMRD per BMCU comes from trip_execution_bmcu_shifts
// joined to live trip_execution_bmcus — the same rows loadDemand is built
// from — for every non-cancelled execution whose plan_for_date is the date,
// split into vendor and sale-tanker lifts (utils/saleTanker.js). The forecast
// is compared with the vendor share unless the run included sale milk.
// Returns null when the date has no executions (future date).
async function loadForecastAccuracy(planDate, demandRows, includeSale = false, opts = {}) {
  const shift = SHIFTS.includes(opts.shift) ? opts.shift : 'BOTH';
  const execCount = (await query(`
    SELECT COUNT(*)::int AS n FROM trip_executions te
    JOIN trip_plans tp ON tp.id = te.trip_plan_id
    WHERE tp.plan_for_date = $1::date AND te.status <> 'cancelled'`, [planDate])).rows[0].n;
  if (!execCount) return null;
  const actualRows = (await query(`
    SELECT teb.bmcu_id, ${saleTankerSql('tp', 't')} AS is_sale, SUM(s.rmrd_qty)::numeric AS qty
    FROM trip_execution_bmcu_shifts s
    JOIN trip_execution_bmcus teb ON teb.execution_id = s.execution_id AND teb.seq_no = s.bmcu_seq_no
      AND teb.is_deleted = FALSE
    JOIN trip_executions te ON te.id = s.execution_id AND te.status <> 'cancelled'
    JOIN trip_plans tp ON tp.id = te.trip_plan_id
    LEFT JOIN tankers t ON t.id = tp.tanker_id
    WHERE tp.plan_for_date = $1::date AND s.shift IN ('AM','PM')
      AND ($2::text = 'BOTH' OR s.shift = $2::text)
    GROUP BY teb.bmcu_id, 2`, [planDate, shift])).rows;

  const per = new Map(); // bmcu_id → { forecast, vendor, sale, ... }
  const plantNames = opts.plantNameById || {};
  for (const d of demandRows || []) {
    per.set(d.bmcu_id, { bmcu_id: d.bmcu_id, bmcu_code: d.bmcu_code, bmcu_name: d.bmcu_name,
      plant_name: plantNames[d.plant_id] || null, forecast: Number(d.litres) || 0, vendor: 0, sale: 0 });
  }
  for (const a of actualRows) {
    if (!per.has(a.bmcu_id)) per.set(a.bmcu_id, { bmcu_id: a.bmcu_id, bmcu_code: null, bmcu_name: null, plant_name: null, forecast: 0, vendor: 0, sale: 0 });
    per.get(a.bmcu_id)[a.is_sale ? 'sale' : 'vendor'] += parseFloat(a.qty) || 0;
  }
  // Names for BMCUs lifted that day but not among the run's nodes (inactive BMCUs)
  const unnamed = [...per.values()].filter(p => !p.bmcu_code).map(p => p.bmcu_id);
  if (unnamed.length) {
    const named = (await query('SELECT id, bmcu_code, bmcu_name FROM bmcus WHERE id = ANY($1)', [unnamed])).rows;
    for (const b of named) Object.assign(per.get(b.id), { bmcu_code: b.bmcu_code, bmcu_name: b.bmcu_name });
  }

  const basis = includeSale ? 'all' : 'vendor';
  let forecast = 0, vendor = 0, sale = 0, bmcusForecast = 0, bmcusLifted = 0, fNotL = 0, lNotF = 0;
  const perBmcu = [];
  for (const p of per.values()) {
    const actual = basis === 'all' ? p.vendor + p.sale : p.vendor;
    forecast += p.forecast; vendor += p.vendor; sale += p.sale;
    const isForecast = p.forecast > 0, isLifted = actual > 0;
    if (!isForecast && !(p.vendor > 0 || p.sale > 0)) continue;
    if (isForecast) bmcusForecast++;
    if (isLifted) bmcusLifted++;
    if (isForecast && !isLifted) fNotL++;
    if (isLifted && !isForecast) lNotF++;
    perBmcu.push({
      bmcu_id: p.bmcu_id, bmcu_code: p.bmcu_code, bmcu_name: p.bmcu_name, plant_name: p.plant_name,
      forecast: r2(p.forecast), actual: r2(actual), diff: r2(p.forecast - actual),
      lifted_by: p.vendor > 0 && p.sale > 0 ? 'both' : p.vendor > 0 ? 'vendor' : p.sale > 0 ? 'sale' : null,
      flag: isForecast && !isLifted ? 'forecast_not_lifted' : isLifted && !isForecast ? 'lifted_not_forecast' : null,
    });
  }
  // Mismatched BMCUs (forecast but not lifted / lifted but not forecast) first, then by |diff|
  perBmcu.sort((a, z) => (z.flag ? 1 : 0) - (a.flag ? 1 : 0) || Math.abs(z.diff) - Math.abs(a.diff));
  const matching = basis === 'all' ? vendor + sale : vendor;
  return {
    date: planDate, shift, basis,
    basis_label: basis === 'all' ? 'forecast includes sale-tanker milk — compared with all RMRD' : 'forecast excludes sale-tanker milk — compared with vendor RMRD',
    forecast_litres: r2(forecast), actual_rmrd_all: r2(vendor + sale), actual_rmrd_vendor: r2(vendor), actual_rmrd_sale: r2(sale),
    error_litres: r2(forecast - matching),
    error_pct: matching > 0 ? r1((forecast - matching) / matching * 100) : null,
    bmcus_forecast: bmcusForecast, bmcus_lifted: bmcusLifted,
    bmcus_forecast_not_lifted: fNotL, bmcus_lifted_not_forecast: lNotF,
    per_bmcu: perBmcu,
  };
}

// ─── Build the optimiser instance for a date + shift scope ──────────────────
async function buildInstance(planDate, shiftScope, demandOverrides, opts = {}) {
  const bmcus = await loadBmcus();
  const { plants, startingPoints } = await loadPlants();
  const { resolve, distMap } = await buildResolver(bmcus, plants, startingPoints);
  const catchments = await loadCatchments(bmcus, plants, resolve);
  const { fleet, excluded, rates } = await loadFleet(planDate);
  const demand = await loadDemand(planDate, bmcus, !!opts.includeSale);
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
  saveForecasts, backfillActuals, distanceCoverage, prefetchDistances, loadComparison, loadForecastAccuracy, buildInstance,
};
