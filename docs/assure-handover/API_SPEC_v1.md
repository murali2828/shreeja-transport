# TMS → Assure integration API — endpoint specification

**For:** the TMS (Tanker/Transport Management System, `tms.shreejamilk.com`) codebase
**From:** Shreeja Assure (EMMS) — milk-procurement reconciliation module
**Status:** specification to implement on the TMS side. Nothing here changes TMS data;
every endpoint is read-only.
**Date:** 8 Sep 2026

---

## 0. Purpose

Assure reconciles the milk chain per shift and per trip:
member payment register → MPP collection → RMRD receipt at the BMCU →
**tanker dispatch (TMS) → customer-plant acknowledgement (TMS)**.

Today the last two steps arrive as CSV files produced by
`docs/assure-handover/scripts/export_samples.sh` (the sample week 01–07 Aug 2026 was
loaded from them). This spec replaces that manual step with three JSON endpoints that
Assure polls automatically. The endpoints return the **same rows the export script
already produces**, so the SQL in that script is the reference implementation — the
work is a route file, an API-key check, pagination, and two extra columns.

Assure's consumer (`tmsPollJob`, every 15 minutes in production; on-demand date-range
backfills for history) lands every row through the same normaliser its file upload uses,
so a row that arrived by file and the same row arriving by API dedupe to one record.

## 1. Ground rules

1. **Read-only.** `SELECT` only. No endpoint writes, and the DB user behind it should be
   a read-only role.
2. **Never filter cancelled / deleted rows out.** Expose them with their status columns
   (`plan_status`, `execution_status`, `is_deleted`). Assure applies its own inclusion
   rule (sale tankers, deleted plans and open executions are excluded at build time on
   Assure's side, with the reason recorded).
3. **Stable column names.** The names below are the contract. If a TMS table is
   renamed later, the query aliases absorb it; Assure never sees internal names.
4. **Dates and times.** `plan_for_date` / `milk_date` / `ack_date` as `YYYY-MM-DD`.
   Timestamps as ISO 8601 **with offset** (`2026-08-03T06:12:45.123+05:30`), the same
   form the export script produced.
5. **Numbers as JSON numbers**, not strings. Nulls as `null` (not `""`, not `"NULL"`).
6. **Density.** `qty_kgs` is TMS's own computed figure at `KG_FACTOR = 1.0285`, which
   equals Assure's `KG_PER_LITRE`. Send the stored value; do not recompute.
7. **Names.** `driver_name` / `loader_name` may be sent unmasked (internal app-to-app
   traffic over the private link). Assure stores them for display only. If TMS prefers
   the masked form used in the sample files (`first ***`), that is acceptable too —
   Assure never matches on them.

## 2. Authentication and placement

- Mount under the existing `/api` prefix at **`/api/integrations/assure/*`**, in a new
  route file (`backend/src/routes/integrations.js`), registered **before** the
  session/JWT middleware — the caller is a server, not a logged-in TMS user.
- **Shared-secret header `X-Assure-Key`.** Compare constant-time
  (`crypto.timingSafeEqual`) against env `ASSURE_API_KEY`.
  - env unset → `503 { "error": "Assure integration not configured", "code": "FEATURE_DISABLED" }`
  - header missing or wrong → `401 { "error": "Invalid API key", "code": "UNAUTHORIZED" }`
- Support **two keys** (`ASSURE_API_KEY` and `ASSURE_API_KEY_NEXT`) so a key can be
  rotated with no downtime: accept either while both are set.
- **Per-IP rate limit** (e.g. 120 requests/minute → `429 RATE_LIMITED`). Optional IP
  allow-list `ASSURE_ALLOWED_IPS` (comma list) — the Assure QA and production hosts.
- Log every call (path, key id — never the key value, IP, rows returned, duration).

This is the same shape Assure uses for its own inbound integrations (IVRS webhook,
device ingestion), so both apps follow one convention.

## 3. Common query parameters

| Parameter | Type | Notes |
|---|---|---|
| `from_date` | `YYYY-MM-DD` | Inclusive. Filters on the parent plan's `plan_for_date`. |
| `to_date` | `YYYY-MM-DD` | Inclusive. `to_date − from_date` must be ≤ **62 days** → else `400 RANGE_TOO_WIDE`. |
| `updated_since` | ISO timestamp | Rows changed at or after this instant (see per-endpoint column). Used for incremental polling. |
| `after_id` | integer | Keyset cursor: return rows with `id > after_id`. |
| `limit` | integer | Default **500**, max **2000**. |

Rules: at least one of `from_date` or `updated_since` is required (`400 MISSING_FILTER`).
`from_date` without `to_date` means "from that date to today". Results are always
ordered by the row's own `id` ascending, so `after_id` paging is stable while data
changes underneath.

## 4. Common response envelope

```json
{
  "data": [ ...rows... ],
  "count": 500,
  "next_after_id": 18342,
  "server_time": "2026-09-08T18:40:11.204+05:30"
}
```

`next_after_id` is `null` when the page was the last one (`count < limit`). Errors:

```json
{ "error": "human readable", "code": "SCREAMING_SNAKE" }
```

## 5. Endpoints

### 5.1 `GET /api/integrations/assure/ping`

Liveness + contract version. No parameters. Auth required (so a wrong key is caught
here first).

```json
{ "ok": true, "contract": "assure-v1", "tms_version": "<git sha or package version>", "server_time": "…" }
```

### 5.2 `GET /api/integrations/assure/trips` — one row per **trip plan**, with its execution

Grain: `trip_plans.id`. The execution is LEFT JOINed, so a plan with no execution yet
appears with the `execution_*` columns `null`. (Assure links loadings/receipts to a trip
by `execution_id` when present, else by `trip_plan_id` — exactly what the sample-week
file forced it to do.)

`updated_since` filters on `GREATEST(tp.updated_at, te.updated_at)`. `after_id` is
`trip_plan_id`.

| Column | Source | Notes |
|---|---|---|
| `trip_plan_id` | `trip_plans.id` | **row id / cursor** |
| `trip_no` | `trip_plans.trip_no` | |
| `plan_date` | `trip_plans.plan_date` | |
| `plan_for_date` | `trip_plans.plan_for_date` | the date filter key |
| `plan_status` | `trip_plans.status` | `draft` \| `published` \| `cancelled` \| `deleted` — **sent, never filtered** |
| `execution_id` | `trip_executions.id` | null until executed |
| `execution_status` | `trip_executions.status` | `in_progress` \| `saved` \| `pending_ack` \| `closed` \| `cancelled` — **new vs the CSV; the most valuable addition** |
| `execution_date` | `trip_executions.execution_date` | |
| `cancel_reason` | `trip_executions.cancel_reason` | |
| `tanker_number` | `tankers.tanker_number` | vehicle registration |
| `route_no` | `route_masters.route_no` | |
| `route_name` | `route_masters.route_name` | |
| `start_point` | `starting_points.name` | |
| `testing_point` | `testing_points.name` | |
| `delivery_point_id` | `delivery_points.id` | |
| `delivery_point` | `delivery_points.name` | the customer plant (no code column exists — name is the key) |
| `is_sale_tanker` | `trip_plans.is_sale_tanker` | boolean |
| `shifts_milk` | `trip_plans.shifts_milk` | |
| `expected_km` | `trip_plans.expected_km` | |
| `actual_km` | `trip_executions.actual_km` | |
| `expected_total_qty` | `trip_plans.expected_total_qty` | litres |
| `loaded_litres` | `trip_executions.total_qty_litres` | Σ loadings |
| `loaded_kg` | `trip_executions.total_qty_kgs` | |
| `loaded_avg_fat_pct` | `trip_executions.avg_fat` | |
| `loaded_avg_snf_pct` | `trip_executions.avg_snf` | |
| `dc_number` | `trip_executions.dc_number` | |
| `total_cost` | `trip_plans.total_cost` | transporter per-km cost — not milk value |
| `per_liter_cost` | `trip_plans.per_liter_cost` | |
| `driver_name` | `trip_plans.driver_name` | free text |
| `loader_name` | `trip_plans.loader_name` | free text |
| `remarks` | `trip_plans.remarks` | |
| `gate_pass_at` | `MIN(trip_document_prints.printed_at) WHERE doc_type='gate_pass'` | trip start proxy |
| `arrived_at` | same, `doc_type='coa'` | |
| `unloaded_at` | same, `doc_type='unloading'` | |
| `created_at` | `trip_plans.created_at` | |
| `updated_at` | `GREATEST(tp.updated_at, te.updated_at)` | the incremental-poll key |

Reference SQL: the `trips` block of `export_samples.sh` **plus** the execution join
and the three `trip_document_prints` sub-selects from `sql/assure_trips_v.sql`.

### 5.3 `GET /api/integrations/assure/loadings` — one row per **BMCU pickup**

Grain: `trip_execution_bmcus.id`. Date filter on the parent plan's `plan_for_date`
(join through `trip_executions` → `trip_plans`). `updated_since` filters on
`trip_executions.updated_at` (the row has no timestamp of its own — say so in the
docs, do not invent one). `after_id` is `loading_id`.

| Column | Source | Notes |
|---|---|---|
| `loading_id` | `trip_execution_bmcus.id` | **row id / cursor** |
| `execution_id` | `trip_execution_bmcus.execution_id` | |
| `trip_plan_id` | `trip_executions.trip_plan_id` | |
| `trip_no` | `trip_plans.trip_no` | |
| `plan_for_date` | `trip_plans.plan_for_date` | |
| `execution_status` | `trip_executions.status` | |
| `tanker_number` | `tankers.tanker_number` | |
| `seq_no` | `trip_execution_bmcus.seq_no` | pickup order within the trip |
| `bmcu_code` | `bmcus.bmcu_code` | matches Assure's BMCU code (e.g. `3001`) |
| `bmcu_name` | `bmcus.bmcu_name` | |
| `milk_date` | `trip_execution_bmcus.milk_date` | |
| `shift` | `trip_execution_bmcus.shift` | blank on every sample row — send whatever is stored |
| `qty_litres` | | |
| `qty_kgs` | | |
| `fat_pct` | | |
| `snf_pct` | | |
| `kg_fat` | | |
| `kg_snf` | | |
| `rmrd_qty` | | |
| `chamber` | | FC / MC / BC |
| `description` | | `RMRD` \| `Balance Milk` \| `Internal Shifting` |
| `is_deleted` | `trip_execution_bmcus.is_deleted` | boolean — **sent, never filtered** |
| `updated_at` | `trip_executions.updated_at` | proxy (documented) |

Reference SQL: the `loadings` block of `export_samples.sh`, plus `te.status`,
`tp.plan_for_date`, `te.updated_at`.

### 5.4 `GET /api/integrations/assure/receipts` — one row per **acknowledgement chamber**

Grain: `trip_acknowledgements.id` = one chamber of one execution. This IS the customer
plant's weighbridge + lab figure as transcribed by Shreeja staff. Assure sums chambers
per execution for the per-trip receipt. **Send empty chamber rows too** (all quantity
fields null) — Assure skips them; do not decide that on the TMS side.

Date filter on the parent plan's `plan_for_date`. `after_id` is `receipt_id`.

| Column | Source | Notes |
|---|---|---|
| `receipt_id` | `trip_acknowledgements.id` | **row id / cursor** — changes on correction, see §6 |
| `execution_id` | `trip_acknowledgements.execution_id` | |
| `trip_plan_id` | `trip_executions.trip_plan_id` | |
| `trip_no` | `trip_plans.trip_no` | |
| `plan_for_date` | `trip_plans.plan_for_date` | |
| `execution_status` | `trip_executions.status` | |
| `tanker_number` | `tankers.tanker_number` | |
| `delivery_point_id` | `delivery_points.id` | |
| `delivery_point` | `delivery_points.name` | |
| `ack_date` | `trip_acknowledgements.ack_date` | |
| `chamber` | | FC / MC / BC |
| `qty_litres` | | net, from the customer slip |
| `qty_kgs` | | user-typed, preserved as stored |
| `fat_pct` | | |
| `snf_pct` | | |
| `kg_fat` | | |
| `kg_snf` | | |
| `temperature` | | free text as stored |
| `description` | | remarks |
| `entered_by` | `users.name` via `created_by` | who transcribed the slip (optional but useful) |
| `created_at` | `trip_acknowledgements.created_at` | = last entry/correction time (see §6) |
| `updated_at` | see §6 | `created_at` until a real column exists |

Reference SQL: the `receipts` block of `export_samples.sh`, plus `te.status`,
`tp.plan_for_date`, `ta.created_at`, and the `users` join.

## 6. The receipts correction problem (please read)

`trip_acknowledgements` has no `updated_at`; a corrected acknowledgement is **deleted
and re-inserted**, so the corrected chamber gets a **new `receipt_id`** and the old id
vanishes. Two consequences:

1. Assure will key live receipts on **`execution_id` + `chamber`** and replace the
   stored row when a newer `created_at` arrives — so a correction updates the record
   rather than sitting beside a stale one. TMS needs nothing for this beyond sending
   `created_at`.
2. Because a deletion cannot be seen through a "changed since" filter, Assure's
   incremental poll for receipts uses a **rolling date window** (`from_date` =
   today − 7 days) rather than `updated_since`. If TMS can add
   `trip_acknowledgements.updated_at` (a migration + one line where the ack is
   written — noted as a gap in the handover), expose it as `updated_at` and Assure
   will switch receipts to `updated_since` too. Not a blocker.

## 7. Performance notes

- Indexes: `trip_plans(plan_for_date)`, `trip_plans(updated_at)`,
  `trip_executions(updated_at)`, `trip_executions(trip_plan_id)`,
  `trip_execution_bmcus(execution_id)`, `trip_acknowledgements(execution_id)`. Check
  which already exist before adding.
- Expected volumes: ~50 plans, ~170 loadings, ~150 chamber rows per day. A month is
  ~1,500 / ~5,000 / ~4,500 rows. With `limit=2000` a monthly backfill is a handful of
  pages per endpoint.
- The 62-day range cap and 2,000-row page cap keep any single query bounded.

## 8. Examples

Incremental poll (what Assure runs every 15 minutes):

```
GET /api/integrations/assure/trips?updated_since=2026-09-08T12:00:00%2B05:30&limit=500
GET /api/integrations/assure/loadings?updated_since=2026-09-08T12:00:00%2B05:30&limit=500
GET /api/integrations/assure/receipts?from_date=2026-09-01&limit=500
X-Assure-Key: <key>
```

Backfill (August):

```
GET /api/integrations/assure/trips?from_date=2026-08-01&to_date=2026-08-31&limit=2000
GET /api/integrations/assure/trips?from_date=2026-08-01&to_date=2026-08-31&limit=2000&after_id=2400
…
```

One `receipts` row (values from the sample week):

```json
{
  "receipt_id": 3680, "execution_id": 1267, "trip_plan_id": 2221, "trip_no": 1,
  "plan_for_date": "2026-08-03", "execution_status": "closed",
  "tanker_number": "TN28AR1990", "delivery_point_id": 4, "delivery_point": "Balaji Dairy",
  "ack_date": "2026-08-03", "chamber": "BC",
  "qty_litres": 10199.32, "qty_kgs": 10490.0006, "fat_pct": 4.12, "snf_pct": 8.18,
  "kg_fat": 432.188, "kg_snf": 858.0821, "temperature": null, "description": null,
  "entered_by": "…", "created_at": "2026-08-03T21:14:02.551+05:30", "updated_at": "2026-08-03T21:14:02.551+05:30"
}
```

## 9. Acceptance checklist

1. `ping` answers `200` with the right key, `401` with a wrong one, `503` with
   `ASSURE_API_KEY` unset.
2. For `from_date=2026-08-01&to_date=2026-08-07` the three endpoints return **exactly
   the rows `export_samples.sh` produces for the same window** (same ids, same
   quantities), plus the new columns. That is the regression test — the sample files
   are in Assure's repo under `docs/tms-handover/samples/`.
3. Paging: with `limit=100`, walking `after_id` until `next_after_id` is `null` yields
   the same set as one `limit=2000` call, no duplicates, no gaps.
4. A cancelled plan, a deleted plan and an `is_deleted` loading all appear in the
   output with their flags set.
5. `updated_since` on trips returns a plan whose execution was edited after the
   timestamp even when the plan itself was not.
6. A range wider than 62 days → `400 RANGE_TOO_WIDE`; no filter at all →
   `400 MISSING_FILTER`.
7. Timestamps carry the `+05:30` offset; numeric fields are numbers; blanks are `null`.

## 10. Out of scope (for now)

- Masters (`vehicles`, `bmcus`, `customers`, `routes`) — Assure keeps its own BMCU
  master and matches customer plants by name; add later if needed.
- Payments / transporter billing and third-party sales — not part of milk
  reconciliation.
- Any write-back from Assure to TMS.

## 11. Open items carried over from the handover (unchanged)

- `loadings.shift` is blank on every sample row although the README says per-shift
  RMRD figures exist — if a `loading_shifts` table carries them, a fourth endpoint can
  follow the same pattern later.
- Weighbridge gross/tare, CLR/acidity, numeric temperature and `customer_slip_no` on
  the acknowledgement form remain the highest-value additions to the ack screen
  (`gaps.md`); when they exist, add them as columns here — the contract is additive.

## 12. What Assure does with it (for context)

`tmsPollJob` (env-gated `TMS_POLL_ENABLED`, `TMS_API_URL`, `TMS_API_KEY`,
`TMS_POLL_CRON`) calls the three endpoints, pushes every row through the same
normaliser as the file upload (`tms_trips` / `tms_legs` / `tms_receipts` import
definitions), dedupes on `trip_plan_id` / `loading_id` / `execution_id+chamber`, logs
each run to `proc_transport_poll_log`, and the nightly reconciliation builds
`proc_trip_recon` (Σ pickups vs Σ chambers per trip, volume and total-solids variance,
apportioned per BMCU) and raises anomaly flags. With `execution_status` available,
Assure switches its `TRIP_*` rules to `require_closed = true`.
