// backend/src/services/rates.js
// Tanker Rate Master lookup shared by billing (routes/billing.js) and the Day
// Optimizer (services/optimizerV2 via routes/optimize.js). One rule for both:
// rate = tanker_rates row matching state × transport type × capacity KL whose
// period covers the PLANNING date. Moved verbatim from routes/billing.js so
// the optimiser prices trips exactly as the billing team will pay them.
const { query } = require('../config/db');

const STATES = ['Andhra Pradesh', 'Tamil Nadu', 'Karnataka', 'Telangana'];

// Registration prefix → state (used only when billing history has no state
// for the tanker yet).
const REG_PREFIX_STATE = { AP: 'Andhra Pradesh', TN: 'Tamil Nadu', KA: 'Karnataka', TS: 'Telangana', TG: 'Telangana' };

const { transportTypeFor } = require('./optimizerV2'); // 1 BMCU → Point to Point, else BMCU/CC to Dairy/CC

// Rate lookup: state × transport type × capacity KL, period covering planDate.
async function findRate(state, transportType, capacityLitres, planDate) {
  if (!state || !transportType || !capacityLitres || !planDate) return null;
  const r = await query(`
    SELECT id, rate_per_km FROM tanker_rates
    WHERE state = $1 AND transport_type = $2
      AND ABS(capacity_kl - $3::numeric / 1000.0) < 0.051
      AND $4::date BETWEEN effective_from AND effective_to
    ORDER BY ABS(capacity_kl - $3::numeric / 1000.0)
    LIMIT 1`, [state, transportType, capacityLitres, planDate]);
  return r.rows[0] || null;
}

// Every rate row valid on planDate, keyed "state|transport_type|capacity_kl"
// — one query for a whole fleet instead of a lookup per tanker × type.
async function loadRatesForDate(planDate) {
  const r = await query(`
    SELECT id, state, transport_type, capacity_kl, rate_per_km FROM tanker_rates
    WHERE $1::date BETWEEN effective_from AND effective_to`, [planDate]);
  return r.rows;
}

// Pick the rate for a tanker out of loadRatesForDate() rows (same tolerance
// as findRate: capacity within ±0.05 KL, closest wins).
function pickRate(rows, state, transportType, capacityLitres) {
  const kl = Number(capacityLitres) / 1000;
  let best = null, bestDiff = Infinity;
  for (const r of rows) {
    if (r.state !== state || r.transport_type !== transportType) continue;
    const diff = Math.abs(parseFloat(r.capacity_kl) - kl);
    if (diff < 0.051 && diff < bestDiff) { best = r; bestDiff = diff; }
  }
  return best ? { id: best.id, rate_per_km: parseFloat(best.rate_per_km) } : null;
}

function stateFromRegistration(tankerNumber) {
  const m = String(tankerNumber || '').trim().toUpperCase().match(/^([A-Z]{2})/);
  return m ? REG_PREFIX_STATE[m[1]] || null : null;
}

// Billing state per tanker: the state the biller chose most often for the
// tanker in the last `days` days of billing runs (billing_run_trips keys by
// tanker_number). Returns Map<tanker_number, state>.
async function loadBillingStates(days = 90) {
  const r = await query(`
    SELECT tanker_number, state FROM (
      SELECT tanker_number, state, COUNT(*) AS n,
             ROW_NUMBER() OVER (PARTITION BY tanker_number ORDER BY COUNT(*) DESC, state) AS rn
      FROM billing_run_trips
      WHERE state IS NOT NULL AND plan_for_date >= CURRENT_DATE - $1::int
      GROUP BY tanker_number, state) x
    WHERE rn = 1`, [days]);
  return new Map(r.rows.map(x => [x.tanker_number, x.state]));
}

module.exports = {
  STATES, findRate, loadRatesForDate, pickRate, transportTypeFor,
  stateFromRegistration, loadBillingStates,
};
