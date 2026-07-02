-- 011_trip_distance.sql
-- Coordinates for location masters + auto-calculated trip distance for executions.

-- Coordinates on location masters (BMCUs already have latitude/longitude via 002/004).
ALTER TABLE starting_points ADD COLUMN IF NOT EXISTS latitude  NUMERIC(11,8);
ALTER TABLE starting_points ADD COLUMN IF NOT EXISTS longitude NUMERIC(11,8);
ALTER TABLE delivery_points ADD COLUMN IF NOT EXISTS latitude  NUMERIC(11,8);
ALTER TABLE delivery_points ADD COLUMN IF NOT EXISTS longitude NUMERIC(11,8);
ALTER TABLE testing_points  ADD COLUMN IF NOT EXISTS latitude  NUMERIC(11,8);
ALTER TABLE testing_points  ADD COLUMN IF NOT EXISTS longitude NUMERIC(11,8);

-- Auto-calculated road distance for a trip execution (for vendor payments).
ALTER TABLE trip_executions ADD COLUMN IF NOT EXISTS calculated_km          NUMERIC(8,2);
ALTER TABLE trip_executions ADD COLUMN IF NOT EXISTS km_estimated_leg_count INTEGER DEFAULT 0;
ALTER TABLE trip_executions ADD COLUMN IF NOT EXISTS km_incomplete          BOOLEAN DEFAULT FALSE;
