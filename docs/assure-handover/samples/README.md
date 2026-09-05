# Sample Export Shapes (no live data included)

This environment has **no live database connection** (no docker/psql access), so this
folder contains no actual CSV data. A ready-to-run export script is expected to be
supplied separately (outside this documentation task) to pull real sample rows from a
live TMS database. This file documents, purely from the schema, what each planned
export file's GRAIN and join keys would be, so Assure can anticipate the shape before
real data arrives.

## `trips.csv` — one row per planned trip
- Grain: one row per `trip_plans.id`.
- Key: `trip_plans.id`.
- Joins: `tanker_id → tankers.id`, `route_id → route_masters.id`,
  `start_point_id → starting_points.id`, `delivery_point_id → delivery_points.id`,
  `created_by → users.id`.

## `executions.csv` — one row per actual trip run
- Grain: one row per `trip_executions.id`.
- Key: `trip_executions.id`.
- Joins: `trip_plan_id → trip_plans.id` (parent trip; use this to pull vehicle/route/
  delivery-point info from `trips.csv` rather than duplicating it), `executed_by` /
  `updated_by → users.id`.
- Note: at most one non-`closed`, non-`cancelled` execution exists per trip_plan_id at
  a time (app-enforced, not a DB constraint — see README "Natural keys"), but a
  cancelled execution followed by a fresh one for the same plan is possible, so
  `trip_plan_id` is NOT guaranteed unique in this file.

## `loadings.csv` — one row per BMCU pickup on an execution
- Grain: one row per `trip_execution_bmcus.id` (i.e. per BMCU per execution — a
  multi-BMCU trip produces multiple rows here for the same `execution_id`).
- Key: `trip_execution_bmcus.id`.
- Joins: `execution_id → trip_executions.id`, `bmcu_id → bmcus.id`,
  `source_bmcu_id → bmcus.id` (only for 'Internal Shifting' rows).
- Filter: exclude `is_deleted = TRUE` rows unless Assure specifically wants soft-deleted
  history.
- Companion file `loading_shifts.csv` (grain: one row per
  `trip_execution_bmcu_shifts.id`) carries the RMRD fat/SNF captured per BMCU per
  shift — join on `(execution_id, bmcu_seq_no)` back to `loadings.csv`'s
  `(execution_id, seq_no)`.

## `receipts.csv` — one row per acknowledgement (chamber) row
- Grain: one row per `trip_acknowledgements.id` (one row per chamber per execution —
  NEVER per BMCU; see README §6 Multi-pickup).
- Key: `trip_acknowledgements.id`.
- Joins: `execution_id → trip_executions.id`, `entered_by → users.id`.
- Important: to get a single "total received" figure per trip, SUM across all chamber
  rows sharing an `execution_id` — do not treat one row as "the" receipt for the trip.

## `third_party_sales.csv` — one row per direct-sale record
- Grain: one row per `trip_third_party_sales.id` (per BMCU per execution, since
  migration 033 added `bmcu_seq_no`).
- Key: `trip_third_party_sales.id`.
- Joins: `execution_id → trip_executions.id`, `bmcu_seq_no` → the matching
  `loadings.csv` row's `seq_no` within the same `execution_id`.
- No rate/amount field exists on this table — see mapping.md.

## `billing_lines.csv` — one row per trip's transporter-payment billing line
- Grain: one row per `billing_run_trips.id`.
- Key: `billing_run_trips.id`.
- Joins: `run_id → billing_runs.id`, `execution_id → trip_executions.id`,
  `vendor_id → vendors.id`, `rate_id → tanker_rates.id`.
- **This file answers "how much was the transporter paid for this trip", NOT "what was
  the milk worth"** — see README §4 and mapping.md before using it for reconciliation
  math.

## `gate_pass_events.csv` — one row per print event
- Grain: one row per `trip_document_prints.id`.
- Key: `trip_document_prints.id`.
- Joins: `trip_plan_id → trip_plans.id`.
- Use `MIN(printed_at)` per `(trip_plan_id, doc_type)` to get the operational
  trip-start ('gate_pass') / arrival ('coa') / unload-complete ('unloading') timestamp;
  later rows for the same `(trip_plan_id, doc_type)` are reprints (`print_no > 1`).

## Masters (small, low-churn — export in full each time rather than incrementally)
- `tankers.csv` ← `tankers` (+ `vendors` via `vendor_id`)
- `bmcus.csv` ← `bmcus`
- `delivery_points.csv` ← `delivery_points`
- `routes.csv` ← `route_masters` (+ `route_bmcus` for the ordered BMCU sequence per
  route, if Assure needs it)
- `users.csv` ← `users` (id, user_id, full_name, role — no employee code exists, see
  identity.md)

## What real volume/row-count figures will show
Not available from this environment — no live DB connection here. Once the export
script (to be supplied separately) is run against production, real row counts per
month for `trip_plans`, `trip_executions`, `trip_execution_bmcus`, and
`trip_acknowledgements` should be captured and added to this file for Assure's
capacity planning.
