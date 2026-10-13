---
description: Print the operator's deploy commands for qa or prod (never runs them)
---
Print, do not execute, the server-side commands for the tier given in `$ARGUMENTS` (`qa` or `prod`;
if missing or anything else, ask which tier). Nobody runs docker from this sandbox.

Deploys go through the ops-kit (`ops/bin/deploy.sh`): encrypted dump first, fast-forward pull,
build of backend + frontend (the database is left running), migrations, health check that the
site reports the deployed git sha. It needs `.env.deploy` in the checkout
(`docs/BACKUP_RESTORE_STRATEGY.md` §3). If the tier has not been brought up on the kit yet,
print that section's bring-up steps instead.

For **qa** (server checkout `~/shreeja-qa`, https://qatms.shreejamilk.com):
```bash
cd ~/shreeja-qa && ops/bin/deploy.sh qa
```

For **prod** (server checkout `~/shreeja-transport`, https://tms.shreejamilk.com):
```bash
cd ~/shreeja-transport && ops/bin/deploy.sh prod
```

Then add, from the current diff between the deployed branch and its previous state:
- new migrations (`backend/migrations/`) that will run;
- new or changed env vars in `.env.example` / `.env.qa.example` the operator must add to the tier's env file first;
- `--rebuild-db` only when `ops/postgres/` changed (the database restarts — quiet hour);
- reminders: env-only changes need `docker compose -p <project> -f <file> --env-file <env> up -d` without `--build`; never `down -v`; after a secret change `ops/bin/backup.sh <tier> config`.
Point to `docs/RUNBOOK.md` for health checks and `docs/BACKUP_RESTORE_STRATEGY.md` §4 for rollback.
