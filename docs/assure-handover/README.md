# TMS ↔ Shreeja Assure Handover — Data Model for the BMCU→Tanker→Customer Hop

This document describes, from the actual TMS (Shreeja Secondary Transport) code and
migrations only, the data model covering the hop Assure needs: **BMCU dispatch →
tanker trip → customer-plant receipt/acknowledgement → payment to Shreeja's
transporters (not milk-value payment)**.

Everything below is traceable to a specific migration file or source file. Where the
code does not say something, this document says "not captured in TMS" or "not
confirmed from this codebase" rather than guessing.

Companion docs in this folder:
- `mapping.md` — column-by-column mapping of Assure's `proc_transport_trip_raw` /
  `proc_dairy_receipt_raw` to TMS.
- `access.md` — proposed read-only views / API for Assure to pull data.
- `gaps.md` — concrete list of what TMS does not capture today.
- `identity.md` — code/identifier format notes (BMCU code, tanker number, users).
- `samples/README.md` — planned export file shapes (no live DB access in this
  environment, so no real CSVs are included).

---

## 0. TOP-LINE WARNINGS (read this first)

1. **KG_FACTOR is 1.0285 — AGREED: Assure will use 1.0285 too (decision 2026-09-05).**
   TMS converts litres→kg using `KG_FACTOR = 1.0285`
   (`backend/src/services/executionData.js:13`, and duplicated as `KG = 1.0285` in
   `backend/src/routes/analytics.js:17`). The original Assure brief assumed 1.028 kg/L;
   that would have been a ~0.05% systematic difference on every kg figure. **Resolved:
   Assure has confirmed it will adopt 1.0285**, so TMS-origin kg figures reconcile
   exactly. Keep this as a shared config constant on both sides rather than
   hardcoding independently, so any future change is made in lockstep.

2. **TMS billing pays the TRANSPORTER (tanker vendor) per kilometre travelled — it does
   NOT pay for milk value at all.** See `backend/src/routes/billing.js:1-9` (top
   comment) and `tanker_rates`/`billing_run_trips` in migrations 024/025: `amount =
   billed_km × rate_per_km`. There is no `rate_per_litre` or milk-value amount
   anywhere in TMS. Assure's `proc_dairy_receipt_raw.rate_per_litre` / `amount`
   fields have **no TMS equivalent** — see `mapping.md`.

3. **`trip_acknowledgements` IS the customer's weighbridge reading, transcribed by
   Shreeja's team (confirmed by Shreeja, 2026-09-05).** The acknowledgement row's
   `qty_litres` / `qty_kgs` / `fat_pct` / `snf_pct` / `temperature` are typed into TMS
   from the customer plant's own weighbridge + lab slip — they are NOT an independent
   Shreeja measurement. So for reconciliation, the acknowledgement is the customer-end
   figure and the correct thing to compare against BMCU dispatch.
   What the customer slip carries that TMS does **not** store: gross/tare weight (only
   the NET figure is entered), CLR, acidity, a numeric temperature (`temperature` is a
   free-text VARCHAR), grade, an accepted/rejected split, and the customer's own
   slip/GRN/challan number. Those must come from a customer-provided file if Assure
   needs them — see `gaps.md`.

4. **Multi-BMCU trips have exactly ONE blended acknowledgement per chamber, never
   per-BMCU.** A `trip_execution` can dispatch from several BMCUs
   (`trip_execution_bmcus`, one row per BMCU pickup) but `trip_acknowledgements` is
   keyed only by `execution_id` + `chamber` — there is no column linking an
   acknowledgement row back to one BMCU. **Per-BMCU customer-end quality/quantity
   attribution is not possible from TMS data as it exists today.**

5. **Executions/acknowledgements are delete+reinsert, not append-only history.**
   `applyExecutionData` (`backend/src/services/executionData.js`) and
   `POST /:id/acknowledgements` (`backend/src/routes/executions.js:401-448`) both do
   `DELETE ... WHERE execution_id=$1` then re-insert. There is no row-level history of
   prior values (only `trip_executions.updated_at`/`updated_by` show *that* something
   changed, not *what*). Reconciling against an execution that is not yet `status='closed'`
   risks seeing data mid-edit.

---

## 1. Trip / Plan (the planned tanker journey)

**Table: `trip_plans`** (`backend/migrations/001_base_schema.sql:94-117`, further
altered by migrations 002/004/011/030)

| Column | Type | Null? | Example | Meaning |
|---|---|---|---|---|
| id | SERIAL PK | no | 4821 | Internal numeric id |
| plan_date | DATE | no | 2026-05-24 | Date the plan was CREATED (planning date) |
| plan_for_date | DATE | no | 2026-05-25 | Date the trip is planned to RUN |
| trip_no | INTEGER | yes | 1 | Trip sequence number that day (not globally unique) |
| route_id | INT FK route_masters | yes | 12 | Named route (optional) |
| tanker_id | INT FK tankers | yes | 57 | Assigned tanker |
| start_point_id | INT FK starting_points | yes | 2 | Loading start point (e.g. a dairy) |
| testing_point_id | INT FK testing_points | yes | 1 | Optional lab testing stop |
| delivery_point_id | INT FK delivery_points | no (app-enforced) | 3 | Destination "plant"/customer — see §3 for what this really is |
| shifts_milk | VARCHAR(20) | yes | '18E19M' | Free-text shift code (planning-level, NOT the per-BMCU AM/PM enum — see §6) |
| expected_km | NUMERIC(8,2) | yes | 620.00 | Planner-entered expected distance |
| expected_utilization_pct | NUMERIC(6,2) | yes | 84.5 | Computed: expected_total_qty / tanker capacity |
| expected_total_qty | NUMERIC(12,2) | yes | 11570.00 | Sum of planned per-BMCU expected_qty (litres) |
| total_cost | NUMERIC(12,2) | yes | 34720.00 | expected_km × tanker.per_km_rate (planning estimate, NOT the billing amount — see §4) |
| per_liter_cost | NUMERIC(8,4) | yes | 3.0009 | total_cost / expected_total_qty |
| driver_name | VARCHAR(100) | yes | 'Sample Driver' | **Free text**, entered by the planner — not a driver code/master (see §6/identity.md) |
| loader_name | VARCHAR(100) | yes | 'Sample Loader' | Free text |
| remarks | TEXT | yes | | Free text |
| status | VARCHAR(20) | no, default 'draft' | 'published' | CHECK: draft / published / cancelled / deleted (migration 011 added 'deleted') |
| is_sale_tanker | BOOLEAN | no, default FALSE | | Added migration 030 — planner flag: this trip's milk is sold at the BMCU, never delivered to a plant (see billing/gaps notes) |
| created_by | INT FK users | yes | | Planner who created it |
| created_at / updated_at | TIMESTAMP | | | |

**Table: `trip_plan_bmcus`** (one row per planned BMCU pickup on the trip)
`id, trip_plan_id, seq_no, bmcu_id, shift_code, expected_qty, description
('RMRD'|'Balance Milk', default 'RMRD' — migration 003)`.

Natural key: `(trip_plan_id, seq_no)`.

---

## 2. Execution / Loading at the BMCU (the actual pickup)

**Table: `trip_executions`** (`001_base_schema.sql:129-146`; altered by 009, 012, 022)

| Column | Type | Meaning |
|---|---|---|
| id | SERIAL PK | |
| trip_plan_id | INT FK trip_plans, NOT NULL | one execution created from one published plan |
| execution_date | DATE NOT NULL | date the execution was opened (usually = plan_for_date) |
| dc_number | VARCHAR(50) | optional delivery-challan number entered by the executor |
| actual_km | NUMERIC(8,2) | editable actual distance (seeded from calculated_km) |
| calculated_km, km_estimated_leg_count, km_incomplete | (migration 012) | auto road-distance computation (see `computeExecutionDistance`) — used for billing, NOT quality |
| total_qty_litres, total_qty_kgs | NUMERIC | SUM over non-deleted `trip_execution_bmcus` rows (dispatch total) |
| avg_fat, avg_snf | NUMERIC(6,4) | weighted-average % across BMCU rows |
| total_kg_fat, total_kg_snf | NUMERIC(12,4) | |
| status | VARCHAR(30), default 'in_progress' | CHECK: in_progress / saved / pending_ack / closed (see lifecycle §7) |
| cancel_reason | TEXT (migration 009) | set when status transitions to 'cancelled' (note: 'cancelled' is not in the CHECK list added in 001 but IS set by `executions.js:376` — Postgres allows it only if the CHECK constraint was loosened; not independently re-verified beyond the app code doing it) |
| executed_by | INT FK users | user who created the execution (POST) |
| updated_by | INT FK users (migration 022) | last user to PUT/save it |
| created_at / updated_at | TIMESTAMP | |

**Table: `trip_execution_bmcus`** — one row per BMCU pickup on this execution
(`001_base_schema.sql:148-168`; `chamber` widened by migration 010)

| Column | Type | Meaning |
|---|---|---|
| id | SERIAL PK | |
| execution_id | FK trip_executions | |
| seq_no | INTEGER | pickup order (1, 2, 3, …) — **confirms multi-BMCU pickup**: a single execution can and does have many rows |
| bmcu_id | FK bmcus | which BMCU |
| milk_date | DATE | the milk's own date (may differ from execution_date) |
| shift | VARCHAR(5) CHECK IN ('AM','PM') | shift of this specific BMCU pickup |
| qty_litres | NUMERIC(10,2) | litres loaded from this BMCU |
| qty_kgs | NUMERIC(12,4) | = qty_litres × 1.0285 (`calcKgs`, `executionData.js:15`) |
| fat_pct, snf_pct | NUMERIC(6,3) | **fat/SNF captured AT LOADING, per BMCU** — see note below |
| kg_fat, kg_snf | NUMERIC(12,4) | qty_kgs × pct/100 |
| description | VARCHAR(30) CHECK IN ('RMRD','Balance Milk','Internal Shifting') | what kind of row this is |
| source_bmcu_id | FK bmcus | for 'Internal Shifting' rows — where the milk actually came from |
| chamber | VARCHAR(20) (was VARCHAR(5) CHECK IN 'FC'/'MC'/'BC', loosened by migration 010 to allow comma-separated multi-chamber e.g. "FC,MC") | which tanker chamber it went into |
| dps_qty_litres, dps_qty_kgs | NUMERIC | a secondary/DPS quantity field alongside the main qty |
| rmrd_qty | NUMERIC(10,2) | legacy/duplicate RMRD qty field on this row (superseded in practice by the shift-rows table below) |
| is_deleted | BOOLEAN | soft-delete flag for this row |

Natural key: `(execution_id, seq_no)`.

**IMPORTANT on quality at loading**: `trip_execution_bmcus.fat_pct`/`snf_pct` DO exist
directly on the row, but the actual RMRD (raw milk reception data) fat/SNF entry path
used by the app is the separate shift-rows table below — check both.

**Table: `trip_execution_bmcu_shifts`** (migration 008) — the RMRD entry per BMCU per
shift within an execution:
`id, execution_id, bmcu_seq_no (matches trip_execution_bmcus.seq_no), milk_date, shift
('AM'|'PM'), rmrd_qty, rmrd_fat_pct, rmrd_snf_pct, created_at`.
This is a **replace-all** table (`applyExecutionData` deletes all rows for the
execution and reinserts — `executionData.js:225-236`). **So YES: fat% and SNF% at
loading/BMCU ARE captured in TMS**, per BMCU per shift, via `rmrd_fat_pct` /
`rmrd_snf_pct`. This is NOT a gap — correct any assumption otherwise.

**Table: `trip_execution_bmcu_entries`** (migration 026 / runtime DDL in
`executions.js`) — sub-entries for Balance Milk / Left Over / Lifted milk / New MPP /
Internal Shifting adjustments: `id, execution_id, bmcu_seq_no, bmcu_id, kind, category,
source_bmcu_id, qty_litres, fat_pct, snf_pct, remarks, created_at`. Free-text `remarks`
exist here (used in reports) but there is still no formal seal/slip number field.

**Driver at execution time**: `trip_executions` has NO driver column at all. The only
driver field in the whole chain is `trip_plans.driver_name` (free text, set once at
planning time, not per actual pickup/leg, not corrected if a different driver actually
drove). **TMS does not capture a driver per BMCU pickup, and does not capture a
driver code — only a free-text name at the plan level.**

---

## 3. Unloading / Receipt at the customer plant

**Table: `trip_acknowledgements`** (`001_base_schema.sql:171-184`; chamber constraint
loosened by migration 010; `created_at` added by migration 021 with a documented
backfill bug fixed in migration 023; `entered_by` added by migration 022)

| Column | Type | Meaning |
|---|---|---|
| id | SERIAL PK | |
| execution_id | FK trip_executions, NOT NULL | **one execution → one or more chamber rows, NEVER per-BMCU** |
| ack_date | DATE | the business date the milk is acknowledged for (user-entered) |
| chamber | VARCHAR(20) (was VARCHAR(5) CHECK 'FC'/'MC'/'BC', loosened by 010) NOT NULL | which tanker chamber this reading is for |
| qty_litres | NUMERIC(10,2) | litres received, per this migration's default `calcKgs` fallback captures the user-entered value; note `executions.js:419-421` explicitly preserves the user-typed kgs rather than deriving it, to avoid rounding drift |
| qty_kgs | NUMERIC(12,4) | kg received (user-entered value preserved in preference to litres×1.0285 — see comment at `executions.js:419`) |
| fat_pct, snf_pct | NUMERIC(6,3) | fat/SNF % **as measured at the delivery plant** |
| kg_fat, kg_snf | NUMERIC(12,4) | derived |
| temperature | VARCHAR(20) | **free text, not numeric** — e.g. could hold "4°C" or "Cold" |
| description | VARCHAR(50) | free text |
| created_at | TIMESTAMPTZ (migration 021, backfill-fixed by 023) | last entry/correction timestamp — see caveat in migration 021's own comment: both ack write paths are DELETE+reinsert, so this is the LAST entry date, not necessarily the first |
| entered_by | INT (migration 022, no FK declared in the ALTER — check separately if a FK was added; treat as referencing users.id) | who entered/last-corrected this ack |

**No slip/GRN/challan number field exists on `trip_acknowledgements`.** The closest
thing to a receipt document number in the whole chain is `trip_executions.dc_number`
(delivery challan number, free text, one per whole execution — not per chamber, not a
customer-issued number, just whatever the executor types).

**No CLR, acidity, numeric temperature, quality grade, or accept/reject fields exist.**
`temperature` and `description` are free text only.

**"Delivery point" — Shreeja-owned plant vs genuine external customer**:
`delivery_points` (`001_base_schema.sql:63-70`) is `id, name, receiver_name, location,
is_active, created_at`, plus `latitude/longitude` (migration 012). There is **no
boolean or type column distinguishing a Shreeja-owned dairy plant from a third-party
customer** — it's a flat list of destination names (seed data includes 'Balaji Dairy
Plant' → receiver 'MDFVPL', 'Milma Plant' → receiver 'Milma', 'KMF Plant' → receiver
'KMF'). Whether a given delivery point is "Shreeja's own" or "an external customer" is
**not encoded in the schema** — it would have to be inferred by name/receiver_name, or
maintained as an external lookup by Assure.

**`trip_third_party_sales`** (migrations 032, 033) is the closest analog to "sold
directly to a genuine external customer, off the normal BMCU→plant chain":
`id, execution_id, bmcu_seq_no (migration 033 — keyed per BMCU pickup, NOT per trip),
qty_litres, qty_kgs, fat_pct, snf_pct, kg_fat, kg_snf, customer_name (free text),
remarks, entered_by, created_at`.
**No rate or amount field exists on this table** — confirmed by reading its full
column list in both migrations and the runtime-DDL copy in `executions.js:40-66`.
Migration 032's comment explains the design correction in migration 033: a sale
reduces the SPECIFIC BMCU's RMRD figure, not the trip's dispatch total.

---

## 4. Payment / Settlement — TMS pays the TRANSPORTER, not for milk

**This is billing.js's own top-of-file comment, read verbatim**
(`backend/src/routes/billing.js:1-12`):

> Fortnightly vendor payment billing: biller executes a date range → all trips WITH
> acknowledgement data become billing lines; per trip the biller selects the STATE,
> sees the derived transport type (1 BMCU pickup → Point to Point, 2+ → BMCU/CC to
> Dairy/CC), the system distance (Distance Master + Google legs, with breakdown), can
> override the billed km and add remarks. Rate = tanker_rates row matching state ×
> capacity KL × transport type whose period covers the trip's PLANNING date. Amount =
> billed km × rate. Submit → 3-level sequential email approval...

**Table: `tanker_rates`** (migration 024): `effective_from, effective_to, state,
capacity_kl, transport_type CHECK IN ('BMCU/CC to Dairy/CC','Point to Point'),
mileage_km_per_litre, rate_per_km, diesel_price, ...`. Rate lookup in
`backend/src/routes/billing.js:106-116` (`findRate`) matches on
`state, transport_type, ABS(capacity_kl - capacity_litres/1000) < 0.051,
plan_date BETWEEN effective_from AND effective_to`.

**Table: `billing_run_trips`** (migration 025, FKs added migration 036, fat/snf added
migration 034): per-trip billing LINE with `execution_id, tanker_number,
capacity_litres, vendor_id, vendor_name, route_name, start_point, delivery_point,
bmcu_count, ack_litres, ack_kgs, ack_fat_pct, ack_snf_pct` (litres/kg/quality figures
are carried here **for reference/reporting only**), `state, transport_type, system_km,
google_km, master_km, estimated_km, billed_km, legs (JSONB), rate_id, rate_per_km,
amount (= billed_km × rate_per_km), is_sale_tanker, is_milma (migration 031),
excluded`.

**There is no `rate_per_litre` or milk-value `amount` anywhere in TMS.** `ack_litres` /
`ack_kgs` / `ack_fat_pct` / `ack_snf_pct` on `billing_run_trips` exist purely so the
biller and the Excel billing report can SEE the quantity/quality alongside the km-based
amount — they play no role in computing `amount`.

`billing_run_tolls` (migration 028) adds toll-gate reimbursements per tanker per run,
also unrelated to milk value.

**Conclusion for Assure**: map `proc_dairy_receipt_raw.rate_per_litre` and `amount` to
"not available in TMS" — do not attempt to derive them from `billing_run_trips.amount`,
which is a distance-based transporter payment, not a milk-value payment. See
`mapping.md`.

---

## 5. Masters

**`tankers`** (`001_base_schema.sql:20-29`; altered by 002/004/005/020, `vendor_id`
added at runtime by `documents.js`):
`id, tanker_number VARCHAR(20) UNIQUE, compartments (originally INTEGER CHECK IN (2,3),
migration 005 widened to VARCHAR(20) to support "2C"/"3C"-style values), capacity_litres
INTEGER, per_km_rate, vendor_code, vendor_name (free text — legacy), rate_per_km_bmcu,
rate_per_km_p2p, vendor_id (FK vendors, runtime-created table — see below),
induction_type CHECK IN ('Temporary','Permanent') + validity_start/end (migration 020),
is_active, created_at, updated_at`.
Real tanker_number examples from the seed/template data
(`backend/src/routes/plans.js:669-674`): `'AP03TF4985'`, `'AP03TF2538'` — an
Indian-registration-style alphanumeric string (state code + district code + series
letters + digits), stored as free text, uppercased on insert
(`tanker_number.trim().toUpperCase()`), no fixed length/format enforced beyond
VARCHAR(20).

**`vendors`** (table not in any migration file — created via runtime DDL in
`backend/src/routes/documents.js:34-48`, first run wins): `id, vendor_code UNIQUE,
vendor_name, ... , updated_at`. `tankers.vendor_id` FKs to it (also added at runtime,
`documents.js:49`). **Not tracked in the migrations directory** — worth noting for
Assure/ops since a fresh DB depends on `documents.js` having run once.

**`bmcus`** (`001_base_schema.sql:32-43`; lat/lng added by 002/004):
`id, bmcu_code VARCHAR(10) UNIQUE, bmcu_name VARCHAR(100), address, district, state,
contact, latitude, longitude, is_active, created_at, updated_at`.
Real bmcu_code examples from the seed template (`plans.js:669-674`): `'3001'`,
`'3002'`, `'3003'`, `'3004'`, `'3005'` — 4-digit numeric strings stored as VARCHAR(10),
no fixed-length constraint enforced beyond the column length.

**`delivery_points`** (`001_base_schema.sql:63-70`; lat/lng added migration 012):
`id, name, receiver_name, location, is_active, created_at, latitude, longitude`. No
code column at all — identified by free-text `name` (see identity.md).

**`route_masters`** (`001_base_schema.sql:73-83`; `route_no` added 002/004):
`id, route_name, route_no, start_point_id, testing_point_id, delivery_point_id,
distance_km, is_active, created_at, updated_at`. `route_bmcus` links a route to an
ordered BMCU sequence (`route_id, seq_no, bmcu_id`).

**`users`** (`001_base_schema.sql:8-17`; `must_change_password` added migration 006;
`user_id` TEXT login column added at runtime by `auth.js:17-26`; role CHECK loosened by
migrations 025/035 to allow 'viewer'/'biller'/custom roles):
`id, username VARCHAR(50)→TEXT (widened by auth.js), email VARCHAR(100) UNIQUE,
password_hash, full_name, role, is_active, created_at, must_change_password, user_id
TEXT (login identifier, backfilled from username, case-insensitively unique — e.g. an
alphanumeric handle like 'pp01' or an email address, per auth.js:15,28-29)`.
**There is no employee-code column.** `user_id` is a login handle chosen at account
creation, not a Shreeja HR/employee code — see `identity.md`.

---

## 6. Answers to the specific questions asked

### Natural keys
- Trip plan: `trip_plans.id` (surrogate). No other natural key — `trip_no` is only
  unique within a `plan_for_date`, and even that isn't DB-enforced (no UNIQUE
  constraint on `(plan_for_date, trip_no)`).
- Execution: `trip_executions.id`. One active (non-'closed') execution per
  `trip_plan_id` is enforced in application code, not a DB constraint — see
  `executions.js:264-269` (`SELECT ... WHERE trip_plan_id=$1 AND status NOT IN
  ('closed')`, then a 409 if found) — a UNIQUE index does not exist.
- Acknowledgement row: `trip_acknowledgements.id`, naturally identified by
  `(execution_id, chamber)` for the CURRENT set (delete+reinsert on every save, so
  the `id` values themselves are not stable across edits).

### Deletion / overwrite behavior
- **Trip plans are soft-deleted**: `DELETE /api/plans/:id`
  (`backend/src/routes/plans.js:296-320`) does `UPDATE trip_plans SET
  status='deleted'`, never a real `DELETE FROM trip_plans`. Migration 011 added
  `'deleted'` to the status CHECK specifically for this ("Deleted Plans" report).
  No `grep` hit for a literal `DELETE FROM trip_plans` anywhere in the routes.
- **Executions are edited in place, not versioned.** `PUT /api/executions/:id`
  (`executions.js:309-347`) → `applyExecutionData` does targeted `UPDATE`s (for
  `trip_execution_bmcus` with an `id`) and full delete+reinsert for shift rows,
  entries, acknowledgements, and third-party sales. **There is no audit/history row
  kept of the prior values** for these mutable sub-tables — only
  `trip_executions.updated_by`/`updated_at` show *that* a change happened. (Generic
  `audit_logs`, migration 013, records the raw HTTP request body per mutating call —
  in principle a full diff could be reconstructed from `audit_logs.details` JSONB per
  execution PUT, but this is not a purpose-built history table and is out of scope for
  Assure without direct access to `audit_logs`.)
- **`status='closed'` on `trip_executions` is the "final, safe to reconcile" state.**
  `PUT /api/executions/:id` explicitly refuses to edit an execution once
  `status='closed'` (`executions.js:314-317`, `WHERE id=$1 AND status NOT IN
  ('closed')` — 404 if already closed). Any correction to a closed execution goes
  through a separate "change request" approval flow (`change_requests` table,
  migration 014 — not detailed further here since it's out of this hop's core scope,
  but note its existence: a closed execution CAN still change via that flow, calling
  the same `applyExecutionData` with `opts.setSavedStatus=false` so status stays
  'closed'). **Recommend Assure treat `status='closed'` as "safe", but be aware a
  closed execution can still be corrected later via change-request approval — an
  `updated_at` poll, not a one-time pull, is the safe pattern (see `access.md`).**

### Multi-pickup (multi-BMCU trips)
Confirmed: `trip_execution_bmcus.seq_no` is a per-execution sequence — one execution
can, and per the upload template samples routinely does, carry 2–3+ BMCU rows
(`plans.js:669-674` shows a 3-BMCU trip). Quantity is attributed **per row**
(`qty_litres`/`qty_kgs`/`fat_pct`/`snf_pct` all live on the BMCU row, or on the
per-shift `trip_execution_bmcu_shifts` row keyed by `bmcu_seq_no`).
**Customer-end quality (the acknowledgement) is captured ONE ROW PER CHAMBER PER
EXECUTION — never per BMCU.** There is no column on `trip_acknowledgements` that
references `trip_execution_bmcus.id` or `.seq_no`. **This means: for any multi-BMCU
trip, the customer-plant fat/SNF/quantity reading is a blended figure across all
BMCUs on that trip, and cannot be split back to an individual BMCU's contribution.**
This is a structural gap, not a missing feature — see `gaps.md`.

### Multi-trip / shift
No shift column exists directly on `trip_plans` beyond the free-text `shifts_milk`
(e.g. `'18E19M'`, a compound code that appears to encode a time or shift naming
convention but is not decomposed into structured fields). The only structured AM/PM
enum lives on `trip_execution_bmcus.shift` and `trip_execution_bmcu_shifts.shift`
**per BMCU pickup**, not per trip. So yes — in principle one BMCU's AM milk could ride
on one tanker and its PM milk on a different tanker/trip the same day, since shift is
recorded at the BMCU-pickup level, not enforced consistent across the whole trip. This
is inferred from the schema shape (shift lives on the child row, not the parent); no
code path was found that explicitly forbids mixed shifts within one execution.

### Units
- Litres is the primary user-entered unit everywhere (`qty_litres` fields).
- Kg is DERIVED via `calcKgs(litres) = litres * KG_FACTOR` where
  **`KG_FACTOR = 1.0285`** (`backend/src/services/executionData.js:13,15`; duplicated
  as `const KG = 1.0285` in `backend/src/routes/analytics.js:17`).
- **Acknowledgement kg is the one exception**: the app preserves the user-TYPED kg
  value in preference to recomputing from litres, specifically to avoid ±0.01 kg
  rounding drift (`executions.js:419-421`, comment explains why). So a given
  `trip_acknowledgements.qty_kgs` may not be exactly `qty_litres × 1.0285` if a human
  corrected it.
- **Density constant: both systems use 1.0285.** Assure confirmed (2026-09-05) it will
  adopt TMS's 1.0285 rather than the 1.028 in the original brief — see §0.1.

### Time
- `docker-compose.yml` / `docker-compose.qa.yml` set `TZ: Asia/Kolkata` and
  `PGTZ: Asia/Kolkata` for both the app and db containers
  (`/home/user/shreeja-transport/docker-compose.yml:19-20,48`). So **the app and DB
  both run in IST (Asia/Kolkata), not UTC**, in this deployment.
- `backend/src/config/db.js:1-6` has a specific type-parser override for Postgres
  DATE columns (OID 1082) precisely to avoid a UTC-shift bug when converting a
  local-midnight JS Date to ISO — i.e. the team has already hit and worked around a
  timezone bug here; DATE columns (`plan_for_date`, `execution_date`, `ack_date`,
  `milk_date`) are returned as raw `'YYYY-MM-DD'` strings, with no time/timezone
  component to worry about.
  TIMESTAMPTZ columns (`created_at`, `updated_at`, `printed_at`, `issued_at`) ARE
  timezone-aware and, per the docker-compose TZ setting, effectively operate in IST.
- User-entered timestamps: `ack_date` (business date, user-entered — the biller/
  executor types this), `milk_date` (business date, user-entered).
- System-generated: `created_at`/`updated_at` on nearly every table (DEFAULT NOW()),
  `trip_document_prints.printed_at` (system NOW() unless a manual override is passed —
  see `parseManualTs` in `tripDocs.js:146-154`, which allows a manually-entered
  date/time up to 5 minutes in the future tolerance, for correcting a late print
  entry), `non_trip_gate_passes.issued_at`/`returned_at` (same manual-override
  pattern).
- `trip_acknowledgements.created_at` (migration 021) is explicitly documented in its
  own migration comment as "the LAST entry/correction date", not the first — because
  both ack write paths delete+reinsert.

### Lifecycle
- `trip_plans.status`: `draft → published → cancelled|deleted` (CHECK in migration 001,
  loosened by 011). Transitions: created as 'draft' (`plans.js` POST); bulk
  `POST /api/plans/publish` flips `draft→published` for a date; `DELETE` (soft) sets
  'deleted'; execution cancel (`executions.js:380-383`) sets the linked plan to
  'cancelled'.
- `trip_executions.status`: `in_progress (default) → saved → pending_ack → closed`,
  or `→ cancelled` from any non-closed state (CHECK constraint in migration 001 lists
  only in_progress/saved/pending_ack/closed, but the app code sets 'cancelled' too —
  `executions.js:376` — meaning either the CHECK was implicitly relaxed at some point
  outside the tracked migrations, or this would error in a strict deployment; **flagged
  as worth a live-DB confirmation**, not independently verifiable from migrations
  alone). Transitions: POST creates 'in_progress'; PUT (save) sets 'saved'
  (`opts.setSavedStatus=true`); `POST /:id/submit-ack` requires 'saved' → sets
  'pending_ack'; `POST /:id/acknowledgements` requires 'pending_ack' → sets 'closed';
  `POST /:id/cancel` (admin only) sets 'cancelled' from any non-closed status.
  **'closed' = final, safe to reconcile** (see natural-keys section above for the
  change-request caveat).

### Quality source (manual vs device/import)
All fat/SNF entry paths found are manual form submissions through the API — `PUT
/api/executions/:id` (bmcus + shift_rows arrays) and `POST
/api/executions/:id/acknowledgements` (chambers array) both take fat_pct/snf_pct as
plain numeric fields in a JSON body with no reference to a device reading or an
imported file anywhere in `executions.js` or `executionData.js`. No analyzer/device
integration code, no file-import path for quality readings, was found in the routes
reviewed. **Confirmed: fat/SNF at both loading and acknowledgement are manually typed
into the TMS web portal**, not device- or file-sourced.

**Where the typed numbers come from (confirmed by Shreeja, 2026-09-05):**
- Loading (`trip_execution_bmcus`, `trip_execution_bmcu_shifts`): the BMCU's own
  dispatch/RMRD reading, entered by Shreeja's execution team.
- Acknowledgement (`trip_acknowledgements`): the **customer plant's weighbridge and lab
  slip**, transcribed by Shreeja's team. TMS does not take its own measurement at the
  customer end — the acknowledgement is a copy of the customer's figure. Because it is
  hand-copied from a slip, transcription error is a real (unquantified) source of
  variance that Assure's tolerance bands should allow for.

### Codes
- `bmcu_code`: VARCHAR(10), real examples are 4-digit numeric strings ('3001'..'3005')
  from the upload-template sample data (`plans.js:669-674`). No fixed-length DB
  constraint beyond the 10-char column limit — do not assume all codes are 4 digits
  without checking live data.
- `tanker_number`: VARCHAR(20), real examples 'AP03TF4985', 'AP03TF2538' — Indian
  vehicle-registration-style string, stored uppercase, free-form beyond that.

### Volume (row counts / actual data volume)
**Not available from this environment** — there is no live database connection here
(no docker/psql access), so no real row-count-per-month or per-day figures can be
produced. A script to pull these from a live database is expected to be supplied
separately (see `samples/README.md`), and the user should run it against production to
get real figures once this handover doc is delivered.
