# ops-kit — backup, restore, monitoring and deploy for a Docker + Postgres app

A copy-in folder that gives any project the same operational guarantees the
Shreeja Assure platform runs on. Drop it into a repository as `ops/`, write
one `ops.env`, and the project has:

| Guarantee | How |
|---|---|
| **Point-in-time database recovery** to any second in a 4-week window | pgBackRest inside the Postgres container: continuous WAL archiving (≤ 60 s) + nightly base backups; local repo + NAS repo + optional S3 repo |
| **Every copy leaves the server encrypted** | repository cipher (AES-256-CBC), encrypted dumps / master exports / config bundle / credentials escrow — three passphrases held by two custodians + a sealed envelope |
| **A wiped or ransomed server cannot destroy its own backups** | off-box **shrink guard** (a mirror is refused when the local set shrank unexpectedly) + mandatory NAS snapshots + optional S3 object lock |
| **Rebuild on a new machine in under an hour — from the off-box copy alone, even with no internet** | the encrypted config bundle (env files, SSH keys, TLS, nginx), a nightly `git bundle` of the code, a nightly `docker save` of the built images, the uploads mirror, weekly mobile build artefacts, one runbook |
| **The application cannot delete master data** | a restricted runtime DB role (no DELETE/TRUNCATE/DDL except an allow-list), seeds that cannot shrink a table, one deploy path that dumps first |
| **Someone is told within minutes** when anything is down, stale, unencrypted or missing | host watchdog every 2 min (≈ 25 checks, transition-based e-mail) + a probe on the NAS that notices a dead server |
| **The keys no backup covers are escrowed** | app signing keys, store / push / cloud service accounts and the account register in an encrypted bundle that travels with the backups |
| **New CVEs block merges** | a dependency-audit CI workflow per npm package |

Everything is plain bash + python3 + docker on the host, Postgres 14+ and
pgBackRest in the DB image. No agents, no SaaS, no vendor lock-in.

## Layout

```
ops/
  ops.env.example        project identity + per-tier settings  → copy to <repo>/ops.env (committed)
  env.deploy.example     secrets                               → copy to <repo>/.env.deploy (git-ignored, chmod 600)
  bin/                   backup.sh · restore.sh · deploy.sh · healthcheck.sh · escrow.sh · mail.sh · remote-probe.sh · lib.sh
  postgres/              Dockerfile (+pgBackRest), pgbackrest.conf, conf.d/{nas,s3}-repo.conf.example
  tools/                 tiny helper image (rsync, openssl, lftp) used by the scripts
  compose/               the postgres + api service blocks to paste into each docker-compose.<tier>.yml
  db/harden-privileges.sql   restricted app role (edit the DELETE allow-list for your schema)
  app/health.routes.snippet.js   /health, /health/ready, /health/backup for an Express app
  seeds/                 seed-safe.js (transactional, no-shrink) + seeds.nodelete.test.js (Knex projects)
  ci/                    dependency-audit.yml + audit-ci.jsonc
  escrow.manifest        what the credentials escrow must contain (edit per project)
  verify.sql.example     optional post-restore verification query
  docs/                  backup-restore · disaster-recovery · monitoring-alerts · credentials-escrow
  SETUP-CHECKLIST.md     the adoption checklist, in order
  CLAUDE-SNIPPET.md      the paragraph to paste into the project's CLAUDE.md
```

## Adoption in one screen

```bash
cp -r /path/to/ops-kit  <repo>/ops
cp ops/ops.env.example ops.env            # edit: slug, tiers, hosts, services, commands
cp ops/env.deploy.example .env.deploy && chmod 600 .env.deploy   # edit: passwords, passphrases, SMTP
# compose: use ops/postgres as the DB image with the archive settings (ops/compose/postgres.snippet.yml)
# app:     mount ops/app/health.routes.snippet.js; migrations run as the OWNER role, the app as the APP role
# then, per tier, on the server:
ops/bin/deploy.sh qa                      # build, migrate, harden, health
ops/bin/backup.sh qa init                 # stanza (+NAS repo2, cipher), first full backup, all copies
ops/bin/backup.sh qa install-cron
ops/bin/healthcheck.sh qa test-mail && ops/bin/healthcheck.sh qa install-cron
ops/bin/escrow.sh init                    # fill .escrow/, then: escrow.sh check && escrow.sh seal
ops/bin/restore.sh qa --latest && ops/bin/restore.sh qa --cleanup   # the first drill
```

Full sequence with the decisions and the NAS/S3 side: **`SETUP-CHECKLIST.md`**.
The complete to-do for a new project — decisions, day-by-day steps, the
instruction block to hand to Claude Code, per-stack adaptations, acceptance
criteria, the recurring calendar: **`ADOPTION-PLAYBOOK.md`**.

## Conventions the kit assumes (all overridable in ops.env)

- One compose file per tier named `docker-compose.<tier>.yml` with project
  `name: <slug>-<tier>`, volumes `<tier>_pgdata` and `<tier>_uploads`.
- Two DB roles per tier: owner `<slug>_<tier>_user` (migrations, backups) and
  app `<slug>_<tier>_app` (runtime). Secrets in `.env.deploy` as
  `<TIER>_DB_PASS` / `<TIER>_DB_APP_PASS` / `<TIER>_REDIS_PASS`.
- Branch per tier: `qa` deploys `qa`, `prod` deploys `main`.
- A health endpoint returning the running git sha; the API image takes a
  `GIT_SHA` build arg.
- Migrations/seeds are npm scripts run inside the API container (any command
  works — set `<TIER>_MIGRATE_CMD` / `<TIER>_SEED_CMD`).

## What is project-specific (you must edit)

`ops.env`, `.env.deploy`, the DELETE allow-list in `db/harden-privileges.sql`,
`escrow.manifest` + `docs/credentials-escrow.md` §3 (which keys your project
actually has), optionally `verify.sql`, and the matrix in `ci/dependency-audit.yml`.

## Not covered

- **MySQL / MariaDB projects:** everything except the database layer applies.
  Replace pgBackRest with Percona XtraBackup (or `mariabackup`) + binary-log
  shipping; `backup.sh`'s `pgb`/`sql` helpers and `restore.sh`'s PITR branch
  are the only parts to swap.
- Kubernetes; managed databases (use the provider's PITR and keep the rest).
- Application-level data validation — the kit protects against loss, not
  against wrong data written by the app.

Reference implementation: the Shreeja Assure repository (`deploy/` there is
this kit's origin, with the same guarantees under project-specific names).
