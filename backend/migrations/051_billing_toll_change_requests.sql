-- Toll challan change requests (owner, 2026-10-06). Once a billing run has
-- been submitted for approval, a toll challan row (amount / attachment /
-- "No toll") can no longer be edited directly: the biller requests the change,
-- the approver (user PP01 / CHANGE_APPROVER_ID) approves or rejects by a
-- single-use email link or in the portal, and only approval writes the row.
-- The proposed attachment is held here until the decision.
CREATE TABLE IF NOT EXISTS billing_toll_change_requests (
  id                  SERIAL PRIMARY KEY,
  run_id              INTEGER NOT NULL REFERENCES billing_runs(id) ON DELETE CASCADE,
  toll_id             INTEGER,                       -- existing billing_run_tolls row, if any
  tanker_number       TEXT NOT NULL,
  for_run_id          INTEGER,                       -- earlier period the challan covers, if any
  requested_by        INTEGER,
  requested_by_name   TEXT,
  reason              TEXT NOT NULL,
  old_amount          NUMERIC(12,2),
  old_file_name       TEXT,
  old_not_applicable  BOOLEAN,
  old_remarks         TEXT,
  new_amount          NUMERIC(12,2),
  new_file_name       TEXT,
  new_file_mime       TEXT,
  new_file_data       BYTEA,
  new_not_applicable  BOOLEAN NOT NULL DEFAULT FALSE,
  new_remarks         TEXT,
  status              VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approval_token      TEXT UNIQUE,
  decided_by          INTEGER,
  decided_by_name     TEXT,
  decided_at          TIMESTAMPTZ,
  decision_note       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_toll_cr_run ON billing_toll_change_requests (run_id, status);
-- One pending request per tanker-period of a run.
CREATE UNIQUE INDEX IF NOT EXISTS uq_toll_cr_pending
  ON billing_toll_change_requests (run_id, tanker_number, COALESCE(for_run_id, 0)) WHERE status = 'pending';
