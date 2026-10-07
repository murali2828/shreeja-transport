-- QA dispatch: one BMCU's milk may be split across compartments and keyed on
-- one row (owner, 2026-10-07). compartment becomes a comma list in canonical
-- order (FC, MC, BC), e.g. 'FC,MC'. Chips on the page come from the tanker's
-- compartment count in Tanker Master (tankers.compartments '2C' / '3C').
ALTER TABLE qa_dispatch_entries DROP CONSTRAINT IF EXISTS qa_dispatch_entries_compartment_check;
ALTER TABLE qa_dispatch_entries ALTER COLUMN compartment TYPE VARCHAR(12);
ALTER TABLE qa_dispatch_entries ADD CONSTRAINT qa_dispatch_entries_compartment_check
  CHECK (compartment ~ '^(FC|MC|BC)(,(FC|MC|BC))*$');
