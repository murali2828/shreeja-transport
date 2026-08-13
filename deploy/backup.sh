#!/bin/bash
# =============================================================================
# Shreeja Transport — Database Backup Script (dockerized deployment)
# Dumps via docker exec (the DB port is deliberately NOT published to the host).
#
# Install (as the deploy user):
#   crontab -e
#   0 2 * * * /home/chaitanya/shreeja-transport/deploy/backup.sh >> $HOME/shreeja-backups/backup.log 2>&1
#
# IMPORTANT: on-host backups die with the server. Copy $BACKUP_DIR off-box
# (rsync to another machine / S3 / object storage) as a second step.
# =============================================================================

set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-shreeja-db}"       # shreeja-qa-db for the QA stack
BACKUP_DIR="${BACKUP_DIR:-$HOME/shreeja-backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$BACKUP_DIR"

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/${DB_CONTAINER}_$DATE.sql.gz"

echo "$(date) — Starting backup of $DB_CONTAINER..."
# Credentials come from inside the container's own environment — nothing to
# read from .env files and no PGPASSWORD in the host process table.
docker exec "$DB_CONTAINER" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | gzip > "$BACKUP_FILE"

# A backup that silently produced (near-)nothing is worse than a loud failure.
SIZE_BYTES=$(stat -c%s "$BACKUP_FILE")
if [ "$SIZE_BYTES" -lt 10240 ]; then
  echo "$(date) — ERROR: backup is only ${SIZE_BYTES} bytes — treating as FAILED."
  exit 1
fi
echo "$(date) — Backup saved: $BACKUP_FILE ($(du -sh "$BACKUP_FILE" | cut -f1))"

find "$BACKUP_DIR" -name "*.sql.gz" -mtime "+$KEEP_DAYS" -delete
echo "$(date) — Old backups cleaned (keeping last $KEEP_DAYS days); $(ls -1 "$BACKUP_DIR" | grep -c 'sql.gz$' || true) files present"
