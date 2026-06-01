-- Add description to trip_plan_bmcus so planners can pre-declare Balance Milk rows
ALTER TABLE trip_plan_bmcus
  ADD COLUMN IF NOT EXISTS description VARCHAR(30) DEFAULT 'RMRD'
    CHECK (description IN ('RMRD', 'Balance Milk'));
