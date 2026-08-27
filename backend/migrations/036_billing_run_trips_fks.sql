-- Add missing foreign keys on billing_run_trips (audit finding: execution_id,
-- vendor_id and rate_id were plain INTEGER columns joined against constantly
-- in backend/src/routes/billing.js but had no REFERENCES constraint, unlike
-- almost every other *_id column in this schema.
--
-- This is a LIVE table with existing billing history of unknown data
-- quality. Adding a FK constraint normally makes Postgres scan and validate
-- every existing row, which would fail/lock if any orphaned or stale values
-- are present. To avoid any risk of that, these constraints are added with
-- NOT VALID: this registers and enforces the constraint for all NEW
-- inserts/updates from this point forward, WITHOUT scanning existing rows,
-- so it cannot fail or lock on data already in the table.
--
-- vendor_id and rate_id remain nullable (billing.js explicitly handles the
-- "no vendor mapped yet" case via `vendor_id IS NULL`, and rate_id is set to
-- NULL whenever findRate() finds no matching tanker rate), so no NOT NULL is
-- added here.

ALTER TABLE billing_run_trips
  ADD CONSTRAINT billing_run_trips_execution_id_fkey
  FOREIGN KEY (execution_id) REFERENCES trip_executions(id) NOT VALID;

ALTER TABLE billing_run_trips
  ADD CONSTRAINT billing_run_trips_vendor_id_fkey
  FOREIGN KEY (vendor_id) REFERENCES vendors(id) NOT VALID;

ALTER TABLE billing_run_trips
  ADD CONSTRAINT billing_run_trips_rate_id_fkey
  FOREIGN KEY (rate_id) REFERENCES tanker_rates(id) NOT VALID;

-- NOT run here on purpose (would scan/validate all existing rows and could
-- fail or lock the table). Once existing data has been spot-checked for
-- orphaned execution_id/vendor_id/rate_id values, run manually, one at a
-- time, during a maintenance window:
--
--   ALTER TABLE billing_run_trips VALIDATE CONSTRAINT billing_run_trips_execution_id_fkey;
--   ALTER TABLE billing_run_trips VALIDATE CONSTRAINT billing_run_trips_vendor_id_fkey;
--   ALTER TABLE billing_run_trips VALIDATE CONSTRAINT billing_run_trips_rate_id_fkey;
