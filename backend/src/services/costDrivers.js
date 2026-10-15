// backend/src/services/costDrivers.js
// Transport-cost driver analysis (owner, 2026-10-08): why did the period's
// transport cost per litre (and per km) move against the previous period —
// diesel price, kilometres run, BMCUs added or closed, or something else?
// Periods are free: a fortnight, a month, a quarter, a year, or any range;
// the comparison period defaults to the same length immediately before
// (whole months → the same number of months before).
//
// Trip set per period: live (non-cancelled) executions of published milk
// plans by lifting date; sale tankers and material trips excluded. Per trip:
//   km    = billed km when the trip is in a billing run, else the current
//           Distance Master / Google chain km (same rule as the dashboard)
//   state = the biller's state on the billing line, else the state the tanker
//           was billed in most recently, else its registration prefix
//   type  = the billing line's transport type, else 1 BMCU → Point to Point
//   rate  = the billing line's rate, else the Tanker Rate Master row valid on
//           the lifting date (state × type × capacity); mileage from that row
//   diesel= Diesel Rates master price of the state on the lifting date, else
//           the rate row's diesel price
//   cost  = billed amount when billed and not excluded, else km × rate
// Amount decomposition, Δcost = cost_P − cost_Q (per state and overall):
//   diesel effect   = Σ_P km × (diesel on the trip date − km-weighted diesel of Q in that state) ÷ mileage
//   new-BMCU effect = + cost_P of trips visiting a BMCU first served inside P
//   closed-BMCU eff.= − cost_Q of trips visiting a BMCU served in Q but not in P
//   km effect       = (km of the other P trips − km of the other Q trips) × (cost_Q ÷ km_Q)
//   mix / other     = the rest (route / capacity mix, keyed km, other rate changes)
// Per-litre decomposition, Δ(₹/L) = cost_P/L_P − cost_Q/L_Q:
//   each amount effect ÷ L_P, plus a volume effect = cost_Q × (1/L_P − 1/L_Q)
//   (more litres over the same cost lowers ₹/L). Both sets add up exactly.
const { periodOverheads, HISTORY_UNTIL } = require('./transportCumulative');
const { portalPlantMap } = require('./plantNames');
const { query } = require('../config/db');
const { saleTankerSql } = require('../utils/saleTanker');
const { pickRate, transportTypeFor, stateFromRegistration, loadBillingStates } = require('./rates');

const r2 = v => Math.round((v || 0) * 100) / 100;
const r4 = v => Math.round((v || 0) * 10000) / 10000;
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const pad = n => String(n).padStart(2, '0');
const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Comparison period: whole months → the same number of months before;
// 1–15 → 16–end of the previous month; 16–end → 1–15; else same day count before.
function previousPeriod(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (fd === 1 && td === monthEnd(ty, tm)) {
    const months = (ty - fy) * 12 + (tm - fm) + 1;
    let y = fy, m = fm - months;
    while (m < 1) { m += 12; y -= 1; }
    let y2 = fy, m2 = fm - 1;
    if (m2 < 1) { m2 = 12; y2 -= 1; }
    return { from: `${y}-${pad(m)}-01`, to: `${y2}-${pad(m2)}-${pad(monthEnd(y2, m2))}` };
  }
  if (fy === ty && fm === tm && fd === 1 && td === 15) {
    const y = fm === 1 ? fy - 1 : fy, m = fm === 1 ? 12 : fm - 1;
    return { from: `${y}-${pad(m)}-16`, to: `${y}-${pad(m)}-${pad(monthEnd(y, m))}` };
  }
  if (fy === ty && fm === tm && fd === 16 && td === monthEnd(fy, fm)) return { from: `${fy}-${pad(fm)}-01`, to: `${fy}-${pad(fm)}-15` };
  const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

// FY-workbook months (owner, 2026-10-14): up to ANALYTICS_HISTORY_UNTIL the
// trips come from historical_trips (billed km, amount, acknowledged litres,
// BMCUs covered as text), after it from portal executions — as the Payment
// Report and Tanker Utilisation do, so nothing is counted twice.
const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function loadBmcuIndex() {
  const r = await query('SELECT id, bmcu_code, bmcu_name FROM bmcus');
  const byCode = new Map(), byName = new Map();
  for (const b of r.rows) {
    if (b.bmcu_code != null) byCode.set(String(b.bmcu_code).trim().toLowerCase(), b.id);
    if (b.bmcu_name) byName.set(normName(b.bmcu_name), b.id);
  }
  return { byCode, byName };
}
// "3005 Komireddygari Palli, 3006 / Polireddipalli + 3010" → BMCU ids; unmatched tokens counted.
function parseCoverage(text, idx) {
  const ids = new Set(); let unmatched = 0;
  for (const raw of String(text || '').split(/[,/+&;\n]|\s-\s/)) {
    const tok = raw.trim(); if (!tok) continue;
    const code = (tok.match(/^\d{3,6}\b/) || [])[0];
    let id = code ? idx.byCode.get(code) : null;
    if (!id) id = idx.byCode.get(tok.toLowerCase()) || idx.byName.get(normName(tok.replace(/^\d{3,6}\s*/, '')));
    if (id) ids.add(id); else unmatched++;
  }
  return { ids: [...ids], unmatched };
}
async function loadHistoryTrips(from, to, idx) {
  if (from > HISTORY_UNTIL) return [];
  const toPortal = await portalPlantMap();
  const end = to < HISTORY_UNTIL ? to : HISTORY_UNTIL;
  const r = await query(`
    SELECT id, report_date::text AS plan_for_date, tanker_number, capacity_litres, route_name, plant AS delivery_point,
           billed_km, rate_per_km, amount, milk_litres, bmcu_coverage
    FROM historical_trips WHERE report_date BETWEEN $1::date AND $2::date
    ORDER BY report_date, tanker_number`, [from, end]);
  return r.rows.map(h => {
    const cov = parseCoverage(h.bmcu_coverage, idx);
    return {
      plan_id: null, execution_id: null, history_id: h.id, plan_for_date: h.plan_for_date,
      tanker_number: h.tanker_number, capacity_litres: h.capacity_litres, route_name: h.route_name,
      delivery_point: toPortal(h.delivery_point),
      km: h.billed_km, billing_line_id: null, run_id: null, billed_state: null, billed_type: null,
      history_rate: num(h.rate_per_km), history_amount: num(h.amount),
      n_bmcus: cov.ids.length || null, litres: h.milk_litres, bmcu_ids: cov.ids, coverage_unmatched: cov.unmatched,
    };
  });
}

async function loadTrips(from, to, idx) {
  const hist = await loadHistoryTrips(from, to, idx);
  if (to <= HISTORY_UNTIL) return hist;
  const pFrom = from > HISTORY_UNTIL ? from : addDays(HISTORY_UNTIL, 1);
  const r = await query(`
    SELECT tp.id AS plan_id, tp.plan_for_date, te.id AS execution_id,
           t.tanker_number, t.capacity_litres, rm.route_name, dp.name AS delivery_point,
           COALESCE(brt.billed_km, NULLIF(te.calculated_km, 0), te.actual_km, 0) AS km,
           brt.id AS billing_line_id, brt.run_id, brt.state AS billed_state, brt.transport_type AS billed_type,
           brt.rate_per_km AS billed_rate, brt.amount AS billed_amount, brt.excluded AS billed_excluded,
           (SELECT COUNT(*) FROM trip_execution_bmcus teb WHERE teb.execution_id = te.id AND teb.is_deleted = FALSE) AS n_bmcus,
           (SELECT COALESCE(SUM(teb.qty_litres), 0) FROM trip_execution_bmcus teb WHERE teb.execution_id = te.id AND teb.is_deleted = FALSE) AS litres,
           ARRAY(SELECT teb.bmcu_id FROM trip_execution_bmcus teb WHERE teb.execution_id = te.id AND teb.is_deleted = FALSE AND teb.bmcu_id IS NOT NULL) AS bmcu_ids
    FROM trip_plans tp
    JOIN trip_executions te ON te.trip_plan_id = tp.id AND te.status <> 'cancelled'
    LEFT JOIN tankers t          ON t.id  = tp.tanker_id
    LEFT JOIN route_masters rm   ON rm.id = tp.route_id
    LEFT JOIN delivery_points dp ON dp.id = tp.delivery_point_id
    LEFT JOIN LATERAL (SELECT b.* FROM billing_run_trips b WHERE b.execution_id = te.id ORDER BY b.id DESC LIMIT 1) brt ON TRUE
    WHERE tp.plan_for_date BETWEEN $1::date AND $2::date
      AND tp.status NOT IN ('cancelled','deleted')
      AND COALESCE(tp.trip_kind, 'milk') = 'milk'
      AND NOT (${saleTankerSql('tp', 't')})
    ORDER BY tp.plan_for_date, t.tanker_number`, [pFrom, to]);
  return [...hist, ...r.rows];
}

// Every rate row and diesel row touching the period, looked up per trip date.
async function loadRateRows(from, to) {
  const r = await query(`
    SELECT id, state, transport_type, capacity_kl, rate_per_km, mileage_km_per_litre, diesel_price,
           effective_from::text AS effective_from, effective_to::text AS effective_to
    FROM tanker_rates WHERE effective_from <= $2::date AND effective_to >= $1::date`, [from, to]);
  return r.rows;
}
async function loadDieselRows(from, to) {
  const r = await query(`
    SELECT state, price_per_litre, effective_from::text AS effective_from, effective_to::text AS effective_to
    FROM diesel_rates WHERE effective_from <= $2::date AND effective_to >= $1::date
    ORDER BY effective_from DESC`, [from, to]);
  return r.rows;
}
const dieselOn = (rows, state, date) => {
  const hit = rows.find(x => x.state === state && x.effective_from <= date && x.effective_to >= date);
  return hit ? parseFloat(hit.price_per_litre) : null;
};

// BMCUs served in a period: bmcu_id → { code, name, first_date (ever), last_date (ever) }.
async function loadBmcuLife(idx) {
  const r = await query(`
    SELECT x.bmcu_id, b.bmcu_code, b.bmcu_name, x.first_date::text AS first_date, x.last_date::text AS last_date
    FROM (
      SELECT teb.bmcu_id, MIN(tp.plan_for_date) AS first_date, MAX(tp.plan_for_date) AS last_date
      FROM trip_execution_bmcus teb
      JOIN trip_executions te ON te.id = teb.execution_id AND te.status <> 'cancelled'
      JOIN trip_plans tp ON tp.id = te.trip_plan_id AND tp.status NOT IN ('cancelled','deleted')
      WHERE teb.is_deleted = FALSE AND teb.bmcu_id IS NOT NULL
      GROUP BY teb.bmcu_id) x
    JOIN bmcus b ON b.id = x.bmcu_id`);
  const life = new Map(r.rows.map(x => [x.bmcu_id, x]));
  // BMCUs served in the FY workbook months count as served then (not "new" later).
  const h = await query(`SELECT report_date::text AS d, bmcu_coverage FROM historical_trips
    WHERE report_date <= $1::date AND bmcu_coverage IS NOT NULL`, [HISTORY_UNTIL]);
  const names = (await query('SELECT id, bmcu_code, bmcu_name FROM bmcus')).rows;
  const byId = new Map(names.map(b => [b.id, b]));
  for (const row of h.rows) for (const id of parseCoverage(row.bmcu_coverage, idx).ids) {
    const l = life.get(id) || { bmcu_id: id, bmcu_code: byId.get(id)?.bmcu_code, bmcu_name: byId.get(id)?.bmcu_name, first_date: row.d, last_date: row.d };
    if (row.d < l.first_date) l.first_date = row.d;
    if (row.d > l.last_date) l.last_date = row.d;
    life.set(id, l);
  }
  return life;
}

async function pricePeriod(from, to, billingStates, idx) {
  const [trips, rateRows, dieselRows] = await Promise.all([loadTrips(from, to, idx), loadRateRows(from, to), loadDieselRows(from, to)]);
  for (const tr of trips) {
    const date = tr.plan_for_date;
    tr.km = num(tr.km) || 0;
    tr.litres = num(tr.litres) || 0;
    tr.state = tr.billed_state || billingStates.get(tr.tanker_number) || stateFromRegistration(tr.tanker_number) || null;
    tr.transport_type = tr.billed_type || transportTypeFor(parseInt(tr.n_bmcus) || 0);
    const onDate = rateRows.filter(x => x.effective_from <= date && x.effective_to >= date);
    const rr = tr.state ? pickRate(onDate, tr.state, tr.transport_type, tr.capacity_litres) : null;
    const rateRow = rr ? onDate.find(x => x.id === rr.id) : null;
    tr.mileage = rateRow ? num(rateRow.mileage_km_per_litre) : null;
    tr.diesel = tr.state ? (dieselOn(dieselRows, tr.state, date) ?? (rateRow ? num(rateRow.diesel_price) : null)) : null;
    const billed = tr.billing_line_id && !tr.billed_excluded && num(tr.billed_amount) != null;
    const fromHistory = tr.history_id != null && tr.history_amount != null;
    tr.rate = fromHistory ? tr.history_rate : billed ? num(tr.billed_rate) : (rr ? rr.rate_per_km : null);
    tr.cost = fromHistory ? tr.history_amount : billed ? num(tr.billed_amount) : (tr.rate != null ? r2(tr.km * tr.rate) : 0);
    tr.cost_source = fromHistory ? 'FY workbook' : billed ? 'billing run' : (tr.rate != null ? 'rate master' : 'no rate');
    tr.in_billing_run = !!tr.billing_line_id;
  }
  return { trips };
}

function sumBy(trips, f) { let s = 0; for (const t of trips) s += f(t) || 0; return s; }
const uniqBmcus = trips => new Set(trips.flatMap(t => t.bmcu_ids || []));

async function costDrivers(from, to, prevFrom, prevTo) {
  const Q = prevFrom && prevTo ? { from: prevFrom, to: prevTo } : previousPeriod(from, to);
  const [billingStates, idx] = await Promise.all([loadBillingStates(365), loadBmcuIndex()]);
  const [P, Qp, life] = await Promise.all([pricePeriod(from, to, billingStates, idx), pricePeriod(Q.from, Q.to, billingStates, idx), loadBmcuLife(idx)]);

  // New = first ever trip inside P. Closed = served in Q, not served in P.
  const servedP = uniqBmcus(P.trips), servedQ = uniqBmcus(Qp.trips);
  const newIds = new Set([...servedP].filter(id => { const l = life.get(id); return l && l.first_date >= from && l.first_date <= to; }));
  const closedIds = new Set([...servedQ].filter(id => !servedP.has(id)));
  for (const t of P.trips) t.visits_new_bmcu = (t.bmcu_ids || []).some(id => newIds.has(id));
  for (const t of Qp.trips) t.visits_closed_bmcu = (t.bmcu_ids || []).some(id => closedIds.has(id));

  // km-weighted diesel of Q per state — the "then" price a whole quarter / year compares against.
  const states = [...new Set([...P.trips, ...Qp.trips].map(t => t.state).filter(Boolean))].sort();
  const wavg = (trips, f) => { const km = sumBy(trips, t => f(t) != null ? t.km : 0); return km > 0 ? sumBy(trips, t => f(t) != null ? t.km * f(t) : 0) / km : null; };

  const block = (pT, qT, st) => {
    const kmP = sumBy(pT, t => t.km), kmQ = sumBy(qT, t => t.km);
    const lP = sumBy(pT, t => t.litres), lQ = sumBy(qT, t => t.litres);
    const costP = sumBy(pT, t => t.cost), costQ = sumBy(qT, t => t.cost);
    const perKmQ = kmQ > 0 ? costQ / kmQ : 0, perKmP = kmP > 0 ? costP / kmP : 0;
    const perLQ = lQ > 0 ? costQ / lQ : 0, perLP = lP > 0 ? costP / lP : 0;
    const dQby = {}; for (const s of (st ? [st] : states)) dQby[s] = wavg(qT.filter(t => t.state === s), t => t.diesel);
    let diesel = 0;
    for (const t of pT) {
      const b = dQby[t.state];
      if (t.diesel != null && b != null && t.mileage) diesel += t.km * (t.diesel - b) / t.mileage;
    }
    const newTrips = pT.filter(t => t.visits_new_bmcu), closedTrips = qT.filter(t => t.visits_closed_bmcu);
    const newCost = sumBy(newTrips, t => t.cost), closedCost = -sumBy(closedTrips, t => t.cost);
    const kmEffect = ((kmP - sumBy(newTrips, t => t.km)) - (kmQ - sumBy(closedTrips, t => t.km))) * perKmQ;
    const delta = costP - costQ;
    const mix = delta - diesel - kmEffect - newCost - closedCost;
    const volume = lP > 0 && lQ > 0 ? costQ * (1 / lP - 1 / lQ) : 0;
    const perL = v => lP > 0 ? r4(v / lP) : null;
    const stats = (T, km, l, cost, perKm, perLv) => ({
      trips: T.length, km: r2(km), litres: r2(l), cost: r2(cost), per_km: r2(perKm), per_litre: r4(perLv),
      km_per_litre: r4(l > 0 ? km / l : 0), litres_per_trip: r2(T.length ? l / T.length : 0), km_per_trip: r2(T.length ? km / T.length : 0),
      bmcus: uniqBmcus(T).size, unpriced: T.filter(t => t.cost_source === 'no rate').length, billed: T.filter(t => t.cost_source === 'billing run').length,
    });
    return {
      state: st || 'All',
      diesel_prev: st ? r2(dQby[st]) : r2(wavg(qT, t => t.diesel)), diesel_curr: r2(wavg(pT, t => t.diesel)),
      prev: stats(qT, kmQ, lQ, costQ, perKmQ, perLQ), curr: stats(pT, kmP, lP, costP, perKmP, perLP),
      delta_cost: r2(delta), delta_per_km: r2(perKmP - perKmQ), delta_per_litre: r4(perLP - perLQ),
      effects: { diesel: r2(diesel), km: r2(kmEffect), new_bmcu: r2(newCost), closed_bmcu: r2(closedCost), mix: r2(mix) },
      effects_per_litre: { diesel: perL(diesel), km: perL(kmEffect), new_bmcu: perL(newCost), closed_bmcu: perL(closedCost), mix: perL(mix), volume: r4(volume),
        total: r4(perLP - perLQ) },
      new_bmcus: newIds.size, closed_bmcus: closedIds.size,
      new_bmcu_trips: newTrips.length, new_bmcu_km: r2(sumBy(newTrips, t => t.km)),
      closed_bmcu_trips: closedTrips.length, closed_bmcu_km: r2(sumBy(closedTrips, t => t.km)),
    };
  };

  const overall = block(P.trips, Qp.trips, null);
  // All-in view (owner, 2026-10-14): toll + minimum-km fixed cost of the whole
  // months in each period are month-level, so they enter as one more effect,
  // "Toll & fixed cost"; the trip-level effects above are unchanged.
  {
    const ohP = await periodOverheads(from, to), ohQ = await periodOverheads(Q.from, Q.to);
    const lP = overall.curr.litres, lQ = overall.prev.litres;
    const allP = overall.curr.cost + ohP.toll + ohP.fixed, allQ = overall.prev.cost + ohQ.toll + ohQ.fixed;
    overall.overheads = { curr: { toll: ohP.toll, fixed: ohP.fixed }, prev: { toll: ohQ.toll, fixed: ohQ.fixed } };
    overall.all_in = {
      prev_cost: r2(allQ), curr_cost: r2(allP), delta_cost: r2(allP - allQ),
      prev_per_litre: lQ > 0 ? r4(allQ / lQ) : null, curr_per_litre: lP > 0 ? r4(allP / lP) : null,
      delta_per_litre: lP > 0 && lQ > 0 ? r4(allP / lP - allQ / lQ) : null,
    };
    const ohDelta = (ohP.toll + ohP.fixed) - (ohQ.toll + ohQ.fixed);
    overall.effects.toll_fixed = r2(ohDelta);
    overall.effects_per_litre.toll_fixed = lP > 0 && lQ > 0 ? r4((ohP.toll + ohP.fixed) / lP - (ohQ.toll + ohQ.fixed) / lQ) : null;
  }
  const byState = states.map(st => block(P.trips.filter(t => t.state === st), Qp.trips.filter(t => t.state === st), st));
  const unknownP = P.trips.filter(t => !t.state), unknownQ = Qp.trips.filter(t => !t.state);
  if (unknownP.length || unknownQ.length) byState.push({ ...block(unknownP, unknownQ, null), state: 'Unknown state' });

  // By delivery point (owner, 2026-10-15): the same decomposition per receiving plant.
  const plantOf = t => t.delivery_point || 'Unknown plant';
  const plants = [...new Set([...P.trips, ...Qp.trips].map(plantOf))];
  const byPlant = plants.map(pl => ({ ...block(P.trips.filter(t => plantOf(t) === pl), Qp.trips.filter(t => plantOf(t) === pl), null), state: pl, delivery_point: pl }))
    .sort((a, b) => b.curr.cost - a.curr.cost || b.prev.cost - a.prev.cost);

  const bmcuRows = (ids, trips, kind) => [...ids].map(id => {
    const l = life.get(id) || {};
    const T = trips.filter(t => (t.bmcu_ids || []).includes(id));
    return { bmcu_id: id, bmcu_code: l.bmcu_code, bmcu_name: l.bmcu_name, first_date: l.first_date, last_date: l.last_date, kind,
      trips: T.length, km: r2(sumBy(T, t => t.km)), litres: r2(sumBy(T, t => t.litres)), cost: r2(sumBy(T, t => t.cost)) };
  }).sort((a, b) => (a.bmcu_code || '').localeCompare(b.bmcu_code || ''));

  const tripOut = t => ({
    plan_for_date: t.plan_for_date, tanker_number: t.tanker_number, route_name: t.route_name, delivery_point: t.delivery_point,
    capacity_litres: num(t.capacity_litres), state: t.state, transport_type: t.transport_type, n_bmcus: parseInt(t.n_bmcus) || 0,
    km: r2(t.km), litres: r2(t.litres), rate: t.rate, cost: r2(t.cost), cost_source: t.cost_source, run_id: t.run_id || null,
    diesel: t.diesel, mileage: t.mileage, visits_new_bmcu: !!t.visits_new_bmcu, visits_closed_bmcu: !!t.visits_closed_bmcu,
  });

  return {
    period: { from, to }, previous: Q,
    overall, by_state: byState, by_delivery_point: byPlant,
    new_bmcus: bmcuRows(newIds, P.trips, 'new'), closed_bmcus: bmcuRows(closedIds, Qp.trips, 'closed'),
    trips: P.trips.map(tripOut), previous_trips: Qp.trips.map(tripOut),
    notes: [
      ...((from <= HISTORY_UNTIL || Q.from <= HISTORY_UNTIL) ? [`Up to ${HISTORY_UNTIL.split('-').reverse().join('-')} trips come from the FY workbook (billed km, amount, acknowledged litres, BMCUs covered); later trips from the portal.`] : []),
      ...(() => { const n = [...P.trips, ...Qp.trips].filter(t => t.coverage_unmatched > 0).length; return n ? [`${n} FY-workbook trip(s) list BMCUs not found in the BMCU master — new / closed BMCU effects may be understated for them.`] : []; })(),
      'km = billed km when the trip is in a billing run, else the current Distance Master / Google chain. Cost = billed amount when billed, else km × Tanker Rate Master rate valid on the lifting date. Sale tankers and material trips are left out.',
      'Diesel effect = this period\'s km × (diesel on the lifting date − km-weighted diesel of the previous period in that state) ÷ mileage of the rate row.',
      'New BMCUs = cost of this period\'s trips visiting a BMCU whose first ever trip is in this period. Closed BMCUs = − cost of the previous period\'s trips visiting a BMCU not served in this period.',
      'Km effect = change in the remaining km at the previous period\'s ₹/km. Mix / other = the rest (route and capacity mix, keyed km, other rate changes).',
      'Per litre: each effect ÷ this period\'s litres, plus the volume effect (previous cost spread over the new litres). All effects add up to the change exactly.',
    ],
  };
}

module.exports = { costDrivers, previousPeriod };
