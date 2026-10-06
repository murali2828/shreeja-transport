# Shreeja TMS — Runbook

Operator commands run on the server (`~/shreeja-transport` for PROD, `~/shreeja-qa` for
QA). Nothing here is run from the development sandbox. Environment matrix:
[`ENVIRONMENTS.md`](./ENVIRONMENTS.md). Backups: [`BACKUP_RESTORE_STRATEGY.md`](./BACKUP_RESTORE_STRATEGY.md).

Container names: PROD `shreeja-db`, `shreeja-backend`, `shreeja-frontend`; QA
`shreeja-qa-db`, `shreeja-qa-backend`, `shreeja-qa-frontend`. Substitute below.

## Start / stop / restart

```bash
# PROD
docker compose -p shreeja-transport -f docker-compose.yml --env-file .env up -d --build   # deploy / start
docker compose -p shreeja-transport -f docker-compose.yml --env-file .env restart backend  # restart one service
docker compose -p shreeja-transport -f docker-compose.yml --env-file .env stop             # stop, keep volumes
# QA
docker compose -p shreeja-qa -f docker-compose.qa.yml --env-file .env.qa up -d --build
```

Never run `down -v` — it deletes the Postgres and uploads volumes. Env changes need only
`up -d` (no `--build`); code changes need `--build`. The compose project name (`-p`) must
match the running stack (`docker compose ls`), otherwise a second stack is created.

## Health checks

| Check | Command / URL | Healthy |
|---|---|---|
| Containers | `docker compose ls` and `docker ps` | all `Up (healthy)` |
| API | `curl -s http://127.0.0.1:8080/api/health` (QA 8081) or `https://tms.shreejamilk.com/api/health` | `{"ok":true,...}` |
| Frontend shell | `curl -sI https://tms.shreejamilk.com/` | 200, `Cache-Control: no-cache` |
| DB | `docker exec shreeja-db pg_isready -U shreeja_db -d dairy_transport` | `accepting connections` |
| Migrations | `docker logs shreeja-backend 2>&1 \| grep '\[migrate\]'` | last line `All migrations complete.` |
| GPS poller | `GET /api/tracking/status` (JWT, or the Live Tracking page) | `enabled: true`, recent `lastSuccessAt`, `lastError: null` |
| Assure feed | `TMS_URL=… ASSURE_API_KEY=… docs/assure-handover/scripts/verify_assure_api.sh` | all checks pass |
| Backups | `deploy/backup.sh status` | fresh dumps locally and on NAS |

## Logs

```bash
docker logs -f --tail 200 shreeja-backend        # API, [migrate], [wheelseye], [assure], [DB SLOW], [App Error]
docker logs -f --tail 200 shreeja-frontend       # nginx access/error
docker logs --tail 100 shreeja-db                # Postgres
docker compose -p shreeja-transport -f docker-compose.yml --env-file .env logs -f
```
Logs rotate at 10 MB x 5 per container. In-app: Reports → Audit Log (every mutating call
with login id) and its field-level Changes view.

## Common failures and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| Backend restarts in a loop, log `[FATAL] JWT_SECRET…` or `FRONTEND_URL…` | env file missing/short values | fix `.env`, `up -d` |
| Backend exits after `[migrate] FAIL <file>` | broken SQL in the newest migration | fix in git (new commit), redeploy; never edit `schema_migrations` by hand |
| White screen after deploy | browser cached old `index.html` | hard refresh; nginx already sends `no-cache` for the shell |
| 401 on every call after deploy | `JWT_SECRET` changed | users log in again (expected) |
| 429 "Too many login attempts" | rate limit (20 / 15 min per IP) | wait, or check for a shared NAT IP hammering login |
| Billing page says module not enabled (503) | `BILLING_ENABLED` unset | set `BILLING_ENABLED=true` in the tier's env, `up -d` |
| Billing run refuses period | not an exact fortnight (1–15 / 16–end) | pick the fortnight; see ADR-011 |
| Day Optimizer menu missing / API 503 `FEATURE_DISABLED` | `OPTIMIZER_V2_ENABLED` unset | set `OPTIMIZER_V2_ENABLED=true` in the tier's env, `up -d`; users log in again to see the menu |
| Day Optimizer: "No available tankers with a valid rate" | Tanker Rate Master has no row for that capacity × state on the date, or tankers' state unknown | add the rate rows (Masters → Tanker Rates); state comes from billing history or the registration prefix (AP/TN/KA/TS) |
| Day Optimizer: many "estimated legs" | Distance Master pairs missing | click Prefetch missing distances (needs `GOOGLE_MAPS_API_KEY`); fill coordinates for nodes listed under "need coordinates" |
| Billing banner "missing coordinates" | BMCU/point without lat-lng | fill coordinates in Masters, use Recalc Distances on the run |
| Trip appears twice in billing | pre-043 duplicate execution | migration 043 cancels duplicates; check `cancel_reason` on the cancelled row |
| Cannot start execution on a plan | a live execution already exists (unique index) | cancel the old execution first |
| Document/challan upload rejected with a size message | >10 MB (documents) / >15 MB (challans, `CHALLAN_MAX_MB`) or wrong type | compress/convert the file |
| Upload fails with a bare `413` before any app message | host nginx `client_max_body_size` missing (default 1 MB) — both `sites-enabled/tms…` and `qatms…` need `client_max_body_size 20M;` in the **443** server block (added 2026-09-29) | add the line, `nginx -t && systemctl reload nginx` |
| `[DB SLOW]` lines, timeouts at 30 s | heavy report over a long range | narrow the range; check indexes (migrations 026, 039) |
| Uploads gone after restore | uploads volume not restored | `deploy/restore.sh uploads <tier> --latest` |
| Disk full | Docker images/logs or backups | `docker system prune` (images only), check `BACKUP_DIR` retention |

## Backup and restore

Nightly cron (01:15) runs `deploy/backup.sh run`; uploads + mirror every 4 h. Manual:
```bash
deploy/backup.sh dumps            # DB dumps for all tiers now
deploy/backup.sh config && deploy/backup.sh mirror   # after any secret change
deploy/restore.sh list
deploy/restore.sh db prod --latest            # drill into a scratch DB (safe)
deploy/restore.sh db prod --latest --swap     # replace live DB, typed confirmation
```
Scenario A (bad change) and B (server gone) steps: `BACKUP_RESTORE_STRATEGY.md` §4.
Passphrase and FTP password live in the IT vault, not in git.

## When an integration fails

**Google Routes (distances)**
- Symptom: legs flagged estimated, `km_estimated_leg_count > 0`, log `[roadDistance] Google Routes API HTTP 4xx/5xx`.
- Check: `GOOGLE_MAPS_API_KEY` set; key has Routes API enabled and billing active in Google Cloud; outbound HTTPS from the container.
- Effect: falls back to Haversine × 1.3; Distance Master entries are unaffected. Once fixed, use Recalc Distances on the billing run / Google refresh on Distance Master.

**Day Optimizer prefetch (Google Routes)**
- Symptom: Prefetch returns `failed > 0` or `error: GOOGLE_MAPS_API_KEY is not set`; log `[optimizer-v2] prefetch …`.
- Check: same as Google Routes above. Each click makes at most `OPTIMIZER_PREFETCH_MAX` calls; click again until `remaining` is 0.
- Effect: runs still work on Haversine estimates (legs flagged "est."), so costs are approximate until pairs are cached.

**WheelsEye GPS**
- Symptom: Live Tracking empty or stale; `/api/tracking/status` shows `lastError`; log `[wheelseye] …`.
- Check: `WHEELSEYE_ACCESS_TOKEN` present (no token = poller disabled by design); WheelsEye HTTP status in the log; "Poll now" button (admin) for an immediate retry; tankers under "Not in tanker master" mean a registration mismatch — fix Tanker Master.
- Effect: no impact on planning/execution/billing.

**SMTP mail**
- Symptom: report/billing/change-request/password-reset mails not arriving; log `[mailer]` or per-module send errors.
- Check: `SMTP_HOST/PORT/SECURE/USER/PASS/FROM`; Gmail app password still valid; on QA remember `BILLING_EMAIL_REDIRECT` diverts billing mail and the admin vendor-email toggle may be off.
- Effect: approvals stall (tokens are still in the DB; resend from the UI where offered).

**Database**
- Symptom: 500s everywhere, `Unexpected PostgreSQL pool error`, `connection timeout`.
- Check: `docker ps` shows db healthy; disk space; `statement_timeout` (60 s in compose) and pool limits; `idle_in_transaction` sessions.
- Effect: total outage — restart db then backend; restore from backup only if data is corrupt.

**Assure feed**
- Symptom: Assure reports 503 `FEATURE_DISABLED`, 401, 403 or 429.
- Check: 503 → `ASSURE_API_KEY` blank; 401 → key mismatch (rotate via `ASSURE_API_KEY_NEXT`); 403 → caller IP not in `ASSURE_ALLOWED_IPS`; 429 → over 120 req/min. Log line `[assure] GET /trips key=… ip=… status=…` per call.
- Effect: TMS users unaffected; only Assure's reconciliation pull is delayed.

## Recover a billing run that lost trips

Before 2026-09-29 Submit deleted the trips of tankers without a toll challan (run #14
lost 592, run #15 lost 219 of 666). Trips are never dropped any more; to put the lost
lines back on the same run:

1. Billing → open the run. If it is **Awaiting L1** and nobody has decided, click
   **Withdraw from approval** (`POST /api/billing/runs/:id/withdraw`) — status returns to
   Draft, the L1 email links die. If an approver already decided, ask the approver to
   reject it instead (rejected runs are editable too).
2. Click **Re-add unbilled trips of this period (N)** (`POST /api/billing/runs/:id/readd-trips`).
   N comes from `GET /runs/:id/readd-preview`: acknowledged trips of the run's fortnight
   (same offset / floor / ack cutoff as Execute) that are in no billing run. Existing lines
   keep their keyed state / km; the re-added lines come back unkeyed, like a fresh Execute.
3. Restore the keyed values of the re-added lines from the biller's CSV (columns
   `plan_for_date,tanker_number,state,transport_type,billed_km,remarks`):
   ```bash
   docker exec -i shreeja-backend node scripts/restore_run_keyed.js <run_id> < keyed.csv
   ```
   Rows already keyed are matched too but only overwrite with non-empty CSV values.
4. To drop a trip from the run so it is paid in the next fortnight instead, click ✕ on its line (draft / rejected runs only); Excl. keeps it in the run unpaid and does **not** carry it forward.
5. Check the run total on screen, upload any toll challans now available, Submit. Tankers
   still without a challan are listed as "Toll challans pending" (response, L1 mail); their
   toll is uploaded in the next cycle under Toll Challans → **Pending from earlier cycles**.

## Load FY history from the logistics team's workbook

Trips before the portal went live (April to August 2026) are loaded from the
filled "TMS_History_Load_Template_FY2026-27.xlsx" (sheets TRIPS, TRIP_BMCUS,
ACKNOWLEDGEMENTS, NAME_MAP; rules on its README sheet) with
`backend/scripts/import_history.js`. Always on QA first.

```bash
docker cp history.xlsx shreeja-qa-backend:/tmp/history.xlsx
docker exec -i shreeja-qa-backend node scripts/import_history.js /tmp/history.xlsx            # dry run, writes /tmp/history_result.csv
docker exec -i shreeja-qa-backend node scripts/import_history.js /tmp/history.xlsx --apply    # load
docker cp shreeja-qa-backend:/tmp/history_result.csv .                                        # per-trip outcome
```

- Dry run validates every row (masters, dates, BMCU litres within 1 % of the trip,
  chambers) and writes the report without touching the DB; fix the workbook or add
  the missing master rows and re-run until the rejected count is acceptable.
- `--apply` loads one trip per transaction: plan (published) → execution (closed,
  points confirmed) → BMCU rows, RMRD shift rows, acknowledgements, gate pass / COA
  print records, all through `applyExecutionData`. A tanker that already has a live
  execution on that lifting date is skipped, never overwritten, so re-running after a
  partial load is safe. Rows are owned by the inactive login `history-load`.
- `--from` / `--to` restrict the lifting-date window (one month at a time is sensible).
- Distance Master pairs missing for old routes are fetched from Google during the load;
  to avoid that cost run with `-e GOOGLE_MAPS_API_KEY=` on the `docker exec` and use
  Recalc Distances on the billing runs later.
- After the load: delete the partial draft billing runs of those months, add the
  historic rates to the Tanker Rate Master (RATES sheet of the workbook), execute the
  fortnights again.

## Routine tasks

- New user / role: Masters → Users / Roles (admin). Custom roles get module permissions.
- Rotate the Assure key: set `ASSURE_API_KEY_NEXT`, `up -d`, hand over, then move it into `ASSURE_API_KEY`, clear `_NEXT`, `up -d`.
- Tanker document expiry mails: `jobs/docAlerts.js` sends at 30/15/7/1 days and on expiry to recipients configured in Masters → Documents.
- Before a fortnight billing run: all trips acknowledged before the cutoff (`BILLING_ACK_CUTOFF_TIME`, default 06:00 on the 16th / 1st); tolls (FASTag PDF) uploaded; vendors mapped to every tanker; coordinates complete.
