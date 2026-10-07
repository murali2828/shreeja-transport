// backend/src/services/qaDispatch.js
// Formulas of the quality team's tanker dispatch entries (migration 052).
// Dispatch side: the lab reports Fat % and CLR; SNF is derived with the
// standard CLR formula. Both sides: kgs = litres × KG_FACTOR (ADR-006),
// kg fat / kg SNF from the percentages. Variation = dispatch − truck sheet
// (matches the quality team's Excel: 2000 − 2001 = −1, 4 − 3.9 = +0.1).
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

function variations(row) {
  const d = k => (row[k] == null ? null : parseFloat(row[k]));
  const diff = (a, b, r = r2) => (a == null || b == null ? null : r(a - b));
  return {
    qty_var_litres: diff(d('d_qty_litres'), d('ts_qty_litres')),
    qty_var_kgs:    diff(d('d_qty_kgs'), d('ts_qty_kgs')),
    fat_var:        diff(d('d_fat_pct'), d('ts_fat_pct'), r3),
    snf_var:        diff(d('d_snf_pct'), d('ts_snf_pct'), r3),
    kg_fat_var:     diff(d('d_kg_fat'), d('ts_kg_fat')),
    kg_snf_var:     diff(d('d_kg_snf'), d('ts_kg_snf')),
  };
}

module.exports = { snfFromClr, computeDispatch, computeTruckSheet, variations, n };
