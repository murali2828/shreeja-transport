-- 075: log of every vendor mail attempt from Push to Vendors (draft tanker cards
-- for verification, or the final cards of an approved run), so the biller sees
-- which vendors of a run were sent, failed or never mailed (owner, 2026-10-17).
CREATE TABLE IF NOT EXISTS billing_vendor_pushes (
  id            SERIAL PRIMARY KEY,
  run_id        INT NOT NULL,
  vendor_id     INT NULL,
  vendor_name   TEXT,
  email         TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('draft', 'approved')),
  trips         INT,
  amount        NUMERIC(14,2),
  status        TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error         TEXT,
  sent_by       INT,
  sent_by_name  TEXT,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_vendor_pushes_run ON billing_vendor_pushes (run_id);
