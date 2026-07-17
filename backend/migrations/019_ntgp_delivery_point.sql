-- Capture the delivery point (dairy) from which a non-trip gate pass is issued.
ALTER TABLE non_trip_gate_passes
  ADD COLUMN IF NOT EXISTS delivery_point_id INTEGER REFERENCES delivery_points(id);
