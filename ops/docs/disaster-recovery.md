# Disaster recovery (ops-kit) — the NAS, the off-site copy, and rebuilding on another server

## 0. Two recovery scenarios — decide which one you are in first

| | **Scenario A — the server is still running** | **Scenario B — the server is gone** |
|---|---|---|
| Looks like | a bad data change, a wrong seed/import, a deleted record set, lost uploads, a broken deploy, a container that will not start, a corrupted config file | disk failure, OS/hypervisor loss, ransomware, the machine physically gone; the NAS probe mailed `DOWN: hb_heartbeat` |
| Recovery source | the **local** copies on the same box (`BACKUP_DIR`: repo1, dumps, images, git checkout); the NAS only as fallback | the **NAS / off-site copy alone** (`<NAS>/<hostname>/`) + the three passphrases from the vault |
| Data gap | none for the database (repo1 has WAL to the last minute) | ≤ 4 h with an FTP mirror, ≤ 1 min with an NFS/SFTP repo2 or S3 repo3 |
| Time | 5–30 min | < 1 h (drilled) |
| Runbook | §0-A below | §3 |
| Do NOT | rebuild — you would discard the gap-free local copies | fix in place a machine you no longer trust; a ransomed server is Scenario B even if it boots |

### 0-A. Scenario A — recover on the present, running server

All database restores build a scratch cluster first (`127.0.0.1:5599`) and
replace live data only on `--swap` after you type the tier name
(`backup-restore.md` §3 has each command in full).

| What happened | Recover with | Gap |
|---|---|---|
| Bad data change / wrong seed or import / mass delete | `ops/bin/restore.sh <tier> --time "<last good moment>"` → inspect on :5599 → `--swap`; export what users entered after that moment from a later scratch restore and re-import it | only after the chosen moment |
| Database volume corrupt / Postgres will not start | `ops/bin/restore.sh <tier> --latest --swap` (repo1 on the local disk) | ≤ 60 s |
| A few rows deleted | scratch restore without `--swap`, copy across with `psql -h 127.0.0.1 -p 5599`; or the project's master export | none |
| Uploads volume emptied | `ops/bin/backup.sh <tier> restore-uploads` (NAS mirror when mounted, else the local copy) | ≤ 4 h |
| `.env.deploy` / env files / nginx site / TLS lost or corrupted | `ops/bin/backup.sh <tier> restore-config <newest BACKUP_DIR/config/*.tar.enc>`, copy the file back from `restored-config/`, delete the folder; `nginx -t && systemctl reload nginx` | ≤ 24 h, usually none |
| A deploy broke the app | `deploy.sh` dumped first — newest `BACKUP_DIR/dumps/<tier>-*.sql.gz.enc`. `git checkout <previous sha>` then `ops/bin/deploy.sh <tier> --no-pull`; if the migration wrote bad data, `restore.sh <tier> --dump <that dump> --swap` or `--time` just before the deploy | none |
| A container will not start / images pruned | `ops/bin/backup.sh <tier> restore-images` then `docker compose -f docker-compose.<tier>.yml up -d`; with internet, `deploy.sh <tier> --no-pull` rebuilds | none |
| Backups look wrong (`DOWN: backup_guard`, repo shrank) | stop; do not `guard-reset`; confirm the NAS snapshot from before the event is intact; decide A or B with a second person | — |
| Ransomware / attacker had root | Scenario B on a fresh machine from the NAS **snapshot** taken before the event, never from the live mirror; rotate every secret afterwards | ≤ 4 h |

After any swap: `restore.sh` re-applies privileges and takes a full backup;
then `backup.sh <tier> check`, `/health/backup`, log in.

## 1. What "the entire app" consists of, and where each part is kept

| Component | Lives on the server at | Backup copy (encrypted before it leaves) | Recovery source |
|---|---|---|---|
| Application code | the git checkout | GitHub **and** a nightly `git bundle` on the NAS (`<NAS>/<host>/code/<slug>-<date>.bundle`, 30 days; newest = `<slug>-latest.bundle`) | `git clone` from GitHub, or from the bundle when GitHub is unreachable |
| Host configuration & secrets: `.env.deploy`, `ops.env`, **every tier's** app env file (all in every bundle) + `OPS_CONFIG_EXTRA` files, pgBackRest `conf.d/*.conf` (incl. `cipher.conf`), **all** nginx sites + `nginx.conf` + enabled list, TLS certificate + key, docker `daemon.json`, crontab, SSH keys | scattered | encrypted config bundle `<NAS>/<host>/config/config-<tier>-<host>-<date>.tar.enc` (nightly, `BACKUP_CONFIG_PASSPHRASE`) | `backup.sh <tier> restore-config <bundle>` + the passphrase from the vault |
| Database | Docker volume `<project>_<tier>_pgdata` | pgBackRest repo2 on the NAS (WAL ≤ 60 s, nightly base, 8 weeks) · optional S3 repo3 (§2d) · nightly encrypted dump · local repo1 | `restore.sh <tier> --latest --from-nas --swap` (or `--time`) |
| Uploaded files | Docker volume `<project>_<tier>_uploads` | `<NAS>/<host>/uploads-<tier>/` (rsync every 4 h) | `backup.sh <tier> restore-uploads` |
| Master data as files (optional) | written by the app | `<NAS>/<host>/masters-<tier>/masters-<tier>-<date>.tar.enc` | the app's import path |
| Built Docker images | docker image store | `<NAS>/<host>/images/images-<tier>-<date>.tar.gz` (nightly, 2 kept) | `backup.sh <tier> restore-images` → the stack starts with NO Docker Hub / npm access |
| Mobile app binaries (Expo EAS projects) | EAS cloud | `<NAS>/<host>/mobile-builds/` (weekly, 3 per platform; `EXPO_TOKEN`) | side-load / re-upload to the stores; installed apps keep working (same hostname) |
| Server SSH keys | `~/.ssh` | inside the config bundle (`ssh/`) | `restore-config` → `~/.ssh`, chmod 600 |
| Credentials outside the server (signing keys, service accounts, account register) | cloud consoles + `.escrow/` staging | `<NAS>/<host>/escrow/escrow-<host>-<date>.tar.enc` | `escrow.sh open <bundle>` — `credentials-escrow.md` |
| Redis, caches, generated exports | transient | none needed | — |

The three passphrases (config / data / repository cipher) are part of the
plan: vault with two custodians + sealed envelope (`credentials-escrow.md`
§2). Without them a restore is impossible by design.

**3-2-1:** copy 1 = the live server, copy 2 = repo1 on the server's disk,
copy 3 = the NAS. If the NAS is in the same room as the server, add the S3
object-lock repository (§2d) or `BACKUP_OFFSITE_RSYNC` to another building.

## 2. Off-box storage

### 2a. On the NAS

1. A shared folder for backups on a volume with headroom (a year of everything for two tiers of a mid-size app stays well under 200 GB).
2. **NFS** export to the application server's IP, read/write, mapped to a NAS user that owns the folder (`all_squash`); sync preferred.
3. **Snapshots — mandatory:** a daily snapshot of the share kept 30 days. Snapshots are the only copy the application server cannot touch: the server's account can overwrite or delete files in the share (that is how the mirror works) but has no rights over snapshots. Together with the server-side shrink guard this is what makes a ransomware run or a wiped server survivable.
4. **Accounts:** the export rule / FTP user may write ONLY its own share; the NAS **admin** password is never stored on the application server; a separate read-only account is used for restores from another machine. Administer the NAS from an IT laptop, not from the server.
5. Optional: the NAS's own replication to a second NAS or cloud target.

### 2b. On the application server

```bash
sudo apt install -y nfs-common
sudo mkdir -p /mnt/nas/<slug>-backups
echo '<NAS-IP>:/volume1/<slug>-backups  /mnt/nas/<slug>-backups  nfs  rw,soft,timeo=150,retrans=3,_netdev,noatime  0  0' | sudo tee -a /etc/fstab
sudo mount /mnt/nas/<slug>-backups
# .env.deploy: BACKUP_NAS_DIR=/mnt/nas/<slug>-backups, the three passphrases
ops/bin/backup.sh <tier> init        # enables conf.d/nas-repo.conf (repo2), full backup to both repos
ops/bin/backup.sh <tier> status      # "repos": [1, 2], "nas": "mounted"
```
`soft,timeo=150,retrans=3` makes a NAS outage fail writes after ~45 s instead
of hanging Postgres; pgBackRest spools WAL and retries.

### 2c. If the NAS only offers FTP (interim)

Set `BACKUP_FTP_*` in `.env.deploy` (leave `BACKUP_NAS_DIR` blank). Everything
under `BACKUP_DIR`, the repository included, is mirrored with `lftp` to
`<BACKUP_FTP_DIR>/<host>/` nightly and every 4 h — a mirror, not a live
repository: up to 4 h behind. Rebuild from it with `backup.sh <tier>
restore-offsite <old-host>` first, then `restore.sh <tier> --latest --swap`.

### 2d. A true off-site copy: S3 bucket with object lock (recommended)

1. Bucket with **versioning on** and **object lock, COMPLIANCE mode, default retention 35 days**; lifecycle rule expiring non-current versions after 42 days.
2. A dedicated access key allowing put/get/list and plain delete (a delete marker only) and **denying** `s3:DeleteObjectVersion`, `s3:BypassGovernanceRetention`, `s3:PutObjectRetention`, bucket-policy changes.
3. `cp ops/postgres/conf.d/s3-repo.conf.example ops/postgres/conf.d/s3-repo.conf`, fill it in (repo3 beside the NAS repo2, or repo2 if there is no NAS repo), `ops/bin/backup.sh <tier> init`. With `BACKUP_REPO_CIPHER_PASS` set the cipher lines are added for that repo, so objects are encrypted before upload regardless of bucket settings.
4. `status` → `"repos": [1, 2, 3]`. A DR restore can read from it with `pgbackrest --repo=3` even if server and NAS are both gone.

## 3. Scenario B — rebuild on an entirely new server (the runbook)

Only when the old machine is gone or no longer trusted (§0).
Target: **under one hour** from "the old server is gone" to users logging in,
with data as of the last archived WAL segment.

Prerequisites (check in every drill): the three passphrases in the vault /
envelope; the NAS (or S3) reachable from the new machine; DNS under your
control; the escrow bundle (only if the cloud accounts were lost too).

```bash
# 1. Base OS (Ubuntu 22.04/24.04)
sudo apt update && sudo apt install -y docker.io docker-compose-v2 nginx git nfs-common python3 rsync
sudo usermod -aG docker "$USER" && newgrp docker

# 2. Mount the NAS as in §2b; the code from the NAS bundle (no GitHub needed)
sudo mkdir -p <OPS_APP_DIR> && sudo chown "$USER" <OPS_APP_DIR>
git clone /mnt/nas/<slug>-backups/<old-host>/code/<slug>-latest.bundle <OPS_APP_DIR>
cd <OPS_APP_DIR> && git checkout main          # prod branch
git remote set-url origin <OPS_CODE_REMOTE>

# 3. Host configuration from the encrypted bundle (§3c = the passphrase chain)
#    NO INTERNET?  do 3b FIRST (the images archive carries the tools image restore-config needs).
#    FTP-ONLY NAS? pull config/ (+ images/, code/) with any FTP client first; restore-offsite needs .env.deploy.
ops/bin/backup.sh prod restore-config /mnt/nas/<slug>-backups/<old-host>/config/config-prod-<old-host>-<date>.tar.enc   # prompts for BACKUP_CONFIG_PASSPHRASE
cp restored-config/repo/.env.deploy .env.deploy && chmod 600 .env.deploy
cp restored-config/repo/ops.env ops.env
cp -r restored-config/repo/. .          # EVERY tier's app env file (+ OPS_CONFIG_EXTRA files) at their repo-relative paths
mkdir -p ~/.ssh && cp restored-config/ssh/* ~/.ssh/ 2>/dev/null; chmod 700 ~/.ssh; chmod 600 ~/.ssh/id_* 2>/dev/null
cp restored-config/conf.d/*.conf ops/postgres/conf.d/
docker run --rm -v "$PWD/ops/postgres/conf.d:/c" alpine:3.20 sh -c 'chown 999:999 /c/cipher.conf && chmod 600 /c/cipher.conf'
sudo mkdir -p /etc/nginx/ssl && sudo cp -r restored-config/ssl/. /etc/nginx/ssl/
sudo cp restored-config/nginx/nginx.conf /etc/nginx/nginx.conf 2>/dev/null
sudo cp restored-config/nginx/*.conf /etc/nginx/sites-available/      # every site the old box served
sudo rm -f /etc/nginx/sites-enabled/default
for s in $(cat restored-config/nginx/sites-enabled.txt); do sudo ln -sf "/etc/nginx/sites-available/$s" "/etc/nginx/sites-enabled/$s"; done
[[ -f restored-config/docker/daemon.json ]] && sudo cp restored-config/docker/daemon.json /etc/docker/daemon.json && sudo systemctl restart docker
crontab restored-config/crontab.txt 2>/dev/null   # or install-cron in step 7
rm -rf restored-config

# 3b. No internet (Docker Hub / npm unreachable)?  ops/bin/backup.sh prod restore-images   — then deploy.sh --no-pull starts the loaded images

# 4. Database from the NAS (FTP-only NAS: backup.sh prod restore-offsite <old-host> first, then drop --from-nas)
docker compose -f docker-compose.prod.yml build postgres && docker compose -f docker-compose.prod.yml up -d postgres
ops/bin/restore.sh prod --latest --from-nas            # verify counts
ops/bin/restore.sh prod --latest --from-nas --swap     # type "prod"

# 5. Uploads, then the full stack
ops/bin/backup.sh prod restore-uploads /mnt/nas/<slug>-backups/<old-host>/uploads-prod
ops/bin/deploy.sh prod --no-pull

# 6. DNS → the new server. 7. Backups on the NEW server:
ops/bin/backup.sh prod init && ops/bin/backup.sh prod install-cron && ops/bin/backup.sh prod guard-reset
ops/bin/healthcheck.sh prod install-cron
# 8. Only if the cloud accounts were lost too: ops/bin/escrow.sh open <bundle> (credentials-escrow.md §4)
```

If the NAS failed instead: the server still has repo1 and every local copy;
replace the NAS, re-mount, `backup.sh <tier> init`. If both server and NAS
are gone: only the S3 repo / `BACKUP_OFFSITE_RSYNC` copy remains — which is
why §2d exists.

### 3c. How a bare new server opens the encrypted copy — the decryption chain

Every file in the off-box copy is encrypted and the passphrases are never in
it. One passphrase typed by a human is the root; everything else unlocks
from it in this order:

| Step | Opened | Key | Source |
|---|---|---|---|
| 0 | `images/images-<tier>-<date>.tar.gz` (built images incl. the tools helper) | none (plain) | `backup.sh <tier> restore-images` = `docker load`. FIRST on a box with no internet — every later step runs `openssl`/`lftp` in that tools image |
| 1 | `config/config-<tier>-<host>-<date>.tar.enc` | **`BACKUP_CONFIG_PASSPHRASE`** | **typed by a human** from the vault / envelope; `backup.sh <tier> restore-config` prompts when `.env.deploy` is absent (needs only `ops.env`, which is in the git bundle) |
| 2 | from the bundle: `repo/.env.deploy` (carries `BACKUP_DATA_PASSPHRASE` + `BACKUP_REPO_CIPHER_PASS` + NAS/FTP credentials) and `conf.d/cipher.conf` | step 1 | copy into place; nothing prompts from here on |
| 3 | pgBackRest repository `pg-<tier>/` | `BACKUP_REPO_CIPHER_PASS` via `cipher.conf` | `restore.sh <tier> --latest --from-nas` mounts `conf.d/`; pgBackRest decrypts |
| 4 | `dumps/*.enc`, `masters-*/*.enc`, `escrow/*.enc` | `BACKUP_DATA_PASSPHRASE` | `restore.sh --dump`, `escrow.sh open`, sealed exports |
| — | uploads, code bundle, mobile builds | not encrypted | plain copies |

Traps: **no internet** → step 0 before step 1 (`restore-config` would try
to build the tools image). **FTP-only NAS** → `restore-offsite` needs the
FTP password, which is inside `.env.deploy`, which is inside the bundle:
pull `config/` (+ `images/`, `code/`) with any FTP client first using the
password from the vault, do steps 0–2, then `restore-offsite`. **Passphrase
lost = data lost, by design** — two vault custodians + a sealed envelope
(`credentials-escrow.md` §2); the quarterly drill opens the newest bundle
with the vault copy. On the running server (Scenario A) the chain is the
same, but `.env.deploy` is already present so nothing prompts.

## 4. Drill schedule

| Drill | How often | Evidence |
|---|---|---|
| Same-server point-in-time restore (no swap) | quarterly | counts + timestamps in the log |
| Full rebuild on a spare machine/VM from the off-box copy only | twice a year, and after any change here | the spare answers `/health/ready` and shows the latest data |
| Open the newest config bundle and escrow with the vault passphrases; yearly from the envelope | quarterly / yearly | `restore-config` + `escrow.sh open` succeed |
| NAS snapshot schedule exists, a 30-day-old snapshot is browsable | quarterly | screenshot |

## 5. Retention

| Data | Where | Kept |
|---|---|---|
| WAL + base backups, repo1 (server) | `BACKUP_DIR/pg-<tier>` | 4 weekly fulls (~4 weeks PITR) |
| WAL + base backups, repo2 (NAS) / repo3 (S3) | NAS / bucket | 8 weekly fulls / 35-day object lock |
| Encrypted SQL dumps | server + NAS | 14 days |
| Uploads copy | server + NAS | mirror (deletions propagate at the next sync — rely on NAS snapshots) |
| Config bundles | server + NAS | 60 days |
| Code bundles | server + NAS | 30 days |
| Sealed master exports | server + NAS | 8 weeks |
| Escrow bundles | server + NAS | 12 newest |
| Docker images archives | server + NAS | 2 newest |
| Mobile build artefacts | server + NAS | 3 newest per platform |
| Pre-encryption repository copies | server + NAS | until `prune-plain` (≥ 28 days after `encrypt-repo`) |
| NAS snapshots (mandatory) | NAS | 30 days |

## 6. Recovery objectives

| Component | Recovery point | Recovery time (target) | Basis |
|---|---|---|---|
| Database — server disk fails, live NAS/S3 repo | ≤ 60 s | 30 min same box / < 1 h new box | `archive_timeout=60`, repo2/3 receive each segment within a minute |
| Database — server disk fails, FTP mirror only | ≤ 4 h | < 1 h new box | nightly + 4-hourly mirror |
| Database — bad data change (undo to a moment) | 0 within the PITR window | 15–30 min | `restore.sh --time` |
| Database — server AND NAS destroyed | ≤ 60 s with the S3 repo; otherwise total loss | < 1 h | §2d is the only cover for a whole-room event |
| Uploaded files | ≤ 4 h | 15 min | 4-hourly rsync |
| Host configuration, secrets, TLS | ≤ 24 h | 10 min | nightly bundle |
| Application code | ≤ 24 h from the NAS; 0 from GitHub | 10 min | nightly git bundle |
| Signing keys and cloud accounts | 0 (keys don't change) while the escrow is < 100 days old | 1 day | `credentials-escrow.md` |
| Built Docker images | ≤ 24 h | 10 min | nightly `docker save` |
| Mobile app binaries | ≤ 7 d | 0 for users; 1 day to re-publish | weekly EAS artefact download |
| Detection of a dead server | ≈ 10 min | — | NAS probe heartbeat |

Whole-application RTO target: **under one hour** (§3). If a drill takes
longer, fix the runbook, not the target.

## 7. Drill log

| Date | Tier | Drill | Who | Minutes | Outcome / fixed |
|---|---|---|---|---|---|
| | | | | | |
