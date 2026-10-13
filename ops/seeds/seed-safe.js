#!/usr/bin/env node
/**
 * Safe seed runner — the ONLY way seeds are run (npm run seed / seed:one /
 * seed:prod all come here). Knex's own `seed:run` is deliberately not used:
 * it runs each file OUTSIDE a transaction, so a seed that fails half-way
 * leaves its earlier statements applied, and nothing stops a seed from
 * deleting master data (a seed that deletes on a populated environment is the classic data-loss incident).
 *
 * Guarantees:
 *   1. Each seed file runs inside ONE transaction — a failure rolls the whole
 *      file back.
 *   2. NO TABLE MAY SHRINK. Before commit, the exact row count of every user
 *      table is compared with its count at the start of the transaction; if
 *      any table lost rows the transaction is rolled back and the run fails.
 *      (A seed may only ADD or UPDATE — the rule that makes re-seeding a
 *      populated environment safe.)
 *   3. Running ALL seeds is only implicit on an EMPTY database (no row in
 *      SEED_SENTINEL_TABLE). On a populated database name the file(s) — or pass --all.
 *   4. Connects as the ADMIN role (DATABASE_ADMIN_URL when set, see
 *      src/config/knexfile.js) because the runtime app role cannot delete
 *      and may not own the tables.
 *
 * Usage (from backend/):
 *   node scripts/seed-safe.js                       # all seeds, empty DB only
 *   node scripts/seed-safe.js 010_demo_data.js
 *   node scripts/seed-safe.js --all                 # every seed, populated DB
 *   NODE_ENV=production node scripts/seed-safe.js --env production 001_initial_data.js
 */
const path = require('path');
const fs = require('fs');

process.env.KNEX_ADMIN = '1';

// Copy this file to backend/scripts/seed-safe.js (or set SEEDS_DIR / KNEXFILE).
const SEEDS_DIR = process.env.SEEDS_DIR || path.join(__dirname, '../seeds');
const KNEXFILE = process.env.KNEXFILE || '../src/config/knexfile';
// A table that has rows on any populated environment (used to decide whether
// "run all seeds" is allowed implicitly). Set SEED_SENTINEL_TABLE for your schema.
const SENTINEL = process.env.SEED_SENTINEL_TABLE || 'users';
const SKIP_TABLES = new Set(['knex_migrations', 'knex_migrations_lock']);

const parseArgs = (argv) => {
  const out = { env: process.env.NODE_ENV || 'qa', all: false, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--env') { out.env = argv[i += 1]; continue; }
    if (a === '--all') { out.all = true; continue; }
    if (a === '--specific') continue; // tolerate the old knex flag
    if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    out.files.push(a);
  }
  return out;
};

const listSeeds = () => fs.readdirSync(SEEDS_DIR).filter((f) => /^\d+_.*\.js$/.test(f)).sort();

const resolveSeedFile = (name) => {
  const base = path.basename(name);
  const all = listSeeds();
  const hit = all.find((f) => f === base) || all.find((f) => f.startsWith(`${base}_`)) || all.find((f) => f.startsWith(base));
  if (!hit) throw new Error(`No seed file matches "${name}" in ${SEEDS_DIR}`);
  return hit;
};

/** Exact row count per public table (knex's own bookkeeping tables excluded). */
const rowCounts = async (trx) => {
  const { rows } = await trx.raw(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  const counts = {};
  for (const { tablename } of rows) {
    if (SKIP_TABLES.has(tablename)) continue;
    const r = await trx.raw('SELECT count(*)::bigint AS n FROM ??', [tablename]);
    counts[tablename] = Number(r.rows[0].n);
  }
  return counts;
};

/** Pure: names of tables whose count went DOWN (empty array = safe). */
const shrunkTables = (before, after) => Object.keys(before)
  .filter((t) => after[t] !== undefined && after[t] < before[t])
  .map((t) => ({ table: t, before: before[t], after: after[t] }));

const runOne = async (knex, file) => {
  const seed = require(path.join(SEEDS_DIR, file));
  if (typeof seed.seed !== 'function') throw new Error(`${file} does not export seed()`);
  const started = Date.now();
  await knex.transaction(async (trx) => {
    const before = await rowCounts(trx);
    await seed.seed(trx);
    const after = await rowCounts(trx);
    const shrunk = shrunkTables(before, after);
    if (shrunk.length) {
      const detail = shrunk.map((s) => `${s.table} ${s.before}→${s.after}`).join(', ');
      throw new Error(`${file} would REDUCE row counts (${detail}) — seeds may only add or update. Rolled back.`);
    }
    const grew = Object.keys(after).filter((t) => (after[t] || 0) > (before[t] || 0)).map((t) => `${t}+${after[t] - (before[t] || 0)}`);
    console.log(`✅ ${file} committed in ${Date.now() - started} ms${grew.length ? ` (${grew.join(', ')})` : ' (no row-count change)'}`);
  });
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  process.env.NODE_ENV = args.env;
  const knexfile = require(KNEXFILE);
  const cfg = knexfile[args.env];
  if (!cfg) throw new Error(`No knex config for env "${args.env}"`);
  const knex = require('knex')({ ...cfg, pool: { min: 1, max: 2 } });
  try {
    let files;
    if (args.files.length) {
      files = args.files.map(resolveSeedFile);
    } else {
      const populated = await knex(SENTINEL).first().catch(() => null);
      if (populated && !args.all) {
        throw new Error('Database is already populated. Name the seed file(s) to run, e.g. `npm run seed:one -- 010_demo_data.js`, or pass --all to run every seed (each is still transactional and may not shrink any table).');
      }
      files = listSeeds();
    }
    console.log(`Seeding ${files.length} file(s) on env=${args.env} as ${process.env.DATABASE_ADMIN_URL ? 'DATABASE_ADMIN_URL' : 'DATABASE_URL'} (transactional, no-shrink guard)`);
    for (const f of files) await runOne(knex, f); // eslint-disable-line no-await-in-loop
    console.log('✅ Seed run complete');
  } finally {
    await knex.destroy();
  }
};

if (require.main === module) {
  main().catch((err) => { console.error(`❌ ${err.message}`); process.exit(1); });
}

module.exports = { shrunkTables, parseArgs, resolveSeedFile };
