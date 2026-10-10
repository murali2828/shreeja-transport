-- Milk type per QA dispatch entry (owner, 2026-10-10): QA marks whether the
-- compartment(s) of the entry carried Cow, Buffalo or Mixed milk. Nullable so
-- earlier rows stay as they are; new and edited entries require it.
ALTER TABLE qa_dispatch_entries ADD COLUMN IF NOT EXISTS milk_type VARCHAR(10);
ALTER TABLE qa_dispatch_entries DROP CONSTRAINT IF EXISTS qa_dispatch_entries_milk_type_check;
ALTER TABLE qa_dispatch_entries ADD CONSTRAINT qa_dispatch_entries_milk_type_check
  CHECK (milk_type IS NULL OR milk_type IN ('Cow', 'Buffalo', 'Mixed'));
