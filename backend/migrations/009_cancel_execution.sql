-- Add cancel_reason to trip_executions
ALTER TABLE trip_executions ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
