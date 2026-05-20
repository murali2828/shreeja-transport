# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Shreeja Secondary Transport** (internally: Dairy Transport Management System) manages secondary milk transport operations — tanker trip planning, daily execution data entry, delivery acknowledgement, and TS (Total Solid) variation reporting.

Default admin login: `admin` / `Admin@1234`

---

## Development Commands

### Backend (Node.js + Express)
```bash
cd backend
cp .env.example .env        # first-time setup; fill in DB credentials and JWT secret
npm install
npm run dev                 # starts with nodemon on port 5000
npm start                   # production start
node src/config/migrate.js  # run database migrations
```

### Frontend (React + Vite)
```bash
cd frontend
npm install
npm run dev     # starts on http://localhost:5173; proxies /api → localhost:5000
npm run build   # outputs to frontend/dist/
```

No test suite is configured. There is no linter configured.

---

## Architecture

### Stack
- **Backend**: Node.js, Express, PostgreSQL (`pg` pool), JWT auth, Multer (Excel upload), XLSX, Nodemailer
- **Frontend**: React 18, React Router v6, TanStack Query v5, Axios, Tailwind CSS, Lucide React icons, react-hot-toast

### Request Flow
1. All frontend API calls go through `frontend/src/api/index.js` — a single Axios instance with base URL `/api`.
2. Vite dev server proxies `/api` → `http://localhost:5000` (see `vite.config.js`).
3. A request interceptor attaches `Authorization: Bearer <token>` from `localStorage`.
4. A response interceptor auto-redirects to `/login` on 401.
5. On the backend, every route (except `/api/auth/login` and `/api/health`) requires the `authenticate` middleware, which verifies the JWT and sets `req.user`.

### Authentication & Roles
JWT tokens (8h expiry) are issued at login and stored in `localStorage`. Three roles control access:

| Role | Backend (`authorize()`) | Frontend (route guards) |
|------|------------------------|------------------------|
| `admin` | All endpoints | All pages |
| `planner` | Masters, Plans, Reports | Masters, Planning, Reports |
| `executor` | Executions, Reports | Execution, Reports, Dashboard |

The frontend `ProtectedRoute` component in `App.jsx` checks `user.role` against a `roles` prop.

### Backend Route Map
```
/api/auth          → routes/auth.js       (login, get-me, user CRUD)
/api/masters       → routes/masters.js    (tankers, BMCUs, routes, locations, email-config)
/api/plans         → routes/plans.js      (trip plan CRUD, publish, Excel upload/template)
/api/executions    → routes/executions.js (execution CRUD, submit-ack, acknowledgements)
/api/reports       → routes/reports.js    (daily-ts, bmcu-wise, Excel export, email send)
```

All DB access goes through `backend/src/config/db.js`, which exports a `pg.Pool` and a `query()` helper. Multi-step writes always use `pool.connect()` with explicit `BEGIN/COMMIT/ROLLBACK`.

### Frontend Page Structure
```
pages/
  Login.jsx
  Dashboard.jsx
  masters/         TankerMaster, BmcuMaster, RouteMaster, LocationMasters, UserManagement, EmailConfig
  planning/        TripPlanList, TripPlanForm
  execution/       ExecutionList, ExecutionForm, AcknowledgementForm, ClosedTrips
  reports/         DailyTSReport
```

### Business Logic — Key Calculations
These are applied in `routes/executions.js` and must match in the frontend:

- **Litres → Kgs**: `kgs = litres × 1.0285`
- **Kg Fat**: `kg_fat = fat_pct × kgs / 100`
- **Kg SNF**: `kg_snf = snf_pct × kgs / 100`
- **Trip cost**: `total_cost = expected_km × per_km_rate` (per-tanker rate)
- **Per-litre cost**: `per_liter_cost = total_cost / expected_total_qty`
- **Utilization %**: `total_qty_litres / tanker.capacity_litres × 100`

`Balance Milk` rows are excluded from execution totals (`trip_execution_bmcus.description`). Soft-deleted rows (`is_deleted=TRUE`) are excluded from all queries.

### Trip Lifecycle (status transitions)
```
trip_plans:      draft → published → cancelled
trip_executions: in_progress → saved → pending_ack → closed
```
Executions are created from published plans; the plan's BMCU sequence is copied as starting rows with `description='RMRD'`. Once `closed`, executions feed into reports.

### Execution BMCU Row Types
Each row in `trip_execution_bmcus` has a `description` field:
- `RMRD` — regular milk collection from a BMCU
- `Balance Milk` — excluded from tonnage totals; tracked separately
- `Internal Shifting` — milk moved between compartments; requires `source_bmcu_id`

Tanker compartments (`FC`/`MC`/`BC` = Front/Middle/Back chamber) are captured per row and per acknowledgement.

### TS Report
The Daily TS (Total Solid) Variation Report (`/api/reports/daily-ts`) compares three sources for closed executions:
1. **DPS** (scale reading) — sum of `trip_execution_bmcus.dps_qty_litres`
2. **Truck Sheet** — `trip_executions.total_qty_litres/kgs/fat/snf`
3. **Acknowledgement** — from `trip_acknowledgements` (per-chamber entries by the receiving plant)

Variations = Acknowledgement − Truck Sheet values.

### Adding New Features
- **New DB columns**: Add to `backend/migrations/` as a new numbered SQL file. Update the relevant route's INSERT/UPDATE queries and the frontend form.
- **New API endpoint**: Add to the appropriate `routes/*.js` file; register auth middleware; export the API call from `frontend/src/api/index.js`.
- **New page**: Create under `frontend/src/pages/`, import in `App.jsx`, add a `<Route>` with appropriate role guard, and add a sidebar link in `frontend/src/components/Sidebar.jsx`.
- **New master entity**: Follow the pattern in `routes/masters.js` (GET all / POST / PUT /:id / DELETE /:id) and the corresponding master page component.
