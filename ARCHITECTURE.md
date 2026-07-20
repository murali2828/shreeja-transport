# Shreeja TMS — Architecture

Transport Management System for milk tanker logistics at Shreeja Mahila Milk
Producer Company: trip planning, route optimization, trip execution (BMCU milk
collection → dispatch → acknowledgement), gate pass / COA documents, approvals,
and reconciliation reporting.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 (Vite build), react-router, TanStack Query, Tailwind-style utility CSS, lucide-react icons, react-hot-toast |
| Backend | Node.js 20, Express 4 |
| Database | PostgreSQL (pg pool) |
| Excel exports | ExcelJS (styled workbooks); xlsx/SheetJS for uploads |
| Email | nodemailer over SMTP (`SMTP_*` env vars) |
| External API | Google Routes API `computeRouteMatrix` (road distances; optional via `GOOGLE_MAPS_API_KEY`) |
| Packaging | Docker Compose: `frontend` (nginx serving Vite build + `/api` proxy to backend), `backend`, `db` (Postgres) |
| CI | GitHub Actions (`.github/workflows/ci.yml`) — builds both apps on push |

## Environments & branching

Two isolated Compose stacks on one server, fronted by host nginx with a
wildcard `*.shreejamilk.com` certificate (`deploy/reverse-proxy.conf.example`):

| Env | Branch | URL | Checkout | Stack | DB |
|---|---|---|---|---|---|
| Production | `main` | tms.shreejamilk.com | `~/shreeja-transport` | default compose project, port 8080 | `dairy_transport` |
| QA / UAT | `qa` | qatms.shreejamilk.com | `~/shreeja-qa` | `-p shreeja-qa --env-file .env.qa -f docker-compose.qa.yml`, port 8081 | `dairy_transport_qa` (volume `shreeja-qa-pgdata`) |

**Workflow:** all changes land on `qa` first and deploy to QA for UAT;
`main` is only fast-forwarded from `qa` on explicit promotion. See
`docs/ENVIRONMENTS.md`.

## Backend layout (`backend/`)

- `src/app.js` — Express app; mounts audit middleware then routers (below).
- `src/config/db.js` — pg `Pool` + `query()` helper (use `pool.connect()` for transactions).
- `src/config/migrate.js` — runs `migrations/*.sql` in filename order on
  container start (backend Dockerfile: migrate then app); applied files are
  tracked in `schema_migrations (filename)`.
- `src/middleware/`
  - `auth.js` — `authenticate` (JWT) and `authorize(role)`.
  - `auditLog.js` — app-level request audit + field-level change capture (see Auditing).
- `src/services/` (shared logic, no HTTP):
  - `executionData.js` — `applyExecutionData()` shared write path for execution
    saves and change-request approvals; `calcKgs/calcKgFat/calcKgSnf`
    (`KG_FACTOR = 1.0285` litres→kgs); totals recalc.
  - `changeTracker.js` — before/after snapshots + generic differ feeding
    `data_change_logs` (field-level change history).
  - `optimizerCore.js` — Clarke-Wright savings optimizer, distance map,
    tanker assignment (used by `/api/optimize` and `scripts/compare-plan-report.js`).
  - `distanceLookup.js` / `roadDistance.js` — distance cascade:
    `distance_master` → Google Routes API (result cached back into
    `distance_master`) → Haversine × `ROAD_DISTANCE_FACTOR` (1.3, `utils/geo.js`).
- `scripts/` — operational one-offs: `compare-plan-report.js` (manual vs
  optimized plan analysis), `import_masters.js`, `data/*.sql` (auditable data loads).

## Frontend layout (`frontend/src/`)

- `api/index.js` — single axios instance (`/api` base) with JWT header
  interceptor and auto-logout on 401; all API helpers live here.
- `App.jsx` — routes (React Router) with `ProtectedRoute` role guards;
  `components/Sidebar.jsx` — role-aware navigation.
- `pages/` — by module: `masters/`, `planning/`, `execution/` (incl.
  `ExecutionForm`, `Approvals`, `NonTripGatePass`, `TankerPosition`),
  `reports/` (`DailyTSReport`, `BmcuBreakup`, `TripDurations`,
  `DayUtilisation`, `AuditLog`).
- `utils/printDocs.js` — print-window HTML generators for the Gate Pass,
  COA / Milk Dispatch Voucher and non-trip gate pass (DUPLICATE banner on reprints).

## Authentication & authorization

- **Login:** `POST /api/auth/login` with `user_id` (email or handle, e.g. `PP01`)
  + password (bcrypt hashes in `users`). Returns a JWT (`JWT_SECRET`) carrying
  `{ id, role, full_name }` and the user object. `must_change_password` forces
  a password change on first login; forgot/reset flows use single-use emailed tokens.
- **Per-request:** frontend sends `Authorization: Bearer <token>`;
  `authenticate` verifies and sets `req.user`; `authorize('admin')` gates
  admin-only routes (user management, audit logs).
- **Roles:** `admin`, `planner`, `executor`, `viewer` — enforced server-side
  per route and mirrored in the sidebar/route guards client-side.
- **Special principals:** change-request approver = user with
  `user_id = CHANGE_APPROVER_ID` (default `PP01`); Tanker Position dashboard
  is visible to admins + a small allow-list of user IDs.
- **Token-authenticated email links:** change-request approve/reject links use
  a single-use `approval_token` (no login); the token is nulled once decided.

## Database (PostgreSQL)

Migrations `001`–`019` (auto-applied). Main table groups:

- **Masters:** `users`, `tankers` (capacity, chambers, `rate_per_km_bmcu` /
  `rate_per_km_p2p`), `bmcus` (+ latitude/longitude), `starting_points`,
  `testing_points`, `delivery_points`, `route_masters`, `vendors`,
  `tanker_documents` (+ expiry alert recipients), `distance_master`,
  `report_email_config` / plan email config.
- **Planning:** `trip_plans` (planning date, tanker, route, points, expected
  qty/km/cost, status draft→published/cancelled/deleted), `trip_plan_bmcus`.
- **Execution:** `trip_executions` (status in_progress→saved→pending_ack→closed,
  actual/calculated km, totals), `trip_execution_bmcus` (per-BMCU dispatch row:
  qty/fat/snf/kg values, chamber(s), description RMRD/Balance Milk/Internal
  Shifting), `trip_execution_bmcu_shifts` (RMRD per shift), 
  `trip_execution_bmcu_entries` (balance_milk Left Over/Lifted, new_mpp,
  internal_shifting with source plant), `trip_acknowledgements` (per chamber).
- **Governance:** `execution_change_requests` (post-closure corrections:
  JSONB snapshot + proposed changes, PP01 approval, single-use token),
  `audit_logs` (request-level), `data_change_logs` (field-level old→new).
- **Documents/timing:** `trip_document_prints` (gate_pass / coa / unloading —
  first record per type is the operational timestamp: trip start, arrival,
  unloading complete), `non_trip_gate_passes` (reason, issuing delivery point,
  RMT km/rates).

## API surface (all under `/api`, JWT unless noted)

| Mount | Purpose |
|---|---|
| `/auth` | login (public), me, users CRUD (admin), password change/forgot/reset |
| `/masters` | tankers, BMCUs, starting/testing/delivery points, routes, email config |
| `/plans` | trip plan CRUD, `/coverage`, publish, Excel template/upload, plan email config |
| `/executions` | execution lifecycle, PUT save (via `applyExecutionData`), `/coverage`, `/:id/distance`, submit-ack, acknowledgements (closes trip), cancel |
| `/reports` | `daily-ts` (+excel, send-email), `bmcu-breakup` (+excel), `trip-durations` (+excel), `day-utilisation` (+excel), `bmcu-wise` (raw rows) |
| `/distances` | Distance Master CRUD, summary, template/export/upload |
| `/optimize` | run Clarke-Wright optimizer, save-as-plans, sessions, compare |
| `/vendors`, `/documents` | vendor master; tanker documents + expiry alerts |
| `/audit` | admin-only: request log, `/changes` field-level history, filters, Excel exports |
| `/change-requests` | create (on closed trips), list/detail, portal approve/reject, `GET /decide` (token-authenticated email link, no JWT) |
| `/trip-docs` | print logging: `/:planId/print` (gate_pass/coa/unloading with ordering rules), `/status`, `/non-trip` gate passes, `/tanker-position` live dashboard |

Conventions: routers own their auth; mutating requests are audited centrally;
Excel endpoints stream ExcelJS workbooks; reports are computed from execution
tables at request time (no denormalized report storage).

## Auditing & change control

- `auditLog.js` records every mutating `/api` call (user, module, action,
  entity id, sanitized body — passwords/tokens stripped) into `audit_logs`,
  fire-and-forget. For known entities it also snapshots before/after via
  `changeTracker.js` and writes per-field rows to `data_change_logs`.
- Closed trips are immutable except through **change requests**: staged JSONB
  diff → email to the approver (approve/reject links + portal Approvals page) →
  on approval applied via `applyExecutionData` and logged; stakeholders get an
  information-only summary email after approval.

## Operational timestamps (document prints)

Portal-printed documents double as event capture:
`gate pass` first print = trip start → `COA` first print = arrived at delivery
point → `unloading` click = unloading complete → same tanker's next gate pass =
departed after cleaning. These drive the Trip Durations report (round trip,
unloading, cleaning, in-plant totals) and the live Tanker Position dashboard.
Reprints are allowed but marked DUPLICATE; first timestamps are immutable.
