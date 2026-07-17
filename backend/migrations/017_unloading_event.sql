-- Allow 'unloading' events in the trip document print log:
-- COA first print = arrived; 'unloading' first record = unloading completed;
-- next gate pass (same tanker) = out after cleaning.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'trip_document_prints'::regclass AND contype = 'c';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE trip_document_prints DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE trip_document_prints
    ADD CONSTRAINT trip_document_prints_doc_type_check
    CHECK (doc_type IN ('gate_pass','coa','unloading'));
END $$;
