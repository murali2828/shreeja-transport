# GitHub Update — Push Theme-Complete Files
## Run these commands to update your GitHub repo with the fully-themed UI

---

## What happened with your first push

Your first `git push` uploaded whatever files were in your local folder at that time.
The theme update was **incomplete** — only 7 of 23 frontend files had been restyled.
The remaining 16 page files still had old `brand-600`, `bg-gray-50` Tailwind classes.

This has now been fixed. All 23 frontend files are fully updated to the Shreeja Platform theme.

---

## Files that have been updated since your last push

```
frontend/tailwind.config.js              ← Brand colour #0078d4
frontend/src/index.css                   ← All Shreeja CSS classes
frontend/src/components/Layout.jsx       ← Topnav + translucent sidebar
frontend/src/components/Sidebar.jsx      ← White-on-blue nav items
frontend/src/components/MasterTable.jsx  ← Shared modal/button components
frontend/src/pages/Login.jsx             ← Sky gradient + frosted glass card
frontend/src/pages/Dashboard.jsx         ← White greeting, frosted stat cards

← NEW: these 16 pages now also use Shreeja theme →
frontend/src/pages/planning/TripPlanList.jsx
frontend/src/pages/planning/TripPlanForm.jsx
frontend/src/pages/planning/RouteOptimizer.jsx
frontend/src/pages/execution/ExecutionList.jsx
frontend/src/pages/execution/ExecutionForm.jsx
frontend/src/pages/execution/AcknowledgementForm.jsx
frontend/src/pages/execution/ClosedTrips.jsx
frontend/src/pages/masters/TankerMaster.jsx
frontend/src/pages/masters/BmcuMaster.jsx
frontend/src/pages/masters/RouteMaster.jsx
frontend/src/pages/masters/LocationMasters.jsx
frontend/src/pages/masters/DistanceMaster.jsx
frontend/src/pages/masters/UserManagement.jsx
frontend/src/pages/masters/EmailConfig.jsx
frontend/src/pages/reports/DailyTSReport.jsx
```

---

## Commands to update GitHub

Open a terminal in your `shreeja-transport/` project folder and run:

```bash
# 1. Copy all the newly downloaded files into your project folder
#    (replace the old versions with the updated ones)

# 2. Stage all changed files
git add .

# 3. Check what will be committed
git status
# You should see ~23 modified files in frontend/src/

# 4. Commit with a clear message
git commit -m "style: apply Shreeja Platform theme to all 23 frontend files

- Sky-blue gradient background (matches Shreeja platform screenshot)
- Fixed topnav bar with Shreeja wordmark and icon strip
- Translucent blue frosted-glass sidebar
- Frosted white glass cards throughout
- Updated Login, Dashboard, all Masters, Planning, Execution, Reports pages
- Consistent badge, button, table styles matching Shreeja design system"

# 5. Push to GitHub
git push origin main
```

---

## How to verify it worked on GitHub

1. Open `https://github.com/YOUR_ORG/shreeja-transport`
2. Click on `frontend/src/index.css`
3. Search (Ctrl+F) for `.topnav` — it should be there
4. Click on `frontend/src/components/Layout.jsx`
5. You should see `className="topnav"` in the JSX

If you see those → **GitHub is up to date with the full Shreeja theme.**

---

## After pushing — redeploy to server

If the server is already running, pull the latest and rebuild:

```bash
# SSH into server
ssh root@YOUR_SERVER_IP

# Pull latest from GitHub
cd /opt/shreeja
git pull origin main

# Rebuild frontend
cd /opt/shreeja/frontend
sudo -u shreeja npm run build
sudo cp -r dist/* /opt/shreeja/frontend-build/

# Restart backend (in case any backend files changed)
sudo -u shreeja pm2 restart shreeja-backend

echo "Done — open the app and see the new Shreeja theme"
```
