# ops-kit adoption checklist

Work top to bottom; each block is a prerequisite of the next. Tick in the PR
that adopts the kit. `[decision]` = a choice to record, not a command.

## A. Repository (developer laptop)

- [ ] `cp -r ops-kit <repo>/ops`; commit.
- [ ] `cp ops/ops.env.example ops.env` and fill in: `OPS_SLUG`, `OPS_LABEL`, `OPS_TIERS`, services, health paths, `<TIER>_HOST/API_PORT/ENV_FILE/MIGRATE_CMD/SEED_CMD`, nginx site (or blank), `OPS_MASTERS_CMD` (or blank), `OPS_CODE_REMOTE`. Commit.
- [ ] `.gitignore`: add `.env.deploy`, `backups/`, `ops/postgres/conf.d/*.conf` (keep `!*.conf.example`), `.escrow/`, `restored-config/`, `restored-escrow/`.
- [ ] Compose: per tier, the Postgres service from `ops/compose/postgres.snippet.yml` (build `./ops/postgres`, archive settings, `/backups` + `/nas` + `conf.d` mounts); API gets `DATABASE_URL` (app role) + `DATABASE_ADMIN_URL` (owner role) + `GIT_SHA` build arg; volumes named as in `ops.env`.
- [ ] App: health routes (`ops/app/health.routes.snippet.js` or equivalent) — `/health` with `git_sha`, `/health/ready`, `/health/backup`.
- [ ] App: migrations connect with the OWNER url, runtime with the APP url (Knex: `KNEX_ADMIN=1` switch in the migrate/seed scripts).
- [ ] `ops/db/harden-privileges.sql`: list every table the app hard-deletes from; list the audit tables. `[decision]` which deletes should become soft deletes instead.
- [ ] Knex projects: copy `ops/seeds/seed-safe.js` to `backend/scripts/`, point `npm run seed` / `seed:one` at it, set `SEED_SENTINEL_TABLE`; copy the no-delete test next to the other tests.
- [ ] CI: `ops/ci/dependency-audit.yml` → `.github/workflows/`, `ops/ci/audit-ci.jsonc` into each package directory; set the matrix.
- [ ] Optional: a weekly master-data export job writing `<MASTER_EXPORT_DIR>/<date>/manifest.json` (+ CSV per master) and `OPS_MASTERS_CMD` to run it on demand.
- [ ] `ops/escrow.manifest` + `ops/docs/credentials-escrow.md` §3: keep only the keys the project has; add its own.
- [ ] Paste `ops/CLAUDE-SNIPPET.md` into the project's `CLAUDE.md`.

## B. Secrets and custodians `[decisions]`

- [ ] `cp ops/env.deploy.example .env.deploy && chmod 600 .env.deploy` on the server; fill DB/Redis passwords and SMTP.
- [ ] Generate the three passphrases (`openssl rand -base64 32` each): `BACKUP_CONFIG_PASSPHRASE`, `BACKUP_DATA_PASSPHRASE`, `BACKUP_REPO_CIPHER_PASS`.
- [ ] Vault entries for all three, shared with **two named custodians**; the same three printed into a **sealed, dated envelope** in the company safe. Record the custodians in `ops/docs/credentials-escrow.md` §5.
- [ ] Alert mailbox: a Workspace/SMTP account with an App Password; `ALERT_EMAIL_TO` = at least two people.

## C. Off-box storage `[decisions]`

- [ ] NAS share for backups, NFS-mounted on the server (`ops/docs/disaster-recovery.md` §2a/2b) — or the FTP fallback (§2c) if that is all the NAS team offers.
- [ ] **NAS snapshots of the share: daily, 30 days** — mandatory; the server's account must not be able to delete them. NAS admin password is NOT on the server.
- [ ] `[decision]` off-site copy: S3-compatible bucket with versioning + object lock (§2d) — recommended when the NAS is in the same room as the server. Record the decision either way.

## D. First bring-up (per tier, on the server)

- [ ] `ops/bin/deploy.sh <tier>` — green health with the deployed sha.
- [ ] `ops/bin/backup.sh <tier> init` — creates the stanza (encrypted if `BACKUP_REPO_CIPHER_PASS` is set before the first init), first full backup, dump, uploads, config, code, escrow, off-box copy; `status` shows `ok: true`, `repo_cipher: ["aes-256-cbc"]`, `files_encrypted: true`.
- [ ] Existing unencrypted repository? `ops/bin/backup.sh <tier> encrypt-repo` (brief DB stop), then `prune-plain` after 4 weeks.
- [ ] `ops/bin/backup.sh <tier> install-cron`.
- [ ] `ops/bin/healthcheck.sh <tier> test-mail` (a mail arrives) then `install-cron`; `status` shows every check OK.
- [ ] `ops/bin/escrow.sh init` → export every item in `ops/docs/credentials-escrow.md` §3 → `check` → `seal`.
- [ ] Remote probe on the NAS / another box: `ops/bin/remote-probe.sh` + `probe.env`, every 5 min (`ops/docs/monitoring-alerts.md` §2b).

## E. Prove it (before calling it done)

- [ ] `ops/bin/restore.sh <tier> --latest` → counts match live → `--cleanup`.
- [ ] `ops/bin/restore.sh <tier> --time "<30 min ago>"` → `now()` ≤ that time → `--cleanup`.
- [ ] `ops/bin/restore.sh <tier> --dump <newest .sql.gz.enc>` decrypts and loads → `--cleanup`.
- [ ] `ops/bin/backup.sh <tier> restore-config <newest bundle>` opens with the vault passphrase; delete `restored-config/`.
- [ ] `ops/bin/escrow.sh open <newest>` opens with the vault passphrase; delete `restored-escrow/`.
- [ ] `git clone <NAS>/<host>/code/<slug>-latest.bundle /tmp/x` works.
- [ ] Pull the network cable / stop the stack for 10 minutes: DOWN mail arrives (watchdog) and, for the stack stop, RECOVERED afterwards; stop the server itself once: the NAS probe mails.
- [ ] **Full rebuild drill on a spare VM from the off-box copy only** (`ops/docs/disaster-recovery.md` §3), timed; log it in §7 there.

## F. Recurring

- [ ] Quarterly: restore drill (E1–E5), NAS snapshot browse, escrow re-seal after `check`.
- [ ] Twice a year: the full rebuild drill (E8).
- [ ] Yearly: open the sealed envelope instead of the vault, then re-seal a fresh one; review the account register.
- [ ] On any custodian leaving: rotate passwords, re-seal escrow within 5 working days.
