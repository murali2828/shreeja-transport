# Shreeja Secondary Transport Management System
## Complete Production Build & Deployment Guide
### For: Bindra Development Team

---

## ANSWER TO YOUR QUESTION

**Yes — absolutely.** All required components to build the production application have been provided across our conversation. This document consolidates everything your team needs: what files exist, where each one goes, and the exact commands to run in order.

---

## SECTION 1 — WHAT HAS BEEN PROVIDED

### 1.1 Complete File Inventory

Every file below has been generated and is available for download from the Claude conversation outputs.

```
shreeja-optimizer/                        ← ROOT OF PROVIDED CODE
│
├── backend/                              ← Node.js + Express API Server
│   ├── .env.example                      ← Environment variable template
│   ├── package.json                      ← All Node dependencies listed
│   ├── migrations/
│   │   ├── 001_base_schema.sql           ← ALL database tables + seed data
│   │   └── 002_distance_and_optimizer.sql← Distance master + optimizer tables
│   └── src/
│       ├── app.js                        ← Express entry point (registers all routes)
│       ├── config/
│       │   ├── db.js                     ← PostgreSQL connection pool
│       │   └── migrate.js                ← Migration runner (auto-runs SQL files)
│       ├── middleware/
│       │   └── auth.js                   ← JWT authentication + role authorization
│       └── routes/
│           ├── auth.js                   ← Login, user management
│           ├── masters.js                ← Tankers, BMCUs, routes, locations
│           ├── plans.js                  ← Trip plan CRUD + Excel upload/download
│           ├── executions.js             ← Execution lifecycle + acknowledgements
│           ├── reports.js                ← TS report + Excel export + email send
│           ├── distances.js              ← Distance master CRUD + Excel bulk upload
│           └── optimize.js               ← Clarke-Wright route optimizer
│
├── frontend/                             ← React 18 + Vite + Tailwind CSS
│   ├── index.html                        ← Vite HTML entry point
│   ├── package.json                      ← All React dependencies
│   ├── vite.config.js                    ← Vite build config + /api proxy
│   ├── tailwind.config.js                ← Brand colors + typography
│   ├── postcss.config.js                 ← PostCSS for Tailwind
│   ├── public/
│   │   └── favicon.svg                   ← App icon
│   └── src/
│       ├── main.jsx                      ← React entry + AuthProvider wrap
│       ├── App.jsx                       ← All routes + role guards
│       ├── index.css                     ← Tailwind + all utility classes
│       ├── api/
│       │   └── index.js                  ← All API calls (single Axios instance)
│       ├── hooks/
│       │   └── useAuth.js                ← Auth context + localStorage
│       ├── components/
│       │   ├── Layout.jsx                ← Page shell with sidebar
│       │   ├── Sidebar.jsx               ← Navigation + role-based links
│       │   └── MasterTable.jsx           ← Shared Modal/Field/Button components
│       └── pages/
│           ├── Login.jsx                 ← Login page
│           ├── Dashboard.jsx             ← Stats + today's plans overview
│           ├── masters/
│           │   ├── TankerMaster.jsx      ← Tanker CRUD
│           │   ├── BmcuMaster.jsx        ← BMCU CRUD with search/filter
│           │   ├── RouteMaster.jsx       ← Route CRUD with BMCU sequence editor
│           │   ├── LocationMasters.jsx   ← Start/Test/Delivery points (tabbed)
│           │   ├── DistanceMaster.jsx    ← Distance master + Excel bulk upload
│           │   ├── UserManagement.jsx    ← User CRUD (admin only)
│           │   └── EmailConfig.jsx       ← Report email recipients
│           ├── planning/
│           │   ├── TripPlanList.jsx      ← Plans list + publish + Excel upload
│           │   ├── TripPlanForm.jsx      ← Create/edit plan with BMCU sequence
│           │   └── RouteOptimizer.jsx    ← 3-step optimizer wizard
│           ├── execution/
│           │   ├── ExecutionList.jsx     ← Start executions from published plans
│           │   ├── ExecutionForm.jsx     ← BMCU data entry (litres, fat, SNF)
│           │   ├── AcknowledgementForm.jsx← Per-chamber ack entry + close trip
│           │   └── ClosedTrips.jsx       ← Date-range view of closed trips
│           └── reports/
│               └── DailyTSReport.jsx     ← DPS vs TS vs Ack variation report
│
└── deploy/
    ├── deploy.sh                         ← Ubuntu 22.04 one-command deploy script
    └── backup.sh                         ← Daily DB backup script (add to cron)
```

### 1.2 Technology Stack Summary

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| Runtime | Node.js | 20.x LTS | Backend JavaScript runtime |
| API Framework | Express | 4.18 | HTTP routing, middleware |
| Database | PostgreSQL | 16 | Primary data store |
| DB Client | pg (node-postgres) | 8.11 | PostgreSQL connection pool |
| Authentication | JSON Web Tokens | 9.0 | Stateless auth (8h expiry) |
| Password Hashing | bcrypt | 5.1 | Secure password storage |
| File Upload | Multer | 1.4 | Excel file handling |
| Excel Processing | xlsx | 0.18 | Read/write .xlsx files |
| Email | Nodemailer | 6.9 | Send TS reports via Gmail |
| Security | Helmet | 7.1 | HTTP security headers |
| Frontend Framework | React | 18.3 | UI components |
| Build Tool | Vite | 5.2 | Frontend bundler |
| Styling | Tailwind CSS | 3.4 | Utility-first CSS |
| Routing | React Router | v6 | Client-side navigation |
| Data Fetching | TanStack Query | v5 | Server state management |
| HTTP Client | Axios | 1.6 | API calls from frontend |
| Icons | Lucide React | 0.378 | UI icons |
| Notifications | react-hot-toast | 2.4 | Toast messages |
| Web Server | Nginx | Latest | Reverse proxy + static files |
| Process Manager | PM2 | Latest | Node.js process management |
| OS | Ubuntu | 22.04 LTS | Production server OS |

---

## SECTION 2 — SERVER REQUIREMENTS

### 2.1 Minimum Specification

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 1 vCPU | 2 vCPUs |
| RAM | 1 GB | 2 GB |
| Disk | 20 GB SSD | 40 GB SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |
| Network | 100 Mbps | 1 Gbps |

> **For Shreeja's usage pattern (< 50 concurrent users, daily batch operations):
> a 2 vCPU / 2 GB RAM VPS from any provider (DigitalOcean, AWS Lightsail,
> Hetzner, Azure, etc.) is more than sufficient.**

### 2.2 Ports Required

| Port | Service | Notes |
|------|---------|-------|
| 22 | SSH | For server access — restrict to your IP |
| 80 | HTTP | Nginx — redirects to HTTPS |
| 443 | HTTPS | Nginx — main application (if SSL configured) |
| 5000 | Node.js | Internal only — NOT exposed to internet |
| 5432 | PostgreSQL | Internal only — NOT exposed to internet |

### 2.3 Domain Name (Optional but Recommended)

- Register a domain or subdomain, e.g.: `transport.shreeja.com`
- Point its A record to your server's public IP address
- SSL certificate (free, via Let's Encrypt) is auto-configured by the deploy script if a domain is provided

---

## SECTION 3 — COMPLETE DIRECTORY STRUCTURE ON SERVER

After deployment, files are organized as follows on the Ubuntu server:

```
/opt/shreeja/                    ← Application root (owned by 'shreeja' user)
├── backend/                     ← Node.js source code
│   ├── .env                     ← Secrets file (DB password, JWT secret) — chmod 600
│   ├── package.json
│   ├── migrations/
│   └── src/
├── frontend/                    ← React source (used only during build)
├── frontend-build/              ← Built React app — served by Nginx
├── ecosystem.config.js          ← PM2 process configuration
├── logs/
│   ├── out.log                  ← PM2 stdout
│   └── err.log                  ← PM2 stderr
└── backups/                     ← Daily database backups (.sql.gz files)

/etc/nginx/sites-available/shreeja   ← Nginx virtual host config
/root/shreeja-secrets.txt            ← Generated DB password + JWT secret (chmod 600)
```

---

## SECTION 4 — STEP-BY-STEP DEPLOYMENT

### Phase 1 — Prepare the Server

SSH into your Ubuntu 22.04 server as root:

```bash
ssh root@YOUR_SERVER_IP
```

Update the system:

```bash
apt-get update && apt-get upgrade -y
```

### Phase 2 — Edit the Deploy Script

Before running, open `deploy.sh` and set these variables at the top:

```bash
DOMAIN=""          # Leave blank if no domain yet, e.g. "transport.shreeja.com"
SMTP_USER=""       # Your Gmail address for sending reports, e.g. "reports@shreeja.com"
SMTP_PASS=""       # Gmail App Password (NOT your Gmail login password — see Section 5.3)
```

### Phase 3 — Upload the Deploy Script

From your local machine:

```bash
scp deploy/deploy.sh root@YOUR_SERVER_IP:/root/
```

### Phase 4 — Run Phase 1 (Installs Software)

```bash
chmod +x /root/deploy.sh
sudo bash /root/deploy.sh
```

This installs: Node.js 20, PostgreSQL 16, Nginx, PM2, Certbot.
When it pauses and asks you to copy files — proceed to Phase 5.

### Phase 5 — Upload the Application Code

From your local machine (in the directory containing the `shreeja-optimizer` folder):

```bash
scp -r shreeja-optimizer/backend  root@YOUR_SERVER_IP:/opt/shreeja/
scp -r shreeja-optimizer/frontend root@YOUR_SERVER_IP:/opt/shreeja/
```

### Phase 6 — Run Phase 2 (Build, Migrate, Start)

```bash
sudo bash /root/deploy.sh --continue
```

This will:
1. Create the `.env` file with generated secrets
2. Install Node.js dependencies (`npm ci`)
3. Run database migrations (creates all tables + seeds admin user)
4. Build the React frontend (`npm run build`)
5. Start the backend with PM2
6. Configure Nginx as reverse proxy
7. Configure SSL if a domain was provided
8. Set up UFW firewall rules

### Phase 7 — Verify the Deployment

```bash
# Check backend is running
sudo -u shreeja pm2 status

# Expected output:
# ┌─────────────────────┬────┬──────┬─────────┬─────────┐
# │ name                │ id │ mode │ status  │ restart │
# ├─────────────────────┼────┼──────┼─────────┼─────────┤
# │ shreeja-backend     │ 0  │ fork │ online  │ 0       │
# └─────────────────────┴────┴──────┴─────────┴─────────┘

# Check health endpoint
curl http://localhost/api/health
# Expected: {"ok":true,"ts":"2024-..."}

# Check Nginx
sudo nginx -t
# Expected: nginx: configuration file /etc/nginx/nginx.conf test is successful
```

Open a browser: `http://YOUR_SERVER_IP` (or `https://your-domain.com`)

Login with: `admin` / `Admin@1234`

---

## SECTION 5 — FIRST-TIME CONFIGURATION CHECKLIST

Run through this checklist immediately after deployment:

### 5.1 Change the Admin Password

1. Login as `admin` / `Admin@1234`
2. Go to **Masters → Users**
3. Click **Edit** on the admin row
4. Set a new strong password
5. Click **Update**

### 5.2 Create User Accounts

1. Go to **Masters → Users → Add User**
2. Create accounts for planners and executors
3. Assign roles:
   - **admin** — IT administrator, full access
   - **planner** — trip planning team, masters access
   - **executor** — field supervisors, execution data entry only

### 5.3 Configure Email (for TS Reports)

To enable sending TS reports by email:

1. On your Gmail account, enable 2-Factor Authentication
2. Go to: `Google Account → Security → 2-Step Verification → App passwords`
3. Generate an App Password for "Mail"
4. On the server, edit `/opt/shreeja/backend/.env`:
   ```
   SMTP_USER=your.email@gmail.com
   SMTP_PASS=your_16_char_app_password
   SMTP_FROM=Shreeja Transport <your.email@gmail.com>
   ```
5. Restart the backend:
   ```bash
   sudo -u shreeja pm2 restart shreeja-backend
   ```
6. Go to **Masters → Email Config** and add report recipients

### 5.4 Enter Master Data

Enter data in this order (each step depends on the previous):

**Step 1 — Locations**
- Masters → Locations → Starting Points (depots tankers start from)
- Masters → Locations → Testing Points (labs that test milk)
- Masters → Locations → Delivery Points (processing plants that receive milk)

**Step 2 — Tankers**
- Masters → Tankers → Add each tanker
- Enter: tanker number, compartments (2 or 3), capacity in litres, rate per km in ₹

**Step 3 — BMCUs**
- Masters → BMCUs → Add each BMCU
- Enter: code (e.g. AP001), name, district, state
- District and state are used by the optimizer for fallback distance estimates

**Step 4 — Routes** (optional but recommended)
- Masters → Routes → Add standard collection routes
- Assign BMCUs in collection sequence
- This auto-populates trip plans when a route is selected

**Step 5 — Distance Master** (for accurate Route Optimizer)
- Masters → Distance Master → Download Template
- The Excel template pre-fills all BMCU pairs
- Enter actual road distance (km) for each pair
- Upload the filled template
- Also enter depot-to-BMCU distances in the "Depot-to-BMCU" sheet

### 5.5 Set Up Daily Backups

```bash
# SSH into server, then:
crontab -e

# Add this line (runs backup at 2 AM daily):
0 2 * * * /opt/shreeja/deploy/backup.sh >> /opt/shreeja/logs/backup.log 2>&1
```

---

## SECTION 6 — DAILY OPERATIONS WORKFLOW

### 6.1 Trip Planning (Planner Role)

**Manual planning:**
1. Login as planner
2. Planning → Trip Plans → New Plan
3. Select: date, tanker, delivery point, BMCUs with quantities
4. Save as draft → review → Publish (executors can now see it)

**Optimizer-assisted planning:**
1. Planning → Route Optimizer
2. Step 1: Select date, plant, depot, strategy
3. Step 2: Select BMCUs and enter expected milk quantity for each
4. Step 3: Review generated trips, adjust tanker/km if needed, accept/reject
5. Save as Draft Plans → review in Trip Plans → Publish

### 6.2 Execution (Executor Role)

1. Login as executor
2. Execution → Active Trips → select today's date
3. Click **Start** on a published plan
4. Enter BMCU-by-BMCU data:
   - Milk date, shift (AM/PM)
   - Quantity in litres (kg auto-calculated: litres × 1.0285)
   - Fat% and SNF% (kg fat and kg SNF auto-calculated)
   - Description: RMRD / Balance Milk / Internal Shifting
   - Chamber: FC / MC / BC
   - DPS reading
5. Click **Save** at any point to preserve progress
6. When all data entered: **Submit for Acknowledgement**

### 6.3 Acknowledgement (Executor at Plant)

1. Execution → Active Trips → find trip in "pending_ack" status → View
2. Click **Enter Acknowledgement**
3. Enter per-chamber (FC/MC/BC) quantities:
   - Litres, fat%, SNF%, temperature
4. Review live variation vs Truck Sheet totals
5. **Save & Close Trip** — trip becomes "closed" and feeds into reports

### 6.4 Daily TS Report

1. Reports → Daily TS Report
2. Select date range
3. Click **Load Report**
4. Columns: DPS | Truck Sheet | Acknowledgement | **Variation** (colour-coded)
   - Green = variation within acceptable range
   - Amber = moderate variation (> 0.1)
   - Red = significant variation (> 0.5)
5. Click **Excel** to download or **Email** to send to configured recipients

---

## SECTION 7 — TRIP STATUS FLOWS

Understanding these flows is essential for the team:

### Plan Status Flow
```
DRAFT  ──→  PUBLISHED  ──→  (execution starts)
  │
  └─→  CANCELLED
```
- Planner creates plans as **Draft**
- Only **Published** plans are visible to executors
- **Cancelled** plans are hidden from execution view

### Execution Status Flow
```
IN_PROGRESS  ──→  SAVED  ──→  PENDING_ACK  ──→  CLOSED
```
- **in_progress**: Executor started, entering BMCU data
- **saved**: Data entered and saved (can still edit)
- **pending_ack**: Submitted to plant for acknowledgement
- **closed**: Acknowledgement entered — feeds into TS reports

---

## SECTION 8 — SERVER MANAGEMENT COMMANDS

Reference for your system administrator:

```bash
# ── Check application status ──────────────────────────────────────────
sudo -u shreeja pm2 status
sudo -u shreeja pm2 list

# ── View live logs ────────────────────────────────────────────────────
sudo -u shreeja pm2 logs shreeja-backend
sudo -u shreeja pm2 logs shreeja-backend --lines 100  # last 100 lines

# ── Restart after .env change ─────────────────────────────────────────
sudo -u shreeja pm2 restart shreeja-backend

# ── Stop / Start ──────────────────────────────────────────────────────
sudo -u shreeja pm2 stop    shreeja-backend
sudo -u shreeja pm2 start   ecosystem.config.js

# ── Nginx ──────────────────────────────────────────────────────────────
sudo nginx -t                            # Test config
sudo systemctl reload nginx              # Apply config changes
sudo systemctl status nginx              # Check status
sudo journalctl -u nginx -f              # Live Nginx logs

# ── Database ──────────────────────────────────────────────────────────
sudo -u postgres psql dairy_transport    # Open DB console
\dt                                      # List all tables
\d trip_plans                            # Describe a table
SELECT COUNT(*) FROM trip_plans;         # Count rows

# ── Redeploy after code changes ───────────────────────────────────────
# Upload new files via scp, then:
cd /opt/shreeja/backend && sudo -u shreeja npm ci --omit=dev
sudo -u shreeja pm2 restart shreeja-backend
# For frontend changes:
cd /opt/shreeja/frontend && sudo -u shreeja npm run build
cp -r dist/* /opt/shreeja/frontend-build/

# ── Manual database backup ────────────────────────────────────────────
sudo bash /opt/shreeja/deploy/backup.sh

# ── View backup files ─────────────────────────────────────────────────
ls -lh /opt/shreeja/backups/

# ── Restore from backup ───────────────────────────────────────────────
# (Replace BACKUP_FILE with actual filename)
DB_PASS=$(grep DB_PASSWORD /opt/shreeja/backend/.env | cut -d= -f2)
zcat /opt/shreeja/backups/BACKUP_FILE.sql.gz | \
  PGPASSWORD="$DB_PASS" psql -U shreeja_db -h localhost dairy_transport

# ── SSL certificate renewal (auto, but manual if needed) ──────────────
sudo certbot renew --dry-run              # Test renewal
sudo certbot renew                        # Force renewal
```

---

## SECTION 9 — BUSINESS LOGIC REFERENCE

Critical calculations the team must not change without code updates:

| Calculation | Formula | Applied In |
|-------------|---------|-----------|
| Litres → Kgs | `kgs = litres × 1.0285` | executions.js + ExecutionForm.jsx |
| Kg Fat | `kg_fat = fat_pct × kgs / 100` | executions.js + ExecutionForm.jsx |
| Kg SNF | `kg_snf = snf_pct × kgs / 100` | executions.js + ExecutionForm.jsx |
| Trip Cost | `total_cost = expected_km × per_km_rate` | plans.js + TripPlanForm.jsx |
| Per-Litre Cost | `per_liter_cost = total_cost / expected_total_qty` | plans.js + TripPlanForm.jsx |
| Utilization % | `total_qty_litres / tanker.capacity_litres × 100` | plans.js + TripPlanForm.jsx |
| TS Variation | `Acknowledgement total − Truck Sheet total` | reports.js + DailyTSReport.jsx |

**Important rule:** Balance Milk rows (`description = 'Balance Milk'`) are **always excluded** from execution totals and TS report calculations.

---

## SECTION 10 — SECURITY NOTES

1. **Change admin password** immediately after first login
2. **JWT Secret** is auto-generated during deploy — stored in `/root/shreeja-secrets.txt` (chmod 600)
3. **Database password** is auto-generated — never exposed via the API
4. **Port 5000 (Node.js) and 5432 (PostgreSQL)** are NOT open to the internet — only accessible internally via Nginx
5. **Nginx headers** (Helmet.js + Nginx config) set `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`
6. **HTTPS/SSL** is configured via Let's Encrypt if a domain is provided
7. **Firewall (UFW)** only allows ports 22, 80, 443
8. For added security, restrict SSH (port 22) to your office IP:
   ```bash
   ufw delete allow ssh
   ufw allow from YOUR_OFFICE_IP to any port 22
   ufw reload
   ```

---

## SECTION 11 — TROUBLESHOOTING GUIDE

### Problem: White screen / app won't load
```bash
# Check Nginx is serving the build
ls /opt/shreeja/frontend-build/
# Should contain: index.html, assets/

# Rebuild if empty
cd /opt/shreeja/frontend && sudo -u shreeja npm run build
sudo cp -r dist/* /opt/shreeja/frontend-build/
sudo systemctl reload nginx
```

### Problem: "502 Bad Gateway" from Nginx
```bash
# Backend is down — check logs
sudo -u shreeja pm2 logs shreeja-backend --lines 50
# Restart
sudo -u shreeja pm2 restart shreeja-backend
```

### Problem: Login fails with admin/Admin@1234
```bash
# Check if seed data was applied
sudo -u postgres psql dairy_transport -c "SELECT username, is_active FROM users;"
# If admin user missing, re-run migration:
sudo -u postgres psql dairy_transport -f /opt/shreeja/backend/migrations/001_base_schema.sql
```

### Problem: Excel upload not working
```bash
# Check upload directory permissions
ls -la /tmp/
# Multer uses memoryStorage — no disk write needed. Check logs:
sudo -u shreeja pm2 logs shreeja-backend | grep -i "upload\|multer\|error"
```

### Problem: Emails not sending
```bash
# Verify SMTP config
grep SMTP /opt/shreeja/backend/.env
# Test connection (replace values):
node -e "
const nm = require('nodemailer');
const t = nm.createTransport({host:'smtp.gmail.com',port:587,auth:{user:'YOUR_EMAIL',pass:'YOUR_APP_PASS'}});
t.verify().then(()=>console.log('OK')).catch(console.error);
" 
# NOTE: Gmail requires App Password — NOT account password
# Gmail → Account → Security → 2FA → App passwords
```

### Problem: Database connection errors
```bash
# Check PostgreSQL is running
sudo systemctl status postgresql
sudo systemctl start postgresql
# Verify connection
DB_PASS=$(grep DB_PASSWORD /opt/shreeja/backend/.env | cut -d= -f2)
PGPASSWORD="$DB_PASS" psql -U shreeja_db -h localhost -d dairy_transport -c "\dt"
```

---

## SECTION 12 — HANDOVER CHECKLIST FOR BINDRA TEAM

Use this list to confirm everything is complete before going live:

### Pre-Deployment
- [ ] Ubuntu 22.04 LTS server provisioned with minimum 2 vCPU / 2 GB RAM
- [ ] Server has a public IP address
- [ ] SSH access confirmed (root or sudo user)
- [ ] Domain name registered and A record pointed to server IP (optional but recommended)
- [ ] Gmail account ready with App Password generated (for report emails)
- [ ] All code files downloaded from Claude conversation outputs

### Deployment
- [ ] `deploy.sh` variables set: `DOMAIN`, `SMTP_USER`, `SMTP_PASS`
- [ ] Phase 1 completed (Node.js, PostgreSQL, Nginx, PM2 installed)
- [ ] Application code uploaded to `/opt/shreeja/`
- [ ] Phase 2 completed (migrations run, frontend built, PM2 started)
- [ ] Health check passes: `curl http://localhost/api/health`
- [ ] Login works in browser: `admin` / `Admin@1234`

### Post-Deployment Configuration
- [ ] Admin password changed from default
- [ ] Planner user accounts created
- [ ] Executor user accounts created
- [ ] Starting Points entered (depots)
- [ ] Delivery Points entered (processing plants)
- [ ] Testing Points entered (labs)
- [ ] All tankers entered with correct capacity and per-km rate
- [ ] All BMCUs entered with district and state
- [ ] Standard routes defined with BMCU sequences
- [ ] Distance Master uploaded via Excel template (at least depot-to-BMCU distances)
- [ ] Email recipients configured in Masters → Email Config
- [ ] Daily backup cron job added
- [ ] SSL certificate confirmed working (if domain configured)

### User Training
- [ ] Planners trained on: Trip Plan creation, Route Optimizer, Publishing plans
- [ ] Executors trained on: Starting execution, BMCU data entry, Acknowledgement
- [ ] Admin trained on: User management, master data maintenance, viewing reports
- [ ] Team has the default credentials document (keep secure)

---

## SECTION 13 — KEY FILES QUICK REFERENCE

| If you need to change... | Edit this file |
|--------------------------|---------------|
| Database host/password | `/opt/shreeja/backend/.env` |
| JWT token expiry (default 8h) | `/opt/shreeja/backend/.env` → `JWT_EXPIRES_IN` |
| Email/SMTP settings | `/opt/shreeja/backend/.env` |
| Nginx domain / SSL settings | `/etc/nginx/sites-available/shreeja` |
| PM2 process config (memory limit, instances) | `/opt/shreeja/ecosystem.config.js` |
| Add a new API route | `backend/src/routes/*.js` + register in `app.js` |
| Add a new frontend page | `frontend/src/pages/` + `App.jsx` + `Sidebar.jsx` |
| Brand colors | `frontend/tailwind.config.js` |
| Litres-to-Kgs conversion factor | `backend/src/routes/executions.js` (top of file) |
| Optimizer fallback distances | `backend/src/routes/optimize.js` (top constants) |

---

*Document prepared by Claude for Shreeja Transport Management System production deployment.*
*All source files available in the Claude conversation outputs under the `shreeja-optimizer/` folder.*
