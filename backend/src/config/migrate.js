// backend/src/config/migrate.js
// Run: node src/config/migrate.js
// Executes all SQL files in backend/migrations/ in order

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { pool } = require('./db');

async function migrate() {
  const migrationsDir = path.join(__dirname, '../../migrations');

  // Ensure migrations tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         SERIAL PRIMARY KEY,
      filename   VARCHAR(255) UNIQUE NOT NULL,
      run_at     TIMESTAMP DEFAULT NOW()
    )
  `);

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const already = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1', [file]
    );
    if (already.rows.length) {
      console.log(`[migrate] SKIP  ${file}`);
      continue;
    }

    console.log(`[migrate] RUN   ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)', [file]
      );
      await client.query('COMMIT');
      console.log(`[migrate] OK    ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrate] FAIL  ${file}:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log('[migrate] All migrations complete.');
  await pool.end();
}

migrate().catch(err => {
  console.error('[migrate] Fatal:', err);
  process.exit(1);
});
