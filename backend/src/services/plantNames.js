// backend/src/services/plantNames.js
// Receiving-plant names (owner, 2026-10-15): the FY workbook spells each plant
// many ways ("MDFVPL", "Balaji Dairy", "Jersey Milk Processing Unit,
// Madanapalli."); the analysis shows the portal's Delivery Point master name
// for every plant, so legacy (workbook) and portal trips fall on one row.
// Used by scripts/import_trip_history.js (normalised name at load) and at read
// time by the Payment Report and Transport Cost Drivers.
const { query } = require('../config/db');

// [pattern on the lower-cased name, normalised workbook name]
const PLANTS = [
  [/mdfvpl|mdvfpl|balaji/, 'Balaji Dairy (MDFVPL)'],
  [/kmf|kanakapura|shivanahalli/, 'KMF Kanakapura'],
  [/^ska|^s\s*k\s*a/, 'SKA Dairy'],
  [/bathalapalli/, 'Bathalapalli'],
  [/mukund/, 'Mukunda Dairy'],
  [/arvai|arvie/, 'Arvais Dairy (HYD)'],
  [/narmul/, 'NARMUL'],
  [/calvinkare|cavinkare/, 'CavinKare'],
  [/atchay/, 'Atchayam Agro Products'],
  [/jersey.*madanapal/, 'Jersey, Madanapalli'],
  [/jersey.*chennai/, 'Jersey, Chennai'],
  [/farmgate/, 'Farmgate, Palamaner'],
  [/hindustan unilever|\bhul\b/, 'Hindustan Unilever'],
];
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const plantKey = s => { const l = clean(s).toLowerCase(); const i = PLANTS.findIndex(([re]) => re.test(l)); return i < 0 ? null : i; };
const plantName = s => { const t = clean(s); const k = plantKey(t); return k == null ? t || null : PLANTS[k][1]; };

// name → portal Delivery Point name with the same plant key (else unchanged).
let cache = null, cachedAt = 0;
async function portalPlantMap() {
  if (!cache || Date.now() - cachedAt > 60000) {
    const r = await query('SELECT name FROM delivery_points ORDER BY id');
    const byKey = new Map(), byNorm = new Map();
    const norm = s => clean(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const { name } of r.rows) {
      const k = plantKey(name);
      if (k != null && !byKey.has(k)) byKey.set(k, name);
      byNorm.set(norm(name), name);
    }
    cache = name => { if (!name) return name; const k = plantKey(name); return (k != null && byKey.get(k)) || byNorm.get(norm(name)) || name; };
    cachedAt = Date.now();
  }
  return cache;
}

module.exports = { PLANTS, plantKey, plantName, portalPlantMap };
