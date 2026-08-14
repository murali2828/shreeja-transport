-- 028: Toll gate challans — one per tanker per billing run (fortnight).
-- The challan amount is reimbursed to the vendor on top of the km-based
-- trip amounts and flows through the same 3-level approval.
CREATE TABLE IF NOT EXISTS billing_run_tolls (
  id            SERIAL PRIMARY KEY,
  run_id        INTEGER NOT NULL REFERENCES billing_runs(id) ON DELETE CASCADE,
  tanker_number TEXT NOT NULL,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  file_name     TEXT,
  file_mime     TEXT,
  file_data     BYTEA,
  remarks       TEXT,
  created_by    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, tanker_number)
);
CREATE INDEX IF NOT EXISTS idx_brt_tolls_run ON billing_run_tolls (run_id);
