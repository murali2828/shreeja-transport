-- Migration 021 backfilled created_at via `DEFAULT NOW()`, which — being a
-- volatile default — stamped every PRE-EXISTING acknowledgement row with the
-- single moment the ALTER TABLE ran (the deploy time), not their real entry
-- date. That broke the TS report's "Ack Entry Date" mode for any date before
-- this fix: every historical row reported as entered "today".
--
-- The true entry timestamp was never captured for these rows, so ack_date
-- (the acknowledged business date) is the best available proxy — it's what
-- migration 021's original COALESCE fallback intended, but that fallback
-- never fired because the ALTER had already populated a non-null value.
--
-- Only touches rows still carrying that exact backfill timestamp, so any
-- genuinely-entered-today row is left untouched.
UPDATE trip_acknowledgements
   SET created_at = COALESCE(ack_date, created_at::date)::timestamptz
 WHERE created_at = '2026-08-06 04:37:43.872691+00';
