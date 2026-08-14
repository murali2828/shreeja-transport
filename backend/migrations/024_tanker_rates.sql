-- Tanker Rate Master: fortnightly ₹/KM rates decided per state, per tanker
-- capacity (KL) and per transport type (BMCU/CC to Dairy/CC vs Point to
-- Point), with the mileage norm and diesel price behind each decision.
-- Vendor payments are made against these rates.
CREATE TABLE IF NOT EXISTS tanker_rates (
  id                    SERIAL PRIMARY KEY,
  effective_from        DATE NOT NULL,
  effective_to          DATE NOT NULL,
  state                 VARCHAR(40) NOT NULL,
  capacity_kl           NUMERIC(6,2) NOT NULL,
  transport_type        VARCHAR(30) NOT NULL
                        CHECK (transport_type IN ('BMCU/CC to Dairy/CC','Point to Point')),
  mileage_km_per_litre  NUMERIC(6,2),
  rate_per_km           NUMERIC(10,2) NOT NULL,
  diesel_price          NUMERIC(10,2),
  created_by            INTEGER,
  created_by_name       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- No duplicates for the same date / state / capacity / transport type.
  CONSTRAINT tanker_rates_unique UNIQUE (effective_from, state, capacity_kl, transport_type),
  CONSTRAINT tanker_rates_range CHECK (effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_tanker_rates_lookup
  ON tanker_rates (state, capacity_kl, transport_type, effective_from DESC);
