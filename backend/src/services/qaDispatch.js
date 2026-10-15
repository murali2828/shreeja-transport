// backend/src/services/qaDispatch.js
// Formulas of the quality team's tanker dispatch entries (migration 052).
// Dispatch side: the lab reports Fat % and CLR; SNF is derived with the
// standard CLR formula. Both sides: kgs = litres × KG_FACTOR (ADR-006),
// kg fat / kg SNF from the percentages. Variation = dispatch − truck sheet
// (matches the quality team's Excel: 2000 − 2001 = −1, 4 − 3.9 = +0.1);
// truck sheet adjusted for balance milk since migration 068.
const { KG_FACTOR } = require('./executionData');

const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
const r4 = v => Math.round(v * 10000) / 10000;
const n  = v => (v === undefined || v === null || v === '' ? null : (Number.isFinite(parseFloat(v)) ? parseFloat(v) : NaN));

// SNF % from CLR and fat %: CLR/4 + 0.21 × fat + 0.36
function snfFromClr(clr, fat) {
  if (clr == null || fat == null) return null;
  return r3(clr / 4 + 0.21 * fat + 0.36);
}

function solids(litres, fat, snf) {
  const kgs = litres != null ? r4(litres * KG_FACTOR) : null;
  return {
    qty_kgs: kgs,
    kg_fat: kgs != null && fat != null ? r4(kgs * fat / 100) : null,
    kg_snf: kgs != null && snf != null ? r4(kgs * snf / 100) : null,
  };
}

function computeDispatch({ qty_litres, fat_pct, clr }) {
  const l = n(qty_litres), f = n(fat_pct), c = n(clr);
  const snf = snfFromClr(c, f);
  return { d_qty_litres: l, d_fat_pct: f, d_clr: c, d_snf_pct: snf, ...prefix('d_', solids(l, f, snf)) };
}

function computeTruckSheet({ qty_litres, fat_pct, snf_pct }) {
  const l = n(qty_litres), f = n(fat_pct), s = n(snf_pct);
  return { ts_qty_litres: l, ts_fat_pct: f, ts_snf_pct: s, ...prefix('ts_', solids(l, f, s)) };
}

function prefix(p, o) { return Object.fromEntries(Object.entries(o).map(([k, v]) => [p + k, v])); }

// Balance milk (migration 068), the TS report's rule (routes/reports.js applyAdj):
// Left Over milk is deducted from RMRD, Lifted milk is added. Blank fat / SNF of
// a balance line take the truck sheet's. Fat % / SNF % of the adjusted RMRD come
// from the kg totals. Computed on read; only the keyed figures are stored.
function adjustRmrd(row) {
  const g = k => { const v = n(row[k]); return Number.isNaN(v) ? null : v; };
  const tsL = g('ts_qty_litres'), tsF = g('ts_fat_pct'), tsS = g('ts_snf_pct');
  const ts = solids(tsL, tsF, tsS);
  const bal = p => {
    const l = g(p + 'qty_litres');
    const f = g(p + 'fat_pct') ?? tsF, s = g(p + 'snf_pct') ?? tsS;
    return prefix(p, solids(l, f, s));
  };
  const lo = bal('lo_'), lf = bal('lf_');
  const out = { ...lo, ...lf };
  const anyBal = g('lo_qty_litres') != null || g('lf_qty_litres') != null;
  if (tsL == null && !anyBal) {
    return { ...out, rmrd_adj_qty_litres: null, rmrd_adj_qty_kgs: null, rmrd_adj_fat_pct: null, rmrd_adj_snf_pct: null, rmrd_adj_kg_fat: null, rmrd_adj_kg_snf: null };
  }
  const z = v => v || 0;
  const litres = r2(z(tsL) - z(g('lo_qty_litres')) + z(g('lf_qty_litres')));
  const kgs    = r4(z(ts.qty_kgs) - z(lo.lo_qty_kgs) + z(lf.lf_qty_kgs));
  const kgFat  = (tsF == null && lo.lo_kg_fat == null && lf.lf_kg_fat == null) ? null : r4(z(ts.kg_fat) - z(lo.lo_kg_fat) + z(lf.lf_kg_fat));
  const kgSnf  = (tsS == null && lo.lo_kg_snf == null && lf.lf_kg_snf == null) ? null : r4(z(ts.kg_snf) - z(lo.lo_kg_snf) + z(lf.lf_kg_snf));
  return { ...out, rmrd_adj_qty_litres: litres, rmrd_adj_qty_kgs: kgs,
    rmrd_adj_fat_pct: kgs > 0 && kgFat != null ? r3(kgFat / kgs * 100) : null,
    rmrd_adj_snf_pct: kgs > 0 && kgSnf != null ? r3(kgSnf / kgs * 100) : null,
    rmrd_adj_kg_fat: kgFat, rmrd_adj_kg_snf: kgSnf };
}

// Variation = dispatch − RMRD adjusted for balance milk (migration 068).
function variations(row) {
  const a = adjustRmrd(row);
  const d = k => (a[k] !== undefined ? a[k] : (row[k] == null ? null : parseFloat(row[k])));
  const diff = (a, b, r = r2) => (a == null || b == null ? null : r(a - b));
  return {
    qty_var_litres: diff(d('d_qty_litres'), d('rmrd_adj_qty_litres')),
    qty_var_kgs:    diff(d('d_qty_kgs'), d('rmrd_adj_qty_kgs')),
    fat_var:        diff(d('d_fat_pct'), d('rmrd_adj_fat_pct'), r3),
    snf_var:        diff(d('d_snf_pct'), d('rmrd_adj_snf_pct'), r3),
    kg_fat_var:     diff(d('d_kg_fat'), d('rmrd_adj_kg_fat')),
    kg_snf_var:     diff(d('d_kg_snf'), d('rmrd_adj_kg_snf')),
  };
}

module.exports = { snfFromClr, computeDispatch, computeTruckSheet, adjustRmrd, variations, n };
