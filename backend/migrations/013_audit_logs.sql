-- 013_audit_logs.sql
-- Audit trail: every mutating API call (who did what, when).
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER,             -- no FK on purpose: log rows must survive user deletion
  user_name   TEXT,                -- full_name snapshot at time of action
  user_login  TEXT,                -- login identifier used (esp. for login attempts)
  method      VARCHAR(8)  NOT NULL,
  path        TEXT        NOT NULL,
  module      VARCHAR(40),         -- Tankers, BMCUs, Trip Plans, Executions, ...
  action      VARCHAR(20),         -- create | update | delete | login | login_failed | publish | cancel | upload | other
  entity_id   TEXT,                -- id path segment when present
  status_code INTEGER,
  success     BOOLEAN,
  details     JSONB,               -- sanitized request body (secrets stripped, capped)
  ip          VARCHAR(45),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_user_idx    ON audit_logs (user_id);
CREATE INDEX IF NOT EXISTS audit_logs_module_idx  ON audit_logs (module);
