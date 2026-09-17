-- Record at execution time whether a trip was carried forward into the run
-- (its billing date falls before the run's from_date), so the UI does not
-- have to re-derive it from plan_for_date without knowing the billing-date
-- offset (BILLING_DATE_OFFSET_DAYS).
ALTER TABLE billing_run_trips ADD COLUMN IF NOT EXISTS carried_forward BOOLEAN NOT NULL DEFAULT FALSE;
