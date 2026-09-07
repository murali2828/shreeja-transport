-- WheelsEye GPS tanker tracking (services/wheelseye.js, jobs/wheelseyePoll.js,
-- routes/tracking.js). The poller pulls every vehicle's current position from
-- the WheelsEye API and keeps two tables:
--   tanker_gps_latest  — one row per vehicle, the newest position (upserted)
--   tanker_gps_history — append-only trail used for the 24 h route line
-- vehicle_number is normalised (upper-case, non-alphanumerics stripped) so
-- "KA 01 AB 1234" in WheelsEye matches "KA01-AB-1234" in the tanker master.
-- tanker_id is resolved at upsert time; NULL means the registration number in
-- WheelsEye does not match any tanker and is surfaced as "unmatched" in the UI.

CREATE TABLE IF NOT EXISTS tanker_gps_latest (
  vehicle_number     TEXT PRIMARY KEY,              -- normalised
  vehicle_number_raw TEXT,                          -- as sent by WheelsEye
  tanker_id          INTEGER REFERENCES tankers(id),
  device_number      TEXT,
  latitude           NUMERIC(10,7),
  longitude          NUMERIC(10,7),
  speed              NUMERIC(6,2),                  -- km/h
  ignition           BOOLEAN,
  angle              INTEGER,
  accurate           BOOLEAN,
  location           TEXT,                          -- reverse-geocoded address (optional)
  gps_time           TIMESTAMPTZ,                   -- WheelsEye createdDate (unix seconds)
  received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tanker_gps_latest_tanker_idx ON tanker_gps_latest (tanker_id);

-- No FK on tanker_id: the trail must survive tanker deletion (same reasoning
-- as the log tables in migration 013).
CREATE TABLE IF NOT EXISTS tanker_gps_history (
  id             BIGSERIAL PRIMARY KEY,
  vehicle_number TEXT NOT NULL,                     -- normalised
  tanker_id      INTEGER,
  latitude       NUMERIC(10,7),
  longitude      NUMERIC(10,7),
  speed          NUMERIC(6,2),
  ignition       BOOLEAN,
  angle          INTEGER,
  gps_time       TIMESTAMPTZ NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vehicle_number, gps_time)                 -- re-polls never duplicate a point
);
CREATE INDEX IF NOT EXISTS tanker_gps_history_tanker_time_idx ON tanker_gps_history (tanker_id, gps_time DESC);
CREATE INDEX IF NOT EXISTS tanker_gps_history_time_idx        ON tanker_gps_history (gps_time);
