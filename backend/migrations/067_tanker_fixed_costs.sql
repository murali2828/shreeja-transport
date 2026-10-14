-- Minimum-km guarantee (owner, 2026-10-14): approval note 04-06-2026 (ref. the
-- Purchase Committee note of 31-03-2026) pays every vendor tanker a minimum of
-- 9,000 km a month for May–Oct 2026; the shortfall (9,000 − run km − 300 km per
-- maintenance day) is paid at a fixed ₹/km by tanker capacity. Finance's
-- approved monthly "Fixed Cost Consolidated Report" is uploaded (one row per
-- tanker per month, the month replaced on re-upload) and counted in transport
-- cost and the all-in cost per litre. Read by reports only; billing runs and
-- vendor cards are unchanged.
CREATE TABLE IF NOT EXISTS tanker_fixed_costs (
  id               SERIAL PRIMARY KEY,
  month_start      DATE NOT NULL,
  tanker_number    TEXT NOT NULL,
  tanker_id        INTEGER,
  vendor_code      TEXT,
  vendor_id        INTEGER,
  vendor_name      TEXT,
  capacity_litres  NUMERIC(10,2),
  run_km           NUMERIC(12,2),
  maintenance_days NUMERIC(6,2),
  maintenance_km   NUMERIC(12,2),
  total_km         NUMERIC(12,2),
  min_km           NUMERIC(12,2) NOT NULL DEFAULT 9000,
  balance_km       NUMERIC(12,2),
  rate_per_km      NUMERIC(10,2),
  amount           NUMERIC(14,2) NOT NULL DEFAULT 0,
  po_number        TEXT,
  service_sheet_no TEXT,
  source_file      TEXT,
  uploaded_by      INTEGER,
  uploaded_by_name TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tanker_fixed_costs_month_tanker UNIQUE (month_start, tanker_number)
);
CREATE INDEX IF NOT EXISTS idx_tanker_fixed_costs_month ON tanker_fixed_costs (month_start);
