-- 014_change_requests.sql
-- Post-closure correction workflow: proposed edits to closed executions are
-- staged here and applied only after approval (email link or portal).
CREATE TABLE IF NOT EXISTS execution_change_requests (
  id                SERIAL PRIMARY KEY,
  execution_id      INTEGER NOT NULL REFERENCES trip_executions(id) ON DELETE CASCADE,
  requested_by      INTEGER,
  requested_by_name TEXT,
  reason            TEXT,
  snapshot          JSONB NOT NULL,   -- data as it was when the request was raised
  changes           JSONB NOT NULL,   -- proposed data (same shape as the save payload)
  status            VARCHAR(10) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),
  approval_token    TEXT UNIQUE,      -- single-use token for email approve/reject links
  decided_by        INTEGER,
  decided_by_name   TEXT,
  decided_at        TIMESTAMPTZ,
  decision_note     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one pending request per execution at a time.
CREATE UNIQUE INDEX IF NOT EXISTS ecr_one_pending_per_exec
  ON execution_change_requests (execution_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ecr_status_idx  ON execution_change_requests (status, created_at DESC);
