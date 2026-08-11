-- Vendor payment billing: biller role + fortnightly billing runs with a
-- three-level email approval chain (L1 → L2 → L3) and per-trip pricing from
-- tanker_rates (state × capacity KL × transport type, by planning date).

-- 1. Allow the new 'biller' role (and legalise 'viewer', which the app already
--    uses but the original CHECK never included).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','planner','executor','viewer','biller'));

-- 2. Billing runs (one per fortnight execution by the biller)
CREATE TABLE IF NOT EXISTS billing_runs (
  id              SERIAL PRIMARY KEY,
  from_date       DATE NOT NULL,
  to_date         DATE NOT NULL,
  status          VARCHAR(15) NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','pending_l1','pending_l2','pending_l3','approved','rejected')),
  total_amount    NUMERIC(14,2),
  created_by      INTEGER,
  created_by_name TEXT,
  submitted_at    TIMESTAMPTZ,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Per-trip billing lines
CREATE TABLE IF NOT EXISTS billing_run_trips (
  id              SERIAL PRIMARY KEY,
  run_id          INTEGER NOT NULL REFERENCES billing_runs(id) ON DELETE CASCADE,
  execution_id    INTEGER NOT NULL,
  plan_for_date   DATE,
  tanker_number   TEXT,
  capacity_litres NUMERIC(10,2),
  vendor_id       INTEGER,
  vendor_name     TEXT,
  route_name      TEXT,
  start_point     TEXT,
  delivery_point  TEXT,
  bmcu_count      INTEGER,
  ack_litres      NUMERIC(12,2),
  ack_kgs         NUMERIC(12,2),
  state           VARCHAR(40),                    -- biller-selected (blank until chosen)
  transport_type  VARCHAR(30),                    -- derived: 1 BMCU → Point to Point, else BMCU/CC to Dairy/CC
  system_km       NUMERIC(10,2),                  -- Distance Master + Google legs total
  google_km       NUMERIC(10,2),                  -- portion of system_km fetched from Google
  master_km       NUMERIC(10,2),                  -- portion from Distance Master
  estimated_km    NUMERIC(10,2),                  -- portion estimated (haversine)
  billed_km       NUMERIC(10,2),                  -- biller-editable, defaults to system_km
  legs            JSONB,                          -- [{from_label,to_label,km,source}]
  rate_id         INTEGER,
  rate_per_km     NUMERIC(10,2),
  amount          NUMERIC(14,2),                  -- billed_km × rate_per_km
  remarks         TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_run_trip_unique UNIQUE (run_id, execution_id)
);
CREATE INDEX IF NOT EXISTS idx_brt_run ON billing_run_trips (run_id);

-- 4. Approval chain (3 sequential levels, token links for no-login decisions)
CREATE TABLE IF NOT EXISTS billing_run_approvals (
  id              SERIAL PRIMARY KEY,
  run_id          INTEGER NOT NULL REFERENCES billing_runs(id) ON DELETE CASCADE,
  level           INTEGER NOT NULL CHECK (level IN (1,2,3)),
  approver_email  TEXT NOT NULL,
  token           TEXT UNIQUE NOT NULL,
  status          VARCHAR(10) NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting','pending','approved','rejected')),
  remarks         TEXT,
  decided_at      TIMESTAMPTZ,
  CONSTRAINT billing_approval_unique UNIQUE (run_id, level)
);
