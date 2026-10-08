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

// Diesel price of a state on a date (diesel_rates, migration 058); null when
// no period covers the date. The price behind a rate row is its own
// tanker_rates.diesel_price; this is the master for new periods.
async function dieselPriceFor(state, date) {
  if (!state || !date) return null;
  const r = await query(`
    SELECT price_per_litre FROM diesel_rates
    WHERE state = $1 AND $2::date BETWEEN effective_from AND effective_to
    ORDER BY effective_from DESC LIMIT 1`, [state, date]);
  return r.rows[0] ? parseFloat(r.rows[0].price_per_litre) : null;
}

// Every state's diesel price valid on a date → { state: price }.
async function loadDieselForDate(date) {
  const r = await query(`
    SELECT DISTINCT ON (state) state, price_per_litre FROM diesel_rates
    WHERE $1::date BETWEEN effective_from AND effective_to
    ORDER BY state, effective_from DESC`, [date]);
  const out = {};
  for (const x of r.rows) out[x.state] = parseFloat(x.price_per_litre);
  return out;
}

// Fortnight check shared by billing periods and rate/diesel periods:
// 1–15 or 16–month end of one month. Returns an error string or null.
function fortnightError(from, to) {
  if (!from || !to) return 'from and to dates are required';
  if (to < from) return 'to date is before from date';
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const sameMonth = fy === ty && fm === tm;
  const monthEnd = new Date(Date.UTC(fy, fm, 0)).getUTCDate();
  const ok = sameMonth && ((fd === 1 && td === 15) || (fd === 16 && td === monthEnd));
  return ok ? null : `Periods are fortnights only: 1–15 or 16–${monthEnd} of a month`;
}

// The fortnight before [from, to]: [from, to] of the previous half month.
function previousFortnight(from) {
  const [y, m, d] = from.split('-').map(Number);
  if (d > 15) return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: `${y}-${String(m).padStart(2, '0')}-15` };
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const end = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return { from: `${py}-${String(pm).padStart(2, '0')}-16`, to: `${py}-${String(pm).padStart(2, '0')}-${end}` };
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
  dieselPriceFor, loadDieselForDate, fortnightError, previousFortnight,
};
