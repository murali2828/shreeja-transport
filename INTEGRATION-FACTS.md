# Shreeja TMS — Integration Facts

## 1. Framework & language

- **Backend:** Node.js 20 (Docker image `node:20-alpine`), JavaScript (CommonJS), **Express ^4.18.3**.
- **Frontend:** **React ^18.3.1** (JavaScript/JSX), built with **Vite ^5.2.11**; TanStack Query for data fetching; served as static files by nginx.

## 2. Database & connection

- **PostgreSQL** (Docker `db` service; prod DB `dairy_transport`, QA DB `dairy_transport_qa`).
- Connected via **node-postgres (`pg` ^8.11.3) connection pool** — `backend/src/config/db.js`:
  `new Pool({ host: DB_HOST, port: DB_PORT (5432), database: DB_NAME, user: DB_USER, password: DB_PASSWORD, max: 20 })`.
  Plain parameterized SQL (no ORM); a `query()` helper for single statements, `pool.connect()` for transactions.
- Schema managed by sequential SQL migrations in `backend/migrations/*.sql`, auto-applied at backend startup and tracked in `schema_migrations (filename)`.

## 3. Authentication / login

- **Stateless JWT — no cookies, no server-side sessions.** There are **no cookie names**; nothing is stored in cookies.
- Login: `POST /api/auth/login` with `{ user_id, password }` (`user_id` is an email or handle, e.g. `PP01`; passwords are bcrypt hashes in `users.password_hash`). Response returns a **JWT signed with `JWT_SECRET`** carrying `{ id, role, full_name, must_change_password }`.
- The frontend stores the token in **localStorage** and sends it on every request as **`Authorization: Bearer <token>`** (axios interceptor in `frontend/src/api/index.js`; auto-logout on 401).
- **Middleware:** `backend/src/middleware/auth.js` — `authenticate` (verifies the Bearer token, sets `req.user`) and `authorize(...roles)` (role gate). Roles: `admin`, `planner`, `executor`, `viewer`. Routers apply these per route; a separate app-level audit middleware (`backend/src/middleware/auditLog.js`) logs mutating calls.
- Extras: `must_change_password` forces a password change at first login; forgot/reset uses single-use tokens in `password_reset_tokens`; change-request approval emails use their own single-use token (`execution_change_requests.approval_token`), no login required.

## 4. Relevant table schemas

There are **no employee, department, or MPP tables**. ("MPP" appears only as an entry kind
`new_mpp` in `trip_execution_bmcu_entries`; staff exist only as portal `users`.)

### `users` (001_base_schema.sql + later ALTERs)

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PRIMARY KEY | |
| username | VARCHAR(50) UNIQUE NOT NULL | legacy login field |
| user_id | TEXT | current login identifier (email or handle), added at runtime |
| email | VARCHAR(100) UNIQUE NOT NULL | |
| password_hash | VARCHAR(255) NOT NULL | bcrypt |
| full_name | VARCHAR(100) NOT NULL | |
| role | VARCHAR(20) NOT NULL | admin / planner / executor / viewer |
| must_change_password | BOOLEAN NOT NULL DEFAULT FALSE | migration 006 |
| is_active | BOOLEAN DEFAULT TRUE | |
| created_at | TIMESTAMP DEFAULT NOW() | |

**Foreign keys referencing `users(id)`:**
- `trip_plans.created_by`
- `trip_executions.executed_by`
- `distance_master.created_by`, `distance_master.updated_by`
- `optimization_sessions.created_by`
- `password_reset_tokens.user_id`

Soft references (INTEGER user ids **without** FK constraints, by design so rows survive
user deletion): `trip_executions.updated_by`, `trip_acknowledgements.entered_by`,
`trip_document_prints.printed_by`, `non_trip_gate_passes.issued_by`,
`execution_change_requests.requested_by/decided_by`, `audit_logs.user_id`,
`data_change_logs.user_id`.

### `bmcus` (BMCU master — 001_base_schema.sql + coordinate ALTERs)

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PRIMARY KEY | |
| bmcu_code | VARCHAR(10) UNIQUE NOT NULL | e.g. `3001` — business key |
| bmcu_name | VARCHAR(100) NOT NULL | |
| address | TEXT | |
| district | VARCHAR(50) | |
| state | VARCHAR(50) | |
| contact | VARCHAR(15) | |
| latitude | NUMERIC(11,8) | migrations 002/004 |
| longitude | NUMERIC(11,8) | migrations 002/004 |
| is_active | BOOLEAN DEFAULT TRUE | |
| created_at / updated_at | TIMESTAMP DEFAULT NOW() | |

**Foreign keys referencing `bmcus(id)`:**
- `route_bmcus.bmcu_id` (route master sequence)
- `trip_plan_bmcus.bmcu_id` (planned visit sequence)
- `trip_execution_bmcus.bmcu_id` and `.source_bmcu_id` (execution dispatch rows)
- `trip_execution_bmcu_entries.bmcu_id` and `.source_bmcu_id` (balance/new-MPP/shifting entries)
- `optimization_input_bmcus.bmcu_id`, `optimization_result_bmcus.bmcu_id` (optimizer)

## 5. Subdomain & port

Host nginx reverse-proxies (wildcard `*.shreejamilk.com` TLS, `deploy/reverse-proxy.conf.example`)
to per-environment Docker Compose stacks; inside each stack the frontend nginx serves the SPA
and proxies `/api` to the backend (port 5000 internal).

| Environment | Subdomain | Host port |
|---|---|---|
| Production | **tms.shreejamilk.com** | **8080** → container 80 |
| QA / UAT | **qatms.shreejamilk.com** | **8081** → container 80 |
