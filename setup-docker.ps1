# ============================================================
# Shreeja Transport — Auto Docker Setup Script
# Run this from inside your shreeja-transport folder:
#   powershell -ExecutionPolicy Bypass -File setup-docker.ps1
# ============================================================

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Shreeja Transport — Docker File Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. docker-compose.yml (root) ─────────────────────────────
Write-Host "Creating docker-compose.yml..." -ForegroundColor Yellow
@'
version: '3.9'

services:

  db:
    image: postgres:16-alpine
    container_name: shreeja-db
    restart: always
    environment:
      POSTGRES_DB:       ${DB_NAME:-dairy_transport}
      POSTGRES_USER:     ${DB_USER:-shreeja_db}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - shreeja-net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-shreeja_db} -d ${DB_NAME:-dairy_transport}"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 10s

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    container_name: shreeja-backend
    restart: always
    env_file: .env
    environment:
      NODE_ENV: production
      DB_HOST:  db
      DB_PORT:  5432
      PORT:     5000
    depends_on:
      db:
        condition: service_healthy
    networks:
      - shreeja-net
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:5000/api/health || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 30s

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    container_name: shreeja-frontend
    restart: always
    ports:
      - "80:80"
    depends_on:
      backend:
        condition: service_healthy
    networks:
      - shreeja-net

volumes:
  pgdata:
    name: shreeja-pgdata

networks:
  shreeja-net:
    name: shreeja-network
    driver: bridge
'@ | Set-Content -Path "docker-compose.yml" -Encoding UTF8
Write-Host "  docker-compose.yml created" -ForegroundColor Green

# ── 2. .env.example (root) ───────────────────────────────────
Write-Host "Creating .env.example..." -ForegroundColor Yellow
@'
# ============================================================
# Shreeja Transport - Environment Variables
# Copy this file: cp .env.example .env
# Fill in your values. NEVER commit .env to GitHub.
# ============================================================

# Database
DB_NAME=dairy_transport
DB_USER=shreeja_db
DB_PASSWORD=choose_a_strong_password_here

# JWT - generate with: openssl rand -base64 32
JWT_SECRET=change_this_to_a_long_64_char_random_string
JWT_EXPIRES_IN=8h

# Email (Gmail SMTP)
# Gmail: Account -> Security -> 2FA -> App passwords -> Generate
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your.email@gmail.com
SMTP_PASS=your_16_char_app_password
SMTP_FROM=Shreeja Transport <your.email@gmail.com>

# Application
FRONTEND_URL=http://YOUR_SERVER_IP
NODE_ENV=production
'@ | Set-Content -Path ".env.example" -Encoding UTF8
Write-Host "  .env.example created" -ForegroundColor Green

# ── 3. DOCKER_DEPLOY.md (root) ───────────────────────────────
Write-Host "Creating DOCKER_DEPLOY.md..." -ForegroundColor Yellow
@'
# Docker Deployment Guide
## Shreeja Secondary Transport Management System

## Step 1 - Install Docker on Ubuntu Server (one-time)
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

## Step 2 - Clone Repository
```bash
git clone https://github.com/murali2828/shreeja-transport.git
cd shreeja-transport
```

## Step 3 - Create .env File
```bash
cp .env.example .env
nano .env
```
Fill in: DB_PASSWORD, JWT_SECRET, SMTP_USER, SMTP_PASS, FRONTEND_URL

## Step 4 - Start Everything (ONE command)
```bash
docker compose up -d
```

## Step 5 - Verify
```bash
docker compose ps
```
Open browser: http://YOUR_SERVER_IP
Login: admin / Admin@1234
Change admin password immediately.

## Deploy Code Updates
```bash
git pull origin main
docker compose up -d --build
```

## Useful Commands
```bash
docker compose ps            # check status
docker compose logs -f       # view all logs
docker compose logs backend  # backend logs only
docker compose restart       # restart all
docker compose down          # stop all
docker compose up -d         # start all
```

## Database Backup
```bash
docker compose exec db pg_dump -U shreeja_db dairy_transport > backup.sql
```

## Troubleshooting
- Containers not starting: docker compose logs db / backend / frontend
- Port 80 in use: sudo lsof -i :80
- Reset all data: docker compose down -v && docker compose up -d
'@ | Set-Content -Path "DOCKER_DEPLOY.md" -Encoding UTF8
Write-Host "  DOCKER_DEPLOY.md created" -ForegroundColor Green

# ── 4. backend/Dockerfile ────────────────────────────────────
Write-Host "Creating backend/Dockerfile..." -ForegroundColor Yellow
@'
# Shreeja Backend - Node.js 20
# Runs DB migrations automatically on startup, then starts API

FROM node:20-alpine

# Install wget for healthcheck
RUN apk add --no-cache wget

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY . .

EXPOSE 5000

ENV NODE_ENV=production

# Runs migrations first, then starts the Express server
CMD ["sh", "-c", "node src/config/migrate.js && node src/app.js"]
'@ | Set-Content -Path "backend\Dockerfile" -Encoding UTF8
Write-Host "  backend/Dockerfile created" -ForegroundColor Green

# ── 5. backend/.dockerignore ─────────────────────────────────
Write-Host "Creating backend/.dockerignore..." -ForegroundColor Yellow
@'
node_modules
.env
*.log
npm-debug.log*
.git
.gitignore
'@ | Set-Content -Path "backend\.dockerignore" -Encoding UTF8
Write-Host "  backend/.dockerignore created" -ForegroundColor Green

# ── 6. frontend/Dockerfile ───────────────────────────────────
Write-Host "Creating frontend/Dockerfile..." -ForegroundColor Yellow
@'
# Shreeja Frontend - React 18 + Nginx
# Multi-stage build:
#   Stage 1: Build React app with Node.js
#   Stage 2: Serve built files with Nginx

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Serve
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

RUN rm -f /etc/nginx/conf.d/default.conf.default

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
'@ | Set-Content -Path "frontend\Dockerfile" -Encoding UTF8
Write-Host "  frontend/Dockerfile created" -ForegroundColor Green

# ── 7. frontend/.dockerignore ────────────────────────────────
Write-Host "Creating frontend/.dockerignore..." -ForegroundColor Yellow
@'
node_modules
dist
.env
*.log
npm-debug.log*
.git
.gitignore
'@ | Set-Content -Path "frontend\.dockerignore" -Encoding UTF8
Write-Host "  frontend/.dockerignore created" -ForegroundColor Green

# ── 8. frontend/nginx.conf ───────────────────────────────────
Write-Host "Creating frontend/nginx.conf..." -ForegroundColor Yellow
@'
server {
    listen 80;
    server_name _;

    add_header X-Content-Type-Options  nosniff;
    add_header X-Frame-Options         SAMEORIGIN;
    add_header X-XSS-Protection        "1; mode=block";
    add_header Referrer-Policy         strict-origin-when-cross-origin;

    gzip            on;
    gzip_vary       on;
    gzip_min_length 1024;
    gzip_types      text/plain text/css application/json
                    application/javascript text/xml
                    application/xml image/svg+xml;

    client_max_body_size 20M;

    root  /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
        expires 1h;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$ {
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
    }

    location /api/ {
        proxy_pass         http://backend:5000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade          $http_upgrade;
        proxy_set_header   Connection       keep-alive;
        proxy_set_header   Host             $host;
        proxy_set_header   X-Real-IP        $remote_addr;
        proxy_set_header   X-Forwarded-For  $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }

    location /health {
        return 200 'OK';
        add_header Content-Type text/plain;
        access_log off;
    }
}
'@ | Set-Content -Path "frontend\nginx.conf" -Encoding UTF8
Write-Host "  frontend/nginx.conf created" -ForegroundColor Green

# ── Verify all files created ─────────────────────────────────
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Verification" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$files = @(
    "docker-compose.yml",
    ".env.example",
    "DOCKER_DEPLOY.md",
    "backend\Dockerfile",
    "backend\.dockerignore",
    "frontend\Dockerfile",
    "frontend\.dockerignore",
    "frontend\nginx.conf"
)

$allOk = $true
foreach ($f in $files) {
    if (Test-Path $f) {
        Write-Host "  [OK] $f" -ForegroundColor Green
    } else {
        Write-Host "  [MISSING] $f" -ForegroundColor Red
        $allOk = $false
    }
}

Write-Host ""
if ($allOk) {
    Write-Host "All Docker files created successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Next Step - Push to GitHub" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Run these commands:" -ForegroundColor White
    Write-Host ""
    Write-Host "  git add ." -ForegroundColor Yellow
    Write-Host "  git commit -m `"feat: add Docker deployment setup`"" -ForegroundColor Yellow
    Write-Host "  git push origin main" -ForegroundColor Yellow
    Write-Host ""
} else {
    Write-Host "Some files are missing. Please check errors above." -ForegroundColor Red
}
