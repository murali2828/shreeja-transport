# Backup, restore and data protection (ops-kit)

What stands between a mistake and data loss, how to operate it, and exactly
how to restore. Everything here is driven by `ops.env` (identity) and
`.env.deploy` (secrets); `<tier>` is one of `OPS_TIERS`.

## 1. Layers

| Layer | What it does | Where |
|---|---|---|
| **Continuous WAL archiving + base backups** (pgBackRest) | Every WAL segment reaches the repository within **60 s**; a base backup nightly (full Sunday, differential otherwise). Restore to **any second** in the window (4 weekly fulls ≈ 28 days). | `ops/postgres/`, `ops/bin/backup.sh` |
| **Nightly logical dump** | Plain SQL copy of the whole database, encrypted (`.sql.gz.enc`), kept 14 days; loads into any Postgres. | `backup.sh <tier> dump` |
| **NAS = second repository** | With the NAS NFS-mounted (`BACKUP_NAS_DIR`), every WAL segment and base backup is written there too within a minute (`conf.d/nas-repo.conf`, enabled by `init`). | `ops/docs/disaster-recovery.md` §2 |
| **S3 object-lock repository** (optional, recommended) | A third repository on S3-compatible storage in another region, versioned + object-locked: the off-site copy. | `conf.d/s3-repo.conf`, DR §2d |
| **Uploads, config, code, masters** | Uploads volume rsynced every 4 h; an AES-256 bundle of `.env.deploy`, `ops.env`, **every tier's** app env file (all tiers in every bundle) + `OPS_CONFIG_EXTRA` files, pgBackRest conf.d (incl. the repository cipher), **all** nginx sites + `nginx.conf`, TLS cert + key, docker `daemon.json`, crontab and SSH keys nightly; a verified `git bundle` of every branch + tag nightly; the project's master export sealed as an encrypted archive. | `backup.sh <tier> uploads | config | code | masters-seal` |
| **Built images + mobile binaries** | Nightly `docker save` of the tier's images (rebuild needs no Docker Hub / npm); weekly download of the newest EAS build artefacts for Expo projects (`EXPO_TOKEN`). | `backup.sh <tier> images | restore-images | mobile-builds` |
| **Credentials escrow** | App signing keys, service-account keys and the account register, encrypted, re-sealed nightly, carried with everything else. | `ops/bin/escrow.sh`, `ops/docs/credentials-escrow.md` |
| **Off-box copies with a shrink guard** | The whole backup directory mirrored to the NAS (rsync or FTP) and/or over ssh — refused, with an alert, when the local set shrank unexpectedly (§1d). | `backup.sh <tier> offsite` |
| **Encryption at rest** | Repository cipher (AES-256-CBC) + encrypted dumps / exports / escrow / config bundle; three passphrases (vault + envelope). | §1d |
| **Two database roles** | The app runs as a role that cannot DELETE/TRUNCATE any table outside an allow-list, has no DDL; audit tables append-only. | `ops/db/harden-privileges.sql` |
| **Seeds cannot delete** | No delete statements (unit-tested), one transaction per file, rolled back if any table would shrink. | `ops/seeds/` |
| **One deploy script** | Dumps first, fast-forward only, migrates, re-applies privileges, seeds only named files, verifies the running commit. | `ops/bin/deploy.sh` |
| **Monitoring + alerts** | Watchdog every 2 min (≈ 25 checks), `backup.sh check` every 30 min, `pgbackrest verify` weekly, NAS-side probe. | `ops/docs/monitoring-alerts.md` |

Recovery objectives: **RPO ≤ 1 min** for the database (with a live NAS/S3
repository; ≤ 4 h with the FTP mirror only), **RTO 15–30 min** for a
point-in-time restore, **< 1 h** for a rebuild on a new server. The full
per-component table is in `disaster-recovery.md` §6.

## 1b. Every tier is set up the same way

```bash
ops/bin/deploy.sh <tier>                     # image with pgBackRest, migrate, app role
ops/bin/backup.sh <tier> init                # stanza (+NAS repo2, cipher), first full backup, all copies
ops/bin/backup.sh <tier> install-cron        # 01:15 backup · */30 check · 4-hourly uploads+offsite · Sun verify
ops/bin/healthcheck.sh <tier> test-mail && ops/bin/healthcheck.sh <tier> install-cron
ops/bin/restore.sh <tier> --latest && ops/bin/restore.sh <tier> --cleanup      # drill
```

## 1c. Every failure sends a mail

| Failure | Detected by | Subject |
|---|---|---|
| base backup, dump, rsync, encryption or NAS write fails | `backup.sh` ERR trap (mails the log tail) | `[LABEL TIER] backup problem on <host>` |
| WAL archiving stalled, newest base backup > 26 h, no backup, NAS unmounted, off-box copy blocked by the guard | `backup.sh check` every 30 min | same |
| backup cron stopped · dump > 26 h · uploads > 8 h · config > 50 h · code > 50 h · masters > 8 d · images > 50 h · mobile artefacts > 9 d · off-box > 8 h · guard blocked · not encrypted · escrow missing/> 100 d | watchdog (`backup_job`, `backup_dump`, `backup_uploads`, `backup_config`, `backup_code`, `backup_masters`, `backup_offsite`, `backup_guard`, `backup_encryption`, `escrow`) | `DOWN: …` then `RECOVERED` |
| server dead | NAS probe (stale heartbeat + URLs down) | `[LABEL] DOWN: hb_heartbeat-<tier>` |

## 1d. Immutability, encryption at rest, escrow

**A compromised server must not be able to destroy its own backups.** Every
off-box copy is a mirror, and a mirror copies a deletion. Two independent
defences: (a) the **shrink guard** — after every successful copy `backup.sh`
records the repository's shape (`<BACKUP_DIR>/.offsite-guard-<tier>.json`) and
refuses the next copy when the local set lost more than
`BACKUP_GUARD_MAX_DROP` (2) backup sets, its newest set vanished, or the
dumps directory emptied; the alert says why and the watchdog keeps
`backup_guard` red until a human runs `backup.sh <tier> guard-reset`
(`BACKUP_OFFSITE_DELETE=no` never propagates deletions at all); (b)
**snapshots on the NAS** the server's account cannot touch (mandatory, DR
§2a) and, off-site, an S3 bucket with object lock and a key that cannot
delete versions (DR §2d). The NAS admin password is never on the server.

**Everything that leaves the box is encrypted.** `.env.deploy` carries three
passphrases — `BACKUP_CONFIG_PASSPHRASE` (config bundle),
`BACKUP_DATA_PASSPHRASE` (dumps, sealed master exports, escrow; defaults to
the config one), `BACKUP_REPO_CIPHER_PASS` (the pgBackRest repository) —
held in the vault by two custodians and in a sealed envelope. Once per tier:

```bash
ops/bin/backup.sh <tier> encrypt-repo        # ≈1–2 min DB stop: fresh AES-256 repository, full backup, guard reset
ops/bin/backup.sh <tier> status | grep -A2 repo_cipher     # ["aes-256-cbc"]
ops/bin/restore.sh <tier> --latest && ops/bin/restore.sh <tier> --cleanup     # prove it restores
ops/bin/backup.sh <tier> prune-plain          # ≥ 4 weeks later: drop the pre-encryption copies
```
A repository created by `init` with `BACKUP_REPO_CIPHER_PASS` already set is
encrypted from the first byte. `restore.sh --dump` accepts `.enc` files.
Not encrypted: the uploads mirror (a plain rsync so a restore is a plain
copy) — the NAS share is access-controlled; revisit if uploads hold personal
documents.

**The keys no database restore brings back are escrowed** — `credentials-escrow.md`.

## 2. Daily operation

| When | What | Where to look |
|---|---|---|
| continuously | WAL archiving (≤ 60 s behind) | `https://<host>/health/backup` |
| every 30 min | `backup.sh <tier> check` | mail; `<BACKUP_DIR>/<tier>-status.json`; `backup-<tier>.log` |
| 01:15 daily | base backup → dump → uploads → config → code → masters → escrow → offsite → check | `backup.sh <tier> info` |
| every 4 h | uploads + offsite | `.offsite-last` |
| Sun 04:30 | `pgbackrest verify` | log |
| every deploy | logical dump before anything changes | `<BACKUP_DIR>/dumps/` |

Before a risky data operation run `ops/bin/backup.sh <tier> dump`.
`status` prints the JSON the checker evaluates; a `problems` entry means act
now (repository full/unwritable, stanza not initialised, cron not running,
guard blocked).

## 3. Restore procedures

Same-server procedures (Scenario A — the box is up, `BACKUP_DIR` intact, no
data gap). When the server is gone (Scenario B) use `disaster-recovery.md`
§0 to decide and §3 to rebuild from the off-box copy; §0-A there maps every
same-server case to the command below.

All restores build the chosen state in a **scratch cluster first** (own
volume, own container on `127.0.0.1:5599`), print row counts
(`OPS_VERIFY_SQL` or every table), and only replace the live data on
`--swap` after you type the tier name. The live data directory is tarred to
`<BACKUP_DIR>/pre-restore-*` first, privileges are re-applied and a fresh
full backup is taken afterwards.

```bash
ops/bin/restore.sh <tier> --time "2026-09-05 23:14:00+05:30" [--swap]   # undo everything after that second
ops/bin/restore.sh <tier> --latest [--swap]                             # newest backup + all WAL ("the disk died")
ops/bin/restore.sh <tier> --backup <label> [--swap]                     # a specific set (backup.sh <tier> info lists labels)
ops/bin/restore.sh <tier> --dump <BACKUP_DIR>/dumps/<tier>-<date>.sql.gz.enc [--swap]
ops/bin/restore.sh <tier> --latest --from-nas --swap                    # DR on a NEW server (repository read from the NAS)
ops/bin/restore.sh <tier> --cleanup
```

For one table or a handful of rows: restore the point in time WITHOUT
`--swap`, then copy the rows across with `psql -h 127.0.0.1 -p 5599`; or use
the project's master export if it has one.

## 4. Restore drill (quarterly, and after any change to this setup)

- [ ] `backup.sh <tier> check` green; `info` lists ≥ 1 full backup; `status` shows `repo_cipher: ["aes-256-cbc"]`, `files_encrypted: true`, `guard.blocked: false`.
- [ ] `restore.sh <tier> --latest` completes; counts match live.
- [ ] `restore.sh <tier> --time "<30 min ago>"` completes; `now()` ≤ that time.
- [ ] `restore.sh <tier> --dump <latest .enc>` completes.
- [ ] `backup.sh <tier> restore-config <newest bundle>` and `escrow.sh open <newest>` decrypt with the passphrases taken from the **vault**; delete the restored folders.
- [ ] The off-box copy has today's files; the NAS snapshot list shows a 30-day-old snapshot.
- [ ] `git clone <NAS>/<host>/code/<slug>-latest.bundle /tmp/drill` works.
- [ ] `restore.sh <tier> --cleanup`; record date + who in `disaster-recovery.md` §7.

## 5. Rules for developers

- Seeds never delete; deletes in application code need an allow-list entry
  in `ops/db/harden-privileges.sql` (and usually should be soft deletes).
- Migrations are transactional per file and run as the owner; a migration
  that must delete data is a code-review item.
- New data on disk → decide its backup before merging (uploads volume,
  another service, an external bucket) and add it to the DR component table.
