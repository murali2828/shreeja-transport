---
paths:
  - "**/migrations/**"
  - "**/db/**"
  - "backend/src/config/**"
---
# Database rules

- Migrations are `backend/migrations/NNN_snake_case.sql`, applied in filename order by
  `config/migrate.js` at backend start, one transaction each, tracked in `schema_migrations`.
- Never edit, rename or delete an applied migration (latest applied: 043). Fixes are new
  files (pattern: 023 fixes 021; 043 widens a CHECK from 001). Next number: 044.
- Every migration is idempotent where Postgres allows it (`IF NOT EXISTS`, `DROP … IF EXISTS`,
  `ON CONFLICT DO NOTHING`) and starts with a header comment stating the business reason.
- Index expressions must be IMMUTABLE (no `timestamptz::date`); use partial indexes for
  uniqueness with a status filter (see `uq_trip_executions_live_plan`).
- Adding FKs to large existing tables: use `NOT VALID` (migration 036 pattern).
- Data fixes belong in a migration with an auditable reason column value (e.g. the
  `cancel_reason` text in 043), never in ad-hoc psql on the server.
- `DATE` columns are returned as `YYYY-MM-DD` strings (type parser in `config/db.js`);
  session TZ is Asia/Kolkata. Do not add timezone conversions in JS.
- Use `query()` for single statements and `pool.connect()` + BEGIN/COMMIT/ROLLBACK/release
  for multi-statement writes; never hold a transaction across an external HTTP call.
- Respect the timeouts: statement 30 s (`DB_STATEMENT_TIMEOUT_MS`), query 35 s, idle-in-tx
  5 min. Batch jobs preload lookups (e.g. `loadMasterDistanceCache`) instead of N+1 queries.
- Reuse existing SQL rules rather than re-deriving them: `saleTankerSql()` for sale tankers,
  `normalisePair()` for `distance_master` pairs, `applyExecutionData` for execution rows.
- Nobody runs psql or `docker compose` from the dev sandbox; schema changes reach QA by
  pushing the migration and letting the operator redeploy.
