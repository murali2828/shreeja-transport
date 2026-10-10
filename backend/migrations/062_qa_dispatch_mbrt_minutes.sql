-- MBRT is keyed in minutes, not hours (owner, 2026-10-10). Migration 061
-- may already be applied, so this renames the column, widens it for values up
-- to 1440 and converts any hours already entered (× 60).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'qa_dispatch_entries' AND column_name = 'ts_mbrt_hours') THEN
    ALTER TABLE qa_dispatch_entries ALTER COLUMN ts_mbrt_hours TYPE NUMERIC(7,2);
    UPDATE qa_dispatch_entries SET ts_mbrt_hours = ts_mbrt_hours * 60 WHERE ts_mbrt_hours IS NOT NULL;
    ALTER TABLE qa_dispatch_entries RENAME COLUMN ts_mbrt_hours TO ts_mbrt_mins;
  END IF;
END $$;
ALTER TABLE qa_dispatch_entries ADD COLUMN IF NOT EXISTS ts_mbrt_mins NUMERIC(7,2);
