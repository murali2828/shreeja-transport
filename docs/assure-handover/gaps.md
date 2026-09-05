# Gaps: What Assure Needs That TMS Does Not Capture Today

For each item: where it could plausibly be captured in TMS, rough effort, and whether
a customer-provided file is unavoidable instead.

## Confirmed real gaps

> **Important framing (confirmed by Shreeja, 2026-09-05):** the acknowledgement that
> Shreeja's team enters in TMS *is* the customer plant's weighbridge + lab reading,
> transcribed from the customer's slip. So the customer-end **net** quantity, fat and
> SNF are already in TMS (`trip_acknowledgements`). The gaps below are the fields on
> that same slip that TMS's ack form does not have a box for — the executor already
> has the slip in hand when typing the ack, so most of these are cheap to add, not
> customer-file dependent.

### 1. Weighbridge gross/tare weight
- TMS stores only the **net** figure (`trip_acknowledgements.qty_litres` /
  `qty_kgs`) copied from the customer's weighbridge slip. Gross and tare are on that
  same slip but there is no column for them.
- Where it could go: two nullable numeric columns (`gross_kg`, `tare_kg`) on
  `trip_acknowledgements` — one weighbridge ticket per tanker arrival, so
  execution-level rather than per-chamber is the natural grain; putting them on the
  per-chamber ack rows would repeat the same pair across chambers.
- Effort: **small** — migration + two form fields on the acknowledgement screen. No
  customer file needed: the number is already in front of the person typing the ack.
- Caveat: gross − tare will not necessarily equal the sum of per-chamber `qty_kgs` to
  the gram (chambers are read separately from the total weigh); Assure should treat
  the net per-chamber figures as authoritative and gross/tare as a cross-check.

### 2. CLR / acidity / numeric temperature / quality grade at the customer end
- Not captured — `trip_acknowledgements.temperature` and `.description` are free text
  only; no CLR, acidity, or grade columns exist. These are on the customer's lab slip
  alongside the fat/SNF that TMS *does* capture.
- Where it could go: new nullable numeric/enum columns on `trip_acknowledgements`,
  captured per chamber like fat/SNF already are.
- Effort: **small** (migration + form fields). Same reasoning as #1 — the executor is
  transcribing from the customer's slip anyway, so no customer feed is required for
  these. (A customer feed only becomes unavoidable if Assure wants a *machine* copy of
  the slip rather than a transcription — see #8.)

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
  execution, not per chamber, not a customer-issued document number). The customer's
  own slip/GRN number is printed on the very slip the executor transcribes the ack
  from, so it is readily available at entry time.
- Where it could go: a new `customer_slip_no` column on `trip_acknowledgements`
  (execution-level — one slip per arrival — or repeated per chamber). This is the
  natural candidate for Assure's `dairy_ref` unique key, which TMS currently cannot
  supply (see `mapping.md`).
- Effort: **small**. Recommended as the highest-value addition on this list: it is
  the only field that would let Assure match a TMS ack to a customer-side record
  without heuristics on vehicle + date.

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

### 8. Transcription vs. a machine copy of the customer slip
- Everything in `trip_acknowledgements` is hand-typed from the customer's paper/printed
  weighbridge + lab slip by Shreeja's team. TMS holds no image, PDF, or machine feed of
  that slip, and no customer portal or customer login exists (confirmed: no
  'customer' role and no customer-facing route in `backend/src/routes/*`).
- Consequence for Assure: TMS's ack figure and the customer's own system figure
  *should* agree, but can differ by transcription error (digit transposition, wrong
  chamber, litres/kg mix-up). Assure cannot detect this from TMS data alone.
- Options, cheapest first: (a) tolerate it — set reconciliation tolerance bands wide
  enough to absorb occasional typos and route outliers to manual review; (b) add a
  slip-photo upload to the ack screen (small effort, gives a human audit trail but no
  machine check); (c) obtain a periodic customer-side export and reconcile
  TMS-ack-vs-customer-record as a *separate* check from BMCU-vs-ack — this is the only
  option that actually catches transcription error, and it needs #6 (`customer_slip_no`)
  to join on.
- Effort: (a) none in TMS; (b) **small–medium**; (c) **none in TMS** beyond #6, but a
  customer-provided file/feed is unavoidable.

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
