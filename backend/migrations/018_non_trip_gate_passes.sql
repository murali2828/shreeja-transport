-- Gate passes issued OUTSIDE trip planning (maintenance, hot water, RMT, etc.)
CREATE TABLE IF NOT EXISTS non_trip_gate_passes (
  id                 SERIAL PRIMARY KEY,
  tanker_id          INTEGER NOT NULL REFERENCES tankers(id),
  reason             VARCHAR(30) NOT NULL
                     CHECK (reason IN ('Maintainance','Hot water','RMT','Tankers without driver','Others')),
  other_text         TEXT,            -- required when reason = 'Others'
  -- RMT-only fields: reimbursed from Balaji vendor, paid to tanker vendor
  billing            TEXT,
  remarks            TEXT,
  km                 NUMERIC(10,2),
  tanker_vendor_rate NUMERIC(10,2),
  balaji_dairy_rate  NUMERIC(10,2),
  issued_by          INTEGER,
  issued_by_name     TEXT,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ntgp_issued ON non_trip_gate_passes (issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_ntgp_tanker ON non_trip_gate_passes (tanker_id);
