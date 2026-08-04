-- Entry timestamp for acknowledgements (drives the TS report's
-- "by acknowledgement entry date" mode). Both ack write paths are
-- delete+reinsert, so this records the LAST entry/correction date.
ALTER TABLE trip_acknowledgements ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
UPDATE trip_acknowledgements
   SET created_at = COALESCE(ack_date, CURRENT_DATE)::timestamptz
 WHERE created_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ta_created ON trip_acknowledgements (created_at);
