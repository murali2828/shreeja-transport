-- Material (pasteurised milk) trips — owner request 2026-10-05.
-- Shreeja buys pasteurised milk from Balaji Dairy, Tirupati and a vendor tanker
-- carries it to a customer (HUL). The trip has no BMCU chain: the supplier's
-- document gives purchased qty / fat / SNF, the customer acknowledges qty /
-- fat / SNF, both documents are scanned in, and the vendor is paid per km like
-- any other trip (own sub-section in billing).

-- Material master (SAP material code is the key the finance team uses).
CREATE TABLE IF NOT EXISTS materials (
  id          SERIAL PRIMARY KEY,
  sap_code    VARCHAR(40)  NOT NULL UNIQUE,
  name        VARCHAR(120) NOT NULL,
  unit        VARCHAR(10)  NOT NULL DEFAULT 'Ltrs',
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- A plan is a normal milk trip ('milk') or a material trip ('material').
ALTER TABLE trip_plans ADD COLUMN IF NOT EXISTS trip_kind   VARCHAR(20) NOT NULL DEFAULT 'milk';
ALTER TABLE trip_plans ADD COLUMN IF NOT EXISTS material_id INTEGER REFERENCES materials(id);
ALTER TABLE trip_plans DROP CONSTRAINT IF EXISTS trip_plans_trip_kind_check;
ALTER TABLE trip_plans ADD CONSTRAINT trip_plans_trip_kind_check CHECK (trip_kind IN ('milk','material'));
CREATE INDEX IF NOT EXISTS idx_trip_plans_kind ON trip_plans (trip_kind) WHERE trip_kind <> 'milk';

-- Material data of one execution (purchase side + documents + manual km).
-- The customer's acknowledgement qty / fat / SNF lives in trip_acknowledgements
-- (chamber FC) so billing, reports and change requests see it as usual.
CREATE TABLE IF NOT EXISTS trip_material_data (
  execution_id        INTEGER PRIMARY KEY REFERENCES trip_executions(id) ON DELETE CASCADE,
  material_id         INTEGER REFERENCES materials(id),
  supplier_doc_no     VARCHAR(60),
  purchase_qty_litres NUMERIC(12,2),
  purchase_qty_kgs    NUMERIC(14,4),
  purchase_fat_pct    NUMERIC(6,3),
  purchase_snf_pct    NUMERIC(6,3),
  purchase_doc_file   TEXT,            -- stored file name under UPLOAD_DIR/material
  purchase_doc_name   TEXT,            -- original file name for display
  manual_km           NUMERIC(8,2),    -- km keyed by the executor (billed km default)
  ack_doc_file        TEXT,            -- customer's acknowledgement scan
  ack_doc_name        TEXT,
  remarks             TEXT,
  updated_by          INTEGER,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Billing lines remember the kind so the run page, vendor mail and Excel can
-- show material trips in their own sub-section.
ALTER TABLE billing_run_trips ADD COLUMN IF NOT EXISTS trip_kind VARCHAR(20) NOT NULL DEFAULT 'milk';
