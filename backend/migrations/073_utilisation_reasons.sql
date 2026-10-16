-- 073: under-utilisation reasons on Tanker Utilisation Day wise (owner, 2026-10-16).
-- Logistics tags each trip below the utilisation threshold with one of two fixed
-- reasons plus optional free-text detail (e.g. the plant's batch requirement);
-- the tagged trips form the approval note attached to the billing run's
-- L1 / L2 / L3 approval mails — approving the run approves the note.
-- Stored on the same per-execution row as the approval remark (072).
ALTER TABLE utilisation_remarks ADD COLUMN IF NOT EXISTS reason VARCHAR(30);
ALTER TABLE utilisation_remarks ADD COLUMN IF NOT EXISTS reason_detail TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_utilisation_remarks_reason') THEN
    ALTER TABLE utilisation_remarks ADD CONSTRAINT chk_utilisation_remarks_reason
      CHECK (reason IS NULL OR reason IN ('batch_preparation', 'operational_delays'));
  END IF;
END $$;
