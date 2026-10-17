# Changelog

All notable changes to Shreeja TMS. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are not tagged; entries are grouped by the fortnight they landed on `qa`, newest
first. Seeded from `git log --since=2026-07-01 --no-merges` (history in this clone starts
2026-07-24). Migration numbers are noted where a change touched the schema.

## [Unreleased] — on `qa`, pending promotion to `main`

### Added
- Tanker Utilisation → Day wise → By billing run: fortnight picker gains **Whole month** — the latest run of 1–15 and of 16–month end together (rows, counts, search, reasons and Excel "Billing run #A + #B"); the approval note stays per run (`GET /api/reports/day-utilisation?run_ids=` + `/excel`) (owner, 2026-10-17).
- Push to Vendors attaches a printable **Tanker Cards** workbook beside the trip sheet, in the logistics team's card layout: a Summary page (state × tanker × type trips, km, amount, toll challans, total payable) and one sheet per state with a block per tanker × transport type (material trips in their own block) — company line, "Road Tankers Movement Of BMCU's Details From … To …", SL / Date / Vehicle / Capacity / Type / Route / BMCUs / Kms / Rate / Amount, SUM total and a vendor-signature / verified-by line; every sheet portrait A4 fit to width (BMCU chain wraps), a page break after each block so each tanker × type prints on one page for signature (owner, 2026-10-17).

## 2026-10-17 (2) — promoted to `main` 2026-10-17 (no migrations)

### Changed
- Billing run tables: Transport Type shown compact as BMCU/CC / P2P (full name on hover, header "Type") so Amount is visible at first glance (owner, 2026-10-17).
- Utilisation approval mail is chart-first and shorter: greeting and a two-line summary, then the four charts, then one line per reason (trips, short cause, average utilisation, plants with counts, the over-94 % count, logistics' details) and the near-target line; route lists and the plant table move to the attached Excel. Same layout on the decision page and the Mail preview; Regenerate from data builds the short text (owner, 2026-10-17).

## 2026-10-17 — promoted to `main` 2026-10-17 (no migrations)

### Added
- Reports → Analytics: **Trends** section at the top (own FY picker, default current FY vs previous FY, billing runs all / approved; independent of the page's date filter): YTD strip (milk received, trips, km, all-in transport cost, all-in ₹/L, utilisation %, TS gain/loss kg — this FY YTD vs the same months last FY with Δ and Δ %, green = good / red = bad), month-on-month milk bars + all-in ₹/L line, this FY vs last FY lines for milk, ₹/L and utilisation (95 % target line), stacked monthly cost (trip amount + toll + fixed cost), trips & km with avg km/trip, TS gain/loss per month (portal trips only; FY-workbook months show no TS). Figures from `services/transportCumulative.js` (same as Tanker Utilisation); API `GET /api/analytics/trends?fy=&status=`. Period charts above the tables: delivery point delivered kg and TS gain/loss, top 10 routes by TS loss, tankers by fill band (< 80 / 80–90 / 90–95 / ≥ 95 %) and lowest fill, day-of-week TS and trips. Analytics Excel gains a **Trends** sheet (month rows, FY vs last FY, YTD) (owner, 2026-10-17).
- Utilisation approval mails, the decision page and the panel's Mail preview carry four summary charts drawn with table cells (render in Gmail / Outlook / phones, no images or scripts): above vs under 95 % split bar, under-95 % trips by reason, by plant, and trips by utilisation band (< 80, 80–90, 90–94, 94–95, ≥ 95 %) (owner, 2026-10-17).

### Changed
- Billing run Trip Wise / Material / Sale tabs: **Scans** has its own column per trip line (was inside the Tanker cell); State and Transport Type dropdowns widened so the chosen value reads fully (owner, 2026-10-17).
- Utilisation approval Excel attachment: the Approval note sheet is removed (the note is in the mail body) (owner, 2026-10-17).
- Utilisation approval mails no longer carry the "N under-utilised trip(s) had no reason tagged at submission" line (owner, 2026-10-17).
- Utilisation approval note: counts in bold in the mail (above / under trips, total movements, every "(N trips, avg util X%)"), Mail preview under the note; "Not yet categorised" block dropped and replaced by **Near-target trips (94 % to 95 %)** with per-plant counts (also in the Excel Summary / By plant); new closing line; each mail greets its approver (`BILLING_APPROVER_n_TITLE`, defaults Sir / Madam / Sir) and the initiator mail likewise (owner, 2026-10-17).

### Fixed
- Transport Cost Drivers failed with "Failed to build the cost driver analysis" for every period since the diesel carry-forward: the diesel query passed an unused parameter (owner, 2026-10-17).

## 2026-10-16 (2) — promoted to `main` 2026-10-16 (no migrations)

### Changed
- Tanker Utilisation: reasons, reason detail and approval remarks can be keyed by whoever may raise the utilisation approval — Reports **or Execution** at Edit (logistics, e.g. Mahesh K), besides admin and planner / biller with Reports Edit (owner, 2026-10-16).

## 2026-10-16 — promoted to `main` 2026-10-16 (migrations 068–074)

### Changed
- Billing run Excel: the **Tanker Utilisation** sheet is removed; utilisation travels with its own approval mail (attached workbook) and Reports → Tanker Utilisation (owner, 2026-10-16).

### Added
- Tanker utilisation: material (buy-and-sell) trips are out of utilisation like sale tankers — no %, MATERIAL badge on Day wise, left out of the fleet total, above / below counts, the approval note and mail, its Excel attachment (also its All trips sheet) and the billing run Excel's Tanker Utilisation sheet (owner, 2026-10-16).
- Tanker utilisation approval note: each plant line lists the trips' **route names** instead of BMCU names (Excel "By plant" column Routes); Regenerate from data rebuilds a saved draft (owner, 2026-10-16).
- Tanker utilisation approval mails attach a workbook with the data: Summary (movements, above / under 95 %, per reason trips, lowest / average utilisation, over 94 %, plants, approval status), Below 95 % (each under-utilised trip with reason, detail, plant, route, capacity, litres, utilisation, approval remarks), By plant (reason × plant with BMCUs and details), All trips of the run, and the Approval note text (owner, 2026-10-16).
- **Tanker utilisation approval** (L1 → L2 → L3, migration 074): the Approval note on Reports → Tanker Utilisation → By billing run is generated in the structure of logistics' fortnightly mail (period, movements, above / under 95 %, per reason the trip count and the plants, per plant the BMCUs with trips and average utilisation and its reason details, lowest / average utilisation, the over-94 % line, "Not yet categorised (N trips)", plant summary table) and is editable (Regenerate from data, Save draft). Logistics submits it for approval independently of the run's payment approval; the approvers are the billing run's L1 / L2 / L3 (`BILLING_APPROVER_1..3`, shared in `services/billingApprovers.js`; QA divert `BILLING_EMAIL_REDIRECT`). Each level gets a mail "Tanker utilisation approval — Billing run #N (period) — Ln" with the note, the plant table, the run's Day wise Excel and single-use Approve / Reject links (`/utilisation-decision`, SHA-256 token, 14 days) or decides in the panel; L3 approval or any rejection (remarks required) mails the initiator; Withdraw while L1 is undecided; a rejected approval stays as history and can be resubmitted. The panel shows status badge and steps; the billing run card shows the status; the run's approval mails keep the note and add the utilisation approval status line. API `/api/utilisation-approvals` (`GET ?run_id`, `PUT /draft`, `POST /submit`, `POST /:id/withdraw|approve|reject`, `GET /decision-info`, `POST /decide`); tables `utilisation_approvals`, `utilisation_approval_steps` (owner, 2026-10-16).
- Under-utilisation approval with the billing run: on Reports → Tanker Utilisation → Day wise → By billing run, chips All / Above 95 % / Below 95 % with counts; in Below, tick trips (select-all) and **Tag reason** — "Batch Preparation and Specific Plant Requirements" or "Operational Delays and Plant Maintenance" plus optional detail — or set it per row; "Untagged: N" warning; an **Approval note** panel drafts logistics' fortnightly mail (movements, above / under, per reason the plants with their BMCUs, the over-94 % line for operational delays) with Copy. The note is appended to the run's L1 / L2 / L3 approval mails — approving the run approves it; Submit warns (never blocks) when below-threshold trips have no reason; the run page shows a Tanker utilisation card. Day wise Excel and the run Excel's Tanker Utilisation sheet gain Reason and Reason detail. API `PUT /api/reports/day-utilisation/remark` (also reason / reason_detail), `PUT /api/reports/day-utilisation/reasons` (bulk), `GET /api/reports/day-utilisation/note?run_id=`; migration 073 `utilisation_remarks.reason / reason_detail` (owner, 2026-10-16).
- Billing run Excel → Tanker Utilisation sheet leaves sale tankers out (they carry no utilisation); S.No renumbered (owner, 2026-10-16).
- Tanker Utilisation Day wise: editable **Approval remarks** per trip (e.g. CE approval) in both modes, saved on leaving the cell, blank clears, read-only for View users; shown as "Approval Remarks" in the Day wise Excel (`PUT /api/reports/day-utilisation/remark`, migration 072 `utilisation_remarks`). The billing run Excel gains a **Tanker Utilisation** sheet with the run's Day wise rows (Billing Date, Utilization %, ABOVE / BELOW, remarks, approval remarks; vendor workbooks only that vendor's lines; threshold `UTILISATION_THRESHOLD`, default 95); rows built by `services/dayUtilisation.js` (owner, 2026-10-16).
- Reports → Tanker Utilisation → Day wise: mode **By billing run** beside By acknowledgement date — pick a run ("#25 · 01-10-2026 → 15-10-2026 · draft · 671 trips", latest first) and the list holds exactly that run's lines (excluded and sale-tanker lines too, sale tankers without %), ordered by billing date then tanker, with a Billing Date column and the run facts in Remarks (carried forward, excluded in run, the line's own remark such as late ack / pulled); above / below counts and Excel (title and file name "Billing run #N") work in both modes; mode remembered per browser. The run is chosen by **Month** and **Fortnight** (1–15 / 16–month end): one run loads directly, several (e.g. a rejected and a new run) offer a dropdown latest first, none shows "No billing run for this fortnight yet"; `GET /api/reports/billing-runs?from=&to=` filters by exact period. For logistics' CE approval of trips below 95 % after each run. API `GET /api/reports/day-utilisation?run_id=` (+ `/excel`), `GET /api/reports/billing-runs` (reads the tables directly, works with billing unmounted) (owner, 2026-10-16).
- Trip scans follow-ups: **Scans pending (N)** toggle on Active Trips and Closed Trips filters the loaded list to trips with a BMCU line without a DC scan or an acknowledged trip without an ack slip (the list now carries `acknowledged`, same rule as Scan Status; the chip's Ack ✗ turns red only for acknowledged trips; toggle remembered per browser). **📎 Scans** link opens a read-only viewer of the trip's scans grouped as DC per BMCU (code · name) and Ack slip on execution change requests (Execution → Approvals, list and expanded detail) and on billing run Trip Wise lines beside the tanker; images load only when opened. `GET /api/trip-scans` and its file / thumb now also admit roles with the Billing module (view or edit) (owner, 2026-10-16).
- **Trip scans** (migration 071, ADR-025): logistics attaches the scanned / photographed BMCU dispatch challan (DC) to each BMCU line of an execution (📎 on the row, also on closed and billed trips) and the plant acknowledgement slip to the trip (Acknowledgement form and the closed trip's acknowledgement block); several pages per DC / ack, camera or files, multi-select. Photos are shrunk in the browser (≤ 1800 px, JPEG 0.72, 320 px thumbnail; PDFs as-is, ≤ 10 MB, 10 files per upload) and upload in the background with a progress chip and one retry; the server accepts JPEG / PNG / PDF by magic bytes (HEIC refused with "save the photo as JPEG"), streams to disk and stores each file once under `UPLOAD_DIR/trip-scans/YYYY/MM/<sha256>.<ext>`. Badges "DC ✓ 2" / red "DC pending" open a viewer (thumbnails, zoom, PDF inline, next / prev, uploader and time). Active Trips and Closed Trips show a "DC 3/5 · Ack ✓/✗" chip from the executions list query; Reports → **Scan Status** lists per trip DCs scanned n / m and the ack slip, "pending only", Excel. Adding files needs no approval; **replacing or deleting** an uploaded scan is a change request with reason: the approver (`CHANGE_APPROVER_ID`, cc `CHANGE_APPROVER_CC`) gets an email with current and proposed files attached and single-use Approve / Reject links (`/scan-change-decision`) or decides on Scan Status → Scan changes; only approval applies; admins may delete directly; the viewer marks a scan "Change requested — pending approval". Scans never change trip data, so the billing freeze and trip change-request rules are untouched. API `/api/trip-scans` (`GET ?execution_id`, `POST`, `GET /:id/file|thumb`, `DELETE /:id` admin, `GET /pending` + `/pending/excel`, `GET /summary`, `POST|GET /change-requests`, `/change-requests/decision-info|decide`, `/change-requests/:id/approve|reject`); tables `trip_scans`, `trip_scan_change_requests` (owner, 2026-10-16).

### Changed
- Billing: billing date = **lifting date** (`BILLING_DATE_OFFSET_DAYS=0` on both tiers, was 1 = delivery date): a 1–15 run covers trips lifted 1st–15th and a 16–end run 16th–month end; the acknowledgement cutoff (06:00 on the 16th / 1st) is unchanged. Env change only; trips lifted on the last day of the previous month that a run already holds stay where they are, nothing is billed twice (owner, 2026-10-16).

### Added
- QA Dispatch Report: a chamber filled by a single entry shows its QA acknowledgement and Ack − RMRD on that entry's row (no repeated chamber line); separate chamber rows remain only for chambers shared by several entries, split entries or acked without an entry (owner, 2026-10-15).
- QA Dispatch Report: route and grand totals (screen and Excel) fill "Dispatch − RMRD (adjusted)" Var Fat and Var SNF from kg-weighted fat % / SNF %; under each tanker × lifting date a tinted row per chamber (FC, MC, BC) shows the QA acknowledgement of that chamber beside its dispatch and RMRD adjusted figures (an entry on several compartments split equally, as in the Dispatch & COA prefill) with Ack − RMRD Lts / Kgs / Fat / SNF and Ack − Dispatch Lts (owner, 2026-10-15).
- Quality → Dispatch & COA: **Valve** column with its own seal number beside Front / Middle / Back cell, on screen and on the printed Milk Dispatch Voucher, as on the paper template (stored in the document data, no migration) (owner, 2026-10-15).
- Quality → Dispatch & COA: the template's Bill-to (NDDB Dairy Services …) and Ship-to (Mother Dairy Fruit and Vegetable Pvt Ltd c/o Balaji Dairy, SAP 4024119 …) values pre-fill every new document whatever the plant; a plant's saved parties win field by field; all fields stay editable (owner, 2026-10-15).
- QA Acknowledgement: **MBRT (mins)** per chamber (optional, 0–1440, server-validated) with the lowest value on the total line; the QA Dispatch Report and its Excel show "Ack MBRT" in the Plant Acknowledgement (QA) section, the lowest MBRT across chambers on tanker, route and grand totals (migration 070, `qa_acknowledgements.mbrt_mins`, CHECK `chk_qa_ack_mbrt`) (owner, 2026-10-15).
- Quality → **QA Acknowledgement**: the QA team keys its own plant acknowledgement per tanker × lifting date, chamber cards following Tanker Master compartments (FC / MC / BC), Kgs first with litres (kgs ÷ 1.0285), kg fat and kg SNF derived server-side, ack date, remarks, and a reference strip with QA dispatch and RMRD adjusted totals; the server refuses a chamber the tanker lacks. The QA Dispatch Report, its totals and Excel now compare against this QA ack ("Plant Acknowledgement (QA)") instead of the logistics team's; nothing else reads it (`GET /api/quality/acks/tankers`, `GET /api/quality/acks`, `PUT /api/quality/acks`; migration 069, `qa_acknowledgements`) (owner, 2026-10-15).
- QA Dispatch Entry: **Balance milk** in the Truck sheet card, as on Active Trips — Left Over milk (deducted from RMRD) and Lifted milk (added), each with qty (L), fat %, SNF % (blank = truck sheet's) and remarks, plus a live "RMRD after adjustment" line; the QA report, totals and Excel show left over, lifted and RMRD adjusted (L, kgs, fat %, SNF %, kg fat, kg SNF), and dispatch − RMRD and Ack − RMRD use the adjusted RMRD like the TS report (migration 068, `qa_dispatch_entries.lo_* / lf_*`) (owner, 2026-10-15).

### Fixed
- Transport Cost Drivers: a fortnight whose diesel price is not keyed showed diesel 0.00 and no diesel effect; the last known price of the state now carries forward (Diesel Rates master, else the rate cards' diesel price), mileage falls back to the latest rate card of the same state × type × capacity, a missing price shows "—" and the notes name each state and period whose price was carried or missing (owner, 2026-10-15).

## 2026-10-15 (2) — promoted to `main` 2026-10-15 (no migrations)

### Changed
- FY-workbook trips show the portal's Delivery Point names (e.g. "Balaji Dairy" for MDFVPL, "Jersey Milk Processing Unit, Madanapalli.") in the Payment Report and Transport Cost Drivers, so workbook and portal trips of one plant fall on one row; mapping by plant in `services/plantNames.js` at read time, no reload needed (owner, 2026-10-15).

## 2026-10-15 — promoted to `main` 2026-10-15 (no migrations)

### Added
- Transport Cost Drivers: **By delivery point** table (screen and Excel sheet) with the same columns as By state — trips, litres, km, cost, ₹/km, ₹/L and every effect per receiving plant; FY-workbook plant names mapped to the delivery point master (owner, 2026-10-15).
- Transport Cost Drivers: comparison option **vs a chosen month…** with financial-year and month pickers (owner, 2026-10-15).

## 2026-10-14 — promoted to `main` 2026-10-14 (migrations 065–067)

### Added
- Minimum 9,000 km per tanker per month (approval note 04-06-2026, May–Oct 2026): finance's approved monthly "Fixed Cost Consolidated Report" is uploaded on Reports → Tanker Utilisation → **Fixed cost (9,000 km)** (preview → confirm, admin / biller; the month replaces an earlier upload) or loaded with `backend/scripts/import_fixed_costs.js`; the parser reads the sheet "9000 Kms Transporter Wise Difference Fixed Cost On <Mon-YY>" (latest month in the file) per tanker: run km, maintenance days / km, balance km, fixed ₹/km, amount (`tanker_fixed_costs`, migration 067). Counted everywhere transport cost is reported: Month / Year Cumulative gain **Fixed cost**, **Total cost** = trip amount + toll + fixed cost and **Cost/Ltr (all-in)** beside Cost/Ltr (trips); the Payment Report's Tanker / Vendor Wise (screen and Excel) gain Fixed cost, Total cost and Cost/Ltr all-in plus a monthly summary line; the Analytics transport-cost card shows the all-in cost and ₹/1000 L; Transport Cost Drivers adds a "Toll & fixed cost" effect so the total is the all-in change. Fixed cost and toll are month-level and attach to whole months only (owner, 2026-10-14).
- Payment Report → Date Wise (screen and Excel): columns Toll, **Fixed cost** and Total Payable; the run toll, the FY-workbook monthly toll and the month's 9,000-km fixed cost appear as subtotal rows (never per day), and TOTAL carries the toll and fixed-cost totals with Total Payable = amount + toll + fixed cost (owner, 2026-10-14).

### Changed
- Transport Cost Drivers reads the FY workbook trips (`historical_trips`) for dates up to `ANALYTICS_HISTORY_UNTIL` and portal executions after it, like the Payment Report: billed km, amount and acknowledged litres per trip, BMCUs from the workbook's coverage text matched to the BMCU master (also for the first-served date, so April–August BMCUs are not "new" later); cost source "FY workbook". Jun vs May 2026 now compares 1,292 with 1,143 trips instead of 128 with 2 (owner, 2026-10-14).
- Reports → **Tanker Utilisation** (renamed from Day Utilisation) has three tabs: Day wise (unchanged), **Month Cumulative** and **Year Cumulative** with a financial-year picker, run filter (approved / all) and Excel. The two cumulative views (incl. the toll / total-cost columns and the "Upload earlier years" history upload, admin) moved here from Billing → Payment Report, whose tabs and Excel no longer carry them; anyone with the Reports module sees them. API `GET /api/reports/cumulative` (+ `/excel`, `/history-template`, `/history`, `POST /history-upload`); logic in `services/transportCumulative.js`, Excel styling in `services/portalExcel.js` (owner, 2026-10-14).

### Added
- Monthly toll from the FY workbook: each month sheet's "Toll cost" total (Apr ₹14,49,817 · May ₹14,71,607 · Jun ₹24,11,412 · Jul ₹17,69,663 · Aug ₹16,75,521) is loaded by `import_trip_history.js` into `historical_month_tolls` (migration 066). Month / Year Cumulative (screen and Excel) gain **Toll** and **Total cost** (amount + toll); up to `ANALYTICS_HISTORY_UNTIL` the toll is the workbook's monthly total, afterwards the toll challans of the month's billing runs. The Payment Report shows a "Toll for <month> (FY workbook, monthly total)" line for whole history months in the period (screen and the Date Wise Excel sheet); the workbook toll is not split per tanker or date. The sheets' "9K KM Fixed cost" rows are not loaded (owner: later) (owner, 2026-10-13).
- FY 2026-27 trip history from the logistics team's "Tanker Utilization consolidation" workbook (April–August 2026, 6,170 trips): `historical_trips` (migration 065) loaded with `backend/scripts/import_trip_history.js` (dry run with per-month totals, corrections, unmatched tankers / vendors and normalised plants; `--apply`; `--compare` a sheet against portal billing). The Payment Report (Trip / Date / Tanker / Vendor tabs) and the Month / Year Cumulative sheets read these rows for dates up to `ANALYTICS_HISTORY_UNTIL` (default 2026-08-31) and portal billing lines only after it, so August is counted once. Rules: the 68 trips dated 31-03-2026 on the April sheet count in April; 37 dates with a wrong year (2025 / 2024) are corrected to 2026. Billing, executions, TS reports and the Assure feed do not read the history (owner, 2026-10-13).
- Backup and restore on the shared **ops-kit** (`ops/`, from Shreeja Assure; ADR-023): point-in-time recovery of each tier's database to any minute in the last 4 weeks (pgBackRest in the Postgres 16 Alpine image, WAL archived every ≤ 60 s, encrypted repository), encrypted nightly dumps and config bundle, uploads, code bundle and image archive, FTP mirror to the NAS every 4 hours behind a shrink guard, e-mail alerts (watchdog every 2 min, backup check every 30 min), scripted scratch-first restores (`ops/bin/restore.sh --time / --latest / --dump`, `--swap` only with typed confirmation) and `ops/bin/deploy.sh` as the deploy path (dump first, health check on the deployed git sha). `/api/health` now reports `git_sha`; new `/api/health/ready` and `/api/health/backup`. Server bring-up, restore runbook and drills: `docs/BACKUP_RESTORE_STRATEGY.md`. Template `.env.deploy.example` (owner, 2026-10-13).

## 2026-10-12 — promoted to `main` 2026-10-12 (no migrations)

### Changed
- Acknowledgement: the chamber cards follow the tanker's compartments in Tanker Master (`2C` → FC, BC; `3C` → FC, MC, BC; `1` → FC); a chamber already acknowledged outside that list stays visible. The server refuses quantities on a chamber the tanker does not have. The BMCU chamber picker on the execution page uses the same list. Shared helper `utils/compartments.js` (also used by QA dispatch) (owner, 2026-10-12).

## 2026-10-10 — promoted to `main` 2026-10-10 (migrations 060–064)

### Added
- Quality → **Dispatch & COA**: pick lifting date and tanker; the Milk Dispatch Voucher (delivery challan) and Certificate of Analysis are pre-filled from the QA dispatch entries (litres and milk type per compartment, kg-weighted fat / SNF, lowest MBRT), the plan (route, starting point, delivering plant) and the masters (transporter, driver, Bill-to / Ship-to per delivering plant, seeded for Balaji Dairy); every field editable, dropdowns for milk type, states, tax rates, HSN, COA observations; Save assigns a running challan number `DC/26-27/0001` (editable); Print Dispatch / Print COA reproduce the paper templates (Book Antiqua header, Calibri body, black, A4), reprints marked DUPLICATE (migration 064, `qa_trip_documents`, `delivery_points.bill_to / ship_to`; owner 2026-10-10).
- QA Dispatch Entry: **Milk type** chips (Cow / Buffalo / Mixed) under the compartment chips, required on new and edited entries (migration 063, `milk_type`); shown as a column in the QA report and Excel (owner, 2026-10-10).
- QA Dispatch: MBRT (minutes) field in the Truck Sheet section of the entry form (migrations 061 / 062, `ts_mbrt_mins`, 0–1440; 062 converted the first hours-based version); the QA report and Excel show it per entry and the lowest MBRT on route and grand totals. Tanker subtotal rows dropped from the report — route totals carry the acknowledgement comparison (owner, 2026-10-10).
- Quality → QA Dispatch Report: columns grouped into colour-banded sections (Entry, Dispatch, Truck Sheet, Variation, Plant Acknowledgement); rows grouped by route and by tanker × lifting date with subtotal rows; each tanker / route subtotal shows the plant acknowledgement entered by the logistics team (litres, kgs, fat %, SNF %, kg fat, kg SNF) and the variation Acknowledgement − RMRD (truck sheet) in litres, kgs, fat % and SNF % plus Ack − Dispatch litres; grand total; the Excel carries the same grouping, section colours and acknowledgement columns (`GET /api/quality/entries/report`, owner 2026-10-10).
- Roles: per-module access level **None / View / Edit** (migration 060, `roles.access`). Masters → Roles shows a three-way selector per module (Masters, Planning, Execution, Billing, Reports, Quality) with "All granted → View / Edit" shortcuts; the table shows EDIT / VIEW badges. View lets a role open the module's screens and reports but every create / change / approve / delete in that module is refused by the server ("view-only access to …"), even for built-in role names such as planner or biller; Edit is full use. A user with several roles gets the highest level per module. Existing roles were migrated as Edit for ticked modules (View for read-only roles such as viewer); `read_only` is now derived (no module at Edit) and the built-in viewer is capped at View. The login response carries `access`; Billing opens without edit controls and Execution hides Start / Other Gate Pass / Approvals for View-only users (owner, 2026-10-10).

## 2026-09-16 → 2026-10-09 — promoted to `main` 2026-10-09 (migrations 045–059)

### Added
- Billing → Payment Report in the finance team's format: Trip Wise gains S.No, SAP vendor code (the Vendor master's vendor code), cost per litre, utilisation %, milk received (plant acknowledgement: litres, kgs, fat %, SNF %, kg fat, kg SNF) and BMCU coverage; Date Wise and Tanker Wise carry the milk columns, Date Wise also tanker capacity, rate per km, cost per litre and utilisation; System KM and Google KM dropped from all four sheets (finance marked workbook); the per-run Excel follows the same layout (Trip Wise with SAP code, milk, cost per litre, utilisation, BMCU Details last; Date Wise as the second sheet with capacity, milk and cost columns; Tanker Wise milk columns; portal styling on every sheet); new **Month Cumulative** sheet / tab (every month of the From date's financial year: capacity, milk, fat / SNF / TS %, km, rate per km, amount, cost per litre, utilisation, trips, average km, average diesel ₹/L) and **Year Cumulative** (month × financial year matrix with YTD). Earlier financial years are keyed once through "Upload earlier years" (admin, `transport_monthly_history`, template from the tab); a month present in the portal always wins (owner, 2026-10-08).
- Diesel ₹/litre per state per fortnight (migration 058, `diesel_rates`) is maintained from **Masters → Tanker Rates**: the template's "Diesel Price" row and the rate form's diesel field fill it on upload / save, and a diesel strip on the page shows and edits the fortnight's prices. The rate list shows the master price where a row has none (owner, 2026-10-08; the separate Diesel Rates page and the generate-from-diesel option were dropped the same day at the owner's request — rates are uploaded from purchase's annexure as before).
- Reports → **Transport Cost Drivers**: pick a fortnight, month, FY quarter, financial year or custom range and compare with the previous period, the same period last year or a custom one; the change in ₹/litre (or amount) is split into diesel price, kilometres, new BMCUs, closed BMCUs, mix / other and volume, per state and overall, with the BMCUs added / no longer served listed; Excel with trip-level detail (`GET /api/analytics/cost-drivers`, `services/costDrivers.js`) (owner, 2026-10-08).
- Roles: **Read-only** switch (migration 057, `roles.read_only`; the built-in viewer is read-only and stays so). A user whose roles are all read-only can view the modules those roles tick but every create / change is refused by the auth gates; the login response carries `read_only` so the menu hides create actions and billing opens without edit controls. Lets finance / MIS get a role with billing + reports that only looks (owner, 2026-10-07).

### Security
- Role alignment after the audit of 2026-10-07 (migration 056 gives executor its execution flag so its menu matches the API): execution, plan and trip-document reads need the execution scope (admin / planner / executor / biller / viewer); reports and analytics need the reports module; tanker rates, vendors and tanker documents need masters or the roles that use them; Tanker Position is limited server-side to admins and `TANKER_POSITION_USERS`; plan email configuration is admin only; the viewer role no longer reads billing; change-request portal decisions pass the execution gate; every masters / planning / execution page guard also accepts the matching module so custom roles work; Dashboard quick actions follow the user's modules.
- Viewer role sees only the Execution section (migration 055 resets its module flags to execution only; billing, reports and tanker-rate pages now require their module) and the menu hides Other Gate Pass, Approvals and the Start button for viewer-only users (owner, 2026-10-07).
- Viewer role is read-only: a user holding only `viewer` is refused every POST / PUT / DELETE by all three authorisation gates, whatever module flags the role carries (it was able to save executions and edit billing runs through its execution / billing module flags); change-request creation now goes through the execution gate (owner, 2026-10-07).

### Changed
- QA Dispatch Entry: compartment chips come from the tanker's compartment count in Tanker Master (`2C` → FC, BC; `3C` → FC, MC, BC) and several may be ticked on one row when one BMCU's milk is split; stored and reported as e.g. `FC,MC` (migration 054, owner 2026-10-07).

### Added
- Users can hold several roles (migration 053, `users.roles`): Masters → Users offers role chips; a user's module permissions are the union of all their roles, the token's primary `role` is `admin` whenever admin is among them, and every role list check (`authorize`, `authorizeOrModule`, page guards, sidebar) accepts any held role (owner, 2026-10-07).
- Quality module (migration 052): role `quality` / module permission `quality`; Quality → QA Dispatch Entry (phone-first: lifting date, route, tanker, BMCU with route members starred, compartment and shift chips, scale reading; dispatch litres / fat % / CLR with SNF, kgs, kg fat / SNF derived; truck-sheet date / shift / litres / fat % / SNF % with kgs derived; live variation; Save & next BMCU) and QA Dispatch Report (filters, edit, admin delete, Excel in the team's column order). `GET/POST/PUT/DELETE /api/quality/entries`, `GET /api/quality/lookups`, `GET /api/quality/entries/excel`. Independent of the tanker team's data (ADR-021, 2026-10-07).
- Installable web app (PWA): manifest, icons and service worker via `vite-plugin-pwa`; app shell cached, `/api` network-only; nginx serves the manifest and worker `no-cache`. QA phones: Chrome → Add to Home screen (2026-10-07).

### Fixed
- Analytics km (Total KM, L/km, tanker leaderboard, transport cost) now reads the billed km when the trip is in a billing run, else the current Distance Master / Google chain, and ignores cancelled executions; the execution's keyed Actual KM follows the recomputed chain on every save unless the executor typed over it. The seeded Actual KM had gone stale when points changed after Start, leaving the dashboard 31,000 km under billing run #20 on the same 530 trips (2026-10-07).

### Changed
- Billing: acknowledgement cutoff moved from 23:59:59 of the period's last day to 06:00 on the following morning (16th / 1st), configurable as `BILLING_ACK_CUTOFF_TIME`; night deliveries of the last day acknowledged before 06:00 now bill in their own fortnight (owner, 2026-10-05).

### Added
- Billing → Toll Challans: rows auto-save (amount / remarks 1.5 s after the last keystroke, a chosen file at once; status shown per row) while the run is editable. Once the run is under approval or approved, each row offers "Request change": the biller proposes amount / challan / No toll with a reason, PP01 (`CHANGE_APPROVER_ID`, cc `CHANGE_APPROVER_CC`) receives an email with run, tanker, vendor, current vs proposed values, the effect on the run total and the proposed challan attached, and approves or rejects by single-use link (`/toll-change-decision`) or in the portal; only approval writes `billing_run_tolls` and refreshes the total (`billing_toll_change_requests`, migration 051; `routes/billingTollChanges.js`) (owner, 2026-10-06).

### Changed
- Material trips: purchase and customer-acknowledgement sections are keyed in kgs with fat % and SNF %; litres, kg fat, kg SNF and TS are derived (KG_FACTOR 1.0285) and stored, `trip_material_data.purchase_kg_fat / purchase_kg_snf` (migration 050, owner 2026-10-06).

### Added
- Billing: "Pull trip…" on a draft / rejected run (`POST /runs/:id/pull-trip` with tanker number + lifting date) adds one closed, acknowledged, unbilled trip from outside the period or after the cutoff; the line is remarked "Pulled into run by biller" (owner decision 2026-10-06, run #20 alignment with the manual tanker cards).
- Billing: ✕ on a trip line of a draft / rejected run removes it from the run (`DELETE /runs/:id/trips/:tripId`) so it returns to the unbilled pool and carries forward to the next fortnight — unlike Excl., which keeps it in the run unpaid. A Sale-Tanker-flagged line the biller un-excludes is now treated as a paid trip in the vendor email sheet and the run Excel (billing team request, 2026-10-06).
- Material trips (migration 049): Materials master (SAP code) under Masters; "Material purchase & delivery" trip kind on the plan form (supplier = starting point, customer = delivery point, no BMCUs); material execution page with purchased qty / fat / SNF + supplier scan, keyed km with Google and Distance Master reference, customer acknowledgement qty / fat / SNF + scan, Acknowledge & Close; billing lists them under a Material Trips tab, in their own section of the vendor email sheet and on a "Material Trips" Excel sheet, billed km defaulting to the keyed km; milk reports and the Assure feed exclude them (ADR-020, 2026-10-05).
- Billing: "Include late acknowledgements (N)" on a draft / rejected run — Re-add with `include_late_acks` also pulls the period's trips acknowledged after the fortnight cutoff (they would otherwise carry forward); `GET /runs/:id/readd-preview` returns `late_missing` / `late_tankers`; each added line is remarked "Acknowledged after cutoff (time)". Execute is unchanged (ADR-011 override, owner decision 2026-10-05).
- History load: `backend/scripts/import_history.js` loads closed, acknowledged trips from the logistics team's FY workbook (TRIPS / TRIP_BMCUS / ACKNOWLEDGEMENTS / NAME_MAP), dry run by default, one transaction per trip, existing trips skipped; RUNBOOK section (2026-10-05).

### Changed
- Billing: a missing toll challan never removes a tanker's trips from a run (owner rule, 2026-09-29). Submit keeps every line, returns `tolls_pending` and lists those tankers in the L1 mail; the toll is uploaded in a later run against the earlier period (`billing_run_tolls.for_run_id`, migration 046; unique key now per run × tanker × period) and paid in that run's total. Toll Challans tab shows "Pending from earlier cycles" and labels carried-in challans; vendor cards / Excel show the period each challan covers (2026-09-29).

### Added
- Billing: `POST /runs/:id/withdraw` — take an undecided pending_l1 run back to draft (approval rows deleted); `GET /runs/:id/readd-preview` + `POST /runs/:id/readd-trips` — re-add the period's trips that are in no run, through the same selection / insert code as Execute; buttons on the run header. RUNBOOK section "Recover a billing run that lost trips" (2026-09-29).
- Day Optimizer: "Plan to plant requirements" mode — the planner enters the litres each plant requires (default = its catchment forecast, priority, locked); `services/plantAllocation.js` decides which BMCUs supply which plant (greedy min extra km × ₹/km per litre, max extra km per BMCU 60, keep-history bonus 5 %, shortfall rule priority / proportional, planner pins), then the whole-fleet routing runs per plant with plant switching off. `POST /api/optimize/day` takes `mode`, `plant_requirements`, `allocation`, `pinned_bmcu_ids`; the preview returns `catchment_forecast_litres` per plant; results show a Plant allocation panel and the reassigned BMCUs with a "keep usual plant" veto that re-runs; Excel sheet "Plant Allocation"; session `constraints` / `summary.allocation` persist it; `scripts/plant_allocation_selftest.js` (2026-09-26).

### Changed
- Day Optimizer comparison is now on an actual **executed** basis: per live, non-sale execution of the date — RMRD litres (dispatch litres as fallback, acknowledged litres alongside), billed km / amount where the trip is in a billing run, else execution km × Tanker Rate Master rate (cost source labelled per trip); trips and tankers used; litre-weighted fill. The planner's expected figures are kept as a muted "Planned" column (`comparison.actual_planned`); `optimization_sessions.comparison` now stores `{ actual_executed, actual_planned, … }` with the flat fields mirroring the executed block, and the page / Excel Summary render older flat sessions unchanged. Optimiser litres are labelled "Forecast" on the totals bar and comparison (2026-09-25).
- Day Optimizer route names come from plan history (last 120 days of trip plans × BMCUs, recent plans weighted higher, ties by delivery point) instead of `route_bmcus`, which has 3 rows for 66 routes on production; the Route Master set is a secondary source, both need ≥ 50 % of the trip's BMCUs, else "New combination" (2026-09-25).

### Added
- Day Optimizer: forecast accuracy for executed dates — "Forecast vs actual RMRD" panel (totals with vendor / sale / all RMRD, error ±L and %, per-BMCU table with mismatches first) on the Inputs step (preview) and under the Comparison card, stored in `optimization_sessions.comparison.forecast_accuracy`, Excel sheet "Forecast vs RMRD" plus a Summary line (2026-09-26).
- Day Optimizer: route-wise results — suggested Route Master name per trip ("New combination" below 50 % overlap) and vendor stored on `optimization_trips` (migration 045) and shown on the page with tanker state, rate, per-plant / overall totals (trips, tankers used, litres, km, cost, ₹/L, fill); Excel download `GET /api/optimize/:sessionId/report` (Summary, Trip Wise, BMCU Pickups, Tanker Wise); `OPTIMIZER_PREFETCH_RADIUS_KM` default 150 (2026-09-25).
- Day Optimizer: offline replay `backend/scripts/optimizer_v2_replay.js` against a production CSV extract; per-move search stats and seed candidates on the page (2026-09-25).
- Day Optimizer (fleet v2), behind `OPTIMIZER_V2_ENABLED`: plans one date (AM / PM / both) for all BMCUs across all plants with the whole available fleet, minimising Σ km × Tanker Rate Master rate; demand forecast per BMCU × shift with planner override (`bmcu_demand_forecast`), fleet availability from open maintenance gate passes, plant catchments from history, comparison against the actual plans of the date, adopt as draft plans; `POST /api/optimize/day`, `GET /day/preview`, `POST /prefetch-distances` (Google-fills missing nearby pairs into Distance Master), `POST /forecast/backfill`; Planning → Day Optimizer page (migration 044) (2026-09-25).
- BMCU master: optional Chilling Capacity (L) and Lifting Policy fields for the coming lifting advisor (migration 044) (2026-09-25).
- `services/rates.js`: Tanker Rate Master lookup shared by billing and the optimiser (billing behaviour unchanged) (2026-09-25).
- Billing: missing-coordinates check — banner on the run and on the fortnight before Execute, listing BMCUs/points without lat-lng (2026-09-19).
- Billing: Recalc Distances action refreshes System/Google/Master km and legs of an unsubmitted run without touching billed km, rate or amount (2026-09-19).
- Audit log records the login id on every action; JWT now carries `user_id` (2026-09-18).
- Billing: `BILLING_DATE_OFFSET_DAYS` — bill on delivery date (lifting + 1) to match the transport billing team's fortnight (2026-09-17).
- Billing: `carried_forward` stored per trip (migration 042) (2026-09-17).

### Changed
- Day Optimizer core after the first production run (0 moves accepted, 27 pickups unserved): single-BMCU trips over the km limit allowed and flagged, local feasibility + local tanker assignment per move, insert-unserved move, cross-exchange, iterated local search with kicks, seed at every capacity class, trips no tanker can take are split, oversized demand split into parts, unserved penalty capped; defaults 8 BMCUs / 550 km per trip (calibrated on 90 days of plans) (2026-09-25).
- Day Optimizer availability: only a `Maintainance` gate pass blocks a tanker, and it is ignored as stale once the tanker ran again (note in the preview); "Tankers without driver" and other reasons no longer exclude tankers (2026-09-25).
- One live execution per plan: re-start of closed trips blocked, unique partial index, duplicates auto-cancelled; `cancelled` allowed in the status CHECK (migration 043) (2026-09-17).
- Billing excludes cancelled executions from run selection (2026-09-17).
- Change requests: one diff engine covering every editable field; no-op requests rejected; start/delivery point read from `trip_plans` in the snapshot (2026-09-15).

### Fixed
- Billing recalc-distances: legs parameter cast to jsonb; TankerBilling missing `RefreshCw` import (2026-09-19).

## 2026-09-01 → 2026-09-15

### Added
- Backup & restore: encrypted multi-tier backups mirrored to NAS FTP, `deploy/restore.sh`, strategy doc (2026-09-14).
- Analytics: planner-wise tanker utilisation leaderboard, Top Planner KPI, click-through on Unused Tankers (2026-09-10).
- Active Trips: Starting Point column; Remarks dropdown per missed BMCU (migration 041); Sale Tankers + Utilisation cards (2026-09-10).
- Trip Plans: planner name and day tanker utilisation in the header; Starting Point column (2026-09-10).
- Internal Shifting split into Raw Milk / Chilled Milk with Remarks (migration 040) (2026-09-10).
- Assure integration API: read-only trips/loadings/receipts feed with `X-Assure-Key`, verify script, indexes (migration 039) (2026-09-08).
- WheelsEye GPS tracking: poller, tracking API, Live Tracking map, trip playback with planned vs actual route, stops, BMCU layer, Excel reports (migration 038) (2026-09-07).
- Assure handover docs: data model, mapping, access, gaps, identity, one-week sample CSVs, starter prompt (2026-09-05).
- Tanker Position: Excel download (2026-09-05).
- Admin-toggleable switch to stop vendor billing emails during trial runs (migration 037) (2026-09-01).
- Consolidated Report: Qty Gain/Loss % column in both Variation groups (2026-09-01).

### Changed
- Fleet Capacity Utilisation is litre-weighted and counts only active tankers; sale tankers excluded from utilisation (2026-09-10).
- Reports: one row per third-party sale in BMCU breakup; Entered By lists every user with full name (2026-09-07).
- Active Trips: Starting/Delivery Point start blank; Starting Point, Delivery Point, OUT and IN mandatory to save, marked with red asterisk (2026-09-01, 2026-09-05).
- Tanker Position: dropped unused Unloading/Cleaning statuses (2026-09-05).

## 2026-08-16 → 2026-08-31

### Added
- Billing: optional carry-forward floor date via `BILLING_CARRY_FORWARD_FLOOR` (2026-08-31).
- DB-backed, admin-manageable roles with per-module permissions, enforced on data routes (migration 035) (2026-08-26, 2026-08-27).
- Third Party Sale on trip execution, per BMCU, reduces RMRD (migrations 032, 033) (2026-08-24).
- BMCU Break Up: Acknowledgement column group per chamber, Remarks column, GRAND TOTAL rows (2026-08-24, 2026-08-25).
- Billing: toll challan attachment required; vendor filter; fortnight ack cutoff; block payment for tankers with no vendor mapped with inline vendor assign (migration 034) (2026-08-24).
- Sale Tanker logic replacing Milma detection, dedicated Sale Tankers tab, flag computed live on read (2026-08-19, 2026-08-21).
- Billing: sale-tanker exclusion, vendor verification step, mandatory toll carry-forward; Trip Wise BMCU Details column (2026-08-18).

### Changed
- Dates displayed as DD-MM-YYYY across screens, reports and emails (2026-08-24).
- Consolidated Report shows Qty Kgs instead of Ltrs; RMRD vs Acknowledgement variation added (2026-08-24, 2026-08-31).
- Trip execution edits frozen once pulled into a billing run; change requests blocked for trips in a run (2026-08-24).
- Vendor billing emails grouped by email address; re-push of draft tanker cards allowed; no vendor mail on final (L3) approval; coloured tanker cards with subtotals (2026-08-21, 2026-08-22).
- Google reference distance fetched even when Distance Master has a manual km (2026-08-22).
- Save records typed OUT/IN times without printing (2026-08-26).

### Security
- Minimum password length 8; `path.basename` on served files; DB SSL configurable via `DB_SSL`; NOT VALID FKs on `billing_run_trips` (migration 036); vulnerable `xlsx` replaced by `exceljs`; GET requests no longer mutate billing/change-request approvals (2026-08-27).

### Fixed
- Zero-length self-legs skipped in execution distance chain (2026-08-18).
- google-refresh-all stall: batch only fetchable pairs, randomised order (2026-08-17).
- BMCU reorder never persisted seq_no/bmcu_id on existing rows (2026-08-24).

## 2026-08-01 → 2026-08-15

### Added
- Vendor payment billing: biller role, fortnightly runs, 3-level email approval, date-wise summary, cross-run Payment Report, carry-forward of late-acknowledged trips (migrations 024, 025, 028–031) (2026-08-11, 2026-08-12).
- Toll gate challans per tanker per run; FASTag statement PDF upload auto-fills tolls (2026-08-13).
- New-combination approval flow + transporter publishing; biller can override transport type and edit legs with remarks (2026-08-12).
- Distance Master: Google KM reference column, auto-fetch, export column (migration 029); Missing Coordinates Excel report (2026-08-12, 2026-08-14).
- Tanker Movement Plan download (one sheet per day + Summary) (2026-08-14).
- Manual date/time entry for gate pass and OUT/IN events; typed HH:MM fields (2026-08-13).
- TS report: month-to-date day sheets, Milk Shifting, Consolidated, BMCU breakup and Plant Wise sheets; RMRD Adjustments remarks column; email loss summary (2026-08-07, 2026-08-08, 2026-08-14).
- Shared mailer with QA redirect (`BILLING_EMAIL_REDIRECT`, billing only) (2026-08-12).
- Billing module gated behind `BILLING_ENABLED` (2026-08-14).
- `INTEGRATION-FACTS.md` (2026-08-04).

### Changed
- Role realignment per business email; Masters restricted to admin (2026-08-14).
- Capacity guard: 103% → 110%, then RMRD no longer compared against capacity (2026-08-04, 2026-08-06).
- Container and DB timezone set to Asia/Kolkata; tzdata in backend image (2026-08-06).
- TS/BMCU Gain-Loss % uses the confirmed Kg.Fat+Kg.SNF formula; TS email shows Ack vs RMRD losses only (2026-08-05).

### Security
- Audit phases 1–4: perf indexes (migration 026), rate limiting, DB timeouts, auth hardening, upload validation, safe file serving, seed-admin forced password change (migration 027) (2026-08-13).

### Fixed
- DATE columns off by one day under IST (2026-08-06).
- Migration 021/023 index and backfill fixes; migration 026 non-IMMUTABLE index (2026-08-04, 2026-08-06, 2026-08-13).
- `GET /plans/:id` shadowing `/movement-export` (2026-08-14).
- `distance_master` unique pair violation: numeric pair ordering (2026-08-10).
- Distance Master page uses the authenticated client for all calls and downloads (2026-08-10).
- Change-request ack editor: KGS-first entry (kgs/litres swap corruption) (2026-08-11).
- Acknowledgement kgs discrepancy: entered kgs preserved (2026-08-04).

## 2026-07-24 → 2026-07-31

### Added
- Trip plan template: prefix-search BMCU dropdown (2026-07-24).

### Changed
- Active Trips: GP/COA/Unload buttons removed from list rows (2026-07-30).
- Sale-tanker free-text tanker number tried and reverted (2026-07-28).
