# FILE MANIFEST — Shreeja Transport System
## All Files to Collect from Claude Conversation Outputs

Copy every file listed below. Place them exactly as shown in the folder structure.
The deploy script expects this exact layout.

---

## FOLDER STRUCTURE TO CREATE ON YOUR LOCAL MACHINE

```
shreeja/
├── backend/
│   ├── .env.example
│   ├── package.json
│   ├── migrations/
│   │   ├── 001_base_schema.sql
│   │   └── 002_distance_and_optimizer.sql
│   └── src/
│       ├── app.js
│       ├── config/
│       │   ├── db.js
│       │   └── migrate.js
│       ├── middleware/
│       │   └── auth.js
│       └── routes/
│           ├── auth.js
│           ├── masters.js
│           ├── plans.js
│           ├── executions.js
│           ├── reports.js
│           ├── distances.js
│           └── optimize.js
│
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── public/
│   │   └── favicon.svg
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── index.css
│       ├── api/
│       │   └── index.js
│       ├── hooks/
│       │   └── useAuth.js
│       ├── components/
│       │   ├── Layout.jsx
│       │   ├── Sidebar.jsx
│       │   └── MasterTable.jsx
│       └── pages/
│           ├── Login.jsx
│           ├── Dashboard.jsx
│           ├── masters/
│           │   ├── TankerMaster.jsx
│           │   ├── BmcuMaster.jsx
│           │   ├── RouteMaster.jsx
│           │   ├── LocationMasters.jsx
│           │   ├── DistanceMaster.jsx
│           │   ├── UserManagement.jsx
│           │   └── EmailConfig.jsx
│           ├── planning/
│           │   ├── TripPlanList.jsx
│           │   ├── TripPlanForm.jsx
│           │   └── RouteOptimizer.jsx
│           ├── execution/
│           │   ├── ExecutionList.jsx
│           │   ├── ExecutionForm.jsx
│           │   ├── AcknowledgementForm.jsx
│           │   └── ClosedTrips.jsx
│           └── reports/
│               └── DailyTSReport.jsx
│
└── deploy/
    ├── deploy.sh
    └── backup.sh
```

---

## TOTAL FILE COUNT: 51 files

| Category | Count |
|----------|-------|
| Backend route files | 7 |
| Backend config/middleware | 3 |
| Backend migrations (SQL) | 2 |
| Backend config files | 2 |
| Frontend pages | 17 |
| Frontend components | 3 |
| Frontend config/entry files | 8 |
| Deploy scripts | 2 |
| Documentation | 3 |
| **Total** | **51** |

---

## THREE-COMMAND DEPLOY SUMMARY

Once files are on your local machine and server is ready:

```bash
# 1. Upload deploy script and run Phase 1
scp deploy/deploy.sh root@SERVER_IP:/root/
ssh root@SERVER_IP "bash /root/deploy.sh"

# 2. Upload application code
scp -r backend  root@SERVER_IP:/opt/shreeja/
scp -r frontend root@SERVER_IP:/opt/shreeja/
scp -r deploy   root@SERVER_IP:/opt/shreeja/

# 3. Run Phase 2 (build + start)
ssh root@SERVER_IP "bash /root/deploy.sh --continue"
```

**Then open browser → http://SERVER_IP → login: admin / Admin@1234**

---

## DEFAULT CREDENTIALS (change immediately after first login)

| Field | Value |
|-------|-------|
| URL | http://YOUR_SERVER_IP or https://your-domain.com |
| Username | admin |
| Password | Admin@1234 |
| Role | admin (full access) |

**IMPORTANT: Change this password in Masters → Users before going live.**
