// backend/scripts/import_fixed_costs.js
// Load finance's approved "Fixed Cost Consolidated Report" workbooks (minimum
// 9,000 km per tanker per month, migration 067) — one or more files, each
// replacing its month. Same parser as the upload on Reports → Tanker Utilisation.
//
//   node scripts/import_fixed_costs.js /tmp/fc/*.xlsx            # dry run: month, tankers, total, unmatched
//   node scripts/import_fixed_costs.js /tmp/fc/*.xlsx --apply    # load
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/db');
const fc = require('../src/services/fixedCosts');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const files = args.filter(a => !a.startsWith('--'));
if (!files.length) { console.error('usage: node scripts/import_fixed_costs.js <workbook.xlsx> [...] [--apply]'); process.exit(2); }
const fmt = n => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

(async () => {
  console.log(APPLY ? 'APPLY' : 'DRY RUN');
  for (const f of files) {
    const p = await fc.parseFixedCostWorkbook(fs.readFileSync(f));
    const m = await fc.matchMasters(p.rows);
    console.log(`\n${path.basename(f)} → ${p.month_start.slice(0, 7)} (sheet "${p.sheet}"): ${p.rows.length} tankers, ₹${fmt(p.total)}${p.sheet_total != null ? ` (sheet total ₹${fmt(p.sheet_total)})` : ''}`);
    p.warnings.forEach(w => console.log('  warning:', w));
    if (m.unmatched_tankers.length) console.log(`  tankers not in Tanker Master (loaded anyway): ${m.unmatched_tankers.join(', ')}`);
    if (m.unmatched_vendors.length) console.log(`  vendor codes not in Vendor master: ${m.unmatched_vendors.join(', ')}`);
    if (APPLY) { const r = await fc.saveMonth(p.month_start, m.rows, { file: path.basename(f) }); console.log(`  loaded ${r.saved} rows`); }
  }
  if (!APPLY) console.log('\nDry run only — nothing written. Re-run with --apply to load.');
  await pool.end();
})().catch(e => { console.error('[fixed-costs] failed:', e.message); process.exit(1); });
