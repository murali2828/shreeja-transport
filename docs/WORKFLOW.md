# Shreeja TMS — Workflow

How code gets from a laptop (or the Claude sandbox) to tms.shreejamilk.com.
Environment matrix and one-time server setup: [`ENVIRONMENTS.md`](./ENVIRONMENTS.md).
Backups: [`BACKUP_RESTORE_STRATEGY.md`](./BACKUP_RESTORE_STRATEGY.md).

## Local setup from zero

Prerequisites: Node 20 (`engines >=18`), npm, Postgres 16 (local install or Docker), git.

```bash
git clone https://github.com/murali2828/shreeja-transport.git && cd shreeja-transport
git checkout qa

# database (once)
psql -U postgres -c "CREATE DATABASE dairy_transport;"

# backend
cd backend && npm ci
cp .env.example .env             # backend/.env.example is the local-dev template (dotenv reads backend/.env)
#   set DB_USER/DB_PASSWORD, JWT_SECRET (>= 32 chars, or the app refuses to start)
npm run migrate                  # node src/config/migrate.js — applies backend/migrations/*.sql
npm run dev                      # nodemon on http://localhost:5000

# frontend (second terminal)
cd frontend && npm ci
npm run dev                      # Vite on http://localhost:5173, proxies /api to :5000
```

First login: migration 001 seeds `admin` / `Admin@1234`; migration 027 sets
`must_change_password` on that account while it still carries the seeded hash, so the
first login forces a new password.

Optional locally: `BILLING_ENABLED=true` to mount `/api/billing`; leave Google, WheelsEye,
Assure and SMTP blank — every integration degrades to "disabled/estimated".

## Running and debugging

- Backend logs every request and every query with timing when `NODE_ENV !== 'production'`.
- `GET /api/health` → `{ ok: true }`; `GET /api/tracking/status` (JWT) → poller health;
  `GET /api/integrations/assure/ping` (X-Assure-Key) → feed version.
- Migrations print `[migrate] RUN|SKIP|OK|FAIL <file>`; a failed file rolls back and
  aborts startup — fix the SQL, do not mark it applied by hand.
- Import masters from Excel: `EXCEL_PATH=/path/TMS_Master.xlsx node backend/scripts/import_masters.js`.
- Frontend: TanStack Query devtools are not installed; inspect `localStorage.token` / `user`.

## Build and check commands

| Purpose | Command |
|---|---|
| Backend syntax check (per changed file) | `node -c backend/src/<file>.js` |
| Backend syntax check (all, what CI does) | `cd backend && node -e "const fs=require('fs'),cp=require('child_process');function walk(d){for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=d+'/'+f.name;if(f.isDirectory())walk(p);else if(f.name.endsWith('.js'))cp.execSync('node -c '+p);}}walk('src')"` |
| Frontend production build | `cd frontend && npx vite build --logLevel error` (output `frontend/dist/`, git-ignored) |
| Frontend preview of the build | `cd frontend && npm run preview` |

There is no automated test suite, lint or type check. CI (`.github/workflows/ci.yml`)
runs exactly the two checks above on push/PR to `qa` and `main`.

## Branching and review rules

- `qa` is the integration branch and deploys to QA; `main` is production and only ever
  receives what `qa` already has (fast-forward or merge from `qa`).
- Day-to-day work is committed directly on `qa` (feature branches + PRs into `qa` are
  welcome for larger pieces, per `ENVIRONMENTS.md`). Never commit directly on `main`.
- Commits: small, imperative subject that names the module ("Billing: …",
  "Migration 043: …"); body explains the business reason. Required trailer lines are
  given per session (`Co-Authored-By`, `Claude-Session`) and must be the last lines.
- Never rewrite history on `qa` or `main` (`push --force` is blocked in
  `.claude/settings.json`).
- Push after every logical step so work survives an interrupted session.

## Release and deploy

1. Push to `origin qa`. CI must be green.
2. Operator deploys QA on the server (checkout `~/shreeja-qa`):
   ```bash
   git fetch origin && git checkout qa && git pull origin qa
   docker compose -p shreeja-qa -f docker-compose.qa.yml --env-file .env.qa up -d --build
   ```
3. User performs UAT on https://qatms.shreejamilk.com.
4. Promote: fast-forward `qa` into `main` (`/promote-to-main` slash command prints the safe
   sequence; the user approves the push to `main`).
5. Operator deploys PROD on the server (checkout `~/shreeja-transport`):
   ```bash
   git fetch origin && git checkout main && git pull origin main
   docker compose -p shreeja-transport -f docker-compose.yml --env-file .env up -d --build
   ```
   TODO(verify): `ENVIRONMENTS.md` shows the plain `docker compose up -d --build` form
   (default project name); the compose project name must match whatever the running
   stack was created with, otherwise a second stack is created beside the first.
6. Watch `docker logs -f shreeja-backend` for `[migrate]` lines and `[server]` start,
   then hit `/api/health` through the domain.

The backend image runs migrations on every start, so a deploy that adds a migration needs
nothing extra. A new env variable must be added to the server's `.env` / `.env.qa`
(and to `.env.example` / `.env.qa.example` in git) before the deploy.

## Rollback

- Code: `git checkout <previous sha or tag>` on the server and re-run the compose `up
  --build` command. Migrations are forward-only; if the bad release added a migration,
  write a new corrective migration rather than deleting the row from `schema_migrations`.
- Data: `deploy/restore.sh db <tier> --latest` restores to a scratch DB for inspection;
  `--swap` replaces the live DB with typed confirmation. Full runbook in
  `BACKUP_RESTORE_STRATEGY.md` section 4.
- Feature flags are the fastest rollback for billing (`BILLING_ENABLED`), tracking
  (`WHEELSEYE_ACCESS_TOKEN` blank) and the Assure feed (`ASSURE_API_KEY` blank): edit the
  env file and `docker compose … up -d` (no rebuild needed).

## Secrets and configuration

- Real values live only in the server's `.env` (prod) and `.env.qa` (QA) and in
  `deploy/backup.env`; all three are git-ignored. Templates: `.env.example`,
  `.env.qa.example`, `deploy/backup.env.example`.
- Generate secrets with `openssl rand -base64 32` (JWT) / `openssl rand -hex 32` (Assure).
  QA and PROD must use different `JWT_SECRET`, DB passwords and API keys.
- After any secret change: `deploy/backup.sh config && deploy/backup.sh mirror`.
- Key rotation for Assure uses `ASSURE_API_KEY_NEXT` (both accepted while set).
- Never paste live tokens into commits, tickets, chat or docs; the code never logs them.
