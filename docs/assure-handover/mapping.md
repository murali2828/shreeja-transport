# Column Mapping: Assure ↔ TMS

Every source column is given as `table.column`. "Not available in TMS" is used
literally where no equivalent exists — no weak/inferred mapping is forced. See
`README.md` for full column definitions and caveats (especially §0 top-line warnings:
the 1.0285 kg factor, and TMS billing being per-km not per-milk-value).

## `proc_transport_trip_raw`

| Assure column | TMS source | Transform / notes |
|---|---|---|
| trip_ref | `trip_executions.id` (preferred) or `trip_plans.id` | Use `trip_executions.id` as the stable per-actual-trip key; `trip_plans.id` is the planned-trip key (1:1 with an execution once one exists, but a plan can exist with no execution, or — rare, app-enforced — have had a cancelled execution and a later new one) |
| vehicle_no | `tankers.tanker_number` via `trip_plans.tanker_id` | Free-text, uppercased, e.g. 'AP03TF4985' |
| route_code | `route_masters.route_no` or `.route_name` via `trip_plans.route_id` | `route_id` is nullable — a trip plan need not reference a named route |
| origin_bmcu_code | **Not a single column** — see per-pickup legs below | A trip execution can have MULTIPLE BMCUs (`trip_execution_bmcus`); there is no single "origin BMCU" for a multi-pickup trip. For a single-BMCU trip, use `bmcus.bmcu_code` via the one `trip_execution_bmcus.bmcu_id` row |
| dest_dairy_code | **Not available as a code** — `delivery_points.name` via `trip_plans.delivery_point_id` | `delivery_points` has no code column at all, only a free-text `name` and `receiver_name`. No distinction in the schema between a Shreeja-owned plant and a genuine external customer (see README §3) |
| trip_start_at | `trip_document_prints.printed_at` WHERE `doc_type='gate_pass'`, MIN per `trip_plan_id` (first print) | Documented in migration 016/017 comments as the operational "trip start" timestamp. Not always present — gate pass printing is optional workflow, not enforced |
| trip_end_at | `trip_document_prints.printed_at` WHERE `doc_type='coa'` (arrived at delivery point) or `'unloading'` (unloading complete), MIN per `trip_plan_id` | 'coa' = arrived; 'unloading' = unloading completed (migration 017 comment). Choose based on what "trip_end" should mean for Assure — arrival vs unload-complete are two different events, both optional/not always printed in practice (see tripDocs.js:272-275 comment: "the execution team only records Gate Pass ... COA and Unloading are not used" in the current live workflow) |
| loaded_litres | `SUM(trip_execution_bmcus.qty_litres)` WHERE `execution_id=? AND is_deleted=FALSE`, or the precomputed `trip_executions.total_qty_litres` | total_qty_litres already excludes deleted rows and third-party sale netting rules — see README §4 note on netting |
| unloaded_litres | `SUM(trip_acknowledgements.qty_litres)` WHERE `execution_id=?` | Sum across chamber rows (chamber is not preserved separately in Assure's flat schema unless added — see proposed additions) |
| seal_no | **Not available in TMS** | No seal-number field exists anywhere in the schema (trip_executions, trip_execution_bmcus, trip_acknowledgements all lack it) |
| driver_code | **Not available in TMS** | Only `trip_plans.driver_name` (free text, planning-time only, not a formal code, not captured per actual pickup) — see README §2 and identity.md |

### Proposed ADDITIONS for this hop (columns Assure should add)

| Proposed column | TMS source |
|---|---|
| loaded_fat | Weighted-average `trip_execution_bmcus.fat_pct` (per BMCU) or `trip_executions.avg_fat` (trip-level weighted average) |
| loaded_snf | Same, `.snf_pct` / `trip_executions.avg_snf` |
| loaded_kg | `trip_executions.total_qty_kgs` (computed as litres × 1.0285 — see README §0.1) |
| legs (per-pickup, for multi-BMCU trips) | Array of `{bmcu_code, litres, kg, fat_pct, snf_pct, shift, milk_date}` — one entry per `trip_execution_bmcus` row (join `bmcus` for `bmcu_code`), further per-shift breakdown available from `trip_execution_bmcu_shifts` (`rmrd_qty, rmrd_fat_pct, rmrd_snf_pct` per `bmcu_seq_no`+shift) |
| compartment data | `trip_execution_bmcus.chamber` (e.g. 'FC','MC','BC', or comma-joined for multi-chamber since migration 010) per pickup row; `tankers.compartments` (VARCHAR, e.g. "2C"/"3C" — count of physical tanker compartments, a MASTER attribute, not per-trip data) |

---

## `proc_dairy_receipt_raw`

| Assure column | TMS source | Transform / notes |
|---|---|---|
| dairy_ref | `delivery_points.id` (surrogate) or `.name` | No formal dairy/customer code exists — see identity.md |
| dairy_code | **Not available in TMS** | `delivery_points` has no code column |
| receipt_date | `trip_acknowledgements.ack_date` | User-entered business date |
| vehicle_no | `tankers.tanker_number` (via the trip's plan) | Same as trip mapping |
| gross_weight | **Not available in TMS** | No weighbridge integration or gross-weight field anywhere |
| tare_weight | **Not available in TMS** | Same |
| net_litres | `trip_acknowledgements.qty_litres` (SUM across chamber rows for the execution) | |
| fat | `trip_acknowledgements.fat_pct` (weighted average across chambers if more than one) | |
| snf | `trip_acknowledgements.snf_pct` | |
| clr | **Not available in TMS** | No CLR field |
| acidity | **Not available in TMS** | No acidity field |
| quality_grade | **Not available in TMS** | No grade field; `trip_acknowledgements.description` is free text, sometimes used for notes, not a structured grade |
| rate_per_litre | **Not available in TMS** — see README §0.2/§4 | TMS never prices milk; billing is transporter-per-km only |
| amount | **Not available in TMS** (as a milk-value amount) | `billing_run_trips.amount` exists but = `billed_km × rate_per_km`, a TRANSPORT payment, not a milk-value payment — do not map these together |

### Proposed ADDITIONS for this hop

| Proposed column | TMS source |
|---|---|
| receipt_at | Best proxy: `trip_document_prints.printed_at` WHERE `doc_type IN ('coa','unloading')`, MIN per trip_plan_id — but note (per tripDocs.js comment) this workflow step is often skipped in current practice; fall back to `trip_acknowledgements.created_at` (entry timestamp, with the caveat from migration 021 that it reflects the LAST correction, not necessarily receipt time) |
| trip_ref | `trip_acknowledgements.execution_id` → `trip_executions.id` |
| net_kg | `trip_acknowledgements.qty_kgs` (user-typed value, preserved verbatim — see README §6 Units) |
| temperature | `trip_acknowledgements.temperature` — **free text, not numeric**, so cannot be used as a quantitative field without cleanup |
| accepted_litres / rejected_litres + reason | **Not available in TMS** — no accept/reject concept exists; every acknowledged quantity is implicitly "accepted" |
| rate basis fields | **Not available in TMS** — no milk pricing exists at all |
| invoice_no | **Not available in TMS** — closest is `trip_executions.dc_number` (delivery-challan number, free text, one per whole execution, not a formal invoice) |
| payment_status | **Not available in TMS** in the milk-value sense. `billing_runs.status` exists (draft/pending_vendor/pending_l1/l2/l3/approved/rejected) but tracks the TRANSPORTER payment workflow, unrelated to any milk-value payment |
| entered_by / entered_at | `trip_acknowledgements.entered_by` (FK users, migration 022) / `.created_at` (migration 021, with the backfill caveat noted in migration 023) |
