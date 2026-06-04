ALTER TABLE tankers ALTER COLUMN compartments TYPE VARCHAR(20) USING compartments::TEXT;
