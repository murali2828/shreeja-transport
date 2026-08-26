-- 030: Sale-tanker exclusion, vendor-verification step, per-trip exclusion.
ALTER TABLE trip_plans ADD COLUMN IF NOT EXISTS is_sale_tanker BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE billing_run_trips ADD COLUMN IF NOT EXISTS is_sale_tanker BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE billing_run_trips ADD COLUMN IF NOT EXISTS excluded BOOLEAN NOT NULL DEFAULT FALSE;

-- Allow the new pending_vendor stage between draft and pending_l1.
ALTER TABLE billing_runs DROP CONSTRAINT IF EXISTS billing_runs_status_check;
ALTER TABLE billing_runs ADD CONSTRAINT billing_runs_status_check
  CHECK (status IN ('draft','pending_vendor','pending_l1','pending_l2','pending_l3','approved','rejected'));
