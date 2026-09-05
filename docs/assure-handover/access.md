# Proposed Access Model for Assure

Nothing in this file is applied to any database — it is a proposal only, for review by
TMS/ops and by whoever owns the production Postgres instance.

## DB engine
Postgres, via the `pg` node driver (`backend/package.json`: `"pg": "^8.11.3"`).
`backend/src/config/db.js` connects with a standard `Pool`; SSL is off by default in
the current same-host docker-compose deployment (`ssl: process.env.DB_SSL === 'true'`
gate). **This environment cannot confirm the exact live Postgres server version** — no
DB connection is available here; check with `SELECT version();` against the real
server.

## Proposed read-only views (SQL files under `docs/assure-handover/sql/`, NOT applied)

Two views are proposed: `assure_trips_v` (one row per execution) and
`assure_receipts_v` (one row per acknowledgement chamber row). See
`sql/assure_trips_v.sql` and `sql/assure_receipts_v.sql`.

Design choices:
- **Cancelled/deleted rows are FLAGGED via a status column, never filtered out** — both
  views expose the underlying `status` (execution) or the parent plan's `status`, so
  Assure can decide its own inclusion rule rather than have TMS silently hide rows.
- **Stable column names** — the view column names are fixed and independent of the
  underlying table's internal column names, so a future TMS schema change can be
  absorbed by updating the view definition without breaking Assure's consumer code.
- **`updated_at` for incremental polling**:
  - `trip_executions.updated_at` — **already exists** (`001_base_schema.sql:145`,
    refreshed on every `applyExecutionData` write — `executionData.js:346`). Exposed
    directly in `assure_trips_v`.
  - `trip_acknowledgements` has **no `updated_at` column** — only `created_at`
    (migration 021, documented as "last entry/correction date" due to the
    delete+reinsert write pattern). **This is a gap**: `assure_receipts_v` exposes
    `created_at` as the best available proxy and this document does NOT silently
    invent an `updated_at` column that doesn't exist. If Assure needs true
    incremental-polling semantics on receipts, **`trip_acknowledgements` needs an
    `updated_at` column added** (small effort — a migration + one line in
    `applyExecutionData`'s ack insert). See `gaps.md`.
  - `trip_plans.updated_at` — already exists (`001_base_schema.sql:116`).

## Proposed REST endpoint (not built — description only)

Following this codebase's existing conventions (see `backend/src/middleware/auth.js`
for `authenticate`/`authorize`/`authorizeModule` and the route style in
`backend/src/routes/*.js`):

```
GET /api/integrations/assure/trips
GET /api/integrations/assure/receipts
```
under the app's existing `/api` prefix, each:
- Gated by `authenticate` (JWT bearer) + a new role or module permission (e.g. an
  `authorizeModule('reports')`-style check, or a dedicated API-key auth path if Assure
  should not need a human TMS login at all — this is a design choice for whoever
  builds the endpoint, not decided here).
- Filters: `from_date` / `to_date` (maps to `plan_for_date` or `execution_date`
  range), `updated_since` (ISO timestamp — maps to `updated_at` on the underlying
  view/table for incremental pulls).
- Pagination: `limit` + either an offset or a keyset cursor (e.g. `after_id`) — given
  this codebase's existing patterns (`billing.js` etc. use plain SQL with explicit
  params, no generic pagination helper found), a keyset cursor on `id` ordered by
  `updated_at, id` would be the safest choice for a growing table.
- Response: rows from `assure_trips_v` / `assure_receipts_v` respectively, JSON.

This is a proposal for a NEW route file (e.g. `backend/src/routes/integrations.js`) —
no such file exists today; nothing here has been implemented.

## Network placement
**Unknown from this environment.** Whether Assure would reach this endpoint over the
public internet, a VPN, or a private peering link is an infrastructure decision outside
what this codebase can answer. `docker-compose.yml`/`docker-compose.qa.yml` show the
app and DB currently sharing a trusted network with SSL off between them
(`db.js` comment), which says nothing about how an external consumer like Assure would
reach the app tier.

## Credential ownership
A business/ops decision outside this codebase — not addressed here.
