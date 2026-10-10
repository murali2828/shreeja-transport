-- MBRT (methylene blue reduction time, hours) on the QA truck-sheet side
-- (owner, 2026-10-10): keyed on QA Dispatch Entry, shown on the QA report.
ALTER TABLE qa_dispatch_entries ADD COLUMN IF NOT EXISTS ts_mbrt_hours NUMERIC(5,2);
