-- Monthly toll of the FY workbook (owner, 2026-10-13): each month sheet of the
-- logistics team's consolidation workbook ends with one "Toll cost" total for
-- the month — not per tanker or trip. Kept per month for the Month / Year
-- Cumulative sheets and the Payment Report summary, for months up to
-- ANALYTICS_HISTORY_UNTIL (later months use billing_run_tolls). Loaded by
-- scripts/import_trip_history.js with the trips. The sheets' "9K KM Fixed
-- cost" rows are not loaded (owner: later).
CREATE TABLE IF NOT EXISTS historical_month_tolls (
  month_start   DATE PRIMARY KEY,             -- first day of the month
  toll_amount   NUMERIC(14,2) NOT NULL,
  source_sheet  TEXT,
  batch         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
