-- Allow 'deleted' as a trip_plans status (soft delete)
ALTER TABLE trip_plans DROP CONSTRAINT IF EXISTS trip_plans_status_check;
ALTER TABLE trip_plans ADD CONSTRAINT trip_plans_status_check
  CHECK (status IN ('draft','published','cancelled','deleted'));
