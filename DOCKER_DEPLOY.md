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
