#!/bin/bash
# =============================================================================
# Shreeja Transport — Database Backup Script
# Add to cron: 0 2 * * * /opt/shreeja/deploy/backup.sh >> /opt/shreeja/logs/backup.log 2>&1
# =============================================================================

set -euo pipefail

APP_DIR="/opt/shreeja"
BACKUP_DIR="/opt/shreeja/backups"
DB_NAME="dairy_transport"
DB_USER="shreeja_db"
KEEP_DAYS=30

mkdir -p "$BACKUP_DIR"

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/dairy_transport_$DATE.sql.gz"

# Load DB password from .env
DB_PASS=$(grep DB_PASSWORD "$APP_DIR/backend/.env" | cut -d= -f2)

echo "$(date) — Starting backup..."
PGPASSWORD="$DB_PASS" pg_dump -U "$DB_USER" -h localhost "$DB_NAME" | gzip > "$BACKUP_FILE"
echo "$(date) — Backup saved: $BACKUP_FILE ($(du -sh "$BACKUP_FILE" | cut -f1))"

# Remove old backups
find "$BACKUP_DIR" -name "*.sql.gz" -mtime "+$KEEP_DAYS" -delete
echo "$(date) — Old backups cleaned (keeping last $KEEP_DAYS days)"
echo "$(date) — Current backups: $(ls -1 "$BACKUP_DIR" | wc -l) files"
