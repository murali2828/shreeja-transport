-- 074: tanker utilisation approval chain (owner, 2026-10-16).
-- Logistics drafts (and may edit) the under-utilisation note of a billing run
-- and submits it for its own L1 → L2 → L3 approval, independent of the run's
-- payment approval. The approvers are the billing run's L1 / L2 / L3
-- (BILLING_APPROVER_1..3). One live approval per run; a rejected one stays as
-- history and a new one may be submitted. Email links store only the SHA-256
-- of the single-use token (14-day expiry).
CREATE TABLE IF NOT EXISTS utilisation_approvals (
  id                SERIAL PRIMARY KEY,
  run_id            INTEGER NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','pending_l1','pending_l2','pending_l3','approved','rejected')),
  note_text         TEXT,
  note_snapshot     JSONB,
  submitted_by      INTEGER,
  submitted_by_name VARCHAR(200),
  submitted_at      TIMESTAMPTZ,
  decided_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_utilisation_approvals_live_run
  ON utilisation_approvals (run_id) WHERE status <> 'rejected';

CREATE TABLE IF NOT EXISTS utilisation_approval_steps (
  id               SERIAL PRIMARY KEY,
  approval_id      INTEGER NOT NULL REFERENCES utilisation_approvals(id) ON DELETE CASCADE,
  level            SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 3),
  approver_user_id INTEGER,
  approver_email   VARCHAR(200),
  approver_name    VARCHAR(200),
  token_hash       VARCHAR(64),
  token_expires_at TIMESTAMPTZ,
  decision         VARCHAR(10) CHECK (decision IS NULL OR decision IN ('approved','rejected')),
  remarks          TEXT,
  decided_by       VARCHAR(200),
  decided_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (approval_id, level)
);
CREATE INDEX IF NOT EXISTS idx_utilisation_approval_steps_token ON utilisation_approval_steps (token_hash);
