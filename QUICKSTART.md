# Shreeja Transport Management — Quickstart Guide

## Project Structure

```
shreeja-optimizer/
├── backend/                  ← Node.js + Express API
│   ├── migrations/
│   │   ├── 001_base_schema.sql          ← All tables + seed data
│   │   └── 002_distance_and_optimizer.sql ← Distance master + optimizer
│   ├── src/
│   │   ├── app.js                        ← Express entry point
│   │   ├── config/db.js                  ← PostgreSQL pool
│   │   ├── config/migrate.js             ← Migration runner
│   │   ├── middleware/auth.js            ← JWT authenticate + authorize
│   │   └── routes/
│   │       ├── auth.js                   ← Login, users
│   │       ├── masters.js                ← Tankers, BMCUs, routes, locations
│   │       ├── plans.js                  ← Trip plans CRUD + Excel
│   │       ├── executions.js             ← Execution lifecycle
│   │       ├── reports.js                ← TS reports + email
│   │       ├── distances.js              ← Distance master CRUD + Excel
│   │       └── optimize.js               ← Clarke-Wright route optimizer
│   ├── .env.example
│   └── package.json
│
├── frontend/                 ← React 18 + Vite + Tailwind
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx                       ← Routes + role guards
│   │   ├── index.css                     ← Tailwind + custom utilities
│   │   ├── api/index.js                  ← All API calls (Axios)
│   │   ├── hooks/useAuth.js              ← Auth context
│   │   ├── components/
│   │   │   ├── Layout.jsx
│   │   │   ├── Sidebar.jsx
│   │   │   └── MasterTable.jsx           ← Shared UI components
│   │   └── pages/
│   │       ├── Login.jsx / Dashboard.jsx
│   │       ├── masters/
│   │       │   ├── TankerMaster.jsx
│   │       │   ├── BmcuMaster.jsx
│   │       │   ├── RouteMaster.jsx
│   │       │   ├── LocationMasters.jsx
│   │       │   ├── DistanceMaster.jsx
│   │       │   ├── UserManagement.jsx
│   │       │   └── EmailConfig.jsx
│   │       ├── planning/
│   │       │   ├── TripPlanList.jsx
│   │       │   ├── TripPlanForm.jsx
│   │       │   └── RouteOptimizer.jsx
│   │       ├── execution/
│   │       │   ├── ExecutionList.jsx
│   │       │   ├── ExecutionForm.jsx
│   │       │   ├── AcknowledgementForm.jsx
│   │       │   └── ClosedTrips.jsx
│   │       └── reports/
│   │           └── DailyTSReport.jsx
│   ├── index.html
│   ├── vite.config.js
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   └── package.json
│
└── deploy/
    ├── deploy.sh             ← Ubuntu 22.04 one-command deploy
    └── backup.sh             ← Daily DB backup (add to cron)
```

---

## Local Development Setup

### Prerequisites
- Node.js 18+ 
- PostgreSQL 14+
- npm

### Step 1 — Database

```bash
# Create database
psql -U postgres
CREATE DATABASE dairy_transport;
\q
```

### Step 2 — Backend

```bash
cd backend
cp .env.example .env
# Edit .env — set DB_PASSWORD, JWT_SECRET (any random string)
npm install
node src/config/migrate.js    # runs both SQL migrations
npm run dev                    # starts on http://localhost:5000
```

Verify: `curl http://localhost:5000/api/health` → `{"ok":true}`

### Step 3 — Frontend

```bash
cd frontend
npm install
npm run dev                   # starts on http://localhost:5173
```

Open `http://localhost:5173` → Login with `admin` / `Admin@1234`

---

## Production Deploy (Ubuntu 22.04)

```bash
# 1. Upload deploy script
scp deploy/deploy.sh root@YOUR_SERVER_IP:/root/

# 2. Edit the script — set DOMAIN, SMTP_USER, SMTP_PASS at the top
ssh root@YOUR_SERVER_IP
nano /root/deploy.sh

# 3. Phase 1 — installs Node, PostgreSQL, Nginx, PM2
sudo bash /root/deploy.sh

# 4. Upload project files
scp -r ./backend  root@YOUR_SERVER_IP:/opt/shreeja/
scp -r ./frontend root@YOUR_SERVER_IP:/opt/shreeja/

# 5. Phase 2 — build, migrate, start
sudo bash /root/deploy.sh --continue
```

That's it. Visit `http://YOUR_SERVER_IP` (or your domain with SSL).

### Set Up Daily Backups

```bash
# On the server:
crontab -e
# Add this line:
0 2 * * * /opt/shreeja/deploy/backup.sh >> /opt/shreeja/logs/backup.log 2>&1
```

---

## First-Time Setup Checklist

After deploying, do this in order:

1. **Login** → `admin` / `Admin@1234` → **change the password immediately** (Users → Edit)
2. **Masters → Tankers** → Add all tankers with capacity and ₹/km rate
3. **Masters → BMCUs** → Add all BMCUs with district and state (needed for optimizer fallbacks)
4. **Masters → Locations** → Add starting depots and delivery plants
5. **Masters → Distance Master** → Click Template → fill all BMCU-to-BMCU distances → Upload
6. **Masters → Routes** → Define standard routes (optional — optimizer creates ad-hoc routes)
7. **Masters → Email Config** → Add report recipients (admin only)
8. **Masters → Users** → Create planner and executor accounts

---

## Day-to-Day Workflow

### Planning (Planner role)

**Manual:**
1. Planning → New Plan → select tanker, route, BMCUs, expected qty
2. Planning → (set date filter) → Publish Drafts → executors can now see them

**Optimized:**
1. Planning → Route Optimizer
2. Step 1: Set date, plant, depot, strategy
3. Step 2: Select BMCUs and enter expected quantities
4. Step 3: Review generated trips, override tanker/km if needed, reject any trip
5. Click "Save as Draft Plans" → trips appear in Planning list
6. Review in Planning → Publish

### Execution (Executor role)

1. Execution → Active Trips → select date → Start (creates execution from plan)
2. Enter data row by row: milk date, shift, litres, fat%, SNF%, chamber, DPS reading
3. Save → Submit for Acknowledgement
4. Acknowledgement → enter per-chamber quantities from plant scale

### Reports (Any role)

1. Reports → Daily TS Report → set date range → Load Report
2. Green = small variation, Red = large variation (>0.5 unit threshold)
3. Click Excel to download, Email to send to all active recipients

---

## Default Login

| Username | Password   | Role  |
|----------|------------|-------|
| admin    | Admin@1234 | Admin |

---

## Key Business Rules

- **Litres → Kgs**: `kgs = litres × 1.0285`
- **Kg Fat**: `kg_fat = fat_pct × kgs / 100`
- **Trip cost**: `total_cost = expected_km × per_km_rate`
- **Balance Milk rows** are excluded from TS totals
- **TS Variation** = Acknowledgement − Truck Sheet

## Trip Status Flow

```
Plans:      draft → published → (cancelled)
Executions: in_progress → saved → pending_ack → closed
```

---

## Troubleshooting

**Backend won't start:**
```bash
sudo -u shreeja pm2 logs shreeja-backend --lines 50
# Most common: wrong DB_PASSWORD in .env, or migrations not run
```

**Frontend shows blank page:**
```bash
sudo nginx -t
sudo journalctl -u nginx -n 50
# Most common: frontend dist not copied to /opt/shreeja/frontend-build/
```

**Can't login (admin/Admin@1234 fails):**
```bash
# Re-seed the admin user
psql -U shreeja_db -d dairy_transport -c "
SELECT id, username, is_active FROM users WHERE username='admin';
"
# If missing, run migration 001 again
```

**Emails not sending:**
```bash
# Check SMTP config in .env — must use Gmail App Password, not account password
# Gmail: Account → Security → 2FA must be ON → App Passwords
```
