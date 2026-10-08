-- Tanker Payment Report in the finance team's extended format (owner,
-- 2026-10-08): the Trip / Date / Tanker sheets carry milk received (from
-- acknowledgements), cost per litre and utilisation, and two cumulative
-- sheets (month-wise for the financial year, month × year matrix with YTD)
-- compare the year with earlier years. The SAP vendor code is the Vendor
-- master's vendor_code (already maintained). What the portal lacked: the
-- monthly figures of earlier financial years (before the portal), kept as
-- keyed history so the Year Cumulative sheet can show 2023-24 onward.

CREATE TABLE IF NOT EXISTS transport_monthly_history (
  id                       SERIAL PRIMARY KEY,
  fy_start_year            INTEGER NOT NULL,              -- 2023 for FY 2023-24
  month                    INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  tanker_capacity_litres   NUMERIC(16,2),                 -- Σ capacity of the month's trips
  milk_litres              NUMERIC(16,2),
  milk_kgs                 NUMERIC(16,2),
  kg_fat                   NUMERIC(16,3),
  kg_snf                   NUMERIC(16,3),
  total_km                 NUMERIC(14,2),
  amount                   NUMERIC(16,2),
  trips                    INTEGER,
  diesel_price             NUMERIC(10,2),                 -- average ₹/L of the month
  source                   TEXT,
  created_by               INTEGER,
  created_by_name          TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_transport_monthly_history UNIQUE (fy_start_year, month)
);
