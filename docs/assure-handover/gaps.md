# Gaps: What Assure Needs That TMS Does Not Capture Today

For each item: where it could plausibly be captured in TMS, rough effort, and whether
a customer-provided file is unavoidable instead.

## Confirmed real gaps

### 1. Weighbridge gross/tare weight
- Not captured anywhere in TMS — no gross_weight/tare_weight column on any table.
- Where it could go: a new pair of columns on `trip_acknowledgements` (per chamber) or
  a new `execution_id`-level pair if TMS ever gets its own weighbridge integration at
  the delivery point.
- Effort: **medium** if TMS is meant to capture a weighbridge reading manually (new
  form fields + migration); but the CUSTOMER's own weighbridge reading, if that's what
  Assure actually needs, physically lives on the customer's own scale/ERP, not
  anywhere TMS's executor could type it in reliably. **No customer portal or customer
  login exists in TMS** (confirmed: no 'customer' role, no customer-facing route found
  in `backend/src/routes/*` — the only related mention is the free-text
  `trip_third_party_sales.customer_name` field). So a genuine customer weighbridge
  ticket would need to come from **a customer-provided file/feed**, not TMS.

### 2. CLR / acidity / numeric temperature / quality grade at the customer end
- Not captured — `trip_acknowledgements.temperature` and `.description` are free text
  only; no CLR, acidity, or grade columns exist.
- Where it could go: new numeric/enum columns on `trip_acknowledgements`.
- Effort: **small** (a migration adding a few nullable columns + form field changes) —
  IF the customer plant's own lab equipment results are entered manually by a TMS user
  at the point of acknowledgement. If instead these come from the CUSTOMER's own lab
  system, a customer-provided file is unavoidable — same reasoning as #1 (no customer
  portal exists).

### 3. Per-BMCU attribution at the customer end for multi-pickup trips
- Not possible from the schema as it stands — `trip_acknowledgements` keys only to
  `execution_id` + `chamber`, never to a specific `trip_execution_bmcus` row. See
  README §6.
- Where it could go: this is a structural/business-process gap, not a simple missing
  column — a single tanker load is physically blended by the time it's weighed at the
  plant, so there is no way to "unblend" quality/quantity back to source BMCUs without
  additional physical measurement (e.g. per-compartment/chamber weighing IF each
  compartment happens to carry exactly one BMCU's milk — TMS does record `chamber` per
  BMCU pickup row, so if a customer's weighbridge/lab reports per-compartment rather
  than per-tanker, a per-chamber acknowledgement could approximate per-BMCU
  attribution for SINGLE-BMCU-per-chamber trips only).
- Effort: **large** (business-process + schema change; only partially solvable even
  with schema changes, since a mixed-chamber pickup cannot be un-mixed after the fact).

### 4. Seal numbers
- Not captured anywhere.
- Where it could go: a new column on `trip_execution_bmcus` (seal applied at loading)
  and/or `trip_acknowledgements` (seal verified at receipt).
- Effort: **small** (single nullable column + form field), assuming TMS users
  physically observe and can type the seal number — no integration needed.

### 5. Formal driver code
- Not captured — only `trip_plans.driver_name` (free text, set once at planning time,
  not corrected if a different driver actually drives, not captured per BMCU pickup or
  per actual execution at all).
- Where it could go: a `drivers` master table (id, driver_code, full_name, license_no,
  ...) + a `driver_id` FK added to `trip_executions` (captured at actual-trip time,
  not just planning time).
- Effort: **medium** (new master table + migration + form changes across plans.js and
  executions.js).

### 6. Invoice/GRN/slip number for the acknowledgement
- Not captured — closest is `trip_executions.dc_number` (free text, one per whole
  execution, not per chamber, not a customer-issued document number).
- Where it could go: a new `invoice_no`/`slip_no` column on `trip_acknowledgements`.
- Effort: **small**.

### 7. `trip_acknowledgements.updated_at`
- Does not exist — only `created_at` (migration 021), which is documented in its own
  migration comment as reflecting the LAST correction, not the first entry, because
  both ack write paths are delete+reinsert. This is actually workable as an
  "updated_at" proxy in practice (it IS updated on every correction) but is misleadingly
  named and was never intended as a polling column.
- Where it could go: rename/repurpose is risky (existing reports depend on the
  "entry date" semantics of `created_at` — see migration 023's careful backfill note);
  cleanest fix is a NEW `updated_at` column, defaulted and refreshed alongside
  `created_at` in the same insert.
- Effort: **small** (one migration + one line in `applyExecutionData`'s ack insert
  path and the `POST /:id/acknowledgements` handler).

## NOT gaps — confirmed present, do not re-flag these
- Fat%/SNF% AT LOADING (per BMCU, per shift): captured via
  `trip_execution_bmcu_shifts.rmrd_fat_pct` / `.rmrd_snf_pct`, and also directly on
  `trip_execution_bmcus.fat_pct`/`.snf_pct`. **This is NOT a gap.**
- Entered-by / entered-at on acknowledgements: `trip_acknowledgements.entered_by`
  (migration 022) and `.created_at` (migration 021) both exist. **Not a gap**, though
  see #7 above for the updated_at nuance.
- Direct-to-customer sales with customer name: `trip_third_party_sales.customer_name`
  exists. **Not a gap** for the existence of a customer identifier — but note it has
  no rate/amount field (see mapping.md), and no formal customer master/code (see
  identity.md).
