-- Diesel price master per state per fortnight (owner, 2026-10-08). Purchase
-- issues the fortnightly rate annexure from the diesel price of each state
-- (rate = previous rate + (diesel − previous diesel) ÷ mileage). Until now the
-- price lived only as a free-text number on each tanker_rates row, so the
-- movement of ₹/km could not be split into diesel vs km vs new BMCUs. This
-- table is the source of truth for the price; tanker_rates.diesel_price stays
-- as the value a rate row was built from.
CREATE TABLE IF NOT EXISTS diesel_rates (
  id               SERIAL PRIMARY KEY,
  state            VARCHAR(40) NOT NULL,
  effective_from   DATE NOT NULL,
  effective_to     DATE NOT NULL,
  price_per_litre  NUMERIC(10,2) NOT NULL CHECK (price_per_litre > 0),
  source           TEXT,
  created_by       INTEGER,
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_diesel_rates_state_from UNIQUE (state, effective_from),
  CONSTRAINT diesel_rates_range CHECK (effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_diesel_rates_lookup ON diesel_rates (state, effective_from DESC);

-- Backfill from the prices already keyed on Tanker Rate Master rows: one row
-- per state × period (the price most rows of that period carry).
INSERT INTO diesel_rates (state, effective_from, effective_to, price_per_litre, source)
SELECT state, effective_from, effective_to, diesel_price, 'from Tanker Rate Master'
FROM (
  SELECT state, effective_from, effective_to, diesel_price,
         ROW_NUMBER() OVER (PARTITION BY state, effective_from ORDER BY COUNT(*) DESC, diesel_price) AS rn
  FROM tanker_rates
  WHERE diesel_price IS NOT NULL AND diesel_price > 0
  GROUP BY state, effective_from, effective_to, diesel_price
) x
WHERE rn = 1
ON CONFLICT (state, effective_from) DO NOTHING;
