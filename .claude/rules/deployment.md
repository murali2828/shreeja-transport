---
paths:
  - "Dockerfile"
  - "**/Dockerfile"
  - "docker-compose*"
  - "**/deploy/**"
  - "frontend/nginx.conf"
  - ".github/workflows/**"
---
# Deployment rules

- Two tiers on one server: QA (`docker-compose.qa.yml`, `.env.qa`, project `shreeja-qa`,
  port 8081, branch `qa`) and PROD (`docker-compose.yml`, `.env`, project `shreeja-transport`,
  port 8080, branch `main`). Keep both compose files in step when changing a service.
- Nobody runs docker, psql or deploy scripts from the dev sandbox. Print the operator's
  commands (`/deploy-commands qa|prod`) instead of executing them.
- Never suggest `docker compose down -v`, volume deletion or `git push --force`; the
  named volumes `shreeja-pgdata`, `shreeja-docuploads` (and `shreeja-qa-*`) are the data.
- The backend image CMD is `node src/config/migrate.js && node src/app.js`; a failing
  migration keeps the container restarting — that is intended, fix forward.
- Env changes need only `up -d`; code changes need `up -d --build`. New env vars must be
  added to `.env.example` and `.env.qa.example` in the same commit.
- `frontend/nginx.conf` sends `Cache-Control: no-cache` for `index.html` and long cache for
  hashed assets; keep the security headers repeated in every `location` that adds headers.
- Healthchecks: backend `wget /api/health`, db `pg_isready`; frontend depends on a healthy
  backend. Keep `/api/health` free of auth and DB calls.
- Host nginx (`deploy/reverse-proxy.conf.example`) terminates TLS; `app.set('trust proxy', 1)`
  relies on it, so do not add another proxy layer without updating that.
- `deploy/deploy.sh` is the legacy PM2/Nginx installer (pre-Docker); do not extend it.
  `deploy/backup.sh` / `restore.sh` are live tooling — changes must keep the drill in
  `docs/BACKUP_RESTORE_STRATEGY.md` valid.
- CI (`.github/workflows/ci.yml`) is syntax check + build only; do not add steps that need
  secrets.
