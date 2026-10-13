# Monitoring and e-mail alerts (ops-kit)

## 1. Three sources of alerts

| Source | Runs where | Watches | Cadence | Tells you within |
|---|---|---|---|---|
| **Host watchdog** `ops/bin/healthcheck.sh <tier>` | the application server (cron) | containers · Postgres · Redis · API on its port · public health / ready / web · WAL archiving · every backup copy's freshness · shrink guard · encryption at rest · escrow age · disks · NAS mount · TLS expiry | every 2 min | ~4 min (2 consecutive failures) |
| **Remote probe** `ops/bin/remote-probe.sh` | the NAS (task scheduler) or any other machine | the public URLs from outside, and a heartbeat file the watchdog writes to the NAS | every 5 min | ~10 min — the one that fires when the **server itself is dead** |
| **Job alerts** | `backup.sh` (backup/check runs), `deploy.sh` (failed deploy) | backup step failed, archiving stalled, backup too old, guard blocked, deploy failed | at the event | immediately |

Alerts are transition-based: a DOWN mail listing every failing check, a
RECOVERED mail when all is well, a reminder every `ALERT_REMIND_H` (6) hours
while something stays down; optional daily summary (`ALERT_DAILY_SUMMARY`).

## 2. Setup

### 2a. Server
`.env.deploy`: `ALERT_EMAIL_TO` (two people at least), `ALERT_SMTP_HOST/PORT/USER/PASS`
(Google Workspace: port 465 + an App Password), optional `ALERT_WEBHOOK_URL`.
```bash
ops/bin/healthcheck.sh <tier> test-mail       # a mail must arrive
ops/bin/healthcheck.sh <tier> install-cron    # */2 check, 08:00 summary
ops/bin/healthcheck.sh <tier> status          # every line OK
```

### 2b. NAS (or any other box)
Copy `ops/bin/remote-probe.sh` + a `probe.env` (LABEL, URLS, HEARTBEATS,
HEARTBEAT_MAX_MIN, ALERT_*) onto the NAS; schedule `bash remote-probe.sh`
every 5 minutes. The heartbeat path is `<NAS>/<hostname>/heartbeat-<tier>`.

## 3. When you get this mail

| Subject contains | Meaning | First actions |
|---|---|---|
| `DOWN: db` | Postgres not answering | `docker compose … logs --tail 100 postgres`; `df -h`; last resort `backup-restore.md` §3 |
| `DOWN: api_local` | API process crashed / not listening | `docker compose … logs --tail 200 api`; restart; check the last deploy log |
| `DOWN: api_public` / `web` but `api_local` OK | nginx, TLS or DNS | `sudo nginx -t`; certificate; DNS from outside |
| `DOWN: api_ready` | API cannot reach Postgres | usually `db` too; else the app-role password → `deploy.sh <tier> --harden-only` |
| `DOWN: containers` | a container stopped | `docker compose … ps`; `up -d` |
| `DOWN: backup` | WAL archiving stalled | `backup.sh <tier> status` → repo full / unwritable / stanza missing (`init`) |
| `DOWN: backup_job` | the backup check cron stopped, or reports problems | `crontab -l`; `.env.deploy` readable; `backup.sh <tier> status` |
| `DOWN: backup_dump/_uploads/_config/_code/_masters/_offsite` | that copy is older than its schedule allows | `backup-<tier>.log`; run the step by hand |
| `DOWN: backup_guard` / `OFF-BOX COPY BLOCKED` | the local backup set shrank unexpectedly; off-box copies deliberately NOT updated | treat as possible compromise/disk fault first: `backup.sh <tier> status` (the `guard` block says what shrank). Deliberate change → `guard-reset`; otherwise start `disaster-recovery.md` and do NOT reset |
| `DOWN: backup_images` / `backup_mobile` | images archive or mobile artefact download stale | `backup.sh <tier> images` / `mobile-builds`; check `EXPO_TOKEN` |
| `DOWN: backup_encryption` | repository has no cipher, or files are written in the clear | set `BACKUP_REPO_CIPHER_PASS` + `BACKUP_DATA_PASSPHRASE`, run `backup.sh <tier> encrypt-repo` |
| `DOWN: escrow` | no credentials escrow, or > 100 days old | `escrow.sh check` then `seal` — `credentials-escrow.md` |
| `backup problem` / `… FAILED` | a backup step raised an error (log tail in the body) | fix the cause, re-run `backup.sh <tier> backup` |
| `DOWN: disk_root` / `disk_backup` | disk ≥ 90 % | old dumps, `docker system prune`, log rotation |
| `DOWN: nas` | share unmounted | `mount <NAS>`; NFS service up? |
| `DOWN: tls` | certificate expiring | renew, copy to `/etc/nginx/ssl/`, reload |
| `deploy FAILED` | deploy stopped half-way | body carries the log tail; fix and re-run |
| `[LABEL] DOWN: hb_heartbeat-…` (from the NAS) | the server stopped writing its heartbeat and URLs fail | server or network down → `disaster-recovery.md` §3 |
| `RECOVERED` | back to normal | read what was down and why |

## 4. Test it (once, and after any change)
Stop the API container for 5 minutes → DOWN mail → start it → RECOVERED
mail. Stop the whole server once → the NAS probe mails within ~10 minutes.
