-- 072: approval remarks on Tanker Utilisation Day wise (owner, 2026-10-16).
-- Logistics takes CE approval for trips below the utilisation threshold after
-- each billing run and notes it per trip; one remark per execution, keyed on
-- the Day wise screen, shown in its Excel and the billing run's
-- "Tanker Utilisation" sheet. A blank remark deletes the row.
CREATE TABLE IF NOT EXISTS utilisation_remarks (
  execution_id    INTEGER PRIMARY KEY REFERENCES trip_executions(id),
  remark          TEXT,
  updated_by      INTEGER,
  updated_by_name TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
