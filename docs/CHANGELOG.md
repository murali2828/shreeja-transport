# Changelog

All notable changes to Shreeja TMS. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are not tagged; entries are grouped by the fortnight they landed on `qa`, newest
first. Seeded from `git log --since=2026-07-01 --no-merges` (history in this clone starts
2026-07-24). Migration numbers are noted where a change touched the schema.

## [Unreleased] — on `qa`, pending promotion to `main`

### Added
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
