# Environments: QA & Production

Shreeja TMS runs as two isolated stacks on the same server, each mapped to its
own domain and its own git branch. Changes are validated in **QA** before they
reach **Production**.

| | Production | QA / staging |
|---|---|---|
| URL | https://tms.shreejamilk.com | https://qatms.shreejamilk.com |
| Git branch | `main` | `qa` |
| Compose file | `docker-compose.yml` | `docker-compose.qa.yml` |
| Env file | `.env` | `.env.qa` |
| Host port | 8080 | 8081 |
| DB name | `dairy_transport` | `dairy_transport_qa` |
| Docker volume | `shreeja-pgdata` | `shreeja-qa-pgdata` |
| Compose project | `shreeja` (default) | `shreeja-qa` |

The two stacks share nothing — separate database, volume, network and containers —
so QA testing can never touch production data.

## Branch → environment flow

```
feature/*  ──PR──▶  qa  ──(test on qatms)──▶  PR ──▶  main  ──▶ deploy to tms
```

1. Do work on a `feature/*` branch.
2. Open a PR into **`qa`**. Merge → deploy QA → test on qatms.shreejamilk.com.
3. When QA passes, open a PR from **`qa`** into **`main`**. Merge → deploy Production.

Never commit directly to `main`. `main` only ever receives changes that already
passed QA.

## One-time server setup

1. **DNS:** add an `A` record for `qatms.shreejamilk.com` → server public IP.
2. **Reverse proxy:** install the host nginx config that routes both domains —
   see `deploy/reverse-proxy.conf.example`. Then issue TLS certs with certbot.
3. **QA env file:** `cp .env.qa.example .env.qa` and fill in QA values (use a
   separate DB password, JWT secret, and ideally a test email inbox).

## Deploy commands (run on the server)

**QA:**
```bash
git fetch origin
git checkout qa && git pull origin qa
docker compose -p shreeja-qa --env-file .env.qa -f docker-compose.qa.yml up -d --build
```

**Production:**
```bash
git fetch origin
git checkout main && git pull origin main
docker compose up -d --build      # uses docker-compose.yml + .env
```

Database migrations (including `011_trip_distance.sql`) run automatically when the
backend container starts (see `backend/Dockerfile`).

## Notes

- **Seeding QA data:** QA starts with an empty database. Create masters/plans in QA
  to test, or restore a sanitized copy of production if you want realistic data.
- **Google Maps key:** QA can use the same `GOOGLE_MAPS_API_KEY` as production — the
  road-distance results are cached into each environment's Distance Master, so usage
  stays within the free monthly cap. Use a test SMTP inbox in QA to avoid emailing
  real vendors during testing.
