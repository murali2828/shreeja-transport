---
description: Print the operator's deploy commands for qa or prod (never runs them)
---
Print, do not execute, the server-side commands for the tier given in `$ARGUMENTS` (`qa` or `prod`;
if missing or anything else, ask which tier). Nobody runs docker from this sandbox.

For **qa** (server checkout `~/shreeja-qa`, https://qatms.shreejamilk.com):
```bash
cd ~/shreeja-qa
git fetch origin && git checkout qa && git pull --ff-only origin qa
docker compose -p shreeja-qa -f docker-compose.qa.yml --env-file .env.qa up -d --build
docker logs -f --tail 100 shreeja-qa-backend      # wait for "[migrate] All migrations complete." and "[server] ..."
curl -s http://127.0.0.1:8081/api/health
```

For **prod** (server checkout `~/shreeja-transport`, https://tms.shreejamilk.com):
```bash
cd ~/shreeja-transport
git fetch origin && git checkout main && git pull --ff-only origin main
docker compose -p shreeja-transport -f docker-compose.yml --env-file .env up -d --build
docker logs -f --tail 100 shreeja-backend         # wait for "[migrate] All migrations complete." and "[server] ..."
curl -s http://127.0.0.1:8080/api/health
```

Then add, from the current diff between the deployed branch and its previous state:
- new migrations (`backend/migrations/`) that will run on start;
- new or changed env vars in `.env.example` / `.env.qa.example` the operator must add to the tier's env file before `up -d`;
- a reminder: env-only changes need `up -d` without `--build`; never `down -v`; after a secret change run `deploy/backup.sh config && deploy/backup.sh mirror`.
Point to `docs/RUNBOOK.md` for health checks and rollback.
