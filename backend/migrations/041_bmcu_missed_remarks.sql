-- Remarks recorded against a BMCU that was missed (not planned / not
-- collected) on a given day, from the Active Trips "BMCUs Missed" list.
CREATE TABLE IF NOT EXISTS bmcu_missed_remarks (
  id          SERIAL PRIMARY KEY,
  bmcu_id     INTEGER NOT NULL REFERENCES bmcus(id) ON DELETE CASCADE,
  missed_date DATE    NOT NULL,
  remark      VARCHAR(60) NOT NULL,
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (bmcu_id, missed_date)
);
