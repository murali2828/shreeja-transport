-- 069_qa_acknowledgements.sql
-- QA team's own plant acknowledgement (owner, 2026-10-15; ADR-021).
-- The quality team keys the plant acknowledgement per tanker × lifting date ×
-- chamber (FC / MC / BC), Kgs first like the logistics Acknowledgement screen:
-- litres = kgs / 1.0285 (KG_FACTOR), kg fat = kgs × fat % / 100, kg SNF =
-- kgs × SNF % / 100, computed server-side in routes/quality.js. The QA Dispatch
-- Report compares RMRD (adjusted) with these rows INSTEAD of the tanker team's
-- trip_acknowledgements. Independent record set: nothing here feeds
-- executions, trip_acknowledgements, billing, reports or the Assure feed.
CREATE TABLE IF NOT EXISTS qa_acknowledgements (
  id              SERIAL PRIMARY KEY,
  lifting_date    DATE NOT NULL,
  tanker_id       INT NOT NULL REFERENCES tankers(id),
  tanker_number   TEXT,
  chamber         VARCHAR(2) NOT NULL CHECK (chamber IN ('FC','MC','BC')),
  ack_date        DATE,
  qty_kgs         NUMERIC,
  qty_litres      NUMERIC,
  fat_pct         NUMERIC,
  snf_pct         NUMERIC,
  kg_fat          NUMERIC,
  kg_snf          NUMERIC,
  remarks         TEXT,
  entered_by      INT,
  entered_by_name TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_qa_acknowledgements_trip_chamber UNIQUE (lifting_date, tanker_id, chamber)
);
CREATE INDEX IF NOT EXISTS idx_qa_acknowledgements_lifting_date ON qa_acknowledgements (lifting_date);
