# Sample Exports — one week of production data

Produced 2026-09-05 from **production** with `scripts/export_samples.sh` (read-only,
`\copy ... TO STDOUT` only) for the week **2026-08-01 → 2026-08-07**. The CSVs live in
this folder. Column names are TMS's native column names (or explicit aliases shown in
the script); dates are ISO `YYYY-MM-DD`; blanks are empty fields, not `NULL` text.

## What was actually exported

| File | Grain (one row = …) | Rows | Notes |
|---|---|---|---|
| `trips_2026-08-01_2026-08-07.csv` | one planned trip (`trip_plans.id`) | 350 | includes `status` — cancelled/deleted rows are **kept, not filtered** |
| `loadings_2026-08-01_2026-08-07.csv` | one BMCU pickup on an execution (`trip_execution_bmcus.id`) | 1,150 | **filter `is_deleted = FALSE`** for reconciliation; ~3.3 rows per trip |
| `receipts_2026-08-01_2026-08-07.csv` | one acknowledgement row = one **chamber** (`trip_acknowledgements.id`) | 951 | this IS the customer weighbridge figure, transcribed — SUM chambers per `execution_id` for a per-trip receipt |
| `third_party_sales_2026-08-01_2026-08-07.csv` | one direct-sale record | **0** | feature shipped 2026-08-31; no production history yet |
| `payments_2026-08-01_2026-08-07.csv` | one transporter-billing line (`billing_run_trips.id`) | **0** | **not a bug** — see below |
| `vehicles.csv` | one tanker | 90 | master, full |
| `bmcus.csv` | one BMCU | 164 | master, full |
| `customers.csv` | one delivery point | 11 | master, full — these are the "customer plants" |
| `routes.csv` | one route | 66 | master, full |

**Why `payments` is empty for this week:** Shreeja deliberately did not run the billing
cycle for the 2nd fortnight of July or the 1st fortnight of August 2026 (see
`BILLING_CARRY_FORWARD_FLOOR` in `backend/src/routes/billing.js`). `billing_run_trips`
rows only exist for periods that were billed, so 1–7 Aug has none. For a populated
payments sample, re-run the script for a billed window, e.g. the 1st fortnight of
July: `FROM_DATE=2026-07-01 TO_DATE=2026-07-07`. Remember these are transporter
per-km payments, not milk value (README §4).

**Masking:** `driver_name` and `loader_name` are reduced to first name + `***`. No
mobile/phone columns exist in this schema. Everything else (codes, quantities, fat/SNF,
timestamps, amounts) is real.

**Join keys:** `trips.trip_plan_id` ← `loadings.trip_plan_id` / `receipts.trip_plan_id`
/ `payments.execution_id→…`; `loadings.execution_id` = `receipts.execution_id` =
`third_party_sales.execution_id`. `loadings.seq_no` = `third_party_sales.bmcu_seq_no`
within the same `execution_id`. Masters join by name (`tanker_number`, `bmcu_code`,
`delivery_point` name) as exported, or by `id`.

**Planned files NOT produced by this script** (the sections below describe them from
the schema so Assure can request them): `executions.csv` (its columns —
`execution_id`, `trip_plan_id`, `status` — are already embedded in `loadings` and
`receipts`), `loading_shifts.csv` (per-shift RMRD fat/SNF), `gate_pass_events.csv`
(OUT/IN timestamps), `users.csv`. Say which are wanted and they can be added to the
script.

---

## Schema-level grain and join notes (all files, including not-yet-exported ones)

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

## Real volume / row-count figures
Captured from production on 2026-09-05 — see the **Volume** section of `../README.md`
for the monthly table (July/Aug ≈ 1,100–1,400 closed executions, 4,500–5,300 BMCU
loadings and 3,000–4,500 acknowledgement rows per month; 86 tankers, 142 BMCUs).
