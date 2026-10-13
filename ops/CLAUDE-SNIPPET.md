# Paste into the project's CLAUDE.md (adjust names)

```markdown
## Operations, backups and data protection — `ops/` (ops-kit)

This project runs on the ops-kit (`ops/README.md`). The rules below are
NOT optional and apply to every change:

- **Deploy path:** `ops/bin/deploy.sh <tier>` is the ONLY way code reaches a
  server (dump → fast-forward pull → build → migrate as the OWNER role →
  `ops/db/harden-privileges.sql` → named seeds only → nginx → health must
  report the deployed git sha). Never run migrations or seeds by hand on a
  server.
- **Two database roles.** The app connects as the restricted APP role
  (`DATABASE_URL`): SELECT/INSERT/UPDATE everywhere, DELETE only on the
  allow-list in `ops/db/harden-privileges.sql`, no DDL, audit tables
  append-only. Migrations/seeds use the OWNER role (`DATABASE_ADMIN_URL`).
  A new hard delete in application code REQUIRES adding the table to the
  allow-list — and first asking whether a soft delete is the right design.
- **Seeds never delete.** `ops/seeds/seeds.nodelete.test.js` fails the build
  on `.del()`/`.delete()`/`truncate`/`DELETE FROM`/`dropTable` in a seed;
  `seed-safe.js` runs each seed in one transaction and rolls back any file
  that would reduce a table's row count. Seeds only add or update.
- **Backups:** pgBackRest PITR (≤ 60 s RPO) + nightly dump + uploads + an
  encrypted config bundle + a git bundle of the code + the credentials
  escrow, all copied off-box (NAS, optional S3) ENCRYPTED, behind a shrink
  guard. Restore ONLY with `ops/bin/restore.sh` (scratch cluster first,
  `--swap` with typed confirmation). Two recovery scenarios, decided first:
  A = server still running → local copies, no data gap (DR §0-A); B =
  server gone/untrusted → rebuild on a new machine from the off-box copy
  alone (DR §3). Guides: `ops/docs/backup-restore.md`,
  `ops/docs/disaster-recovery.md` (RPO/RTO table + drill log).
- **Health endpoints are contract:** `/health` (with `git_sha`),
  `/health/ready`, `/health/backup` — the watchdog and deploy depend on them.
- **Monitoring:** `ops/bin/healthcheck.sh` every 2 min + the NAS-side
  `remote-probe.sh`; every backup/deploy failure mails
  (`ops/docs/monitoring-alerts.md`). A red check is a task, not noise.
- **Secrets:** `.env.deploy` (git-ignored) holds passwords + the three
  backup passphrases (config / data / repository cipher) — vault with two
  custodians + sealed envelope; never inside a backup or the escrow.
- **Credentials escrow:** app signing keys, store/push/cloud service
  accounts and the third-party account register are sealed by
  `ops/bin/escrow.sh` (`ops/docs/credentials-escrow.md`). Any new key or
  account → add to `ops/escrow.manifest` + the register, re-seal.
- **New data on disk** (a new volume, a new upload folder, a new external
  service) → decide how it is backed up BEFORE merging; update `ops.env`
  and the DR component table.
```
