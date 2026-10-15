-- 068_qa_dispatch_balance_milk.sql
-- Balance milk on QA dispatch entries (owner, 2026-10-15).
-- Like Active Trips' "Balance milk" (Left Over milk / Lifted milk) and the TS
-- report's RMRD adjustment: Left Over milk (milk left at the BMCU) is DEDUCTED
-- from the truck-sheet (RMRD) figures, Lifted milk (earlier balance lifted now)
-- is ADDED. QA keys qty (L), fat %, SNF % and remarks for each; blank fat / SNF
-- fall back to the truck sheet's. Kgs, kg fat / SNF and the adjusted RMRD are
-- computed on read in services/qaDispatch.js (KG_FACTOR 1.0285); the
-- dispatch − RMRD variation and the Ack − RMRD comparison use the adjusted RMRD.
ALTER TABLE qa_dispatch_entries
  ADD COLUMN IF NOT EXISTS lo_qty_litres NUMERIC,
  ADD COLUMN IF NOT EXISTS lo_fat_pct    NUMERIC,
  ADD COLUMN IF NOT EXISTS lo_snf_pct    NUMERIC,
  ADD COLUMN IF NOT EXISTS lo_remarks    TEXT,
  ADD COLUMN IF NOT EXISTS lf_qty_litres NUMERIC,
  ADD COLUMN IF NOT EXISTS lf_fat_pct    NUMERIC,
  ADD COLUMN IF NOT EXISTS lf_snf_pct    NUMERIC,
  ADD COLUMN IF NOT EXISTS lf_remarks    TEXT;

ALTER TABLE qa_dispatch_entries DROP CONSTRAINT IF EXISTS chk_qa_dispatch_lo_qty;
ALTER TABLE qa_dispatch_entries ADD CONSTRAINT chk_qa_dispatch_lo_qty CHECK (lo_qty_litres IS NULL OR lo_qty_litres >= 0);
ALTER TABLE qa_dispatch_entries DROP CONSTRAINT IF EXISTS chk_qa_dispatch_lf_qty;
ALTER TABLE qa_dispatch_entries ADD CONSTRAINT chk_qa_dispatch_lf_qty CHECK (lf_qty_litres IS NULL OR lf_qty_litres >= 0);
