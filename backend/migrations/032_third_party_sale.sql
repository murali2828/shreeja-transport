-- Third Party Sale: milk from a trip sold directly to a third-party buyer
-- (not delivered through the usual BMCU/plant chain). Recorded per execution
-- (trip-level — a sale isn't tied to one BMCU pickup the way balance-milk /
-- internal-shifting entries are, so it doesn't fit trip_execution_bmcu_entries,
-- whose bmcu_seq_no column is NOT NULL). Reduces the trip's dispatch/TS totals
-- everywhere those totals are computed (see services/executionData.js and
-- routes/reports.js).
CREATE TABLE IF NOT EXISTS trip_third_party_sales (
  id             SERIAL PRIMARY KEY,
  execution_id   INTEGER NOT NULL REFERENCES trip_executions(id) ON DELETE CASCADE,
  qty_litres     NUMERIC(10,2),
  qty_kgs        NUMERIC(12,4),
  fat_pct        NUMERIC(6,3),
  snf_pct        NUMERIC(6,3),
  kg_fat         NUMERIC(12,4),
  kg_snf         NUMERIC(12,4),
  customer_name  VARCHAR(100),
  remarks        TEXT,
  entered_by     INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ttps_exec_idx ON trip_third_party_sales (execution_id);
