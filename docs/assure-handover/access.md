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

## REST endpoint — IMPLEMENTED

The endpoint is built and mounted at **`/api/integrations/assure/*`** on both the QA
host (`qatms.shreejamilk.com`) and, after promotion of the `qa` branch, the production
host (`tms.shreejamilk.com`):

```
GET /api/integrations/assure/ping
GET /api/integrations/assure/trips
GET /api/integrations/assure/loadings
GET /api/integrations/assure/receipts
```

The contract (auth header, query parameters, envelope, every column name) is
**`API_SPEC_v1.md`** in this folder — written by Assure, implemented verbatim in
`backend/src/routes/integrations.js`. Auth is the shared-secret header `X-Assure-Key`
(`ASSURE_API_KEY` / `ASSURE_API_KEY_NEXT` in the server env — see
`docs/ENVIRONMENTS.md`), not a TMS login. The queries are derived from the reference
SQL in `scripts/export_samples.sh`, so for the same date window the endpoints return
exactly the rows the sample CSVs held; `scripts/verify_assure_api.sh` checks that
plus the rest of the spec's §9 acceptance list against a live host.

The proposed views in `sql/` remain unapplied — the endpoints query the tables
directly.

## Network placement
**Unknown from this environment.** Whether Assure would reach this endpoint over the
public internet, a VPN, or a private peering link is an infrastructure decision outside
what this codebase can answer. `docker-compose.yml`/`docker-compose.qa.yml` show the
app and DB currently sharing a trusted network with SSL off between them
(`db.js` comment), which says nothing about how an external consumer like Assure would
reach the app tier.

## Credential ownership
A business/ops decision outside this codebase — not addressed here.
