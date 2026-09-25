# Shreeja TMS — Architecture

Milk-tanker Transport Management System for Shreeja Mahila Milk Producer
Company. It plans tanker trips from BMCUs (bulk milk cooling units) to plants,
records what was actually lifted and delivered, reconciles the variation, and
pays the tanker vendors per kilometre in fortnightly billing runs.

A longer, older narrative lives in the root [`ARCHITECTURE.md`](../ARCHITECTURE.md)
(migrations up to 019); this file is the current map. Environment matrix:
[`ENVIRONMENTS.md`](./ENVIRONMENTS.md). Integration facts for outside teams:
[`INTEGRATION-FACTS.md`](../INTEGRATION-FACTS.md).

## Overview

| Layer | What | Where |
|---|---|---|
| Frontend | React 18 SPA, Vite build, Tailwind, TanStack Query, axios, react-router, Leaflet map, recharts, ExcelJS-free (downloads come from backend) | `frontend/src` |
| Web tier | nginx serves the SPA and proxies `/api/` to `backend:5000` | `frontend/nginx.conf` |
| Backend | Express 4 API, CommonJS, raw parameterised SQL via `pg` Pool (max 20) | `backend/src` |
| DB | Postgres 16 (`postgres:16-alpine`), TZ Asia/Kolkata, statement timeout 60 s | compose `db` service |
| Jobs | in-process `setInterval` schedulers started from `app.js` | `backend/src/jobs` |
| Packaging | Docker Compose; backend image runs `migrate.js` then `app.js` | `docker-compose*.yml`, `backend/Dockerfile` |
| CI | GitHub Actions: backend `node -c` walk + frontend `npm run build` on push/PR to `qa`, `main` | `.github/workflows/ci.yml` |

## Module map (backend)

`backend/src/app.js` order: helmet → rate limiters → CORS (`FRONTEND_URL`) → JSON body (10 MB) →
`/api/health` → `middleware/auditLog` → routers → 404 → error handler.

| Mount | File | Purpose | Auth pattern |
|---|---|---|---|
| `/api/auth` | `routes/auth.js` | login, me, users CRUD, change/forgot/reset password | public login; `authorize('admin')` for users |
| `/api/roles` | `routes/roles.js` | admin-managed roles + per-module permissions (migration 035) | admin |
| `/api/masters` | `routes/masters.js` | tankers, BMCUs, starting/testing/delivery points, route masters, email configs | `authorizeOrModule('masters','admin')` |
| `/api/vendors`, `/api/tanker-rates`, `/api/documents` | own files | vendor master, per-km rates (024), tanker statutory documents + uploads (`UPLOAD_DIR`) | masters module |
| `/api/distances` | `routes/distances.js` | Distance Master CRUD, Excel template/upload, Google refresh | masters module |
| `/api/plans` | `routes/plans.js` | trip plan CRUD, publish, coverage, movement-plan export, plan email config | `authorizeOrModule('planning', ...)` |
| `/api/optimize` | `routes/optimize.js` | Clarke-Wright optimizer sessions (v1), save-as-plans, compare; **Day Optimizer (fleet v2)**: `POST /day`, `GET /day/preview`, `POST /prefetch-distances`, `POST /forecast/backfill` — mounted only when `OPTIMIZER_V2_ENABLED=true` (503 `FEATURE_DISABLED` otherwise) | planning |
| `/api/executions` | `routes/executions.js` | start/save/submit-ack/acknowledge/cancel execution; third-party sales; missed-BMCU remarks | `authorizeOrModule('execution', ...)` |
| `/api/trip-docs` | `routes/tripDocs.js` | gate pass / COA / unloading print logging, non-trip gate passes, Tanker Position dashboard + Excel | execution |
| `/api/change-requests` | `routes/changeRequests.js` | post-closure corrections with approver email + single-use token decision (`POST /decide`) | execution; token for decide |
| `/api/reports`, `/api/analytics` | own files | Daily TS, BMCU breakup, trip durations, day utilisation, analytics KPIs, Excel + email | `authorizeOrModule('reports', ...)` |
| `/api/billing` | `routes/billing.js` | fortnightly vendor billing runs, tolls (FASTag PDF parse), 3-level approval, vendor cards | `authorizeOrModule('billing', admin, biller)`; mounted only when `BILLING_ENABLED=true` |
| `/api/tracking` | `routes/tracking.js` | WheelsEye live positions, poll-now, trip playback analysis, fleet report | execution/admin |
| `/api/audit` | `routes/audit.js` | request + field-level audit logs, Excel | admin |
| `/api/integrations/assure` | `routes/integrations.js` | read-only trips/loadings/receipts feed for Shreeja Assure | `X-Assure-Key` header, not JWT |

Services (`backend/src/services`, no HTTP):

- `executionData.js` — `KG_FACTOR = 1.0285`, `calcKgs/KgFat/KgSnf`, `computeExecutionDistance`, `applyExecutionData` (single write path used by executions and change-request approval).
- `distanceLookup.js` / `roadDistance.js` — Distance Master read/write with pair normalisation (`uq_distance_pair`), Google Routes `computeRouteMatrix` call, master cache for batch jobs.
- `optimizerCore.js` — Clarke-Wright savings optimizer and tanker assignment (v1, also the seed of v2).
- `optimizerV2.js` — Day Optimizer core (DB-free): per-plant Clarke-Wright seed, cost-aware tanker assignment (km × Tanker Rate Master rate by transport type, fill floor, trips per tanker per day), local search (relocate/swap/2-opt/merge/split) with seeded restarts. `scripts/optimizer_v2_selftest.js` exercises it without a DB.
- `dayOptimizerData.js` — builds the v2 instance from the DB: demand forecast (`bmcu_demand_forecast`), plant catchments, fleet availability (open maintenance / without-driver gate passes), rate state per tanker, distance coverage, Google prefetch, comparison with actual plans.
- `rates.js` — Tanker Rate Master lookup (`findRate`, moved from billing; `loadRatesForDate`, `pickRate`, billing-state per tanker) shared by billing and the optimiser.
- `changeTracker.js` — before/after snapshots and field diffs for `data_change_logs`.
- `tripAnalysis.js` — GPS trail vs planned route: stops, geofence visits.
- `wheelseye.js` — WheelsEye `currentLoc` fetch + sync into GPS tables.
- `fastagParser.js` — parses bank FASTag statement PDFs into per-tanker tolls.

Utils: `utils/saleTanker.js` (sale-tanker SQL rule), `utils/geo.js` (Haversine, `ROAD_FACTOR`), `utils/date.js`.

## Module map (frontend)

- `src/api/index.js` — the only axios instance (`baseURL /api`, Bearer token from localStorage, auto-logout on 401) and every API helper.
- `src/App.jsx` — React Router tree; `ProtectedRoute` role/module guards; `hooks/useAuth.jsx` holds the user.
- `src/components` — `Layout`, `Sidebar` (role-aware), `MasterTable` (shared CRUD modal/table), `SearchableSelect`.
- `src/pages` — `masters/`, `planning/`, `execution/` (ExecutionForm, AcknowledgementForm, Approvals, TankerPosition, LiveTracking, NonTripGatePass, ClosedTrips), `billing/` (TankerBilling, BillingDecision), `reports/` (DailyTSReport, BmcuBreakup, TripDurations, DayUtilisation, Analytics, AuditLog), `auth/`, `changeRequests/`.
- `src/utils/printDocs.js` — print-window HTML for gate pass / COA / non-trip gate pass; `utils/date.js` — DD-MM-YYYY display.

## Data flow

```mermaid
flowchart LR
  P[Trip plan<br/>trip_plans + trip_plan_bmcus] -->|publish| E[Execution<br/>trip_executions (one live per plan)]
  E -->|per BMCU litres, fat, SNF| B[trip_execution_bmcus<br/>shifts / entries / third_party_sales]
  E -->|gate pass, COA, unloading prints| D[trip_document_prints<br/>operational timestamps]
  E -->|submit-ack| A[trip_acknowledgements<br/>per chamber FC/MC/BC]
  A -->|closes trip| R[Reports: TS variation, BMCU breakup, durations, utilisation]
  A -->|fortnight run| BR[billing_runs → billing_run_trips<br/>tolls, approvals, vendor cards]
  E -.->|closed trip edits| CR[execution_change_requests<br/>approver email token]
  CR -->|approved| E
  G[Google Routes] --> DM[distance_master] --> E
  W[WheelsEye GPS] --> GPS[tanker_gps_latest / history] --> T[Live Tracking, trip playback]
  E --> AS[/api/integrations/assure/*]
```

Distance cascade for every leg (start → BMCUs in seq → delivery point): Distance Master exact pair →
Google Routes API (`GOOGLE_MAPS_API_KEY`; result cached back into `distance_master` with Google
attribution) → Haversine × `ROAD_DISTANCE_FACTOR` (default 1.3), flagged as estimated.

## Integrations

| Integration | Code | Auth / config | Failure mode |
|---|---|---|---|
| Google Routes API (`computeRouteMatrix`) | `services/roadDistance.js`, `distanceLookup.js`, `routes/distances.js` | `GOOGLE_MAPS_API_KEY` header `X-Goog-Api-Key`; 12 s timeout | returns null → Haversine estimate, `km_estimated_leg_count` |
| WheelsEye GPS | `services/wheelseye.js`, `jobs/wheelseyePoll.js`, `routes/tracking.js` | `WHEELSEYE_ACCESS_TOKEN` query param; `WHEELSEYE_POLL_SECONDS` (min 60), `_FETCH_ADDRESS`, `_STALE_MINUTES`, `_HISTORY_DAYS`; tracking geofence vars | poller disabled without token; `GET /api/tracking/status` shows lastError |
| Shreeja Assure (outbound feed) | `routes/integrations.js`, spec `assure-handover/API_SPEC_v1.md` | `ASSURE_API_KEY` (+ `_NEXT` for rotation), `ASSURE_ALLOWED_IPS`, `TMS_GIT_SHA`; constant-time compare; 120 req/min per IP | 503 FEATURE_DISABLED without a key |
| SMTP mail | `config/mailer.js` (nodemailer), used by reports, billing, change requests, docAlerts, password reset | `SMTP_HOST/PORT/SECURE/USER/PASS/FROM`; QA divert `BILLING_EMAIL_REDIRECT` (billing mails only) | send errors logged per caller; there is no global redirect — non-billing mail on QA goes to real recipients unless QA uses a test inbox |
| FASTag statement PDFs | `services/fastagParser.js` (pdf-parse) | upload via billing tolls endpoint | parse failures reported to biller |

## Data model summary

Tables (from `backend/migrations/001`–`044`), grouped:

- **Identity**: `users` (login `user_id`, bcrypt `password_hash`, `role`, `is_active`, `must_change_password`), `roles` (name, `permissions` JSON per module: masters/planning/execution/billing/reports), `password_reset_tokens` (created at runtime by `routes/auth.js`, not by a migration).
- **Masters**: `tankers` (capacity, chambers, vendor, rates), `vendors`, `tanker_rates` (per-km by state/type), `tanker_documents`, `bmcus` (lat/lng, 044: `chilling_capacity_litres`, `lift_policy`), `starting_points`, `testing_points`, `delivery_points`, `route_masters` + `route_bmcus`, `distance_master` (unique normalised pair, `distance_km`, `google_km`), `report_email_config`, `plan_email_configs`, `app_settings` (e.g. vendor-email toggle).
- **Planning**: `trip_plans` (`plan_for_date`, tanker, route, start/delivery points, expected km/cost, `is_sale_tanker`, status draft/published/cancelled/deleted, `created_by`), `trip_plan_bmcus`, optimizer tables `optimization_sessions/inputs/trips/trip_bmcus` (044: `algorithm`, `constraints`, `shift_scope`, `comparison`, `summary` on sessions; per-trip `delivery_point_id`, `start_point_id`, `transport_type`, `rate_state`, `flags`), `bmcu_demand_forecast` (044: forecast + actual litres per BMCU × shift × date).
- **Execution**: `trip_executions` (status in_progress→saved→pending_ack→closed, or cancelled; unique live per plan), `trip_execution_bmcus`, `trip_execution_bmcu_shifts`, `trip_execution_bmcu_entries` (balance milk, new MPP, internal shifting raw/chilled), `trip_third_party_sales`, `trip_acknowledgements` (per chamber, `entered_by`), `bmcu_missed_remarks`, `trip_document_prints`, `non_trip_gate_passes`.
- **Billing**: `billing_runs` (fortnight from/to, status), `billing_run_trips` (billed km, rate, amount, legs JSON, `carried_forward`), `billing_run_tolls`, `billing_run_approvals` (3 levels, email tokens).
- **Governance**: `execution_change_requests`, `audit_logs`, `data_change_logs`, `schema_migrations`.
- **Tracking**: `tanker_gps_latest`, `tanker_gps_history` (pruned to `WHEELSEYE_HISTORY_DAYS`).

Key relationships: `trip_plans.tanker_id → tankers`, `trip_executions.trip_plan_id → trip_plans`,
`trip_execution_bmcus.execution_id → trip_executions`, `trip_acknowledgements.execution_id`,
`billing_run_trips.(run_id, execution_id)` (NOT VALID FKs, migration 036), `tankers.vendor_id → vendors`.
Soft (non-FK) integer user references are deliberate so rows survive user deletion.

## Environments

| | PROD | QA |
|---|---|---|
| URL / branch | tms.shreejamilk.com / `main` | qatms.shreejamilk.com / `qa` |
| Compose | `docker-compose.yml`, `.env`, project `shreeja-transport` | `docker-compose.qa.yml`, `.env.qa`, project `shreeja-qa` |
| Host port → nginx | 127.0.0.1:8080 | 127.0.0.1:8081 |
| DB / volumes | `dairy_transport`, `shreeja-pgdata`, `shreeja-docuploads` | `dairy_transport_qa`, `shreeja-qa-pgdata`, `shreeja-qa-docuploads` |
| Billing module | `BILLING_ENABLED=true` since Aug 2026 (parallel run with the transport billing team, Sep 2026) | `BILLING_ENABLED=true` |

Host nginx (`deploy/reverse-proxy.conf.example`) terminates TLS for both domains. Full detail in
[`ENVIRONMENTS.md`](./ENVIRONMENTS.md).
