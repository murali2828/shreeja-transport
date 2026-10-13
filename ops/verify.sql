-- Shreeja TMS — printed after every restore (ops/bin/restore.sh, scratch cluster).
-- Compare these with live before any --swap.
SELECT 'now() in restored cluster:   ' || now();
SELECT 'latest audit entry:          ' || COALESCE(max(created_at)::text, '-') FROM audit_logs;
SELECT 'latest trip plan date:       ' || COALESCE(max(plan_for_date)::text, '-') FROM trip_plans;
SELECT 'latest acknowledgement:      ' || COALESCE(max(created_at)::text, '-') FROM trip_acknowledgements;
SELECT rpad(t, 28) || n FROM (
            SELECT 'users' AS t, count(*)::text AS n FROM users
  UNION ALL SELECT 'tankers', count(*)::text FROM tankers
  UNION ALL SELECT 'bmcus', count(*)::text FROM bmcus
  UNION ALL SELECT 'trip_plans', count(*)::text FROM trip_plans
  UNION ALL SELECT 'trip_executions', count(*)::text FROM trip_executions
  UNION ALL SELECT 'trip_acknowledgements', count(*)::text FROM trip_acknowledgements
  UNION ALL SELECT 'billing_runs', count(*)::text FROM billing_runs
  UNION ALL SELECT 'billing_run_trips', count(*)::text FROM billing_run_trips
  UNION ALL SELECT 'qa_dispatch_entries', count(*)::text FROM qa_dispatch_entries) x;
