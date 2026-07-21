-- Tanker induction type (Temporary/Permanent) with validity period.
ALTER TABLE tankers ADD COLUMN IF NOT EXISTS induction_type VARCHAR(10)
  CHECK (induction_type IN ('Temporary','Permanent'));
ALTER TABLE tankers ADD COLUMN IF NOT EXISTS validity_start DATE;
ALTER TABLE tankers ADD COLUMN IF NOT EXISTS validity_end   DATE;
