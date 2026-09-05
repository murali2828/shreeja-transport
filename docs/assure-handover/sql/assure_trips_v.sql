-- PROPOSED VIEW — NOT APPLIED TO ANY DATABASE.
-- One row per trip_executions.id — the actual (as opposed to planned) trip.
-- Cancelled/deleted rows are exposed via status columns, never filtered out here;
-- the consumer (Assure) decides its own inclusion rule.
--
-- Gaps carried through as NULL/absent, not invented:
--   - no seal_no, no driver_code (only trip_plans.driver_name free text)
--   - no gross/tare weight (not part of this "trip" concept at all — see receipts view)

CREATE OR REPLACE VIEW assure_trips_v AS
SELECT
  te.id                    AS trip_ref,          -- stable per-actual-trip key
  tp.id                    AS plan_ref,
  t.tanker_number          AS vehicle_no,
  rm.route_no              AS route_code,
  rm.route_name            AS route_name,
  dp.name                  AS dest_dairy_name,   -- no code column exists on delivery_points
  sp.name                  AS start_point_name,
  tp.plan_for_date         AS plan_for_date,
  te.execution_date        AS execution_date,
  tp.driver_name           AS driver_name_free_text,  -- planning-time only, free text, not a code
  te.dc_number             AS dc_number,
  te.actual_km             AS actual_km,
  te.calculated_km         AS calculated_km,
  te.total_qty_litres      AS loaded_litres,
  te.total_qty_kgs         AS loaded_kg,          -- computed at KG_FACTOR=1.0285, see README
  te.avg_fat               AS loaded_avg_fat_pct,
  te.avg_snf               AS loaded_avg_snf_pct,
  te.status                AS execution_status,   -- in_progress|saved|pending_ack|closed|cancelled
  te.cancel_reason         AS cancel_reason,
  tp.status                AS plan_status,        -- draft|published|cancelled|deleted
  tp.is_sale_tanker        AS is_sale_tanker,
  (SELECT MIN(printed_at) FROM trip_document_prints p
     WHERE p.trip_plan_id = tp.id AND p.doc_type = 'gate_pass')  AS trip_start_at,
  (SELECT MIN(printed_at) FROM trip_document_prints p
     WHERE p.trip_plan_id = tp.id AND p.doc_type = 'coa')        AS arrived_at,
  (SELECT MIN(printed_at) FROM trip_document_prints p
     WHERE p.trip_plan_id = tp.id AND p.doc_type = 'unloading')  AS unloaded_at,
  te.created_at            AS created_at,
  te.updated_at            AS updated_at          -- already exists — safe to poll incrementally
FROM trip_executions te
JOIN trip_plans tp            ON tp.id = te.trip_plan_id
LEFT JOIN tankers t            ON t.id = tp.tanker_id
LEFT JOIN route_masters rm     ON rm.id = tp.route_id
LEFT JOIN starting_points sp   ON sp.id = tp.start_point_id
LEFT JOIN delivery_points dp   ON dp.id = tp.delivery_point_id;

-- Per-BMCU-pickup legs for multi-BMCU trips (join on trip_ref):
CREATE OR REPLACE VIEW assure_trip_legs_v AS
SELECT
  teb.execution_id        AS trip_ref,
  teb.seq_no               AS seq_no,
  b.bmcu_code              AS bmcu_code,
  b.bmcu_name              AS bmcu_name,
  teb.milk_date            AS milk_date,
  teb.shift                AS shift,
  teb.qty_litres           AS litres,
  teb.qty_kgs              AS kg,
  teb.fat_pct              AS fat_pct,
  teb.snf_pct              AS snf_pct,
  teb.chamber              AS chamber,
  teb.description          AS description,        -- RMRD | Balance Milk | Internal Shifting
  sb.bmcu_code             AS source_bmcu_code,    -- only for Internal Shifting rows
  teb.is_deleted           AS is_deleted
FROM trip_execution_bmcus teb
JOIN bmcus b            ON b.id = teb.bmcu_id
LEFT JOIN bmcus sb       ON sb.id = teb.source_bmcu_id;
