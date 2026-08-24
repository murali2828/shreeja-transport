-- Correction: Third Party Sale is a PER-BMCU entry, not a trip-level one.
-- Sale quantity must reduce the RMRD total of the SPECIFIC BMCU it is
-- recorded against; it must NOT touch the trip's dispatch quantity at all
-- (see services/executionData.js / routes/reports.js). Add bmcu_seq_no,
-- following the same convention trip_execution_bmcu_shifts and
-- trip_execution_bmcu_entries use to key a row to its BMCU within an
-- execution (bmcu_seq_no matching trip_execution_bmcus.seq_no).
ALTER TABLE trip_third_party_sales ADD COLUMN IF NOT EXISTS bmcu_seq_no INTEGER;
CREATE INDEX IF NOT EXISTS ttps_exec_bmcu_idx ON trip_third_party_sales (execution_id, bmcu_seq_no);
