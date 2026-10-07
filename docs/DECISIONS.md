# Shreeja TMS — Architecture Decision Records

One entry per decision that shapes the code. "Inferred" means the decision is evident
from the codebase but was never written down; the date is the earliest commit that
shows it (git history in this clone starts 2026-07-24, so anything older is dated
"before 2026-07-24"). Add new ADRs at the bottom with the next number.

Format: `## ADR-NNN: Title (YYYY-MM-DD)` → Context / Decision / Consequences.

## ADR-001: Raw parameterised SQL with node-postgres, no ORM (before 2026-07-24, inferred)
- Context: small team, report-heavy workload with hand-tuned joins and Excel exports.
- Decision: `pg` Pool + `query()` helper; transactions via `pool.connect()`; SQL lives in the route/service that owns it.
- Consequences: full control of query plans; no model layer, so column names are the API contract; every write path must be reviewed for SQL injection (always `$n` params).

## ADR-002: Forward-only SQL migrations applied at backend start (before 2026-07-24, inferred)
- Context: single server, Docker deploy, no DBA.
- Decision: `backend/migrations/NNN_*.sql` run in filename order by `config/migrate.js`, each in its own transaction, tracked in `schema_migrations`; the backend image's CMD is `migrate && app`.
- Consequences: deploys are one command; applied files are immutable (fixes are new migrations, e.g. 023 fixing 021, 043 widening the status CHECK from 001); a failing migration blocks startup until fixed.

## ADR-003: Stateless JWT auth with DB-backed roles and hardcoded admin bypass (before 2026-07-24; roles table 2026-08-26)
- Context: no session store; admins need to create custom roles without code changes.
- Decision: 8h JWT in `Authorization: Bearer`; `roles.permissions` JSON per module (masters/planning/execution/billing/reports); `authorizeOrModule` adds custom roles to the legacy role lists; admin is allowed in code, never only by a DB row; `is_active` re-checked with a 60 s cache.
- Consequences: a deactivated user loses access within a minute; a corrupted roles row cannot lock admins out; JWTs cannot be revoked individually. Since 2026-10-07 (migration 053) a user may hold several roles: `users.roles` is the set, `users.role` the primary (`admin` if held), permissions are the union; `hasRole()` / `rolesOf()` in `middleware/auth.js` and `utils/roles.js` are the only ways to test a role. Roles carry a `read_only` switch (migration 057; the built-in `viewer` is read-only): a user whose roles are all read-only is refused every non-GET call in `authorize` / `authorizeModule` / `authorizeOrModule`, whatever module flags those roles carry (60 s cache per role name); its module flags are execution only (migration 055). Reads are scoped like writes since 2026-10-07: execution / planning / reports / masters reads need the matching module or role, so a role sees only its own data (`quality` sees nothing outside `/api/quality`).

## ADR-004: Central audit middleware plus field-level change logs (before 2026-07-24, inferred; login id added 2026-09-18)
- Context: auditors ask "who changed this trip and when".
- Decision: `auditLog.js` records every mutating `/api` call (sanitised body) and, for known entities, before/after diffs into `data_change_logs`; fire-and-forget.
- Consequences: routes never write audit rows themselves; auditing must never fail a request; secrets are stripped by key name.

## ADR-005: Closed trips are immutable except via approved change requests (before 2026-07-24, inferred)
- Context: post-closure corrections must be traceable and approved by a named person.
- Decision: `execution_change_requests` stores a JSONB snapshot + proposed diff; approver (`CHANGE_APPROVER_ID`) decides via portal or single-use email token; approval applies through `applyExecutionData`.
- Consequences: one shared write path for execution data; trips already inside a billing run refuse change requests (2026-08-24).

## ADR-006: Litres→kg factor 1.0285, shared with Assure (before 2026-07-24; confirmed with Assure 2026-09-05)
- Context: milk is planned in litres, acknowledged and reconciled in kg.
- Decision: `KG_FACTOR = 1.0285` in `services/executionData.js` (mirrored in `routes/analytics.js`); Assure adopted the same value.
- Consequences: any change must be made in lockstep with Assure and the billing team; recorded in `docs/assure-handover/README.md`.

## ADR-007: Distance cascade Distance Master → Google Routes → Haversine (2026-08 series, evident in code)
- Context: vendor payment is per km, so km must be reproducible and cheap.
- Decision: master pair first; Google `computeRouteMatrix` on a miss, cached back with attribution and a separate `google_km` reference; Haversine × `ROAD_DISTANCE_FACTOR` (1.3) as flagged fallback; pairs normalised so `(from) < (to)` numerically.
- Consequences: Google usage stays near zero after warm-up; estimated legs are counted and visible in billing; a missing coordinate is a billing blocker (banner added 2026-09-19).

## ADR-008: All timestamps in IST, DATE columns returned as strings (2026-08-06)
- Context: containers ran in UTC and DATE columns shifted a day in JSON.
- Decision: `TZ=Asia/Kolkata` on db and backend (tzdata installed); pg type parser returns `DATE` as `YYYY-MM-DD`; display formatting (DD-MM-YYYY) only in `fmtDate` helpers.
- Consequences: never construct JS `Date` from a DATE column for comparison; Assure feed renders `+05:30` explicitly in SQL.

## ADR-009: Security hardening baseline from the 2026-08 audit (2026-08-13, 2026-08-27)
- Context: internet-facing app with vendor emails and file uploads.
- Decision: helmet, per-endpoint rate limits, `trust proxy 1`, DB statement/idle timeouts, boot-time `JWT_SECRET` ≥ 32 check, `FRONTEND_URL` required in production, upload type/size filters, `path.basename` on served files, min password 8, GET never mutates approvals, `xlsx` replaced by `exceljs`, DB SSL configurable (`DB_SSL`, default off for same-host compose).
- Consequences: new endpoints must reuse these patterns; production error messages are generic.

## ADR-010: Billing module gated by `BILLING_ENABLED` and mails divertable on QA (2026-08-12, 2026-08-14)
- Context: vendor billing was built while production was live and vendors must not receive test mail.
- Decision: `/api/billing` mounts only when `BILLING_ENABLED=true` (503 otherwise); `BILLING_EMAIL_REDIRECT` diverts billing mail only; admin toggle `billing_vendor_emails_enabled` in `app_settings` (2026-09-01).
- Consequences: production can run the same image with billing off; other modules' mail is not redirected — QA should use a test SMTP inbox.

## ADR-011: Fortnightly billing on delivery date with ack cutoff and carry-forward (2026-08-11 → 2026-09-17)
- Context: the transport billing team pays per fortnight (1–15, 16–end) on delivery date, and late acknowledgements must not be lost or double-billed.
- Decision: runs accept only exact fortnights; billing date = `plan_for_date + BILLING_DATE_OFFSET_DAYS` (1 on both tiers); acknowledgement must be complete by the cutoff — `BILLING_ACK_CUTOFF_TIME` (default 06:00) on the morning after the period end, i.e. 06:00 on the 16th / 1st (owner, 2026-10-05; 23:59:59 of the last day before that, which pushed the last night's deliveries into the next cycle); unbilled earlier trips (≤ 31 days) carry forward, never earlier than `BILLING_CARRY_FORWARD_FLOOR`; `billing_run_trips.carried_forward` records it; trips in a run are frozen; three approval levels by email; tolls (FASTag PDF) are expected per tanker per period but are **not** a submit blocker (owner, 2026-09-29).
- Consequences: changing the offset or floor changes which trips a run picks — coordinate with the billing team and record here. Biller override (owner, 2026-10-05): on a draft run, Re-add offers the period's trips acknowledged after the cutoff separately ("Include late acknowledgements"); the biller opts in explicitly, each such line carries the remark "Acknowledged after cutoff (time)", and Execute itself still applies the cutoff. Trips lifted on the period's last day still bill in the next fortnight by the delivery-date rule, unless the biller pulls a named trip into a run with "Pull trip…" (owner, 2026-10-06), which bypasses period and cutoff for that one line and remarks it. Toll challan rows auto-save while the run is editable; once the run is under approval or approved, a toll change goes through `billing_toll_change_requests` (migration 051): PP01 approves by email link or portal and only approval writes the row (owner, 2026-10-06). Tolls carry forward, trips never: a tanker without a challan is still paid its trips; only the toll is uploaded in a later run against the earlier period (`billing_run_tolls.for_run_id`, migration 046) and paid in that run's total. Submit never deletes `billing_run_trips` (the earlier behaviour lost 592 trips on run #14 and 219 on run #15). A run that lost lines is recovered with withdraw → re-add → `scripts/restore_run_keyed.js` (RUNBOOK).

## ADR-012: Sale tankers are excluded from vendor billing and utilisation (2026-08-18, 2026-08-21)
- Context: milk sold at the BMCU / to third parties ("Milma" originally) is not transported for Shreeja and must not be paid to a vendor or counted as fleet usage.
- Decision: one SQL rule in `utils/saleTanker.js`: `trip_plans.is_sale_tanker` OR tanker number `ILIKE 'SALE%'`; computed live on read, shown on a dedicated tab.
- Consequences: every query that pays or measures tankers must call `saleTankerSql`; the SALE placeholder tanker is not a fleet vehicle.

## ADR-013: Two isolated Compose stacks (QA, PROD) on one server, branch per tier (before 2026-07-24, inferred)
- Context: UAT needs production-like data without touching production.
- Decision: `qa` branch → `docker-compose.qa.yml` + `.env.qa` (port 8081, own DB/volumes/network); `main` → `docker-compose.yml` + `.env` (8080); host nginx terminates TLS for both domains; `main` only receives `qa`.
- Consequences: two env files to keep in sync; Google key may be shared (results cached per tier); every new env var must be added to both examples.

## ADR-014: WheelsEye GPS polled server-side into local tables (2026-09-07)
- Context: the vendor exposes one paginated pull endpoint; the UI must not call it per user.
- Decision: in-process poller every `WHEELSEYE_POLL_SECONDS` (min 60) writes `tanker_gps_latest/history`; pages read local tables only; vehicles matched by normalised registration; token never logged or returned.
- Consequences: history exists only from the first poll (2026-09-07 on prod); poller health via `/api/tracking/status`; pruning keeps `WHEELSEYE_HISTORY_DAYS`.

## ADR-015: Read-only Assure feed with shared-secret header and frozen contract (2026-09-08)
- Context: Shreeja Assure reconciles milk and needs trips/loadings/receipts without DB access.
- Decision: `/api/integrations/assure/*` with `X-Assure-Key` (constant-time compare, optional IP allow-list, per-IP 120/min), versioned `assure-v1`, columns per `docs/assure-handover/API_SPEC_v1.md`, key rotation via `ASSURE_API_KEY_NEXT`.
- Consequences: renaming an alias is a breaking change; endpoints are disabled without a key.

## ADR-016: One live execution per plan (2026-09-17, migration 043)
- Context: "Start" on a closed plan or a double click created a second execution that billing paid twice.
- Decision: partial unique index on `trip_executions(trip_plan_id) WHERE status <> 'cancelled'`; duplicates auto-cancelled with an auditable reason; `cancelled` added to the status CHECK; billing ignores cancelled executions.
- Consequences: re-starting a closed trip is refused; cancelling is the only way to replace an execution.

## ADR-017: Encrypted multi-tier backups mirrored to the NAS, restore drills (2026-09-14)
- Context: uploads and config were not backed up; only a plain nightly dump existed.
- Decision: `deploy/backup.sh` (dumps, uploads, config, code; openssl-encrypted; lftp mirror with shrink guard) and `deploy/restore.sh` (scratch-first, typed confirmation to swap); strategy and drill calendar in `docs/BACKUP_RESTORE_STRATEGY.md`.
- Consequences: passphrase custody is an operational duty; after any secret change re-run `backup.sh config && mirror`.

## ADR-018: No automated test suite; CI is syntax check + build (2026-07-24 or earlier, inferred)
- Context: team capacity; verification happens on QA by business users.
- Decision: CI runs `node -c` over `backend/src` and `npm run build` for the frontend; UAT on qatms is the functional gate.
- Consequences: regressions are caught by users; keep changes small and push to QA often. Revisit if a test framework is adopted.

## ADR-020: Material (pasteurised milk) trips reuse the plan → execution → billing chain (2026-10-05)
- Context: Shreeja buys pasteurised milk from Balaji Dairy, Tirupati and a vendor tanker delivers it to HUL; the vendor is paid per km but the trip has no BMCU chain, and the supplier's and customer's documents (qty, fat, SNF) must be kept.
- Decision: `trip_plans.trip_kind = 'material'` with a `materials` master (SAP code); the execution gets `trip_material_data` (purchase figures, two scans, keyed km) and the customer's figures as one FC acknowledgement through `applyExecutionData`; milk totals of the execution stay 0 so TS / BMCU reports and the Assure feed (filtered to `trip_kind = 'milk'`) never count purchased milk; billing picks the trip up like any other, billed km defaults to the keyed km with System / Google as reference, and the run page, vendor mail and Excel show these trips in their own "Material Trips" section.
- Consequences: gate pass, COA, GPS playback, change requests and the one-live-execution rule apply unchanged; a material trip needs a supplier (starting point), a customer (delivery point) and a material; scans live on the uploads volume. Quantities are keyed in kgs with fat % and SNF % (owner, 2026-10-06, migration 050); litres, kg fat and kg SNF are derived with KG_FACTOR.

## ADR-021: Quality team's dispatch entries are an independent record set; mobile = installable web app (2026-10-07)
- Context: the quality team keys tanker dispatch (scale reading, shifts, litres, fat %, CLR) and truck-sheet (RMRD) figures from paper documents and reports the variation; they must not see or alter the tanker team's data; they asked for a mobile app.
- Decision: own table `qa_dispatch_entries` (migration 052) and own module permission `quality` (role `quality` seeded); QA keys both sides; dispatch SNF is derived from CLR (`CLR/4 + 0.21×Fat + 0.36`), kgs and kg fat / SNF from `KG_FACTOR`; variation = dispatch − truck sheet; nothing feeds executions, reports, billing or Assure. Mobile delivery is the same portal as an installable PWA (`vite-plugin-pwa`, app shell cached, API network-only) with a phone-first entry page, not a native app.
- Consequences: one more module key in `MODULES` / RoleManagement / Sidebar; `ProtectedRoute` gained a `module` prop; users whose only permission is `quality` land on `/quality/entry`; the manifest and service worker are served `no-cache`; no offline entry. A row's compartment may be a list (`FC,MC`) when one BMCU's milk is split across compartments; the chips follow Tanker Master's compartment count (migration 054).

## ADR-019: Day Optimizer (fleet v2) minimises km × rate behind `OPTIMIZER_V2_ENABLED` (2026-09-25)
- Context: the v1 Route Optimizer minimises km for one plant and one capacity; vendor cost is per km by state and tanker size, so the cheap plan is not the short plan (docs/OPTIMISATION_PLAN.md).
- Decision: a separate DB-free core (`services/optimizerV2.js`): Clarke-Wright seed per plant, cost-aware assignment against the Tanker Rate Master (`services/rates.js`, shared with billing), local search with seeded restarts; inputs from history (demand = weighted 14-day RMRD, catchment = most-used plant, availability = active tankers minus those on a credible open Maintainance gate pass (other pass reasons ignored, a pass is stale once the tanker ran again — 2026-09-25 after the first production run), rate state = billing history else registration prefix); results stored in the existing optimizer tables (migration 044) so save-as-plans is reused; whole feature gated by `OPTIMIZER_V2_ENABLED` and only ever creates draft plans.
- Consequences: a tanker without a rate row for its capacity × state is excluded, not guessed; Distance Master coverage drives accuracy (prefetch endpoint fills nearby pairs from Google); defaults (fill floor 85 %, 8 BMCUs, 550 km, 1 trip/tanker/day — operations confirmed on 2026-09-26 that a second trip is not feasible once loading, unloading and cleaning are counted — 8 / 550 calibrated on 90 days of plans with `scripts/optimizer_v2_replay.js`, see plan §4 "first production run") are tunable per run and should be confirmed by operations (plan §6).
