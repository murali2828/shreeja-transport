-- Migration 045: Day Optimizer trips carry a suggested route name and vendor.
-- Business reason: planners read the optimised day "route wise" — each trip is
-- labelled with the Route Master whose BMCU set overlaps its pickups most
-- (or "New combination"), and with the vendor of the tanker, both on the page
-- and in the Excel download (GET /api/optimize/:sessionId/report).
ALTER TABLE optimization_trips ADD COLUMN IF NOT EXISTS route_name  TEXT;
ALTER TABLE optimization_trips ADD COLUMN IF NOT EXISTS vendor_name TEXT;
