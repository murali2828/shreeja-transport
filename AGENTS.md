# AGENTS.md

See [CLAUDE.md](./CLAUDE.md) for the full project guide (stack, architecture, conventions,
workflow, decisions). The two sections below are mirrored from it so any agent tooling that
reads this file gets the essentials; keep them in sync when CLAUDE.md changes.

## Commands
- Backend syntax check: `node -c backend/src/app.js` (repeat per changed `.js`; CI walks all of `src/`)
- Frontend build: `cd frontend && npx vite build --logLevel error` (needs `npm ci` once)
- Local dev: `cd backend && npm run dev` (port 5000) · `cd frontend && npm run dev` (5173, proxies `/api`)
- Migrations locally: `cd backend && npm run migrate`
- QA deploy (operator, on server): `docker compose -p shreeja-qa -f docker-compose.qa.yml --env-file .env.qa up -d --build`
- PROD deploy (operator, on server): `docker compose -p shreeja-transport -f docker-compose.yml --env-file .env up -d --build`
- Nobody runs docker/psql from the dev sandbox; the operator runs server commands
- There is no automated test suite; do not invent test commands

## Must-not-break rules
- Never edit an applied migration; add a new `NNN_name.sql` (next: 044); migrations run in a transaction each
- `KG_FACTOR = 1.0285` (litres→kg) is shared with Assure — change only in lockstep, never silently
- Billing is fortnightly (1–15 / 16–end); billing date = `plan_for_date + BILLING_DATE_OFFSET_DAYS`; ack cutoff 23:59:59; honour `BILLING_CARRY_FORWARD_FLOOR`
- Sale tankers (`trip_plans.is_sale_tanker` OR tanker number `SALE%`, `utils/saleTanker.js`) stay out of vendor billing and utilisation
- One live (non-cancelled) execution per plan (unique index, migration 043); closed trips change only via change requests
- Trips already in a billing run are frozen; GET requests must never mutate approvals
- Assure API column aliases are a contract (`docs/assure-handover/API_SPEC_v1.md`); keys/tokens are never logged or returned
- Admin bypass in `authorizeModule` must stay hardcoded; `JWT_SECRET` ≥ 32 chars
- Don't touch `main` directly; `.env*` real files are never committed

## Workflow in one line
Develop on `qa` → push `origin qa` → user UATs on qatms.shreejamilk.com → fast-forward `qa` into `main` → operator deploys PROD. Details: [docs/WORKFLOW.md](./docs/WORKFLOW.md).
