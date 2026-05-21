# GitHub Repository Setup Guide
## Shreeja Secondary Transport Management System

---

## PART A — WHAT CHANGED: UI THEME UPDATE

The frontend has been restyled to match the **Shreeja Platform** theme shown in the screenshot:

| Element | Before | After |
|---------|--------|-------|
| Background | Light gray `#f3f4f6` | Sky-blue gradient (matches Shreeja platform) |
| Sidebar | White panel, blue text | Translucent blue glass, white text |
| Top nav | None (sidebar only) | Fixed Shreeja blue navbar with logo + icon strip |
| Cards | Plain white border | Frosted glass with soft blue shadow |
| Buttons | Flat blue | Blue with drop shadow + hover lift |
| Tables | Gray header | Blue-tinted header cells |
| Login page | Blue gradient | Shreeja sky gradient with floating glass blobs |
| Font | Inter | Segoe UI (matches Shreeja platform) |

### Files updated for the theme:
```
frontend/tailwind.config.js          ← Brand colors: #0078d4 Shreeja blue
frontend/src/index.css               ← All utility classes (card, topnav, sidebar, badge, etc.)
frontend/src/components/Layout.jsx   ← New topnav bar + translucent sidebar
frontend/src/components/Sidebar.jsx  ← White-on-blue nav items
frontend/src/components/MasterTable.jsx ← Shared modal/button using new classes
frontend/src/pages/Login.jsx         ← Sky gradient + frosted glass card
frontend/src/pages/Dashboard.jsx     ← White greeting text, frosted stat cards
```

---

## PART B — GITHUB REPOSITORY SETUP

### Step 1 — Install Git (if not already installed)

```bash
# Ubuntu/Debian
sudo apt-get install -y git

# macOS
brew install git

# Windows
# Download from https://git-scm.com/download/win
```

Verify:
```bash
git --version
# Expected: git version 2.x.x
```

### Step 2 — Create GitHub Account & Repository

1. Go to **https://github.com** and sign in (or create an account)
2. Click the **+** button (top right) → **New repository**
3. Fill in:
   - **Repository name**: `shreeja-transport` (or `shreeja-secondary-transport`)
   - **Description**: `Shreeja Secondary Transport Management System`
   - **Visibility**: Choose **Private** (recommended — production code)
   - **Do NOT** initialise with README, .gitignore, or licence (we'll push our own)
4. Click **Create repository**
5. GitHub will show you the repository URL — copy it. It looks like:
   `https://github.com/YOUR_ORG/shreeja-transport.git`

### Step 3 — Configure Git Identity (one-time setup)

```bash
git config --global user.name  "Your Name"
git config --global user.email "your@email.com"
```

### Step 4 — Prepare the Local Folder

Organise your downloaded files into this exact structure:

```
shreeja-transport/           ← This becomes the git repository root
├── backend/
├── frontend/
├── deploy/
├── QUICKSTART.md
├── PRODUCTION_DEPLOYMENT_GUIDE.md
├── FILE_MANIFEST.md
├── .gitignore               ← Create this (see Step 5)
└── README.md                ← Create this (see Step 6)
```

### Step 5 — Create .gitignore

In the `shreeja-transport/` root, create a file named `.gitignore`:

```gitignore
# Node modules — never commit these
node_modules/
*/node_modules/

# Environment files — NEVER commit secrets
.env
backend/.env
*.env.local
*.env.production

# Build output
frontend/dist/
frontend/.vite/

# OS files
.DS_Store
Thumbs.db

# Editor files
.vscode/
.idea/
*.swp
*.swo

# Logs
*.log
logs/
npm-debug.log*

# PM2
.pm2/

# Backups
backups/
*.sql.gz

# Coverage
coverage/
```

### Step 6 — Create README.md

In the `shreeja-transport/` root, create `README.md`:

```markdown
# Shreeja Secondary Transport Management System

Full-stack web application for managing dairy milk secondary transport operations.

## Stack
- **Backend**: Node.js 20, Express, PostgreSQL 16, JWT auth
- **Frontend**: React 18, Vite, Tailwind CSS, TanStack Query
- **Server**: Ubuntu 22.04, Nginx, PM2

## Modules
- Trip Planning (manual + Clarke-Wright Route Optimizer)
- Daily Execution data entry (litres, fat%, SNF%, DPS)
- Acknowledgement by chamber (FC/MC/BC)
- TS Variation Reports (DPS vs Truck Sheet vs Ack)
- Distance Master for road-distance-based optimization
- Role-based access: Admin / Planner / Executor

## Default Login
`admin` / `Admin@1234` — change immediately after deployment

## Quick Start
See [QUICKSTART.md](./QUICKSTART.md) for local development setup.
See [PRODUCTION_DEPLOYMENT_GUIDE.md](./PRODUCTION_DEPLOYMENT_GUIDE.md) for server deployment.

## Theme
Styled to match the Shreeja Platform — sky-blue gradient, frosted glass cards,
translucent sidebar, matching the Shreeja app ecosystem.
```

### Step 7 — Initialise Git and Make First Commit

Open a terminal in your `shreeja-transport/` folder:

```bash
cd shreeja-transport/

# Initialise the repository
git init

# Add all files
git add .

# Verify what will be committed (check .env is NOT listed)
git status

# First commit
git commit -m "Initial commit: Shreeja Transport Management System with Shreeja Platform theme"
```

### Step 8 — Connect to GitHub and Push

```bash
# Add GitHub as the remote origin
git remote add origin https://github.com/YOUR_ORG/shreeja-transport.git

# Rename default branch to main (GitHub standard)
git branch -M main

# Push to GitHub
git push -u origin main
```

You'll be prompted for your GitHub username and password.
> **Note**: GitHub no longer accepts account passwords for git push.
> You need a **Personal Access Token (PAT)**. See Step 8b.

### Step 8b — Create a Personal Access Token (PAT)

1. GitHub → Settings (top right avatar) → **Developer settings**
2. → **Personal access tokens** → **Tokens (classic)**
3. → **Generate new token (classic)**
4. Set: **Note** = "shreeja-deploy", **Expiration** = 90 days
5. Select scopes: ✅ `repo` (full control of private repos)
6. Click **Generate token** → **Copy the token immediately** (shown only once)
7. Use this token as the password when git asks for it

To avoid typing it every time:
```bash
git config --global credential.helper store
# Then push once — credentials are saved after that
```

### Step 9 — Verify on GitHub

1. Open `https://github.com/YOUR_ORG/shreeja-transport`
2. You should see all files in the correct structure
3. The `backend/.env.example` should be visible but NOT `backend/.env`

---

## PART C — BRANCH STRATEGY (Recommended)

```
main          ← Production-ready code only
├── develop   ← Integration branch for completed features
│   ├── feature/route-optimizer-improvements
│   ├── feature/mobile-ui
│   └── fix/execution-form-validation
└── hotfix/   ← Emergency fixes direct to main
```

### Setting up branches:

```bash
# Create develop branch
git checkout -b develop
git push -u origin develop

# Start a new feature
git checkout develop
git checkout -b feature/my-feature
# ... make changes ...
git add .
git commit -m "feat: description of what was added"
git push origin feature/my-feature
# Then open a Pull Request on GitHub: feature/my-feature → develop
```

---

## PART D — DEPLOYMENT FROM GITHUB

Once the repo is on GitHub, the server can pull updates directly:

### First deploy (using scp as before)

```bash
scp -r shreeja-transport/backend  root@SERVER_IP:/opt/shreeja/
scp -r shreeja-transport/frontend root@SERVER_IP:/opt/shreeja/
scp -r shreeja-transport/deploy   root@SERVER_IP:/opt/shreeja/
```

### Subsequent updates (pull from GitHub on server)

After first deploy, set up git on the server:

```bash
# On the server:
cd /opt/shreeja
git init
git remote add origin https://github.com/YOUR_ORG/shreeja-transport.git
git pull origin main
```

For future code updates:

```bash
# On the server — pull and redeploy backend:
cd /opt/shreeja
git pull origin main

# Reinstall deps if package.json changed:
cd backend && sudo -u shreeja npm ci --omit=dev

# Restart backend:
sudo -u shreeja pm2 restart shreeja-backend

# Rebuild frontend if UI changed:
cd /opt/shreeja/frontend
sudo -u shreeja npm run build
sudo cp -r dist/* /opt/shreeja/frontend-build/
```

---

## PART E — COMMIT MESSAGE CONVENTION

Use these prefixes for clear history:

| Prefix | Use for |
|--------|---------|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `style:` | UI/CSS changes only |
| `refactor:` | Code restructure, no behaviour change |
| `chore:` | Config, deps, tooling |
| `docs:` | Documentation only |

Examples:
```bash
git commit -m "feat: add bulk BMCU Excel import"
git commit -m "fix: execution form litres calculation on empty rows"
git commit -m "style: update cards to Shreeja platform frosted glass theme"
git commit -m "chore: update tailwind to v3.4.3"
```

---

## PART F — GITHUB SECRETS FOR CI/CD (Optional, future)

If the team later adds GitHub Actions for automated deployment:

1. Go to: Repository → **Settings** → **Secrets and variables** → **Actions**
2. Add these secrets:
   - `SERVER_HOST` — your server IP
   - `SERVER_USER` — `root` or `shreeja`
   - `SERVER_SSH_KEY` — your private SSH key content
   - `DB_PASSWORD` — database password (from `/root/shreeja-secrets.txt`)

---

## SUMMARY — COMMANDS IN ORDER

```bash
# 1. Navigate to your project folder
cd shreeja-transport/

# 2. Create .gitignore (paste content from Step 5 above)
nano .gitignore

# 3. Create README.md (paste content from Step 6 above)
nano README.md

# 4. Initialise and commit
git init
git add .
git status     # verify .env is NOT listed
git commit -m "Initial commit: Shreeja Transport Management System"

# 5. Push to GitHub
git remote add origin https://github.com/YOUR_ORG/shreeja-transport.git
git branch -M main
git push -u origin main

# 6. Create develop branch
git checkout -b develop
git push -u origin develop
```

**That's it — your code is now on GitHub and ready for team collaboration.**
