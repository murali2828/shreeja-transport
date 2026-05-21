-- =============================================================================
-- Migration 002: Distance Master + Route Optimizer Tables
-- Run: psql -U postgres -d dairy_transport -f 002_distance_and_optimizer.sql
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. NODE TYPES
--    A "node" is anything a tanker can start from, visit, or end at:
--    bmcu | starting_point | delivery_point | testing_point
-- ─────────────────────────────────────────────────────────────────────────────

-- 2. DISTANCE MASTER
--    Stores planner-entered road distances between any two nodes.
--    symmetric: dist(A→B) = dist(B→A), so we store only one row per pair.
CREATE TABLE IF NOT EXISTS distance_master (
  id              SERIAL PRIMARY KEY,
  from_type       VARCHAR(20) NOT NULL CHECK (from_type IN ('bmcu','starting_point','delivery_point','testing_point')),
  from_id         INTEGER NOT NULL,
  to_type         VARCHAR(20) NOT NULL CHECK (to_type IN ('bmcu','starting_point','delivery_point','testing_point')),
  to_id           INTEGER NOT NULL,
  distance_km     NUMERIC(8,2) NOT NULL CHECK (distance_km >= 0),
  -- optional: road type for planner notes
  road_notes      VARCHAR(200),
  created_by      INTEGER REFERENCES users(id),
  updated_by      INTEGER REFERENCES users(id),
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW(),
  -- enforce uniqueness both directions
  CONSTRAINT uq_distance_pair CHECK (
    (from_type, from_id) < (to_type, to_id)
    OR (from_type = to_type AND from_id < to_id)
  )
);

-- Partial unique index: only one row per (from_type,from_id,to_type,to_id) pair
-- We normalise so that from_type/from_id is always lexicographically ≤ to_type/to_id
CREATE UNIQUE INDEX IF NOT EXISTS uq_distance_master
  ON distance_master (from_type, from_id, to_type, to_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. OPTIMIZATION SESSIONS
--    One row per optimizer run (keeps history)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS optimization_sessions (
  id                  SERIAL PRIMARY KEY,
  plan_for_date       DATE NOT NULL,
  delivery_point_id   INTEGER REFERENCES delivery_points(id),
  start_point_id      INTEGER REFERENCES starting_points(id),
  shifts_milk         VARCHAR(20),
  strategy            VARCHAR(30) NOT NULL DEFAULT 'distance_savings'
                      CHECK (strategy IN ('distance_savings','best_fit','cheapest','district')),
  input_bmcu_count    INTEGER NOT NULL DEFAULT 0,
  input_total_qty     NUMERIC(12,2) NOT NULL DEFAULT 0,
  result_trip_count   INTEGER,
  result_total_km     NUMERIC(12,2),
  result_total_cost   NUMERIC(12,2),
  km_coverage_pct     NUMERIC(5,1),   -- % of BMCU pairs that had real distances
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','completed','saved_as_plans','dismissed')),
  created_by          INTEGER REFERENCES users(id),
  created_at          TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. OPTIMIZATION INPUTS  (which BMCUs + quantities were fed in)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS optimization_inputs (
  id                    SERIAL PRIMARY KEY,
  session_id            INTEGER NOT NULL REFERENCES optimization_sessions(id) ON DELETE CASCADE,
  bmcu_id               INTEGER NOT NULL REFERENCES bmcus(id),
  expected_qty_litres   NUMERIC(10,2) NOT NULL DEFAULT 0,
  shift_code            VARCHAR(20)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. OPTIMIZATION TRIPS  (one row per proposed tanker trip)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS optimization_trips (
  id                   SERIAL PRIMARY KEY,
  session_id           INTEGER NOT NULL REFERENCES optimization_sessions(id) ON DELETE CASCADE,
  trip_seq             INTEGER NOT NULL,
  tanker_id            INTEGER REFERENCES tankers(id),
  tanker_number        VARCHAR(20),
  capacity_litres      INTEGER,
  per_km_rate          NUMERIC(8,2),
  total_qty_litres     NUMERIC(12,2),
  utilization_pct      NUMERIC(6,2),
  estimated_km         NUMERIC(10,2),
  estimated_cost       NUMERIC(12,2),
  per_liter_cost       NUMERIC(8,4),
  km_is_estimated      BOOLEAN DEFAULT FALSE,  -- TRUE if any leg used fallback km
  accepted             BOOLEAN DEFAULT TRUE,
  converted_to_plan_id INTEGER REFERENCES trip_plans(id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. OPTIMIZATION TRIP BMCUs  (ordered BMCU sequence per trip)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS optimization_trip_bmcus (
  id                    SERIAL PRIMARY KEY,
  opt_trip_id           INTEGER NOT NULL REFERENCES optimization_trips(id) ON DELETE CASCADE,
  seq_no                INTEGER NOT NULL,
  bmcu_id               INTEGER NOT NULL REFERENCES bmcus(id),
  expected_qty_litres   NUMERIC(10,2),
  leg_km                NUMERIC(8,2),       -- km from previous stop to this stop
  leg_is_estimated      BOOLEAN DEFAULT FALSE
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_distance_from   ON distance_master(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_distance_to     ON distance_master(to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_opt_sess_date   ON optimization_sessions(plan_for_date);
CREATE INDEX IF NOT EXISTS idx_opt_trips_sess  ON optimization_trips(session_id);
CREATE INDEX IF NOT EXISTS idx_opt_tbmcu_trip  ON optimization_trip_bmcus(opt_trip_id);
CREATE INDEX IF NOT EXISTS idx_opt_inputs_sess ON optimization_inputs(session_id);
