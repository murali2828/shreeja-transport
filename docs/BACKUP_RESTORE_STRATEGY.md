# Shreeja TMS — Backup and Restore Strategy

TMS runs the **ops-kit** from Shreeja Assure (`ops/`, copied from
`murali2828/shreeja-emms/ops-kit`), the same mechanism described in the
playbook "Backup & Recovery Strategy — Reusable Playbook for Claude-built
Projects" (13 Oct 2026). Kit reference: `ops/README.md`, `ops/docs/*.md`.
This file is the TMS-specific part: what is protected, the server bring-up,
the restore runbook, the drills and what is still open.

## 1. What is protected

| What | How | How often | Kept | Encrypted |
|---|---|---|---|---|
| Database, point in time | pgBackRest inside the DB container: WAL archived every ≤ 60 s + full backup Sunday, differential other nights 01:15 | continuous | 4 full backups (≈ 4 weeks) | yes, repository cipher (AES-256-CBC) |
| Database, logical dump | `pg_dump` of the whole database | nightly + before every `deploy.sh` | 14 days | yes (`.sql.gz.enc`) |
| Uploads (documents, challans, material scans) | rsync of the uploads volume | nightly + every 4 h | mirror + NAS snapshots | no (access-controlled share) |
| Config | both tiers' env files, `.env.deploy`, nginx sites, TLS, crontab, SSH keys, `conf.d` | nightly | 60 days | yes |
| Code | `git bundle` of every branch | nightly | 30 days | no |
| Built images | `docker save` of db, backend, frontend, tools | nightly | last 2 | no |
| Off-box copy | `lftp mirror` of everything above to the NAS over FTP, behind the shrink guard | nightly + every 4 h | NAS snapshots 30 days | inherits |
| Health | watchdog (every 2 min), backup check (every 30 min), failure mails from every script | — | — | — |

Recovery point: about one minute while the server lives; **up to 4 hours** if the
server is lost (FTP mirror). Recovery time: 5–30 minutes on the same server,
under an hour on a new one.

TMS specifics wired into the kit (all in `ops.env`, `docker-compose*.yml`):
QA and PROD run from **separate checkouts** (`~/shreeja-qa` on `qa`,
`~/shreeja-transport` on `main`), each running the scripts for its own tier;
both share `BACKUP_DIR=/home/chaitanya/tms-backups`. Services are `db`,
`backend`, `frontend` (no Redis). Volumes keep their existing names
(`shreeja-pgdata`, `shreeja-qa-pgdata`, `…-docuploads`). The database image
stays **Postgres 16 Alpine** with pgBackRest added (`ops/postgres/Dockerfile`)
— switching the existing data to a Debian image would change text collation.
Health: `/api/health` (carries `git_sha`), `/api/health/ready`,
`/api/health/backup`.

## 2. Decisions (owner, 2026-10-13)

| Decision | TMS answer |
|---|---|
| Off-box target | NAS over **FTP** (as before); NFS later would cut the server-loss gap from 4 h to 1 min |
| Restricted app role (playbook Layer 1) | **phase 2** — the app hard-deletes in many places (acknowledgements, billing lines, plans, change requests); the allow-list is built and tested on QA separately. Until then `OPS_HARDEN_SQL` is empty |
| Alerts | murali.m@shreejamilk.com + the operator (chaitanya) |
| Credentials escrow | not used (`OPS_ESCROW=no`): no mobile app or signing keys; API keys (Google, WheelsEye, Assure, SMTP) are in the env files inside the config bundle |
| Passphrase custodians | to name: two people + a sealed envelope |
| Rebuild target | to name: a VM / machine that can be brought up within an hour |
| Off-site copy (S3 object lock) | not yet — the NAS is the only off-box copy; record a decision |

## 3. Server bring-up (operator, once; QA first, PROD after UAT)

Nothing below runs from the dev sandbox. Do QA end to end, prove it (section 5),
then repeat for PROD in a quiet hour.

**0. Passphrases first** (before anything is encrypted):
```bash
openssl rand -base64 48   # three times → BACKUP_CONFIG_PASSPHRASE, BACKUP_DATA_PASSPHRASE, BACKUP_REPO_CIPHER_PASS
```
Put the three in the vault (two named custodians) **and** in a sealed, dated
envelope. A lost passphrase means lost backups, by design.

**1. Secrets file, in each checkout** (same content in both):
```bash
cd ~/shreeja-qa && git pull origin qa
cp .env.deploy.example .env.deploy && chmod 600 .env.deploy
nano .env.deploy        # DB passwords (= DB_PASSWORD in .env.qa / .env), passphrases, FTP, SMTP, alert mailboxes
mkdir -p /home/chaitanya/tms-backups
```

**2. First deploy through the kit** (the database restarts once, ~10 s, to switch
on WAL archiving; the image gains pgBackRest):
```bash
ops/bin/deploy.sh qa --rebuild-db
```

**3. Initialise backups** (stanza with the repository cipher, first full backup,
dump, uploads, config, code, images, first FTP mirror):
```bash
ops/bin/backup.sh qa init
ops/bin/backup.sh qa status        # ok: true, repo_cipher aes-256-cbc, files_encrypted true
ops/bin/backup.sh qa install-cron  # 01:15 nightly, */30 check, 4-hourly uploads + mirror, Sunday verify
```

**4. Alerts:**
```bash
ops/bin/healthcheck.sh qa test-mail      # both mailboxes receive it
ops/bin/healthcheck.sh qa install-cron   # watchdog every 2 min
```

**5. First drill** (section 5, no `--swap`).

**PROD** — the same in `~/shreeja-transport` with `prod`, after QA has run
green for a few days. From then on **every deploy is**
`ops/bin/deploy.sh qa` / `ops/bin/deploy.sh prod` (dump first, fast-forward pull,
build, migrate, health check on the deployed sha). Do not use
`docker compose … up -d --build` by hand any more: it rebuilds the database
image and restarts the database.

**Switch-over from the interim scripts:** keep the old `deploy/backup.sh` cron
running until both tiers have a week of green `backup.sh <tier> status`, then
remove its crontab lines (`crontab -e`). Its NAS folder (`/tms-server`) stays as
an archive until its newest copy is 60 days old; the kit mirrors to
`/tms-server-pitr`.

## 4. Restore runbook

Decide the scenario first: **A** — server still running (bad data, deleted
rows, lost uploads, broken deploy, lost config) → local copies, no data gap.
**B** — server gone or untrusted (disk lost, ransomware) → rebuild on a new
machine from the NAS copy; never repair a ransomed server in place.

Every database restore builds a **scratch cluster on 127.0.0.1:5599** first,
prints `ops/verify.sql` (row counts, latest plan / acknowledgement / audit), and
replaces live data only with `--swap` after you type the tier name.

| What happened | Command (in that tier's checkout) |
|---|---|
| Bad data change, wrong import, mass delete | `ops/bin/restore.sh <tier> --time "2026-10-13 14:05"` (the last good minute), inspect, then add `--swap` |
| A few rows deleted | scratch restore without `--swap`, copy the rows across with `psql -h 127.0.0.1 -p 5599` |
| Database volume corrupt | `ops/bin/restore.sh <tier> --latest --swap` |
| Restore from a dump instead | `ops/bin/restore.sh <tier> --dump /home/chaitanya/tms-backups/dumps/<file>.sql.gz.enc` |
| Uploads emptied | `ops/bin/backup.sh <tier> restore-uploads` |
| Env file, nginx site or TLS lost | `ops/bin/backup.sh <tier> restore-config <newest bundle>`, copy back the one file |
| A deploy broke the app | `git checkout <previous sha>` then `ops/bin/deploy.sh <tier> --no-pull`; damaged data → `--dump` the pre-deploy dump or `--time` just before |
| Images pruned, container will not start | `ops/bin/backup.sh <tier> restore-images` |
| Clean up a scratch restore | `ops/bin/restore.sh <tier> --cleanup` |
| Shrink guard fired | **stop**; do not `guard-reset`; look at the NAS snapshot from before the event, decide A or B with a second person |

**Scenario B — new machine** (`ops/docs/disaster-recovery.md` §3): install
Ubuntu, Docker, nginx, git, lftp → pull `config/`, `images/`, `code/` from the
NAS FTP folder with any FTP client → `git clone` the newest code bundle into
`~/shreeja-transport` and `~/shreeja-qa` → `restore-images` →
`restore-config` with `BACKUP_CONFIG_PASSPHRASE` from the vault (puts back
`.env`, `.env.qa`, `.env.deploy`, `conf.d`, nginx, TLS, crontab) →
`ops/bin/backup.sh prod restore-offsite` → `ops/bin/restore.sh prod --latest`,
check counts, `--swap` → `restore-uploads` → `ops/bin/deploy.sh prod --no-pull`
→ point DNS → `backup.sh prod init`, `install-cron`, `guard-reset`;
`healthcheck.sh prod install-cron`. Same for QA.

## 5. Drills — a backup you have not restored is a hope

| Drill | When | Command |
|---|---|---|
| Point-in-time restore, no swap | quarterly | `restore.sh <tier> --latest`, then `--time "<30 min ago>"`, then `--dump <newest>`; counts match live; `--cleanup` |
| Open the config bundle with the vault passphrase | quarterly; from the envelope yearly | `backup.sh <tier> restore-config <newest>`, then delete `restored-config/` |
| Browse a 30-day-old NAS snapshot | quarterly | NAS admin |
| Full rebuild on a spare VM from the NAS only, timed | twice a year | section 4, scenario B |
| Alert path | after bring-up, yearly | stop the backend 5 minutes → DOWN then RECOVERED mail |

Never use `--swap` in a drill. Record every drill in section 7.

## 6. Calendar

| When | What | Who |
|---|---|---|
| every 2 / 30 min | watchdog / backup check | cron |
| nightly 01:15 | base backup, dump, uploads, config, code, images, FTP mirror, check | cron |
| every 4 h | uploads + FTP mirror | cron |
| Sunday | `pgbackrest verify` | cron |
| after any secret change | `ops/bin/backup.sh <tier> config` | operator |
| monthly | read `status` and the week's `backup-<tier>.log`; disk and NAS quota | operator |
| quarterly | restore drill (section 5) | operator + second custodian |
| twice a year | full rebuild drill | operator + second custodian |
| yearly | open and re-seal the passphrase envelope; review retention | IT head |

## 7. Open items and drill log

Open, in order: name the two passphrase custodians and seal the envelope ·
confirm NAS snapshots (daily, 30 days, not deletable by the server's FTP
account) in writing · run `remote-probe.sh` on another machine that can reach
the NAS (it notices a dead server) · name the rebuild machine · phase 2:
restricted app role (`ops/db/harden-privileges.sql` with the TMS DELETE
allow-list) · decide on an off-site S3 object-lock copy.

| Date | Drill | Tier | Time taken | Result | By |
|---|---|---|---|---|---|
| | | | | | |
