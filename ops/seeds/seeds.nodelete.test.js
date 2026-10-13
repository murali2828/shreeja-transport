/**
 * Data-protection guards (ops-kit — copy to backend/scripts/__tests__/):
 *   - no seed file may contain a delete/truncate statement — seeds only ADD
 *     or UPDATE, so `npm run seed` is safe on a populated environment;
 *   - the safe seed runner's no-shrink check flags any table that lost rows.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { shrunkTables, parseArgs, resolveSeedFile } = require('../seed-safe');

const SEEDS_DIR = path.join(__dirname, '../../seeds');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"])\/\/.*$/gm, '$1');
const FORBIDDEN = /\.(del|delete|truncate)\s*\(|\btruncate\b|\bdelete\s+from\b|dropTable|\bdrop\s+table\b/i;

test('no seed file deletes, truncates or drops anything', () => {
  const files = fs.readdirSync(SEEDS_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 1, 'seeds present');
  const offenders = files.filter((f) => FORBIDDEN.test(stripComments(fs.readFileSync(path.join(SEEDS_DIR, f), 'utf8'))));
  assert.deepEqual(offenders, [], `seed files must never delete: ${offenders.join(', ')}`);
});

test('shrunkTables(): flags only tables whose count went down', () => {
  const before = { roles: 17, employees: 113, mpp_locations: 5235, silo_readings: 40 };
  assert.deepEqual(shrunkTables(before, { ...before, employees: 116 }), []);
  assert.deepEqual(shrunkTables(before, { ...before, mpp_locations: 0, roles: 17 }), [{ table: 'mpp_locations', before: 5235, after: 0 }]);
  assert.deepEqual(shrunkTables(before, { roles: 17 }), [], 'a table missing from the after-snapshot is not a shrink');
});

test('parseArgs(): files, --all, --env; old --specific flag tolerated', () => {
  assert.deepEqual(parseArgs(['--specific', '010_demo_data.js']).files, ['010_demo_data.js']);
  assert.equal(parseArgs(['--all']).all, true);
  assert.equal(parseArgs(['--env', 'production', 'x.js']).env, 'production');
  assert.throws(() => parseArgs(['--force']), /Unknown option/);
});

test('resolveSeedFile(): exact name, numeric prefix, or prefix match', () => {
  const first = fs.readdirSync(SEEDS_DIR).filter((f) => /^\d+_.*\.js$/.test(f)).sort()[0];
  assert.equal(resolveSeedFile(first), first);
  assert.equal(resolveSeedFile(first.split('_')[0]), first);
  assert.equal(resolveSeedFile(`seeds/${first}`), first);
  assert.throws(() => resolveSeedFile('999_nope.js'), /No seed file/);
});
