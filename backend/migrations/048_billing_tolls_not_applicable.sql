-- "No toll" for a tanker-period: routes with no toll plazas. A row with
-- not_applicable = TRUE (amount 0, no file) satisfies the toll requirement so
-- the tanker is neither listed as pending nor carried to the next cycle.
ALTER TABLE billing_run_tolls ADD COLUMN IF NOT EXISTS not_applicable BOOLEAN NOT NULL DEFAULT FALSE;
