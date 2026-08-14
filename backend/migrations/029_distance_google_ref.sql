-- 029: Google reference distance on the Distance Master.
-- google_km holds the Google Routes API figure for the pair as a REFERENCE —
-- it never replaces the (possibly manually entered) distance_km.
ALTER TABLE distance_master ADD COLUMN IF NOT EXISTS google_km NUMERIC(8,2);
-- Rows that were cached from Google ARE the Google figure — backfill.
UPDATE distance_master SET google_km = distance_km
WHERE google_km IS NULL AND road_notes ILIKE '%google%';
