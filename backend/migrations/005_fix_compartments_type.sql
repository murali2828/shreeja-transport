DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name='tankers' AND column_name='compartments') != 'character varying' THEN
    -- Drop the integer CHECK (compartments IN (2,3)) before the type change, else it
    -- compares a varchar column to integers afterward and errors ("varchar = integer").
    ALTER TABLE tankers DROP CONSTRAINT IF EXISTS tankers_compartments_check;
    ALTER TABLE tankers ALTER COLUMN compartments TYPE VARCHAR(20) USING CAST(compartments AS TEXT);
  END IF;
END$$;
