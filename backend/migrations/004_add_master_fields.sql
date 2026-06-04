-- Routes: add route_no (distance_km already exists)
ALTER TABLE route_masters ADD COLUMN IF NOT EXISTS route_no VARCHAR(20);

-- BMCUs: add lat/lng
ALTER TABLE bmcus ADD COLUMN IF NOT EXISTS latitude NUMERIC(11,8);
ALTER TABLE bmcus ADD COLUMN IF NOT EXISTS longitude NUMERIC(11,8);

-- Tankers: add vendor/rate fields; alter compartments to VARCHAR to support "2C"/"3C" format
ALTER TABLE tankers ADD COLUMN IF NOT EXISTS vendor_code VARCHAR(50);
ALTER TABLE tankers ADD COLUMN IF NOT EXISTS vendor_name VARCHAR(100);
ALTER TABLE tankers ADD COLUMN IF NOT EXISTS rate_per_km_bmcu NUMERIC(8,2);
ALTER TABLE tankers ADD COLUMN IF NOT EXISTS rate_per_km_p2p NUMERIC(8,2);
ALTER TABLE tankers ALTER COLUMN compartments TYPE VARCHAR(20) USING compartments::VARCHAR;
