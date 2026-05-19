# Dairy Transport Management System — Deployment Guide

## Overview

Full-stack web application for managing secondary milk transport operations.

- **Backend**: Node.js + Express + PostgreSQL  
- **Frontend**: React + Vite + Tailwind CSS  
- **Default Admin Login**: `admin` / `Admin@1234`

---

## Step 1: Install Prerequisites

### 1a. Node.js (Required)
Download and install from: https://nodejs.org/en/download  
- Choose **LTS version (18.x or 20.x)**
- During installation, tick "Add to PATH"
- Verify: open Command Prompt and type `node --version`

### 1b. PostgreSQL (Database)
Download from: https://www.postgresql.org/download/windows/  
- Version 14, 15, or 16
- Note the **postgres** user password you set during installation
- Default port: 5432

### 1c. Git (Optional, for version control)
Download from: https://git-scm.com/download/win

---

## Step 2: Set Up Database

1. Open **pgAdmin** (installed with PostgreSQL) or **psql** command line
2. Create a new database:
   ```sql
   CREATE DATABASE dairy_transport;
   ```
3. Run the schema migration:
   - In pgAdmin: right-click `dairy_transport` → Query Tool → paste contents of `backend\migrations\001_schema.sql` → Run
   - Or via psql:
     ```
     psql -U postgres -d dairy_transport -f "C:\Users\murali.MURALI-IT\Applications\dairy-transport\backend\migrations\001_schema.sql"
     ```

---

## Step 3: Configure Backend Environment

1. Navigate to the backend folder:
   ```
   C:\Users\murali.MURALI-IT\Applications\dairy-transport\backend\
   ```
2. Copy `.env.example` to `.env`:
   ```
   copy .env.example .env
   ```
3. Open `.env` and fill in your values:
   ```
   PORT=5000
   
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=dairy_transport
   DB_USER=postgres
   DB_PASSWORD=your_postgres_password_here
   
   JWT_SECRET=change_this_to_a_long_random_string_32chars
   JWT_EXPIRES_IN=8h
   
   # Gmail SMTP (for sending reports)
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=your_gmail@gmail.com
   SMTP_PASS=your_gmail_app_password
   SMTP_FROM=Dairy Transport <your_gmail@gmail.com>
   
   FRONTEND_URL=http://localhost:5173
   ```

   > **Gmail App Password**: Go to Google Account → Security → 2-Step Verification → App passwords → Generate a 16-char password

---

## Step 4: Install Dependencies

Open Command Prompt (or PowerShell), run:

```cmd
cd C:\Users\murali.MURALI-IT\Applications\dairy-transport\backend
npm install

cd C:\Users\murali.MURALI-IT\Applications\dairy-transport\frontend
npm install
```

---

## Step 5: Start the Application

### Start Backend (API Server)
```cmd
cd C:\Users\murali.MURALI-IT\Applications\dairy-transport\backend
npm run dev
```
You should see: `Dairy Transport API running on port 5000`

### Start Frontend (Development Mode)
Open a **second** Command Prompt window:
```cmd
cd C:\Users\murali.MURALI-IT\Applications\dairy-transport\frontend
npm run dev
```
You should see: `Local: http://localhost:5173`

Open your browser at: **http://localhost:5173**

---

## Step 6: First Login & Setup

1. Login with **admin / Admin@1234**
2. Go to **Masters → Users** → change admin password
3. Go to **Masters → BMCUs** → enter all 135 BMCUs
   - BMCU Code (e.g. 3001), BMCU Name, District, State
4. Go to **Masters → Tankers** → enter all tankers from your Excel file
   - Set Per KM Rate for each tanker
5. Go to **Masters → Locations** → enter:
   - Starting Points (Balaji Dairy, KMF Dairy, etc.)
   - Testing Points
   - Delivery Points
6. Go to **Masters → Routes** → create routes with BMCU sequences
7. Go to **Masters → Users** → create Planner and Executor accounts
8. Go to **Masters → Email Config** → add email recipients for reports

---

## Step 7: Production Deployment (for permanent use)

### Option A: Run on same PC permanently

Install **PM2** to keep the backend running:
```cmd
npm install -g pm2
cd C:\Users\murali.MURALI-IT\Applications\dairy-transport\backend
pm2 start src/app.js --name "dairy-backend"
pm2 startup
pm2 save
```

Build frontend for production:
```cmd
cd C:\Users\murali.MURALI-IT\Applications\dairy-transport\frontend
npm run build
```

Install **serve** to host the built frontend:
```cmd
npm install -g serve
serve -s dist -l 3000
```

Access at: http://localhost:3000

### Option B: Deploy on a Cloud Server (recommended for team access)

**Recommended: Use a VPS (DigitalOcean, AWS EC2, or Azure)**

1. Get a Ubuntu 22.04 server
2. Install Node.js 20, PostgreSQL 16, Nginx
3. Copy the project files to the server
4. Build frontend: `npm run build`
5. Configure Nginx to:
   - Serve frontend `dist/` folder at `/`
   - Proxy `/api` requests to `localhost:5000`
6. Use PM2 to manage the Node.js backend
7. Set up SSL with Let's Encrypt for HTTPS

**Sample Nginx config:**
```nginx
server {
    listen 80;
    server_name your-domain.com;

    root /var/www/dairy-transport/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api {
        proxy_pass http://localhost:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Daily Workflow

### Tanker Planner (done each evening/night)
1. Login → **Planning → Trip Plans**
2. Select tomorrow's date
3. Add trip plans individually OR upload Excel (use Template button to download format)
4. Fill route, tanker, BMCU sequence, expected qty, driver, loader details
5. Cost auto-calculates: KM × Per KM Rate ÷ Expected Qty
6. Click **Publish Plans** when ready — makes trips visible to executors

### Trip Executors (done each morning)
1. Login → **Execution → Active Trips**
2. Select today's date → see published plans
3. Click **Start** on a trip → opens data entry form
4. Fill each BMCU row:
   - Date and Shift of milk (AM/PM)
   - Qty Litres → Qty Kgs auto-calculates (×1.0285)
   - Fat% and SNF% → Kg Fat and Kg SNF auto-calculate
   - Description: RMRD / Balance Milk / Internal Shifting
   - Chamber: FC / MC / BC (where milk is poured)
   - DPS reading and RMRD qty
5. Add extra BMCUs or delete rows if needed
6. Edit actual KMs if different from planned
7. Click **Save** to save progress
8. Click **Submit for Acknowledgement** when done

### After Delivery (next day)
1. Go to **Execution → Active Trips** (or Dashboard "Pending Acknowledgement" section)
2. Click **Acknowledge** on a pending trip
3. Enter qty, fat%, snf%, temperature per chamber (FC/MC/BC)
4. System shows variations: Ack vs Truck Sheet vs DPS
5. Click **Save & Close Trip** → trip is marked closed

### Reports
1. Go to **Reports → TS Report**
2. Select date range → **Generate Report**
3. View the full TS variation table (DPS / Truck Sheet / Dairy columns)
4. To email: select a date → **Send by Email** (sends to all configured recipients)
5. To download Excel: select date → **Download Excel**

---

## User Roles Summary

| Role | Access |
|------|--------|
| **Admin** | Everything: all masters, all plans, all executions, reports, user management |
| **Tanker Planner** | Masters (tankers, BMCUs, routes, locations), Trip Planning (create/edit/publish plans), Reports |
| **Trip Executor** | View published plans, Execute trips, Enter BMCU data, Submit acknowledgements, View reports |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Can't connect to DB | Check `DB_PASSWORD` in `.env`, ensure PostgreSQL is running |
| "No token provided" error | Login again; token may have expired (8h lifetime) |
| Email not sending | Check Gmail App Password, ensure 2FA is enabled on Gmail |
| Frontend blank page | Check browser console, ensure backend is running on port 5000 |
| Plans not visible to executors | Plans must be **Published** by planner (not just saved as Draft) |

---

## Future Scaling Notes

The application is designed for easy expansion:
- **New fields**: Add columns to PostgreSQL tables + update API routes + frontend forms
- **New users**: Admin adds them via User Management page
- **New plants**: Add to Delivery Points master
- **New BMCUs**: Add to BMCU master; immediately available in routes and plans
- **Multiple plants**: Delivery points support multiple receivers (MDFVPL, Milma, KMF, etc.)
- **Reporting**: Raw data in PostgreSQL — any new report can be built as a new API endpoint
