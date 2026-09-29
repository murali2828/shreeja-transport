-- Migration 046: toll challans can be uploaded in a later billing run for an
-- earlier period. Business rule (owner, 2026-09-29): a missing toll challan
-- must NEVER remove a tanker's trips from a billing run — trip payment always
-- goes through; only the TOLL carries forward to the next cycle, where the
-- biller uploads the challan against the earlier period and it is paid then.
--
-- for_run_id = the run (period) the toll belongs to when it was uploaded in a
-- later run; NULL = the toll is for the run's own period. The toll row's
-- run_id stays the run that PAYS it (refreshRunTotal sums by run_id).
ALTER TABLE billing_run_tolls
  ADD COLUMN IF NOT EXISTS for_run_id INTEGER REFERENCES billing_runs(id);
CREATE INDEX IF NOT EXISTS idx_brt_tolls_for_run ON billing_run_tolls (for_run_id);

-- One toll per (paying run, tanker) was the rule; with carry-forward a tanker
-- may have its own-period toll AND one for an earlier period in the same
-- paying run, so the unique key widens to include the period it covers.
ALTER TABLE billing_run_tolls DROP CONSTRAINT IF EXISTS billing_run_tolls_run_id_tanker_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_run_tolls_run_tanker_period
  ON billing_run_tolls (run_id, tanker_number, COALESCE(for_run_id, 0));
