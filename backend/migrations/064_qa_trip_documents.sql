-- QA team's Milk Dispatch Voucher (delivery challan) and Certificate of Analysis
-- per tanker × lifting date (owner, 2026-10-10). The portal pre-fills what it
-- knows (QA dispatch entries, plan, tanker), QA edits the rest; `data` keeps
-- every printed field exactly as saved. Bill-to / Ship-to party details are
-- kept per delivering plant and seeded for Balaji Dairy from the paper template.
ALTER TABLE delivery_points ADD COLUMN IF NOT EXISTS bill_to JSONB;
ALTER TABLE delivery_points ADD COLUMN IF NOT EXISTS ship_to JSONB;

UPDATE delivery_points SET
  bill_to = '{"name":"NDDB Dairy Services","customer_code":"","address":"NDDB House, Safdarjung Enclave, South West Delhi, New Delhi 110029","gstin":"07AADCN1059J1ZG","state":"Delhi","state_code":"07"}'::jsonb,
  ship_to = '{"sap_vendor_code":"4024119","name":"Mother Dairy Fruit and Vegetable Private Limited (c/o Balaji Dairy)","customer_code":"","address":"","place_of_supply":"TIRUPATI","gstin":"37AACCM3174A1ZU","state":"ANDHRA PRADESH","state_code":"37"}'::jsonb
WHERE name ILIKE '%balaji%' AND bill_to IS NULL;

CREATE TABLE IF NOT EXISTS qa_trip_documents (
  id                   SERIAL PRIMARY KEY,
  lifting_date         DATE NOT NULL,
  tanker_id            INTEGER NOT NULL REFERENCES tankers(id),
  tanker_number        TEXT,
  route_name           TEXT,
  delivery_point_id    INTEGER REFERENCES delivery_points(id),
  challan_no           VARCHAR(30) NOT NULL,
  data                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  print_count_dispatch INTEGER NOT NULL DEFAULT 0,
  print_count_coa      INTEGER NOT NULL DEFAULT 0,
  created_by           INTEGER,
  created_by_name      TEXT,
  updated_by_name      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_qa_trip_documents_trip UNIQUE (lifting_date, tanker_id),
  CONSTRAINT uq_qa_trip_documents_challan UNIQUE (challan_no)
);

-- Running challan series per financial year: DC/26-27/0001.
CREATE TABLE IF NOT EXISTS qa_challan_counters (
  fy_start_year INTEGER PRIMARY KEY,
  last_no       INTEGER NOT NULL DEFAULT 0
);
