-- Allow multiple chambers per BMCU row (stored as comma-separated e.g. "FC,MC")
DO $$
BEGIN
  -- Drop the single-value check constraint on trip_execution_bmcus
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name='trip_execution_bmcus' AND constraint_type='CHECK'
    AND constraint_name LIKE '%chamber%'
  ) THEN
    ALTER TABLE trip_execution_bmcus DROP CONSTRAINT IF EXISTS trip_execution_bmcus_chamber_check;
  END IF;
END $$;

ALTER TABLE trip_execution_bmcus ALTER COLUMN chamber TYPE VARCHAR(20);

-- Drop check constraint on trip_acknowledgements too (if exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name='trip_acknowledgements' AND constraint_type='CHECK'
    AND constraint_name LIKE '%chamber%'
  ) THEN
    ALTER TABLE trip_acknowledgements DROP CONSTRAINT IF EXISTS trip_acknowledgements_chamber_check;
  END IF;
END $$;
