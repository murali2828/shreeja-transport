# Shreeja TMS — milk-tanker Transport Management System (planning → execution → acknowledgement → vendor billing)

## Stack
- Backend: Node 20, Express 4, node-postgres (`pg`) with raw parameterised SQL, no ORM — `backend/`
- Frontend: React 18 + Vite 5 + Tailwind 3 + TanStack Query v5 + axios — `frontend/`
- DB: Postgres 16; SQL migrations in `backend/migrations/` auto-run at backend start (latest: 045)
- Deploy: Docker Compose (db + backend + frontend/nginx), two stacks on one server (QA, PROD)
- No test framework; CI (`.github/workflows/ci.yml`) only syntax-checks backend and builds frontend

## Commands
- Backend syntax check: `node -c backend/src/app.js` (repeat per changed `.js`; CI walks all of `src/`)
- Frontend build: `cd frontend && npx vite build --logLevel error` (needs `npm ci` once)
- Local dev: `cd backend && npm run dev` (port 5000) · `cd frontend && npm run dev` (5173, proxies `/api`)
- Migrations locally: `cd backend && npm run migrate`
- QA deploy (operator, on server): `docker compose -p shreeja-qa -f docker-compose.qa.yml --env-file .env.qa up -d --build`
- PROD deploy (operator, on server): `docker compose -p shreeja-transport -f docker-compose.yml --env-file .env up -d --build`
- Nobody runs docker/psql from the dev sandbox; the operator runs server commands

## Architecture
- `backend/src/app.js` mounts helmet, rate limits, CORS, audit middleware, then one router per module under `/api/*`
- Auth: JWT (8h) in `middleware/auth.js` — `authenticate`, `authorize(roles)`, `authorizeModule`, `authorizeOrModule`; `roles` table holds per-module permissions; admin always bypasses
- `middleware/auditLog.js` records every mutating call to `audit_logs` + field diffs to `data_change_logs`
- Domain flow: trip_plans → trip_executions (one live per plan) → trip_acknowledgements → billing_runs (fortnightly)
- Shared logic lives in `services/` (executionData, distanceLookup, roadDistance, optimizerCore, optimizerV2 + dayOptimizerData, rates, wheelseye, changeTracker)
- Distance cascade: `distance_master` → Google Routes API (cached back) → Haversine × `ROAD_DISTANCE_FACTOR`
- Background jobs: `jobs/docAlerts.js` (document expiry mail), `jobs/wheelseyePoll.js` (GPS every 120s)
- Integrations: Google Routes, WheelsEye GPS, Assure read-only API (`routes/integrations.js`, X-Assure-Key), SMTP
- Frontend: `src/api/index.js` single axios client; `App.jsx` routes with role guards; pages by module
- Detail: @docs/ARCHITECTURE.md

## Conventions
- CommonJS backend, ESM/JSX frontend; 2-space indent, single quotes, semicolons
- Routers own their auth middleware; errors are `res.status(4xx|5xx).json({ error })`; logs prefixed `[module]`
- Dates: DB `DATE` returned as `YYYY-MM-DD` strings (type parser in `config/db.js`); display DD-MM-YYYY; TZ Asia/Kolkata
- Feature flags/tuning via env only (`BILLING_ENABLED`, `OPTIMIZER_V2_ENABLED`, `WHEELSEYE_*`, `BILLING_*`, `OPTIMIZER_*`); no secrets in code
- Detail: @docs/CONVENTIONS.md

## Must-not-break rules
- Never edit an applied migration; add a new `NNN_name.sql` (next: 046); migrations run in a transaction each
- `KG_FACTOR = 1.0285` (litres→kg) is shared with Assure — change only in lockstep, never silently
- Billing is fortnightly (1–15 / 16–end); billing date = `plan_for_date + BILLING_DATE_OFFSET_DAYS`; ack cutoff 23:59:59; honour `BILLING_CARRY_FORWARD_FLOOR`
- Sale tankers (`trip_plans.is_sale_tanker` OR tanker number `SALE%`, `utils/saleTanker.js`) stay out of vendor billing and utilisation
- One live (non-cancelled) execution per plan (unique index, migration 043); closed trips change only via change requests
- Trips already in a billing run are frozen; GET requests must never mutate approvals
- Assure API column aliases are a contract (`docs/assure-handover/API_SPEC_v1.md`); keys/tokens are never logged or returned
- Admin bypass in `authorizeModule` must stay hardcoded; `JWT_SECRET` ≥ 32 chars
- Don't touch `main` directly; `.env*` real files are never committed

## Workflow
- Develop on `qa` → push `origin qa` → user UATs on qatms.shreejamilk.com → fast-forward `qa` into `main` → operator deploys PROD
- Commit early and often, small focused commits, imperative subject; required trailers are given per session
- Before pushing: `node -c` on changed backend files and `npx vite build` for frontend changes
- Detail: @docs/WORKFLOW.md

## Decisions
- @docs/DECISIONS.md

## Current state
- 2026-09-20: `qa` at aec6f90 — billing missing-coordinates check, recalc-distances, migration 043 (one live execution per plan), audit log login id. Billing module live on QA (`BILLING_ENABLED=true`), PROD flag pending sign-off. Backups: interim `deploy/backup.sh` set (see docs/BACKUP_RESTORE_STRATEGY.md).
- Ops docs: @docs/RUNBOOK.md · changes: @docs/CHANGELOG.md · env matrix: @docs/ENVIRONMENTS.md
