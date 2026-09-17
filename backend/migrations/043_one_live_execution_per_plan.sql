-- One live (non-cancelled) execution per trip plan.
--
-- The start-execution guard only refused a plan with an OPEN execution, so
-- "Start" on an already-closed plan created a second execution; a double
-- click could also create two in the same millisecond. Both showed once on
-- Active Trips (one row per plan) but twice in billing.
--
-- Cleanup rule for existing duplicates, per plan: keep the execution with
-- acknowledgement data, preferring the latest id; cancel the rest with a
-- reason that names the kept execution so the choice is auditable.
--
-- The original status CHECK (001) never listed 'cancelled', so the cancel
-- endpoint (009) has always failed on this table; widen it first.
ALTER TABLE trip_executions DROP CONSTRAINT IF EXISTS trip_executions_status_check;
ALTER TABLE trip_executions ADD CONSTRAINT trip_executions_status_check
  CHECK (status IN ('in_progress','saved','pending_ack','closed','cancelled'));

WITH ranked AS (
  SELECT te.id, te.trip_plan_id,
         ROW_NUMBER() OVER (
           PARTITION BY te.trip_plan_id
           ORDER BY (EXISTS (SELECT 1 FROM trip_acknowledgements a WHERE a.execution_id = te.id)) DESC,
                    (te.status = 'closed') DESC,
                    te.id DESC) AS rn,
         FIRST_VALUE(te.id) OVER (
           PARTITION BY te.trip_plan_id
           ORDER BY (EXISTS (SELECT 1 FROM trip_acknowledgements a WHERE a.execution_id = te.id)) DESC,
                    (te.status = 'closed') DESC,
                    te.id DESC) AS keep_id
  FROM trip_executions te
  WHERE te.status <> 'cancelled'
)
UPDATE trip_executions te
   SET status = 'cancelled',
       cancel_reason = 'Duplicate execution of the same plan — auto-cancelled by migration 043, kept execution #' || r.keep_id,
       updated_at = NOW()
  FROM ranked r
 WHERE r.id = te.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_trip_executions_live_plan
  ON trip_executions (trip_plan_id) WHERE status <> 'cancelled';
