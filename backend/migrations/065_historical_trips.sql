-- Trip history before the portal was complete (owner, 2026-10-13): the
-- logistics team's "Tanker Utilization consolidation FY 2026-27" workbook has
-- one row per trip (plant, date, vehicle, capacity, transporter, km, rate,
-- amount, route, acknowledged litres / kgs / fat / SNF, BMCUs covered) for
-- April–August 2026. The rows have no per-BMCU or per-chamber litres, so they
-- cannot become plans / executions; they are kept here and read only by the
-- analysis (Payment Report tabs, Month / Year Cumulative) for dates up to
-- ANALYTICS_HISTORY_UNTIL (default 2026-08-31). Billing, executions, TS reports
-- and the Assure feed never read this table.
CREATE TABLE IF NOT EXISTS historical_trips (
  id                SERIAL PRIMARY KEY,
  source_sheet      TEXT NOT NULL,                 -- e.g. April'26
  source_row        INTEGER NOT NULL,              -- Excel row number
  trip_date         DATE NOT NULL,                 -- date as on the sheet (year typos corrected)
  report_date       DATE NOT NULL,                 -- date the analysis files it under: never before the sheet's month
  plant_raw         TEXT,                          -- receiving plant as typed
  plant             TEXT,                          -- normalised plant name
  tanker_number     TEXT NOT NULL,
  tanker_id         INTEGER,                       -- tankers.id when the number matches the master
  capacity_litres   NUMERIC(12,2),
  vendor_name       TEXT,
  vendor_code       TEXT,
  vendor_id         INTEGER,                       -- vendors.id via vendor_code
  route_name        TEXT,
  billed_km         NUMERIC(12,2),
  rate_per_km       NUMERIC(10,2),
  amount            NUMERIC(14,2),
  milk_litres       NUMERIC(14,2),
  milk_kgs          NUMERIC(14,2),
  fat_pct           NUMERIC(6,3),
  snf_pct           NUMERIC(6,3),
  kg_fat            NUMERIC(14,3),
  kg_snf            NUMERIC(14,3),
  bmcu_coverage     TEXT,
  notes             TEXT,                          -- corrections made by the loader
  batch             TEXT,                          -- workbook file name of the load
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_historical_trips_source UNIQUE (source_sheet, source_row)
);
CREATE INDEX IF NOT EXISTS idx_historical_trips_report_date ON historical_trips (report_date);
