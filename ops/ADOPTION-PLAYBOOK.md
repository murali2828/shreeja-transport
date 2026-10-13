# Adoption playbook — everything to do for another Claude Code project

This is the complete to-do for giving any other project the same backup,
restore, monitoring and deploy guarantees as Shreeja Assure, using the
`ops-kit/` folder. It is written for a project that is developed with
Claude Code, so section D is the instruction block to hand to Claude in
that project. Sections are in the order you do them.

## A. What you are adopting (read once)

Eight guarantees, each backed by a script in the kit:

1. Point-in-time database recovery to any second in a 4-week window
   (pgBackRest: WAL every 60 s + nightly base backups).
2. Every copy that leaves the server is encrypted (repository cipher,
   encrypted dumps / exports / escrow / config bundle; three passphrases).
3. A wiped or ransomed server cannot destroy its own backups (shrink
   guard + NAS snapshots + optional S3 object lock).
4. Rebuild on a new machine in under an hour from the off-box copy alone,
   even with no internet (config bundle, git bundle, images archive,
   uploads mirror, mobile artefacts, decryption chain).
5. Same-server recovery with no data gap for every everyday incident (bad
   data, lost uploads, lost config, broken deploy, lost image).
6. The application cannot delete master data (restricted DB role, seeds
   that cannot shrink a table, dump-first deploy).
7. Someone is told within minutes when anything is down, stale,
   unencrypted or missing (host watchdog + a probe on another machine).
8. The keys no backup covers are escrowed (signing keys, service
   accounts, account register).

Origin: `Shreeja-EMMS/deploy/` and `docs/backup-restore.md`,
`docs/disaster-recovery.md`, `docs/backup-360-review.md` (the review that
produced this playbook).

## B. Decisions to make before touching the project (30 minutes)

Write the answers down; they become `ops.env` and `.env.deploy`.

| Decision | Options | Assure's answer |
|---|---|---|
| Tiers | `qa prod` (recommended) or one | qa + prod on one box |
| Database | Postgres (kit as-is) / MySQL-MariaDB (swap the DB layer, see E) / managed cloud DB (use the provider's PITR, keep the rest) | Postgres 15 |
| File storage | Docker volume (kit as-is) / S3-MinIO bucket (add a bucket mirror, see E) / none | volume (MinIO decision pending for prod) |
| Off-box target | NFS share on a NAS (best) / SFTP-FTP account on a NAS (4 h lag) / S3 object-lock bucket / rsync to another box | FTP interim |
| Off-site copy | S3 object lock in another region / second building / none (state the risk) | none yet |
| Passphrase custody | two named custodians + one sealed envelope | to be done |
| Alert recipients | at least two mailboxes; SMTP account | Workspace mailbox |
| Rebuild target | a VM or machine you can bring up in an hour | to be named |
| Mobile app | yes (needs `EXPO_TOKEN`, escrow of signing keys) / no | yes |
| Retention | PITR 4 weeks, dumps 14 d, config 60 d, code 30 d, plus a yearly archive if compliance needs it | defaults |
| Who runs drills | name + quarter dates | IT head |

## C. Steps, in order

### Day 1 — put the kit in and configure (2–3 hours)

```bash
cp -r /path/to/Shreeja-EMMS/ops-kit  <repo>/ops
cp ops/ops.env.example ops.env                       # identity: slug, tiers, hosts, services, commands
cp ops/env.deploy.example .env.deploy && chmod 600 .env.deploy   # secrets: DB, Redis, passphrases, SMTP, NAS/FTP, EXPO_TOKEN
# generate the three passphrases NOW and put them in the vault + envelope before anything is encrypted with them
openssl rand -base64 48   # ×3 → BACKUP_CONFIG_PASSPHRASE, BACKUP_DATA_PASSPHRASE, BACKUP_REPO_CIPHER_PASS
```

Then wire the project (this is the part to give Claude Code — section D):

- compose: use `ops/postgres` as the DB image with the archive settings
  from `ops/compose/postgres.snippet.yml`; name the project `<slug>-<tier>`
  and the volumes `<tier>_pgdata`, `<tier>_uploads`.
- two DB roles per tier: owner for migrations/backups, app for runtime;
  `ops/db/harden-privileges.sql` with the project's own DELETE allow-list.
- health endpoints `/health` (with the git sha), `/health/ready`,
  `/health/backup` (`ops/app/health.routes.snippet.js`).
- seeds through `ops/seeds/seed-safe.js`; the no-delete test in CI.
- `ops/ci/dependency-audit.yml` with the project's package folders.
- `ops/escrow.manifest` edited to what the project actually has.
- `.gitignore`: `.env.deploy`, `.escrow/`, `restored-*/`, `backups/`,
  `ops/postgres/conf.d/*.conf` (keep the `.example` files).
- paste `ops/CLAUDE-SNIPPET.md` into the project's CLAUDE.md.

### Day 2 — first backups and the first restore (2 hours)

```bash
ops/bin/deploy.sh qa                          # build, migrate, harden, health
ops/bin/backup.sh qa init                     # stanza (+NAS repo2, cipher from the first byte), first full backup, all copies
ops/bin/backup.sh qa install-cron             # 01:15 backup · */30 check · 4-hourly uploads+offsite · Sun verify
ops/bin/healthcheck.sh qa test-mail && ops/bin/healthcheck.sh qa install-cron
ops/bin/escrow.sh init && ops/bin/escrow.sh check && ops/bin/escrow.sh seal
ops/bin/backup.sh qa images && ops/bin/backup.sh qa mobile-builds
ops/bin/backup.sh qa status                   # every block green, repo_cipher aes-256-cbc, files_encrypted true
ops/bin/restore.sh qa --latest && ops/bin/restore.sh qa --cleanup       # the first drill, no swap
ops/bin/backup.sh qa restore-config <newest BACKUP_DIR/config/*.tar.enc>  # with the passphrase read from the VAULT
```

### Week 1 — the other machine

- NAS: share or account created, daily snapshots (30 d) confirmed in
  writing, the server's account cannot delete snapshots.
- Probe: `ops/bin/remote-probe.sh` + `probe.env` on another Linux box
  (another project's server is ideal — they probe each other), every
  5 min; stop the API for 5 minutes and receive the mail.
- Off-site: S3 object-lock bucket (`ops/postgres/conf.d/s3-repo.conf`)
  or an rsync target; `status` → `repos: [1,2,3]`.
- Rebuild target named in `ops/docs/disaster-recovery.md` §3.

### Month 1 — prove it

- Full rebuild drill on the target from the off-box copy alone, no
  internet if you can, timed, logged in DR §7. This is the only proof the
  plan works.
- Repeat `deploy.sh prod` … `init` … `install-cron` for the prod tier at
  go-live, with prod's own passphrases if you want tier separation.

### Every quarter, forever

The drill in `ops/docs/backup-restore.md` §4: check green, `--latest`,
`--time`, `--dump .enc`, open the config bundle and the escrow with the
passphrase from the vault, clone the git bundle, look at the NAS snapshot
list, record it. Twice a year: the full rebuild. Once a year: open the
sealed envelope and reseal it.

## D. The instruction block for Claude Code in the other project

Paste this as the task (adjust the paths and the three project facts):

```
Adopt the ops-kit at <path-to>/Shreeja-EMMS/ops-kit into this repository as ops/.
Read ops/README.md, ops/SETUP-CHECKLIST.md and ops/ADOPTION-PLAYBOOK.md first.

Project facts:
- slug: <myapp>; tiers: qa prod; public hosts: qa.<host>, <host>
- database: Postgres <version> (owner role <slug>_<tier>_user, app role <slug>_<tier>_app)
- file storage: <docker volume named <tier>_uploads | S3/MinIO bucket <name> | none>
- migrations: <command>; seeds: <command>; health route file: <path>
- mobile app: <yes (Expo project id …) | no>

Do, in this order, committing each step:
1. Copy the kit to ops/. Write ops.env from ops/ops.env.example with the facts above.
   Add .env.deploy, .escrow/, restored-*/, backups/, ops/postgres/conf.d/*.conf (not *.example) to .gitignore.
2. Change docker-compose.<tier>.yml per ops/compose/postgres.snippet.yml: build the DB from ops/postgres,
   archive_mode=on, archive_timeout=60, bind-mount the repo from BACKUP_DIR/pg-<tier>, project name <slug>-<tier>,
   volumes <tier>_pgdata and <tier>_uploads. Pass GIT_SHA as a build arg to the API image.
3. Add the two-role model: migrations use the owner URL, the app uses the app URL. Edit ops/db/harden-privileges.sql:
   list every table the application legitimately DELETEs from (search the code for .del(), DELETE, destroy) in the
   allow-list; everything else read/insert/update only; the audit table append-only.
4. Mount ops/app/health.routes.snippet.js (or port it) so /health returns the git sha, /health/ready checks the DB,
   /health/backup reports archiving.
5. Route seeds through ops/seeds/seed-safe.js and add ops/seeds/seeds.nodelete.test.js to the test run.
6. Add ops/ci/dependency-audit.yml with this project's package folders in the matrix.
7. Edit ops/escrow.manifest to the keys this project really has; edit ops/docs/credentials-escrow.md §3 accordingly.
8. If file storage is an S3/MinIO bucket: add a `bucket` step to ops/bin/backup.sh that mirrors the bucket to
   BACKUP_DIR/uploads-<tier>/ (mc mirror) and a restore-bucket counterpart; wire both into cmd_backup and cmd_uploads.
9. Paste ops/CLAUDE-SNIPPET.md into CLAUDE.md and add a short "Backups and recovery" section pointing at ops/docs.
10. Run: bash -n on every ops/bin script; the test suite; docker compose config for each tier.
Do not: put any passphrase, password or token in a committed file; change retention or cron times without saying so;
delete or truncate anything; touch the production tier.
Report at the end: what was wired, what you could not verify without a server, and the exact commands I must run
on the server (init, install-cron, test-mail, escrow, first restore) in order.
```

After Claude reports, a human does Day 2 on the server — the scripts
need Docker, the NAS and the vault passphrases, none of which Claude has.

## E. Adapting to a different stack

| Stack | What changes | What stays |
|---|---|---|
| Node + Postgres + Docker (Assure) | nothing | everything |
| Python / Go / Java + Postgres | `<TIER>_MIGRATE_CMD`, `<TIER>_SEED_CMD`; port the health routes (three endpoints, same JSON) | all scripts |
| MySQL / MariaDB | replace the DB layer only: Percona XtraBackup (or `mariabackup`) + binary-log shipping in place of pgBackRest; `backup.sh`'s `pgb`/`sql` helpers and `restore.sh`'s PITR branch are the two places; dumps via `mysqldump --single-transaction`; `harden-privileges.sql` in MySQL grammar | config bundle, code bundle, images, uploads, escrow, guard, watchdog, probe, deploy, encryption of files |
| Managed cloud database | use the provider's PITR and snapshots; keep dumps (encrypted), the bundle, code, images, escrow, watchdog | everything but the repository |
| S3 / MinIO file storage | `bucket` + `restore-bucket` steps with `mc mirror` (add `minio/mc` to the tools image); or bucket versioning + native replication to the NAS | the rest |
| Several apps on one server | one `BACKUP_DIR` per app (`/opt/<slug>/backups`), one `ops/` per repo, one host nginx with all sites (the bundle takes all of them), one watchdog per tier, cross-probe between servers | — |
| No Docker (PM2 on the host) | containerise the DB at least (the kit's Postgres image is the PITR mechanism); the rest of the kit assumes compose — adapting `deploy.sh` and the container checks is a day's work | — |
| Static site / no DB | drop the DB layer; keep code bundle, config bundle, images, watchdog, probe | — |

## F. Acceptance — the project is protected when all of these are true

1. `ops/bin/backup.sh <tier> status` is all green, `repo_cipher: ["aes-256-cbc"]`, `files_encrypted: true`, `guard.blocked: false`, `repos` lists the NAS (and S3 if chosen).
2. `restore.sh <tier> --latest` and `--time` both complete on the scratch cluster with counts matching live.
3. `restore.sh <tier> --dump <newest .enc>` completes.
4. `restore-config <newest bundle>` and `escrow.sh open <newest>` decrypt with the passphrase taken from the **vault**, and the bundle contains every tier's env file and every nginx site.
5. `restore-images` loads last night's archive on a box with the images removed.
6. `git clone <off-box>/code/<slug>-latest.bundle` works.
7. The NAS shows a snapshot list; the server's account cannot delete it.
8. Stopping the API for 5 minutes produces a DOWN mail from the watchdog; stopping the server produces one from the probe on the other machine.
9. `healthcheck.sh <tier> status` shows every backup freshness check green after 48 h of cron.
10. The dependency-audit workflow passed at least once on `main`.
11. The full rebuild drill is in DR §7 with a time under 60 minutes.
12. Two people can do items 2–4 without the other present.

## G. Recurring calendar

| When | What | Who |
|---|---|---|
| every 2 min / 30 min | watchdog / backup check (automatic) | cron |
| nightly 01:15 | base backup → dump → uploads → config → code → masters → escrow → images → offsite → check | cron |
| every 4 h | uploads + offsite mirror | cron |
| weekly Sun | `pgbackrest verify`; mobile artefacts; (recommended) automated scratch restore with mailed result | cron |
| after any secret change | `backup.sh <tier> config` by hand | operator |
| monthly | read `status` and the last week of the backup log; check disk and quota | operator |
| quarterly | the drill (backup-restore §4); rotate anything the escrow says expires | operator + custodian 2 |
| twice a year | full rebuild on the target machine from the off-box copy | operator + custodian 2 |
| yearly | open and reseal the passphrase envelope; review retention with compliance | IT head |

## H. Mistakes to avoid (all seen or nearly seen on Assure)

- Running seeds on a populated database (the 5 Sep incident) — the kit's seed runner refuses to shrink a table, keep it in the path.
- Encrypting before the passphrases are in the vault — a backup nobody can open.
- One tier's bundle only carrying its own env file — every bundle must carry every tier's.
- Only the app's nginx site in the bundle — a gateway or second site with hand-pasted keys is lost.
- Rebuilding for a same-server incident — throws away the gap-free local copies; use Scenario A.
- Fixing a ransomed server in place — Scenario B from a NAS **snapshot**, then rotate every secret.
- `guard-reset` without knowing why the set shrank.
- A probe that runs on the same server it watches.
- Assuming a rebuild target exists.
- Never running the rebuild drill.

## I. Across all projects

- One NAS folder layout: `<NAS>/<hostname>/` per server; one FTP or NFS account per server.
- One vault structure: `<project>/backup-config`, `/backup-data`, `/repo-cipher`, `/ftp`, `/escrow-accounts`; the same two custodians or a named pair per project.
- Cross-monitoring: each server runs the probe for the others.
- One drill calendar: all projects' quarterly drills in the same week, the rebuild drills alternating.
- Keep `ops/` identical across projects (copy the kit, do not fork it); improvements go back to `Shreeja-EMMS/ops-kit` and are re-copied.
