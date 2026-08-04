-- Maintenance return tracking + entered-by attribution on transactions.
ALTER TABLE non_trip_gate_passes ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;
ALTER TABLE non_trip_gate_passes ADD COLUMN IF NOT EXISTS returned_by_name TEXT;
ALTER TABLE trip_executions      ADD COLUMN IF NOT EXISTS updated_by INTEGER;
ALTER TABLE trip_acknowledgements ADD COLUMN IF NOT EXISTS entered_by INTEGER;
