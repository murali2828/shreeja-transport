-- 026: Performance indexes from the 2026-08 audit.
-- Covers the hottest join/filter paths in reports, analytics and billing.

-- The single most-used join in the app (reports, analytics, billing, executions)
CREATE INDEX IF NOT EXISTS idx_trip_exec_plan ON trip_executions (trip_plan_id);

-- Acknowledgements: joined/subqueried by execution everywhere; the by-ack-entry
-- TS report drives on created_at::date (expression index — the plain created_at
-- index from 021 is unusable under the cast).
CREATE INDEX IF NOT EXISTS idx_ta_exec         ON trip_acknowledgements (execution_id);
CREATE INDEX IF NOT EXISTS idx_ta_created_date ON trip_acknowledgements ((created_at::date));
CREATE INDEX IF NOT EXISTS idx_ta_ack_date     ON trip_acknowledgements (ack_date);

-- Shift rows: joined by execution (+ bmcu_seq_no) in every report/analytics CTE
CREATE INDEX IF NOT EXISTS idx_tebs_exec_seq ON trip_execution_bmcu_shifts (execution_id, bmcu_seq_no);

-- BMCU rows: always filtered execution_id + is_deleted=FALSE
CREATE INDEX IF NOT EXISTS idx_teb_exec_live
  ON trip_execution_bmcus (execution_id, seq_no) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_teb_bmcu ON trip_execution_bmcus (bmcu_id);

-- Billing: carry-forward anti-join (NOT EXISTS on execution_id) currently seq-scans;
-- report filters group by date/tanker/vendor.
CREATE INDEX IF NOT EXISTS idx_brt_exec   ON billing_run_trips (execution_id);
CREATE INDEX IF NOT EXISTS idx_brt_date   ON billing_run_trips (plan_for_date);
CREATE INDEX IF NOT EXISTS idx_brt_tanker ON billing_run_trips (tanker_number);
CREATE INDEX IF NOT EXISTS idx_brt_vendor ON billing_run_trips (vendor_id);

-- Trip plans: combined date+status filter plus FK filters used by analytics
CREATE INDEX IF NOT EXISTS idx_trip_plans_date_status ON trip_plans (plan_for_date, status);
CREATE INDEX IF NOT EXISTS idx_trip_plans_tanker ON trip_plans (tanker_id);
CREATE INDEX IF NOT EXISTS idx_trip_plans_route  ON trip_plans (route_id);
CREATE INDEX IF NOT EXISTS idx_trip_plans_dp     ON trip_plans (delivery_point_id);

-- Sub-entry rows (Left Over / Lifted / New MPP / Internal Shifting): table was
-- previously created by runtime DDL in executions.js — brought into migrations
-- here so fresh databases don't depend on route-module import order.
CREATE TABLE IF NOT EXISTS trip_execution_bmcu_entries (
  id             SERIAL PRIMARY KEY,
  execution_id   INTEGER NOT NULL REFERENCES trip_executions(id) ON DELETE CASCADE,
  bmcu_seq_no    INTEGER NOT NULL,
  bmcu_id        INTEGER REFERENCES bmcus(id),
  kind           TEXT NOT NULL,
  category       TEXT,
  source_bmcu_id INTEGER REFERENCES bmcus(id),
  qty_litres     NUMERIC,
  fat_pct        NUMERIC,
  snf_pct        NUMERIC,
  remarks        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tebe_exec_idx ON trip_execution_bmcu_entries (execution_id);
CREATE INDEX IF NOT EXISTS tebe_bmcu_idx ON trip_execution_bmcu_entries (bmcu_id);
CREATE INDEX IF NOT EXISTS tebe_exec_seq ON trip_execution_bmcu_entries (execution_id, bmcu_seq_no);
