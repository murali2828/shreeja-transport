-- Migration 071: trip scans — BMCU dispatch challans and plant acknowledgement slips (owner, 2026-10-16)
-- Logistics attaches the scanned / photographed BMCU dispatch challan (DC) to each BMCU line of a
-- trip execution (kind 'bmcu_dc', teb_id = trip_execution_bmcus.id) and the plant acknowledgement
-- slip to the trip (kind 'ack', teb_id NULL). Several files per line / ack are allowed (pages).
-- Bytes live on the uploads volume under UPLOAD_DIR/trip-scans/YYYY/MM/<sha256>.<ext>
-- (content-addressed, ADR-025); this table holds metadata only. Scans never change trip data,
-- so they may be added to any non-cancelled trip, closed and billed ones included.
-- Pending is computed, never stored: DC pending = live BMCU row (is_deleted = false) without a
-- DC scan; ack pending = acknowledged trip without an ack scan. Deletes are soft (deleted_at).
-- Adding files is free. Replacing or deleting an uploaded scan goes through
-- trip_scan_change_requests (owner, 2026-10-16): the approver (CHANGE_APPROVER_ID) decides by
-- single-use email link or in the portal; only approval applies. Files proposed for a replace
-- are stored like any scan with is_proposed = TRUE and never count as live until approved.
-- Admins may still delete directly.
CREATE TABLE IF NOT EXISTS trip_scans (
  id               SERIAL PRIMARY KEY,
  execution_id     INTEGER NOT NULL REFERENCES trip_executions(id),
  kind             VARCHAR(10) NOT NULL CHECK (kind IN ('bmcu_dc','ack')),
  teb_id           INTEGER,
  bmcu_id          INTEGER,
  file_path        TEXT NOT NULL,
  thumb_path       TEXT,
  mime             VARCHAR(40) NOT NULL,
  bytes            INTEGER NOT NULL,
  sha256           CHAR(64) NOT NULL,
  original_name    TEXT,
  uploaded_by      INTEGER,
  uploaded_by_name TEXT,
  uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ,
  deleted_by       INTEGER,
  is_proposed      BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT chk_trip_scans_teb CHECK (kind <> 'bmcu_dc' OR teb_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_trip_scans_exec ON trip_scans (execution_id) WHERE deleted_at IS NULL AND is_proposed = FALSE;
CREATE INDEX IF NOT EXISTS idx_trip_scans_teb  ON trip_scans (teb_id) WHERE deleted_at IS NULL AND is_proposed = FALSE;

CREATE TABLE IF NOT EXISTS trip_scan_change_requests (
  id                 SERIAL PRIMARY KEY,
  scan_id            INTEGER NOT NULL REFERENCES trip_scans(id),
  execution_id       INTEGER NOT NULL REFERENCES trip_executions(id),
  action             VARCHAR(10) NOT NULL CHECK (action IN ('replace','delete')),
  reason             TEXT NOT NULL,
  proposed_scan_ids  INTEGER[] NOT NULL DEFAULT '{}',
  status             VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by       INTEGER,
  requested_by_name  TEXT,
  requested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by         INTEGER,
  decided_by_name    TEXT,
  decided_at         TIMESTAMPTZ,
  decision_note      TEXT,
  token_hash         CHAR(64),
  token_expires_at   TIMESTAMPTZ
);
-- One open request per scan.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trip_scan_change_requests_open ON trip_scan_change_requests (scan_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_trip_scan_cr_token ON trip_scan_change_requests (token_hash) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_trip_scan_cr_exec  ON trip_scan_change_requests (execution_id);
