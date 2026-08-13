// backend/src/config/db.js
const { Pool, types } = require('pg');

// OID 1082 = DATE. Return the raw 'YYYY-MM-DD' string Postgres sends instead of letting
// pg construct a local-midnight JS Date (which res.json() then serializes via toISOString()
// into UTC — shifting a day whenever the process runs ahead of UTC, e.g. under TZ=Asia/Kolkata).
types.setTypeParser(1082, val => val);

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'dairy_transport',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // Runaway-query guards (audit 2026-08): a hung analytics/report query must
  // not pin a pool slot forever, and a transaction left open across an
  // external call must eventually release.
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '30000'),
  query_timeout: parseInt(process.env.DB_QUERY_TIMEOUT_MS || '35000'),
  idle_in_transaction_session_timeout: parseInt(process.env.DB_IDLE_TX_TIMEOUT_MS || '300000'),
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

// Simple query helper — use pool.connect() for transactions
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const ms = Date.now() - start;
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[DB] ${ms}ms — ${text.substring(0, 80)}`);
  } else if (ms > 500) {
    // Slow-query visibility in production (no params — they may hold data)
    console.warn(`[DB SLOW] ${ms}ms — ${text.replace(/\s+/g, ' ').substring(0, 200)}`);
  }
  return res;
}

module.exports = { pool, query };
