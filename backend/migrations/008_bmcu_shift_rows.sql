CREATE TABLE IF NOT EXISTS trip_execution_bmcu_shifts (
  id              SERIAL PRIMARY KEY,
  execution_id    INTEGER NOT NULL REFERENCES trip_executions(id) ON DELETE CASCADE,
  bmcu_seq_no     INTEGER NOT NULL,
  milk_date       DATE,
  shift           VARCHAR(5) CHECK (shift IN ('AM','PM')),
  rmrd_qty        NUMERIC(10,2),
  rmrd_fat_pct    NUMERIC(6,3),
  rmrd_snf_pct    NUMERIC(6,3),
  created_at      TIMESTAMP DEFAULT NOW()
);
