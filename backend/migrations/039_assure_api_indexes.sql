-- Shreeja Assure integration API (routes/integrations.js, docs/assure-handover/
-- API_SPEC_v1.md §7). The /trips and /loadings endpoints poll incrementally on
-- updated_at (GREATEST(tp.updated_at, te.updated_at) / te.updated_at). The other
-- indexes the spec lists — trip_plans(plan_for_date), trip_executions(trip_plan_id),
-- trip_execution_bmcus(execution_id), trip_acknowledgements(execution_id) — already
-- exist from earlier migrations; only these two were missing.
CREATE INDEX IF NOT EXISTS idx_trip_plans_updated_at      ON trip_plans (updated_at);
CREATE INDEX IF NOT EXISTS idx_trip_executions_updated_at ON trip_executions (updated_at);
