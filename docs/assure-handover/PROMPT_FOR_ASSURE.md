# Prompt for Claude Code in the Shreeja Assure repository (`shreeja-emms`)

> Paste everything below the line into Claude Code inside the **Assure** repo, after
> the handover folder has been copied in (e.g. to `docs/tms-handover/`). Adjust the
> path on the first line if you put it somewhere else.

---

The folder `docs/tms-handover/` is a completed, read-only handover from the Shreeja
TMS (Tanker Management System) team describing the one hop of the milk-procurement
chain that TMS owns:

  BMCU dispatch → tanker trip → customer-plant acknowledgement → transporter payment

Read it in this order before touching any code:

1. `README.md` §0 "TOP-LINE WARNINGS" — five findings that change the reconciliation
   design. The important ones:
   - Density factor is **1.0285 kg/L** (agreed — use it, not 1.028).
   - The TMS acknowledgement **is the customer plant's own weighbridge + lab reading**,
     transcribed by Shreeja staff. It is the customer-end figure to reconcile against
     BMCU dispatch — but it holds only the NET quantity, fat and SNF; no gross/tare,
     CLR, acidity, grade, accept/reject, or the customer's slip number.
   - **Multi-BMCU pickup is the norm (~3.8 loadings per trip).** The customer-end
     reading is one blended figure per trip per chamber and can NEVER be attributed
     back to an individual BMCU. Reconcile at trip level, not BMCU level.
   - TMS pays the **transporter per km**. There is no milk-value payment, no
     rate-per-litre, no amount-for-milk anywhere in TMS. Do not map
     `proc_dairy_receipt_raw.rate_per_litre` / `amount` from TMS.
   - Executions can be amended after `closed` via a change-request flow, and
     `trip_acknowledgements` has no `updated_at` — poll incrementally, don't pull once.
2. `mapping.md` — TMS source column (or "not available") for every column of
   `proc_transport_trip_raw` and `proc_dairy_receipt_raw`, plus the columns Assure
   should add.
3. `samples/README.md` then the CSVs in `samples/` — one real production week
   (2026-08-01 → 07): 350 trips, 1,150 BMCU loadings, 951 acknowledgement rows, plus
   masters. Grain and join keys are documented there. `payments_*.csv` is empty for a
   documented reason; `third_party_sales_*.csv` is empty because the feature is new.
4. `README.md` "Volume" — real monthly row counts for capacity planning.
5. `gaps.md` — what TMS does not capture, and what it would cost to add. Item #6
   (`customer_slip_no`) is the single most valuable addition: it is the natural
   `dairy_ref` key and the only way to join a TMS ack to the customer's record without
   vehicle+date heuristics.
6. `access.md` + `sql/` — proposed read-only views `assure_trips_v` /
   `assure_receipts_v` (not yet created in TMS) and a proposed REST endpoint, for the
   later live-connection phase.
7. `identity.md` — how TMS codes (BMCU `bmcu_code`, `tanker_number`, delivery point
   names, users) relate to SAP/Assure masters, and where a mapping table is needed.

Then, for the one-month-of-history ingestion:

- Build the loaders for `proc_transport_trip_raw` and `proc_dairy_receipt_raw` from
  the CSV shapes in `samples/`, using the column mapping in `mapping.md` exactly.
  Where `mapping.md` says "not available in TMS", leave the column NULL — do not
  derive or guess.
- Filter `loadings` rows with `is_deleted = TRUE` and reconcile only executions with
  `status = 'closed'`; both are called out in `samples/README.md`.
- SUM acknowledgement rows per `execution_id` (they are per chamber) before comparing
  to the trip's total dispatch.
- Add the extra columns `mapping.md` proposes (`loaded_fat`, `loaded_snf`,
  `loaded_kg`, per-pickup legs, `net_kg`, `receipt_at`, `trip_ref`, `entered_by/at`).
- Raise anything in the handover that contradicts what you find in Assure's own
  design before implementing around it — the TMS team can be asked.

Do not modify anything under `docs/tms-handover/`; it is the TMS team's document.
