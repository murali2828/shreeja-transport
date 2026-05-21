# Shreeja Secondary Transport Management System

> Full-stack web application for managing dairy milk secondary transport operations — trip planning, daily execution data entry, delivery acknowledgement, and TS variation reporting.

Styled to match the **Shreeja Platform** — sky-blue gradient UI, frosted glass cards, translucent sidebar.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 20, Express 4, PostgreSQL 16 |
| Auth | JWT (8h expiry), bcrypt password hashing |
| Frontend | React 18, Vite, Tailwind CSS, TanStack Query v5 |
| Process | PM2 |
| Web Server | Nginx |
| OS | Ubuntu 22.04 LTS |

---

## Modules

| Module | Description |
|--------|-------------|
| **Masters** | Tankers, BMCUs, Routes, Locations, Distance Master, Users |
| **Trip Planning** | Manual + Clarke-Wright Route Optimizer (distance-matrix based) |
| **Execution** | BMCU-level data entry (litres → kgs auto, fat%, SNF%, DPS, chambers) |
| **Acknowledgement** | Per-chamber (FC/MC/BC) ack at plant |
| **TS Report** | Daily DPS vs Truck Sheet vs Acknowledgement variation report |

---

## Business Logic

- `kgs = litres × 1.0285`
- `kg_fat = fat_pct × kgs / 100`
- `kg_snf = snf_pct × kgs / 100`
- `total_cost = expected_km × per_km_rate`
- Balance Milk rows excluded from totals
- TS Variation = Acknowledgement − Truck Sheet

## Trip Lifecycle

```
Plans:      draft → published → cancelled
Executions: in_progress → saved → pending_ack → closed
```

---

## Quick Start (Local Development)

```bash
# 1. Database
psql -U postgres -c "CREATE DATABASE dairy_transport;"

# 2. Backend
cd backend
cp .env.example .env      # fill in DB_PASSWORD and JWT_SECRET
npm install
node src/config/migrate.js
npm run dev               # http://localhost:5000

# 3. Frontend
cd frontend
npm install
npm run dev               # http://localhost:5173
```

Login: `admin` / `Admin@1234`

---

## Production Deployment (Ubuntu 22.04)

```bash
# Upload and run deploy script
scp deploy/deploy.sh root@YOUR_SERVER:/root/
ssh root@YOUR_SERVER "bash /root/deploy.sh"

# Upload code
scp -r backend frontend deploy root@YOUR_SERVER:/opt/shreeja/

# Build and start
ssh root@YOUR_SERVER "bash /root/deploy.sh --continue"
```

See [PRODUCTION_DEPLOYMENT_GUIDE.md](./PRODUCTION_DEPLOYMENT_GUIDE.md) for full details.

---

## Roles

| Role | Access |
|------|--------|
| `admin` | Full access to all modules |
| `planner` | Masters, Trip Planning, Reports |
| `executor` | Execution data entry, Reports |

---

## Folder Structure

```
├── backend/           Node.js + Express API
│   ├── migrations/    SQL schema files
│   └── src/
│       ├── routes/    7 route files
│       ├── config/    DB pool + migration runner
│       └── middleware/ JWT auth
├── frontend/          React 18 + Vite
│   └── src/
│       ├── pages/     17 page components
│       ├── components/ Layout, Sidebar, shared UI
│       └── api/       Single Axios instance
└── deploy/            Ubuntu 22.04 deploy + backup scripts
```

---

*Shreeja Transport Management System — built for Shreeja Dairy Operations*
