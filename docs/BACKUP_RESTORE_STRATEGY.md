# Shreeja TMS — Backup and Restore Strategy

Written 14 Sep 2026 after reading the Assure "Backup 360° review and adoption
playbook". TMS follows the same eight guarantees; this file records the TMS
decisions, the interim arrangement that is live now, and the path to the shared
`ops-kit` so both projects end up identical.

## 1. Where TMS stands today

| Layer | Before 14 Sep | Now (interim, `deploy/backup.sh`) | Target (ops-kit) |
|---|---|---|---|
| Database | nightly plain `pg_dump` on the server only | nightly encrypted custom-format dump per tier, verified with `pg_restore -l`, mirrored to the NAS | pgBackRest PITR: WAL every 60 s, 4-week window |
| Uploads (toll challans, documents) | **not backed up** | tar of the Docker volume per tier, nightly + every 4 h, mirrored | rsync mirror + NAS snapshots |
| Code | GitHub only | nightly verified git bundle of every branch, mirrored | same |
| Config and secrets | nothing | encrypted bundle: both tiers' env files, compose, nginx, TLS, crontab, image list | same, plus escrow |
| Off-box copy | none | NAS FTP mirror with shrink guard, no deletes | same, plus S3 object-lock option |
| Monitoring | none | cron log, mail on failure if `mail` exists | watchdog every 2 min + probe from another server |
| Restore | manual `psql < file` | `deploy/restore.sh` scratch-first, typed confirmation to swap | same design, PITR to any second |

Recovery objectives with the interim set:

| Scenario | RPO (data lost) | RTO (time to service) |
|---|---|---|
| A. Bad change, server alive | up to 24 h for DB, 4 h for uploads | 15 min |
| B. Server gone, rebuild from NAS | up to 24 h for DB, 4 h for uploads | about 1 h on a machine with Docker |

With the ops-kit the DB RPO drops to about 1 minute (PITR).

## 2. Decisions (playbook section B, TMS answers)

| Decision | TMS answer |
|---|---|
| Tiers | qa + prod on one server (`~/shreeja-qa`, `~/shreeja-transport`) |
| Database | Postgres 16 in Docker; migrations run at backend start |
| File storage | Docker volumes `shreeja-docuploads`, `shreeja-qa-docuploads` (no MinIO) |
| Off-box target | NAS FTP account, one per server, folder `/tms-server` |
| Off-site copy | none yet; risk stated: NAS and server in the same room |
| Passphrase custody | one passphrase (interim) in the IT vault with two custodians + sealed envelope |
| Alert recipients | murali.m@shreejamilk.com plus one more to be named |
| Rebuild target | to be named: a VM in the data centre or a cloud VM with Docker |
| Mobile app | no |
| Retention | dumps 14 d, uploads 7 d locally (NAS snapshots hold history), config 60 d, code 30 d |
| Drills | quarterly, same week as Assure's; IT head + second custodian |

## 3. Day 1 on the server (interim set)

```bash
cd ~/shreeja-transport && git pull origin main
sudo apt-get install -y lftp
cp deploy/backup.env.example deploy/backup.env && chmod 600 deploy/backup.env
openssl rand -base64 48        # → BACKUP_PASSPHRASE; put in the vault + envelope FIRST
nano deploy/backup.env         # passphrase, FTP host/user/pass, FTP_DIR
bash deploy/backup.sh run      # first full run, all tiers, mirror to NAS
bash deploy/backup.sh status
bash deploy/restore.sh db qa --latest      # first drill: scratch restore, compare counts, no swap
bash deploy/backup.sh install-cron
```

NAS side, in writing from the NAS team: daily snapshots of the share, 30 days,
and the `tms-backup` account cannot delete snapshots. That is the ransomware
defence; the script's shrink guard only protects against a wiped server.

## 4. Restore runbook

Scenario A, bad data or a broken deploy on the running server:

1. `deploy/restore.sh db prod --latest` restores into a scratch database and prints row counts next to live. Nothing changes.
2. If the scratch copy is what you want: `deploy/restore.sh db prod --latest --swap`, type `prod`. The backend stops, the live database is renamed `<db>_pre_restore_<stamp>`, the scratch copy takes its name, the backend starts. The old database stays until you drop it.
3. Lost uploads only: `deploy/restore.sh uploads prod --latest`.
4. Lost env or nginx file: `deploy/restore.sh config --latest`, copy the file back from `restored-config/`.

Scenario B, server gone, new Ubuntu machine:

1. Install Docker, git, lftp. Create the deploy user.
2. Get `BACKUP_PASSPHRASE` and the FTP password from the vault. Create `deploy/backup.env` by hand with those and `BACKUP_DIR`.
3. `deploy/restore.sh fetch` pulls the whole NAS copy.
4. `deploy/restore.sh config --latest`, copy `.env`, `.env.qa`, nginx sites and TLS back into place.
5. `deploy/restore.sh code prod ~/shreeja-transport` and `code qa ~/shreeja-qa`.
6. Bring each tier up with its compose command. The backend runs migrations on an empty database; that is fine, the restore replaces it next.
7. `deploy/restore.sh db prod --latest --swap`, then `uploads prod --latest`; repeat for qa.
8. Reinstall cron, run `backup.sh run` so the new server has its own first copy, repoint DNS.

## 5. Calendar

| When | What | Who |
|---|---|---|
| 01:15 nightly | dumps, uploads, config, code, mirror (cron) | cron |
| every 4 h | uploads + mirror (cron) | cron |
| after any secret change | `backup.sh config && backup.sh mirror` | operator |
| monthly | `backup.sh status`, read `backup.log`, check disk and FTP quota | operator |
| quarterly | drill: `restore.sh db <tier> --latest`, open a config bundle with the vault passphrase, clone a code bundle, look at the NAS snapshot list; record date and time taken below | operator + custodian 2 |
| twice a year | full Scenario B rebuild on the named target, timed | operator + custodian 2 |
| yearly | open and reseal the passphrase envelope | IT head |

## 6. Gaps and next steps, in priority order

1. **P0** Passphrase into the vault with two custodians before the first run.
2. **P0** NAS snapshot confirmation in writing.
3. **P0** First drill on QA, recorded in section 7.
4. **P1** Adopt the shared `ops-kit` from Shreeja-EMMS (section 8) to get PITR, the watchdog, the probe and the escrow. Grant this session read access to the Shreeja-EMMS repository, or copy `ops-kit/` into this repository under `ops/`.
5. **P1** Name the rebuild target machine.
6. **P1** Second alert recipient; install `mailutils` or route alerts through the app's SMTP account.
7. **P2** SFTP instead of FTP once the NAS supports it; off-site copy decision.
8. **P2** Confirm retention against statutory needs (billing records, audit trail); yearly archive dump if required.

## 7. Drill log

| Date | Tier | What | Time taken | Result | By |
|---|---|---|---|---|---|
| | | | | | |

## 8. Adopting the ops-kit (playbook section D, filled in for TMS)

Paste this as the task once `ops-kit/` is reachable:

```
Adopt the ops-kit at <path-to>/Shreeja-EMMS/ops-kit into this repository as ops/.
Read ops/README.md, ops/SETUP-CHECKLIST.md and ops/ADOPTION-PLAYBOOK.md first.
Project facts:
- slug: tms; tiers: qa prod; public hosts: qatms.shreejamilk.com, tms.shreejamilk.com
- database: Postgres 16 (owner role shreeja_db per tier today; add app role tms_<tier>_app)
- file storage: docker volumes shreeja-docuploads (prod), shreeja-qa-docuploads (qa), mounted at /app/uploads
- migrations: run automatically by the backend at start (backend/src/config/db.js, schema_migrations table);
  seeds: none in production (backend/scripts/import_masters.js is a one-off import)
- health route: backend/src/app.js exposes GET /api/health
- compose: docker-compose.yml (project shreeja-transport, env .env) and docker-compose.qa.yml (project shreeja-qa, env .env.qa)
- mobile app: no
- existing interim backup: deploy/backup.sh, deploy/restore.sh, deploy/backup.env — retire these once ops/ is live and drilled
Do, in this order, committing each step: (steps 1–10 of the playbook, unchanged, except step 5 seeds: none, and step 7 escrow:
Google Maps API key, WheelsEye token, Assure API key, SMTP app password, GitHub deploy key, DNS/registrar and TLS issuer accounts).
Do not touch the production tier.
```
