# Changelog

All notable changes to Shreeja TMS. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are not tagged; entries are grouped by the fortnight they landed on `qa`, newest
first. Seeded from `git log --since=2026-07-01 --no-merges` (history in this clone starts
2026-07-24). Migration numbers are noted where a change touched the schema.

## [Unreleased] — on `qa`, pending promotion to `main`

### Added
- Billing → Payment Report in the finance team's format: Trip Wise gains S.No, SAP vendor code (new field on the Vendor master, migration 059), cost per litre, utilisation %, milk received (plant acknowledgement: litres, kgs, fat %, SNF %, kg fat, kg SNF) and BMCU coverage; Date Wise and Tanker Wise carry the milk columns, Date Wise also tanker capacity, rate per km, cost per litre and utilisation; new **Month Cumulative** sheet / tab (every month of the From date's financial year: capacity, milk, fat / SNF / TS %, km, rate per km, amount, cost per litre, utilisation, trips, average km, average diesel ₹/L) and **Year Cumulative** (month × financial year matrix with YTD). Earlier financial years are keyed once through "Upload earlier years" (admin, `transport_monthly_history`, template from the tab); a month present in the portal always wins (owner, 2026-10-08).
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
