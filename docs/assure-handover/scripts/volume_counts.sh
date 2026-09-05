#!/bin/bash
# Read-only row-count report for the last 3 full calendar months, per the
# Assure handover's README §"VOLUME". Run ON THE SERVER, e.g.:
#
#   ./volume_counts.sh
#
# Adjust DB_CONTAINER if the DB container isn't named shreeja-db (QA uses
# shreeja-qa-db). No writes — SELECT COUNT(*) only.
set -euo pipefail
DB_CONTAINER="${DB_CONTAINER:-shreeja-db}"

docker exec -i "$DB_CONTAINER" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
\echo '-- Trip plans per month (last 3 full months) --'
SELECT date_trunc('month', plan_for_date)::date AS month, status, COUNT(*)
FROM trip_plans
WHERE plan_for_date >= date_trunc('month', now()) - INTERVAL '3 months'
  AND plan_for_date <  date_trunc('month', now())
GROUP BY 1, 2 ORDER BY 1, 2;

\echo '-- Trip executions per month, by status --'
SELECT date_trunc('month', te.execution_date)::date AS month, te.status, COUNT(*)
FROM trip_executions te
WHERE te.execution_date >= date_trunc('month', now()) - INTERVAL '3 months'
  AND te.execution_date <  date_trunc('month', now())
GROUP BY 1, 2 ORDER BY 1, 2;

\echo '-- BMCU loadings (trip_execution_bmcus) per month --'
SELECT date_trunc('month', teb.milk_date)::date AS month, COUNT(*), COUNT(*) FILTER (WHERE teb.is_deleted) AS deleted_rows
FROM trip_execution_bmcus teb
WHERE teb.milk_date >= date_trunc('month', now()) - INTERVAL '3 months'
  AND teb.milk_date <  date_trunc('month', now())
GROUP BY 1 ORDER BY 1;

\echo '-- Acknowledgements (receipts) per month --'
SELECT date_trunc('month', ta.ack_date)::date AS month, COUNT(*)
FROM trip_acknowledgements ta
WHERE ta.ack_date >= date_trunc('month', now()) - INTERVAL '3 months'
  AND ta.ack_date <  date_trunc('month', now())
GROUP BY 1 ORDER BY 1;

\echo '-- Third-party (direct customer) sales per month --'
SELECT date_trunc('month', s.created_at)::date AS month, COUNT(*)
FROM trip_third_party_sales s
WHERE s.created_at >= date_trunc('month', now()) - INTERVAL '3 months'
  AND s.created_at <  date_trunc('month', now())
GROUP BY 1 ORDER BY 1;

\echo '-- Distinct tankers and BMCUs active in the window --'
SELECT COUNT(DISTINCT tanker_id) AS distinct_tankers FROM trip_plans
WHERE plan_for_date >= date_trunc('month', now()) - INTERVAL '3 months';
SELECT COUNT(DISTINCT bmcu_id) AS distinct_bmcus FROM trip_execution_bmcus teb
JOIN trip_executions te ON te.id = teb.execution_id
JOIN trip_plans tp ON tp.id = te.trip_plan_id
WHERE tp.plan_for_date >= date_trunc('month', now()) - INTERVAL '3 months';
SQL
