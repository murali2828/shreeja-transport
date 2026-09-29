-- Remember that the executor explicitly chose Starting / Delivery Point on
-- this execution, so the screen shows the saved values instead of asking
-- again on every open (the plan's defaults are still not inherited silently).
ALTER TABLE trip_executions ADD COLUMN IF NOT EXISTS points_confirmed BOOLEAN NOT NULL DEFAULT FALSE;
