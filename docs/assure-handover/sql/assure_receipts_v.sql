-- PROPOSED VIEW — NOT APPLIED TO ANY DATABASE.
-- One row per trip_acknowledgements.id (one row per CHAMBER per execution —
-- NEVER per BMCU; a multi-BMCU trip's customer-end reading is always blended
-- across all its BMCUs — see README §6 Multi-pickup).
--
-- GAP: trip_acknowledgements has no updated_at column today (only created_at,
-- which migration 021's own comment documents as "last entry/correction date",
-- not first-entry date, because both ack write paths are delete+reinsert).
-- This view exposes created_at as-is and does NOT invent an updated_at column
-- that doesn't exist in the base table — see gaps.md for the proposed fix.

CREATE OR REPLACE VIEW assure_receipts_v AS
SELECT
  ta.id                    AS receipt_ref,
  ta.execution_id          AS trip_ref,
  dp.name                  AS dest_dairy_name,     -- no code column exists on delivery_points
  ta.ack_date              AS receipt_date,        -- user-entered business date
  ta.chamber               AS chamber,
  ta.qty_litres            AS net_litres,
  ta.qty_kgs               AS net_kg,              -- user-typed value, preserved verbatim
  ta.fat_pct               AS fat_pct,
  ta.snf_pct               AS snf_pct,
  ta.kg_fat                AS kg_fat,
  ta.kg_snf                AS kg_snf,
  ta.temperature            AS temperature_free_text,  -- free text, NOT numeric
  ta.description            AS description_free_text,
  u.user_id                 AS entered_by_login,       -- login handle, not an employee code — see identity.md
  ta.created_at             AS created_at              -- see GAP note above; no updated_at exists
FROM trip_acknowledgements ta
JOIN trip_executions te   ON te.id = ta.execution_id
JOIN trip_plans tp        ON tp.id = te.trip_plan_id
LEFT JOIN delivery_points dp ON dp.id = tp.delivery_point_id
LEFT JOIN users u          ON u.id = ta.entered_by;
