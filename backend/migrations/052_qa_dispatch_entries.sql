-- QA tanker dispatch entries (owner, 2026-10-07). The quality team records,
-- independently of the tanker team's executions, the dispatch figures
-- (scale reading, shifts, litres, fat %, CLR → SNF) and the truck-sheet
-- (RMRD) figures per tanker × BMCU × compartment × lifting date from the paper
-- documents, and reports the variation. Nothing here feeds executions,
-- acknowledgements, reports or billing. Derived columns (kgs, kg fat / SNF,
-- SNF from CLR) are computed server-side with KG_FACTOR 1.0285 and stored.
CREATE TABLE IF NOT EXISTS qa_dispatch_entries (
  id               SERIAL PRIMARY KEY,
  submission_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  lifting_date     DATE NOT NULL,
  route_id         INTEGER REFERENCES route_masters(id),
  route_name       TEXT,
  tanker_id        INTEGER NOT NULL REFERENCES tankers(id),
  tanker_number    TEXT,
  bmcu_id          INTEGER NOT NULL REFERENCES bmcus(id),
  bmcu_code        TEXT,
  bmcu_name        TEXT,
  compartment      VARCHAR(2) NOT NULL CHECK (compartment IN ('FC','MC','BC')),
  scale_reading    NUMERIC(10,2),
  shifts           TEXT,                       -- e.g. 23E,24M,24E
  d_qty_litres     NUMERIC(12,2),
  d_fat_pct        NUMERIC(6,3),
  d_clr            NUMERIC(6,2),
  d_snf_pct        NUMERIC(6,3),               -- CLR/4 + 0.21*fat + 0.36
  d_qty_kgs        NUMERIC(14,4),
  d_kg_fat         NUMERIC(14,4),
  d_kg_snf         NUMERIC(14,4),
  ts_date          DATE,
  ts_shift         TEXT,
  ts_qty_litres    NUMERIC(12,2),
  ts_fat_pct       NUMERIC(6,3),
  ts_snf_pct       NUMERIC(6,3),
  ts_qty_kgs       NUMERIC(14,4),
  ts_kg_fat        NUMERIC(14,4),
  ts_kg_snf        NUMERIC(14,4),
  remarks          TEXT,
  entered_by       INTEGER,
  entered_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lifting_date, tanker_id, bmcu_id, compartment)
);
CREATE INDEX IF NOT EXISTS idx_qa_dispatch_lifting ON qa_dispatch_entries (lifting_date);

-- Role for the quality team: only the Quality module.
INSERT INTO roles (name, label, is_system, permissions)
VALUES ('quality', 'Quality (QA)', FALSE, '{"masters":false,"planning":false,"execution":false,"billing":false,"reports":false,"quality":true}')
ON CONFLICT (name) DO NOTHING;
