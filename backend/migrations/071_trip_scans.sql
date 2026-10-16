-- Migration 071: trip scans — BMCU dispatch challans and plant acknowledgement slips (owner, 2026-10-16)
-- Logistics attaches the scanned / photographed BMCU dispatch challan (DC) to each BMCU line of a
-- trip execution (kind 'bmcu_dc', teb_id = trip_execution_bmcus.id) and the plant acknowledgement
-- slip to the trip (kind 'ack', teb_id NULL). Several files per line / ack are allowed (pages).
-- Bytes live on the uploads volume under UPLOAD_DIR/trip-scans/YYYY/MM/<sha256>.<ext>
-- (content-addressed, ADR-025); this table holds metadata only. Scans never change trip data,
-- so they may be added to any non-cancelled trip, closed and billed ones included.
-- Pending is computed, never stored: DC pending = live BMCU row (is_deleted = false) without a
-- DC scan; ack pending = acknowledged trip without an ack scan. Deletes are soft (deleted_at).
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
  CONSTRAINT chk_trip_scans_teb CHECK (kind <> 'bmcu_dc' OR teb_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_trip_scans_exec ON trip_scans (execution_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_trip_scans_teb  ON trip_scans (teb_id) WHERE deleted_at IS NULL;
