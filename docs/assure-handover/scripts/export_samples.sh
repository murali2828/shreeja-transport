#!/bin/bash
# Read-only export of one week of TMS data for the Shreeja Assure handover.
# Run this ON THE SERVER where the TMS database container is reachable, e.g.:
#
#   FROM_DATE=2026-08-01 TO_DATE=2026-08-07 ./export_samples.sh
#
# Defaults to the most recent complete Mon-Sun week if FROM_DATE/TO_DATE are
# not set. Writes CSVs to ./assure_samples_<FROM_DATE>_<TO_DATE>/ in the
# current directory. Everything here is SELECT-only against a container named
# shreeja-qa-db or shreeja-db (adjust DB_CONTAINER below if different) —
# no writes, no schema changes.
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-shreeja-db}"
FROM_DATE="${FROM_DATE:-$(date -d 'last monday - 7 days' +%Y-%m-%d)}"
TO_DATE="${TO_DATE:-$(date -d "$FROM_DATE + 6 days" +%Y-%m-%d)}"
OUT="assure_samples_${FROM_DATE}_${TO_DATE}"
mkdir -p "$OUT"

psql_copy() { # psql_copy <out_file> <sql>
  docker exec -i "$DB_CONTAINER" sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"\\copy ($2) TO STDOUT CSV HEADER\"" > "$OUT/$1"
  echo "  wrote $1: $(( $(wc -l < "$OUT/$1") - 1 )) rows"
}

echo "== Exporting TMS samples for $FROM_DATE .. $TO_DATE into $OUT/ =="

# 1. trips — one row per planned trip (join to route for readable start/testing/
#    delivery point names; driver_name masked to first-name-only + '***').
psql_copy "trips_${FROM_DATE}_${TO_DATE}.csv" "
  SELECT tp.id AS trip_plan_id, tp.trip_no, tp.plan_date, tp.plan_for_date,
         tp.status, t.tanker_number, rm.route_name,
         sp.name AS start_point, dpt.name AS testing_point, dp.name AS delivery_point,
         tp.shifts_milk, tp.expected_km, tp.expected_total_qty,
         tp.total_cost, tp.per_liter_cost,
         regexp_replace(tp.driver_name, '(^\S+).*', '\1 ***') AS driver_name_masked,
         regexp_replace(tp.loader_name, '(^\S+).*', '\1 ***') AS loader_name_masked,
         tp.remarks, tp.created_at, tp.updated_at
  FROM trip_plans tp
  LEFT JOIN tankers t          ON t.id = tp.tanker_id
  LEFT JOIN route_masters rm   ON rm.id = tp.route_id
  LEFT JOIN starting_points sp ON sp.id = tp.start_point_id
  LEFT JOIN testing_points dpt ON dpt.id = tp.testing_point_id
  LEFT JOIN delivery_points dp ON dp.id = tp.delivery_point_id
  WHERE tp.plan_for_date BETWEEN '$FROM_DATE' AND '$TO_DATE'
  ORDER BY tp.plan_for_date, tp.trip_no
"

# 2. loadings — one row per BMCU pickup (trip_execution_bmcus), joined back to
#    its trip and the delivered BMCU name.
psql_copy "loadings_${FROM_DATE}_${TO_DATE}.csv" "
  SELECT teb.id AS loading_id, teb.execution_id, te.trip_plan_id, tp.trip_no,
         t.tanker_number, teb.seq_no, b.bmcu_code, b.bmcu_name,
         teb.milk_date, teb.shift, teb.qty_litres, teb.qty_kgs,
         teb.fat_pct, teb.snf_pct, teb.kg_fat, teb.kg_snf,
         teb.description, teb.chamber, teb.rmrd_qty, teb.is_deleted
  FROM trip_execution_bmcus teb
  JOIN trip_executions te ON te.id = teb.execution_id
  JOIN trip_plans tp      ON tp.id = te.trip_plan_id
  LEFT JOIN tankers t     ON t.id = tp.tanker_id
  JOIN bmcus b            ON b.id = teb.bmcu_id
  WHERE tp.plan_for_date BETWEEN '$FROM_DATE' AND '$TO_DATE'
  ORDER BY tp.plan_for_date, tp.trip_no, teb.seq_no
"

# 3. receipts — one row per acknowledgement (per chamber) at the delivery point.
psql_copy "receipts_${FROM_DATE}_${TO_DATE}.csv" "
  SELECT ta.id AS receipt_id, ta.execution_id, te.trip_plan_id, tp.trip_no,
         t.tanker_number, dp.name AS delivery_point, ta.ack_date, ta.chamber,
         ta.qty_litres, ta.qty_kgs, ta.fat_pct, ta.snf_pct, ta.kg_fat, ta.kg_snf,
         ta.temperature, ta.description
  FROM trip_acknowledgements ta
  JOIN trip_executions te ON te.id = ta.execution_id
  JOIN trip_plans tp      ON tp.id = te.trip_plan_id
  LEFT JOIN tankers t     ON t.id = tp.tanker_id
  LEFT JOIN delivery_points dp ON dp.id = tp.delivery_point_id
  WHERE tp.plan_for_date BETWEEN '$FROM_DATE' AND '$TO_DATE'
  ORDER BY tp.plan_for_date, tp.trip_no, ta.chamber
"

# 4. third_party_sales — direct-from-BMCU milk sales (closest analog to a
#    genuine external-customer transaction TMS captures a quantity/quality for).
psql_copy "third_party_sales_${FROM_DATE}_${TO_DATE}.csv" "
  SELECT s.id, s.execution_id, te.trip_plan_id, tp.trip_no, t.tanker_number,
         s.bmcu_seq_no, s.qty_litres, s.qty_kgs, s.fat_pct, s.snf_pct,
         s.kg_fat, s.kg_snf, s.customer_name, s.remarks, s.created_at
  FROM trip_third_party_sales s
  JOIN trip_executions te ON te.id = s.execution_id
  JOIN trip_plans tp      ON tp.id = te.trip_plan_id
  LEFT JOIN tankers t     ON t.id = tp.tanker_id
  WHERE tp.plan_for_date BETWEEN '$FROM_DATE' AND '$TO_DATE'
  ORDER BY tp.plan_for_date, tp.trip_no
"

# 5. billing_run_trips — transporter PAYMENT lines that fall in this window
#    (billed per km, NOT per litre/quality — see docs/assure-handover/README.md).
psql_copy "payments_${FROM_DATE}_${TO_DATE}.csv" "
  SELECT brt.id, brt.run_id, brt.execution_id, brt.plan_for_date, brt.tanker_number,
         brt.vendor_name, brt.state, brt.transport_type, brt.system_km, brt.billed_km,
         brt.rate_per_km, brt.amount, brt.excluded, brt.is_sale_tanker, brt.remarks
  FROM billing_run_trips brt
  WHERE brt.plan_for_date BETWEEN '$FROM_DATE' AND '$TO_DATE'
  ORDER BY brt.plan_for_date, brt.tanker_number
"

# Masters (small, exported in full — not date-scoped).
psql_copy "vehicles.csv"  "SELECT id, tanker_number, compartments, capacity_litres, per_km_rate, is_active FROM tankers ORDER BY tanker_number"
psql_copy "bmcus.csv"     "SELECT id, bmcu_code, bmcu_name, district, state, is_active FROM bmcus ORDER BY bmcu_code"
psql_copy "customers.csv" "SELECT id, name, receiver_name, is_active FROM delivery_points ORDER BY name"
psql_copy "routes.csv"    "SELECT rm.id, rm.route_name, sp.name AS start_point, dp.name AS delivery_point, rm.distance_km, rm.is_active FROM route_masters rm LEFT JOIN starting_points sp ON sp.id=rm.start_point_id LEFT JOIN delivery_points dp ON dp.id=rm.delivery_point_id ORDER BY rm.route_name"

echo "== Done. Files are in $OUT/ — nothing was written to the database. =="
echo "Masking note: driver_name/loader_name are reduced to first name + '***'. No mobile/phone columns exist in this schema to mask."
