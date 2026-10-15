-- Migration 070: MBRT (methylene blue reduction time, minutes) on the QA team's
-- plant acknowledgement (owner, 2026-10-15). One value per tanker × lifting
-- date × chamber in qa_acknowledgements (migration 069), same range as the
-- truck-sheet MBRT (ts_mbrt_mins, migrations 061 / 062): 0–1440 minutes,
-- optional. The QA Dispatch Report shows the lowest value on totals.
-- Idempotent: the column and the CHECK are added only if missing.

ALTER TABLE qa_acknowledgements ADD COLUMN IF NOT EXISTS mbrt_mins NUMERIC(6,1);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_qa_ack_mbrt') THEN
    ALTER TABLE qa_acknowledgements
      ADD CONSTRAINT chk_qa_ack_mbrt CHECK (mbrt_mins IS NULL OR (mbrt_mins >= 0 AND mbrt_mins <= 1440));
  END IF;
END $$;
