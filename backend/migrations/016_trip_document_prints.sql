-- Gate Pass / COA print log. First print per (trip, doc_type) is the
-- operational timestamp: gate_pass = trip start, coa = arrived at delivery point.
CREATE TABLE IF NOT EXISTS trip_document_prints (
  id              SERIAL PRIMARY KEY,
  trip_plan_id    INTEGER NOT NULL REFERENCES trip_plans(id),
  doc_type        VARCHAR(12) NOT NULL CHECK (doc_type IN ('gate_pass','coa')),
  print_no        INTEGER NOT NULL,          -- 1 = original, >1 duplicates
  printed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  printed_by      INTEGER,
  printed_by_name TEXT,
  UNIQUE (trip_plan_id, doc_type, print_no)
);
CREATE INDEX IF NOT EXISTS idx_tdp_plan ON trip_document_prints (trip_plan_id);
CREATE INDEX IF NOT EXISTS idx_tdp_type_time ON trip_document_prints (doc_type, printed_at);
