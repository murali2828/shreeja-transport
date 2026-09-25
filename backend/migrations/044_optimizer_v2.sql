-- Migration 044: Day Optimizer (fleet v2) — docs/OPTIMISATION_PLAN.md §3.1/§3.2.
-- Business reason: plan a whole day for all BMCUs across all plants with the
-- whole fleet, minimising Σ km × per-km rate of the tanker that drives each
-- trip. Needs (1) a demand forecast per BMCU × shift, (2) BMCU chilling /
-- lifting policy fields for the later lifting advisor, (3) session columns to
-- store the algorithm, constraints and comparison, and (4) a per-trip delivery
-- point so multi-plant sessions can reuse the existing save-as-plans flow.

-- 1. Demand forecast per BMCU × shift × date (actual_litres filled by backfill)
CREATE TABLE IF NOT EXISTS bmcu_demand_forecast (
  id              SERIAL PRIMARY KEY,
  forecast_date   DATE NOT NULL,
  bmcu_id         INTEGER NOT NULL REFERENCES bmcus(id),
  shift           VARCHAR(5) NOT NULL CHECK (shift IN ('AM','PM')),
  forecast_litres NUMERIC(10,2) NOT NULL DEFAULT 0,
  method          VARCHAR(30),          -- weighted_14d | avg_60d | plan_qty | override | none
  actual_litres   NUMERIC(10,2),        -- RMRD litres once the trip is executed
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW(),
  CONSTRAINT uq_bmcu_demand_forecast UNIQUE (forecast_date, bmcu_id, shift)
);
CREATE INDEX IF NOT EXISTS idx_bmcu_demand_forecast_date ON bmcu_demand_forecast (forecast_date);

-- 2. BMCU chilling capacity and lifting policy (used by the lifting advisor)
ALTER TABLE bmcus ADD COLUMN IF NOT EXISTS chilling_capacity_litres NUMERIC(10,2);
ALTER TABLE bmcus ADD COLUMN IF NOT EXISTS lift_policy VARCHAR(20) DEFAULT 'twice_daily';
ALTER TABLE bmcus DROP CONSTRAINT IF EXISTS bmcus_lift_policy_check;
ALTER TABLE bmcus ADD CONSTRAINT bmcus_lift_policy_check
  CHECK (lift_policy IS NULL OR lift_policy IN ('twice_daily','daily','alternate_days'));

-- 3. Optimizer sessions: algorithm + constraints + comparison; fleet sessions
--    span several plants so delivery_point_id becomes nullable (it already is —
--    001 declared it without NOT NULL; kept explicit for clarity).
ALTER TABLE optimization_sessions ADD COLUMN IF NOT EXISTS algorithm   VARCHAR(20) DEFAULT 'v1';
ALTER TABLE optimization_sessions ADD COLUMN IF NOT EXISTS constraints JSONB;
ALTER TABLE optimization_sessions ADD COLUMN IF NOT EXISTS shift_scope VARCHAR(10);
ALTER TABLE optimization_sessions ADD COLUMN IF NOT EXISTS comparison  JSONB;
ALTER TABLE optimization_sessions ADD COLUMN IF NOT EXISTS summary     JSONB;
ALTER TABLE optimization_sessions ALTER COLUMN delivery_point_id DROP NOT NULL;
-- v2 stores a strategy the 002 CHECK did not know
ALTER TABLE optimization_sessions DROP CONSTRAINT IF EXISTS optimization_sessions_strategy_check;
ALTER TABLE optimization_sessions ADD CONSTRAINT optimization_sessions_strategy_check
  CHECK (strategy IN ('distance_savings','best_fit','cheapest','district','fleet_v2'));

-- 4. Per-trip plant (and start point) so save-as-plans can create plans for
--    several plants out of one session.
ALTER TABLE optimization_trips ADD COLUMN IF NOT EXISTS delivery_point_id INTEGER REFERENCES delivery_points(id);
ALTER TABLE optimization_trips ADD COLUMN IF NOT EXISTS start_point_id    INTEGER REFERENCES starting_points(id);
ALTER TABLE optimization_trips ADD COLUMN IF NOT EXISTS transport_type    VARCHAR(30);
ALTER TABLE optimization_trips ADD COLUMN IF NOT EXISTS rate_state        VARCHAR(40);
ALTER TABLE optimization_trips ADD COLUMN IF NOT EXISTS flags             JSONB;
ALTER TABLE optimization_trips ADD COLUMN IF NOT EXISTS shift_code        VARCHAR(5);
