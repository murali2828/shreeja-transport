# Shreeja Secondary Transport — Full Codebase Reference

## Database Schema (PostgreSQL)

```sql
-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin','planner','executor')),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tanker Master
CREATE TABLE tankers (
  id SERIAL PRIMARY KEY,
  tanker_number VARCHAR(20) UNIQUE NOT NULL,
  compartments INTEGER NOT NULL CHECK (compartments IN (2,3)),
  capacity_litres INTEGER NOT NULL,
  per_km_rate NUMERIC(8,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- BMCU Master (Bulk Milk Cooling Units)
CREATE TABLE bmcus (
  id SERIAL PRIMARY KEY,
  bmcu_code VARCHAR(10) UNIQUE NOT NULL,
  bmcu_name VARCHAR(100) NOT NULL,
  address TEXT, district VARCHAR(50), state VARCHAR(50), contact VARCHAR(15),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
);

-- Location masters
CREATE TABLE starting_points (id SERIAL PRIMARY KEY, name VARCHAR(100), location TEXT, description TEXT, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE testing_points  (id SERIAL PRIMARY KEY, name VARCHAR(100), location TEXT, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE delivery_points (id SERIAL PRIMARY KEY, name VARCHAR(100), receiver_name VARCHAR(100), location TEXT, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT NOW());

-- Route Masters
CREATE TABLE route_masters (
  id SERIAL PRIMARY KEY,
  route_name VARCHAR(100) NOT NULL,
  start_point_id INTEGER REFERENCES starting_points(id),
  testing_point_id INTEGER REFERENCES testing_points(id),
  delivery_point_id INTEGER REFERENCES delivery_points(id),
  distance_km NUMERIC(8,2),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE route_bmcus (
  id SERIAL PRIMARY KEY,
  route_id INTEGER NOT NULL REFERENCES route_masters(id) ON DELETE CASCADE,
  seq_no INTEGER NOT NULL,
  bmcu_id INTEGER NOT NULL REFERENCES bmcus(id),
  UNIQUE(route_id, seq_no)
);

-- Trip Plans
CREATE TABLE trip_plans (
  id SERIAL PRIMARY KEY,
  plan_date DATE NOT NULL,
  plan_for_date DATE NOT NULL,
  trip_no INTEGER,
  route_id INTEGER REFERENCES route_masters(id),
  tanker_id INTEGER REFERENCES tankers(id),
  start_point_id INTEGER REFERENCES starting_points(id),
  testing_point_id INTEGER REFERENCES testing_points(id),
  delivery_point_id INTEGER REFERENCES delivery_points(id),
  shifts_milk VARCHAR(20),
  expected_km NUMERIC(8,2),
  expected_utilization_pct NUMERIC(6,2),
  expected_total_qty NUMERIC(12,2),
  total_cost NUMERIC(12,2),
  per_liter_cost NUMERIC(8,4),
  driver_name VARCHAR(100), loader_name VARCHAR(100), remarks TEXT,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled')),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE trip_plan_bmcus (
  id SERIAL PRIMARY KEY,
  trip_plan_id INTEGER NOT NULL REFERENCES trip_plans(id) ON DELETE CASCADE,
  seq_no INTEGER NOT NULL,
  bmcu_id INTEGER NOT NULL REFERENCES bmcus(id),
  shift_code VARCHAR(20),
  expected_qty NUMERIC(10,2)
);

-- Trip Executions
CREATE TABLE trip_executions (
  id SERIAL PRIMARY KEY,
  trip_plan_id INTEGER NOT NULL REFERENCES trip_plans(id),
  execution_date DATE NOT NULL,
  dc_number VARCHAR(50),
  actual_km NUMERIC(8,2),
  total_qty_litres NUMERIC(12,2) DEFAULT 0,
  total_qty_kgs NUMERIC(12,4) DEFAULT 0,
  avg_fat NUMERIC(6,4) DEFAULT 0, avg_snf NUMERIC(6,4) DEFAULT 0,
  total_kg_fat NUMERIC(12,4) DEFAULT 0, total_kg_snf NUMERIC(12,4) DEFAULT 0,
  status VARCHAR(30) DEFAULT 'in_progress' CHECK (status IN ('in_progress','saved','pending_ack','closed')),
  executed_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE trip_execution_bmcus (
  id SERIAL PRIMARY KEY,
  execution_id INTEGER NOT NULL REFERENCES trip_executions(id) ON DELETE CASCADE,
  seq_no INTEGER NOT NULL,
  bmcu_id INTEGER NOT NULL REFERENCES bmcus(id),
  milk_date DATE,
  shift VARCHAR(5) CHECK (shift IN ('AM','PM')),
  qty_litres NUMERIC(10,2), qty_kgs NUMERIC(12,4),
  fat_pct NUMERIC(6,3), snf_pct NUMERIC(6,3),
  kg_fat NUMERIC(12,4), kg_snf NUMERIC(12,4),
  description VARCHAR(30) CHECK (description IN ('RMRD','Balance Milk','Internal Shifting')),
  source_bmcu_id INTEGER REFERENCES bmcus(id),
  chamber VARCHAR(5) CHECK (chamber IN ('FC','MC','BC')),
  dps_qty_litres NUMERIC(10,2) DEFAULT 0, dps_qty_kgs NUMERIC(12,4) DEFAULT 0,
  rmrd_qty NUMERIC(10,2) DEFAULT 0,
  is_deleted BOOLEAN DEFAULT FALSE
);

-- Trip Acknowledgements (per chamber)
CREATE TABLE trip_acknowledgements (
  id SERIAL PRIMARY KEY,
  execution_id INTEGER NOT NULL REFERENCES trip_executions(id) ON DELETE CASCADE,
  ack_date DATE,
  chamber VARCHAR(5) NOT NULL CHECK (chamber IN ('FC','MC','BC')),
  qty_litres NUMERIC(10,2), qty_kgs NUMERIC(12,4),
  fat_pct NUMERIC(6,3), snf_pct NUMERIC(6,3),
  kg_fat NUMERIC(12,4), kg_snf NUMERIC(12,4),
  temperature VARCHAR(20), description VARCHAR(50)
);

-- Report email recipients
CREATE TABLE report_email_config (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Backend API Routes

### Auth — `/api/auth`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/login` | None | Returns `{ token, user }` |
| GET | `/me` | Any | Returns current user |
| GET | `/users` | admin | List all users |
| POST | `/users` | admin | Create user |
| PUT | `/users/:id` | admin | Update user |

### Masters — `/api/masters`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET/POST | `/tankers` | any / admin,planner | List or create tanker |
| PUT/DELETE | `/tankers/:id` | admin,planner / admin | Update or soft-delete |
| GET/POST | `/bmcus` | any / admin,planner | List or create BMCU |
| PUT/DELETE | `/bmcus/:id` | admin,planner / admin | Update or soft-delete |
| GET/POST/PUT/DELETE | `/starting-points` | varies | Location masters |
| GET/POST/PUT/DELETE | `/testing-points` | varies | Location masters |
| GET/POST/PUT/DELETE | `/delivery-points` | varies | Location masters |
| GET | `/routes` | any | List routes with joins |
| GET | `/routes/:id` | any | Route + BMCU sequence |
| POST | `/routes` | admin,planner | Create route + BMCUs (transaction) |
| PUT | `/routes/:id` | admin,planner | Update route + replace BMCUs |
| GET/POST/PUT/DELETE | `/email-config` | admin | Report email recipients |

### Plans — `/api/plans`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | any | List plans; filter by `plan_for_date`, `status` |
| GET | `/:id` | any | Plan detail + BMCU sequence |
| POST | `/` | admin,planner | Create plan + BMCUs (calculates cost) |
| PUT | `/:id` | admin,planner | Update plan + replace BMCUs |
| DELETE | `/:id` | admin,planner | Soft-delete (sets status=cancelled) |
| POST | `/publish` | admin,planner | Bulk publish drafts for a date |
| GET | `/template/download` | any | Download Excel upload template |
| POST | `/upload` | admin,planner | Bulk upload plans from Excel |

### Executions — `/api/executions`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | any | List; filter by `status`, `execution_date`, `from_date`, `to_date`, `tanker_id` |
| GET | `/:id` | any | Execution + BMCU rows + acknowledgements |
| POST | `/` | any | Create execution from plan (copies plan BMCUs as RMRD rows) |
| PUT | `/:id` | any | Save BMCU data; recalculates totals (excludes Balance Milk) |
| POST | `/:id/submit-ack` | any | Transitions status: saved → pending_ack |
| POST | `/:id/acknowledgements` | any | Save chamber acks; transitions status → closed |

### Reports — `/api/reports`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/daily-ts` | any | TS variation data (DPS vs Truck vs Ack); params: `from_date`, `to_date` |
| GET | `/bmcu-wise` | any | Per-BMCU breakdown; params: `from_date`, `to_date` |
| GET | `/daily-ts/excel` | any | Download Excel TS report; param: `report_date` |
| POST | `/send-email` | any | Email TS report to all active recipients; body: `{ report_date }` |

---

## Frontend API Client (`frontend/src/api/index.js`)

All calls use a single Axios instance with base URL `/api`. Token is auto-attached via request interceptor. 401 responses auto-redirect to `/login`.

```js
// Auth
login(data), getMe(), getUsers(), createUser(data), updateUser(id, data)

// Masters
getTankers(), createTanker(d), updateTanker(id, d), deleteTanker(id)
getBmcus(), createBmcu(d), updateBmcu(id, d), deleteBmcu(id)
getStartingPoints(), createStartingPoint(d), updateStartingPoint(id, d), deleteStartingPoint(id)
getTestingPoints(), createTestingPoint(d), updateTestingPoint(id, d), deleteTestingPoint(id)
getDeliveryPoints(), createDeliveryPoint(d), updateDeliveryPoint(id, d), deleteDeliveryPoint(id)
getRoutes(), getRoute(id), createRoute(d), updateRoute(id, d)
getEmailConfig(), createEmailConfig(d), updateEmailConfig(id, d), deleteEmailConfig(id)

// Plans
getPlans(params), getPlan(id), createPlan(d), updatePlan(id, d), deletePlan(id)
publishPlans(plan_for_date), uploadPlans(formData)

// Executions
getExecutions(params), getExecution(id), createExecution(d), updateExecution(id, d)
submitForAck(id), saveAcknowledgements(id, d)

// Reports
getDailyTSReport(params), getBmcuWiseReport(params)
sendDailyReport(report_date), downloadTSExcel(report_date)
```

---

## Frontend Route Structure (`frontend/src/App.jsx`)

```
/login                              → Login (public)
/                                   → Dashboard (any logged-in user)
/masters/tankers                    → TankerMaster        [admin, planner]
/masters/bmcus                      → BmcuMaster          [admin, planner]
/masters/routes                     → RouteMaster         [admin, planner]
/masters/locations                  → LocationMasters     [admin, planner]
/masters/users                      → UserManagement      [admin]
/masters/email-config               → EmailConfig         [admin]
/planning                           → TripPlanList        [admin, planner]
/planning/new                       → TripPlanForm        [admin, planner]
/planning/:id/edit                  → TripPlanForm        [admin, planner]
/execution                          → ExecutionList       [all]
/execution/:id                      → ExecutionForm       [all]
/execution/:id/acknowledge          → AcknowledgementForm [all]
/execution/closed                   → ClosedTrips         [all]
/reports                            → DailyTSReport       [all]
```

---

## Environment Variables (`backend/.env`)

```
PORT=5000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=dairy_transport
DB_USER=postgres
DB_PASSWORD=...
JWT_SECRET=...
JWT_EXPIRES_IN=8h
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...        # Gmail App Password (not account password)
SMTP_FROM=Dairy Transport <...>
FRONTEND_URL=http://localhost:5173
```
