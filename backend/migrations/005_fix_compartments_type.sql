DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name='tankers' AND column_name='compartments') != 'character varying' THEN
    ALTER TABLE tankers ALTER COLUMN compartments TYPE VARCHAR(20) USING CAST(compartments AS TEXT);
  END IF;
END$$;
