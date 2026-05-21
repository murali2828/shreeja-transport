#!/bin/bash
# =============================================================================
# Shreeja Transport Management System — Ubuntu 22.04 Production Deploy Script
# Run as root or with sudo: sudo bash deploy.sh
#
# What this script does:
#   1. Installs Node.js 20, PostgreSQL 16, Nginx, PM2
#   2. Creates postgres DB + user
#   3. Copies project files, installs deps, builds frontend
#   4. Runs all DB migrations
#   5. Configures PM2 for backend
#   6. Configures Nginx as reverse proxy
#   7. Optionally configures SSL (Let's Encrypt)
# =============================================================================

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# ─── CONFIGURATION — edit these before running ────────────────────────────────
APP_DIR="/opt/shreeja"
APP_USER="shreeja"
DB_NAME="dairy_transport"
DB_USER="shreeja_db"
DB_PASS="$(openssl rand -base64 20)"   # auto-generated; saved to /root/shreeja-secrets.txt
JWT_SECRET="$(openssl rand -base64 32)"
DOMAIN=""            # e.g. transport.yourcompany.com — leave blank to skip SSL
SMTP_USER=""         # Gmail address for email reports
SMTP_PASS=""         # Gmail App Password
SMTP_FROM="Shreeja Transport <$SMTP_USER>"

# ─────────────────────────────────────────────────────────────────────────────
echo "=== [1/8] System update ==="
apt-get update -qq
apt-get upgrade -y -qq

# ─── Node.js 20 ───────────────────────────────────────────────────────────────
echo "=== [2/8] Installing Node.js 20 ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# ─── PostgreSQL 16 ────────────────────────────────────────────────────────────
echo "=== [3/8] Installing PostgreSQL 16 ==="
apt-get install -y postgresql postgresql-contrib
systemctl enable postgresql
systemctl start postgresql

# ─── Nginx ────────────────────────────────────────────────────────────────────
echo "=== [4/8] Installing Nginx ==="
apt-get install -y nginx certbot python3-certbot-nginx
systemctl enable nginx

# ─── PM2 ─────────────────────────────────────────────────────────────────────
echo "=== [5/8] Installing PM2 ==="
npm install -g pm2

# ─── App user ─────────────────────────────────────────────────────────────────
echo "=== [6/8] Creating app user ==="
if ! id "$APP_USER" &>/dev/null; then
  useradd -m -s /bin/bash "$APP_USER"
fi

# ─── PostgreSQL DB setup ──────────────────────────────────────────────────────
echo "=== [7/8] Setting up PostgreSQL database ==="
sudo -u postgres psql <<EOF
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS';
  END IF;
END
\$\$;
CREATE DATABASE $DB_NAME OWNER $DB_USER;
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
EOF

# ─── Secrets file ─────────────────────────────────────────────────────────────
cat > /root/shreeja-secrets.txt <<EOF
== Shreeja Transport — Generated Secrets ==
Date: $(date)
DB_USER: $DB_USER
DB_PASS: $DB_PASS
JWT_SECRET: $JWT_SECRET
App Dir: $APP_DIR
EOF
chmod 600 /root/shreeja-secrets.txt
echo "Secrets saved to /root/shreeja-secrets.txt"

# ─── Directory structure ──────────────────────────────────────────────────────
mkdir -p "$APP_DIR"/{backend,frontend-build,logs}
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo ""
echo "======================================================="
echo "PREREQUISITES INSTALLED. Now copy your project files:"
echo "  scp -r /path/to/backend  root@<server>:$APP_DIR/"
echo "  scp -r /path/to/frontend root@<server>:$APP_DIR/"
echo "Then re-run this script with: sudo bash deploy.sh --continue"
echo "======================================================="
echo ""

if [[ "${1:-}" != "--continue" ]]; then
  echo "Stopping here. Run again with --continue after copying files."
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# PART 2 — runs after project files are copied
# ─────────────────────────────────────────────────────────────────────────────

echo "=== Checking project files ==="
[[ -d "$APP_DIR/backend" ]]  || { echo "ERROR: $APP_DIR/backend not found"; exit 1; }
[[ -d "$APP_DIR/frontend" ]] || { echo "ERROR: $APP_DIR/frontend not found"; exit 1; }

# ─── Backend .env ─────────────────────────────────────────────────────────────
echo "=== Creating backend .env ==="
cat > "$APP_DIR/backend/.env" <<EOF
PORT=5000
NODE_ENV=production

DB_HOST=localhost
DB_PORT=5432
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS

JWT_SECRET=$JWT_SECRET
JWT_EXPIRES_IN=8h

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=$SMTP_USER
SMTP_PASS=$SMTP_PASS
SMTP_FROM=$SMTP_FROM

FRONTEND_URL=http://${DOMAIN:-localhost}
EOF
chown "$APP_USER":"$APP_USER" "$APP_DIR/backend/.env"
chmod 600 "$APP_DIR/backend/.env"

# ─── Backend dependencies ─────────────────────────────────────────────────────
echo "=== Installing backend dependencies ==="
cd "$APP_DIR/backend"
sudo -u "$APP_USER" npm ci --omit=dev

# ─── Run migrations ───────────────────────────────────────────────────────────
echo "=== Running database migrations ==="
cd "$APP_DIR/backend"
sudo -u "$APP_USER" node src/config/migrate.js

# Also run the optimizer migration
PGPASSWORD="$DB_PASS" psql -U "$DB_USER" -h localhost -d "$DB_NAME" \
  -f "$APP_DIR/backend/migrations/002_distance_and_optimizer.sql" 2>/dev/null || true

# ─── Frontend build ───────────────────────────────────────────────────────────
echo "=== Building frontend ==="
cd "$APP_DIR/frontend"
sudo -u "$APP_USER" npm ci
sudo -u "$APP_USER" npm run build
cp -r dist/* "$APP_DIR/frontend-build/"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR/frontend-build"

# ─── PM2 setup ────────────────────────────────────────────────────────────────
echo "=== Configuring PM2 ==="
cat > "$APP_DIR/ecosystem.config.js" <<'EOF'
module.exports = {
  apps: [{
    name: 'shreeja-backend',
    script: './backend/src/app.js',
    cwd: '/opt/shreeja',
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV: 'production' },
    out_file: '/opt/shreeja/logs/out.log',
    error_file: '/opt/shreeja/logs/err.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    max_memory_restart: '512M',
    restart_delay: 3000,
    watch: false,
  }]
};
EOF
chown "$APP_USER":"$APP_USER" "$APP_DIR/ecosystem.config.js"

cd "$APP_DIR"
sudo -u "$APP_USER" pm2 start ecosystem.config.js
sudo -u "$APP_USER" pm2 save
pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" | tail -1 | bash || true

# ─── Nginx configuration ──────────────────────────────────────────────────────
echo "=== Configuring Nginx ==="
NGINX_CONF="/etc/nginx/sites-available/shreeja"

if [[ -n "$DOMAIN" ]]; then
  SERVER_NAME="$DOMAIN"
else
  SERVER_NAME="_"
fi

cat > "$NGINX_CONF" <<EOF
upstream shreeja_backend {
    server 127.0.0.1:5000;
    keepalive 64;
}

server {
    listen 80;
    server_name $SERVER_NAME;

    # Security headers
    add_header X-Content-Type-Options  nosniff;
    add_header X-Frame-Options         SAMEORIGIN;
    add_header X-XSS-Protection        "1; mode=block";
    add_header Referrer-Policy         strict-origin-when-cross-origin;

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
    gzip_vary on;

    client_max_body_size 20M;

    # Frontend — serve built React app
    root $APP_DIR/frontend-build;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
        expires 1h;
        add_header Cache-Control "public, max-age=3600";
    }

    # Static assets — long cache
    location ~* \.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$ {
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
    }

    # API — proxy to Node.js backend
    location /api/ {
        proxy_pass         http://shreeja_backend;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade          \$http_upgrade;
        proxy_set_header   Connection       keep-alive;
        proxy_set_header   Host             \$host;
        proxy_set_header   X-Real-IP        \$remote_addr;
        proxy_set_header   X-Forwarded-For  \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }

    # Health check
    location /api/health {
        proxy_pass http://shreeja_backend;
        access_log off;
    }
}
EOF

ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/shreeja
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ─── SSL with Let's Encrypt ───────────────────────────────────────────────────
if [[ -n "$DOMAIN" ]]; then
  echo "=== Obtaining SSL certificate for $DOMAIN ==="
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN" \
    --redirect || echo "SSL setup failed — run manually: certbot --nginx -d $DOMAIN"
fi

# ─── Firewall ─────────────────────────────────────────────────────────────────
echo "=== Configuring UFW firewall ==="
apt-get install -y ufw
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 'Nginx Full'
ufw --force enable

# ─── Final health check ───────────────────────────────────────────────────────
echo "=== Health check ==="
sleep 3
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost/api/health || echo "000")
if [[ "$HTTP_CODE" == "200" ]]; then
  echo "✓ Backend is responding (HTTP 200)"
else
  echo "⚠ Backend health check returned HTTP $HTTP_CODE — check logs:"
  echo "  sudo -u $APP_USER pm2 logs shreeja-backend --lines 30"
fi

echo ""
echo "============================================================"
echo "  DEPLOYMENT COMPLETE"
echo "============================================================"
echo "  App URL  : http://${DOMAIN:-<server-ip>}"
if [[ -n "$DOMAIN" ]]; then
echo "  HTTPS    : https://$DOMAIN"
fi
echo "  Admin    : admin / Admin@1234  (CHANGE THIS IMMEDIATELY)"
echo "  Secrets  : /root/shreeja-secrets.txt"
echo ""
echo "  Useful commands:"
echo "  sudo -u $APP_USER pm2 status"
echo "  sudo -u $APP_USER pm2 logs shreeja-backend"
echo "  sudo -u $APP_USER pm2 restart shreeja-backend"
echo "  sudo nginx -t && sudo systemctl reload nginx"
echo "  journalctl -u nginx -f"
echo "============================================================"
