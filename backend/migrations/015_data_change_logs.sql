-- 015_data_change_logs.sql
-- Field-level change history: one row per changed field per transaction
-- (module, record, row, field, old value, new value, user, timestamp).
CREATE TABLE IF NOT EXISTS data_change_logs (
  id          BIGSERIAL PRIMARY KEY,
  module      VARCHAR(40),
  entity_type VARCHAR(40),
  entity_id   TEXT,
  row_label   TEXT,              -- e.g. 'BMCU #2 3646', 'Chamber FC', '(record)'
  field       VARCHAR(60),
  old_value   TEXT,
  new_value   TEXT,
  action      VARCHAR(12),       -- create | update | delete
  user_id     INTEGER,
  user_name   TEXT,
  user_login  TEXT,
  audit_path  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dcl_created_idx ON data_change_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS dcl_user_idx    ON data_change_logs (user_id);
CREATE INDEX IF NOT EXISTS dcl_entity_idx  ON data_change_logs (module, entity_id);
