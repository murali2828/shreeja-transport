#!/bin/bash
# =============================================================================
# Shreeja TMS — restore from deploy/backup.sh output (local dir or NAS copy)
#
#   deploy/restore.sh fetch                      pull the NAS copy into BACKUP_DIR (new server)
#   deploy/restore.sh db <tier> [file|--latest]  restore a DB dump (drill by default: scratch DB, no swap)
#   deploy/restore.sh db <tier> --latest --swap  ... and replace the live database (typed confirmation)
#   deploy/restore.sh uploads <tier> [file|--latest]   restore the uploads volume
#   deploy/restore.sh config [file|--latest]     decrypt the config bundle into ./restored-config/
#   deploy/restore.sh code <tier> <dir>          clone the git bundle into <dir>
#   deploy/restore.sh list                       show what can be restored
#
# Scenario A (bad change, server alive): db --latest (drill) → look → --swap.
# Scenario B (server gone): install docker+lftp → fetch → config → code →
#   docker compose up → db --swap → uploads. Full steps: docs/BACKUP_RESTORE_STRATEGY.md
# =============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${BACKUP_ENV:-$HERE/backup.env}"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 2; }
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${BACKUP_DIR:?}" "${TIERS:?}"
[ -n "${BACKUP_PASSPHRASE:-}" ] || read -rsp "BACKUP_PASSPHRASE (from the vault): " BACKUP_PASSPHRASE
export BACKUP_PASSPHRASE
dec() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE "$@"; }
log() { echo "$(date '+%F %T') $*"; }

tier_field() { # tier index → value  (2 db container, 3 volume, 4 repo, 5 env)
  local t=$1 i=$2
  while IFS='|' read -r name dbc vol repo envf; do
    [ "$name" = "$t" ] && { local v; v=$(eval echo "\${$i}"); eval echo "$v"; return; }
  done <<< "$TIERS"
  echo "unknown tier $t" >&2; exit 2
}
latest() { ls -1t "$1" 2>/dev/null | head -1; }
pick() { # dir pattern arg → file
  local dir=$1 arg=$2
  if [ "$arg" = "--latest" ] || [ -z "$arg" ]; then f=$(latest "$dir"); [ -n "$f" ] || { echo "nothing in $dir"; exit 1; }; echo "$dir/$f"
  else echo "$arg"; fi
}

cmd_fetch() {
  : "${FTP_HOST:?}" "${FTP_USER:?}" "${FTP_PASS:?}" "${FTP_DIR:?}"
  mkdir -p "$BACKUP_DIR"
  lftp -u "$FTP_USER","$FTP_PASS" -p "${FTP_PORT:-21}" "$FTP_HOST" -e "
    set ftp:ssl-allow no; set net:max-retries 3;
    mirror --only-newer --no-perms $FTP_DIR $BACKUP_DIR; bye"
  log "fetched NAS copy into $BACKUP_DIR"; cmd_list
}

cmd_list() {
  for d in dumps/* uploads/* config code; do
    [ -d "$BACKUP_DIR/$d" ] && { echo "== $d"; ls -1t "$BACKUP_DIR/$d" | head -5 | sed 's/^/   /'; }
  done
}

cmd_db() {
  local tier=$1 arg=${2:---latest} swap=${3:-}
  local dbc; dbc=$(tier_field "$tier" 2)
  local file; file=$(pick "$BACKUP_DIR/dumps/$tier" "$arg")
  [ -f "$file" ] || { echo "no such dump $file"; exit 1; }
  docker inspect "$dbc" >/dev/null 2>&1 || { echo "container $dbc not running — bring the tier up first"; exit 1; }
  local scratch="restore_$(date +%s)"
  log "restoring $file into scratch database $scratch on $dbc"
  docker exec "$dbc" sh -c "createdb -U \"\$POSTGRES_USER\" $scratch"
  dec -in "$file" | docker exec -i "$dbc" sh -c "pg_restore -U \"\$POSTGRES_USER\" -d $scratch --no-owner --no-privileges -j 2" \
    || log "pg_restore reported warnings (usually harmless extension/ownership notices) — check counts below"
  echo "── row counts: scratch vs live"
  docker exec "$dbc" sh -c "for db in $scratch \"\$POSTGRES_DB\"; do
      echo \"[\$db]\"; psql -U \"\$POSTGRES_USER\" -d \$db -tAc \"
        SELECT 'trip_plans '||count(*) FROM trip_plans UNION ALL
        SELECT 'trip_executions '||count(*) FROM trip_executions UNION ALL
        SELECT 'trip_acknowledgements '||count(*) FROM trip_acknowledgements UNION ALL
        SELECT 'billing_runs '||count(*) FROM billing_runs UNION ALL
        SELECT 'users '||count(*) FROM users UNION ALL
        SELECT 'schema_migrations '||count(*) FROM schema_migrations\"; done"
  if [ "$swap" != "--swap" ]; then
    log "DRILL complete. Scratch database $scratch left in place; drop with:"
    echo "  docker exec $dbc sh -c 'dropdb -U \"\$POSTGRES_USER\" $scratch'"
    return
  fi
  echo; read -rp "Type the tier name ($tier) to REPLACE the live database with $scratch: " ok
  [ "$ok" = "$tier" ] || { echo "aborted"; exit 1; }
  local backend; backend=${dbc/-db/-backend}
  docker stop "$backend" >/dev/null 2>&1 || true
  docker exec "$dbc" sh -c "
    psql -U \"\$POSTGRES_USER\" -d postgres -c \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='\$POSTGRES_DB' AND pid<>pg_backend_pid()\" >/dev/null;
    psql -U \"\$POSTGRES_USER\" -d postgres -c \"ALTER DATABASE \\\"\$POSTGRES_DB\\\" RENAME TO \\\"\$POSTGRES_DB\\\"_pre_restore_$(date +%Y%m%d%H%M)\";
    psql -U \"\$POSTGRES_USER\" -d postgres -c \"ALTER DATABASE $scratch RENAME TO \\\"\$POSTGRES_DB\\\"\""
  docker start "$backend" >/dev/null
  log "SWAPPED. Old database kept as <db>_pre_restore_<stamp> — drop it once you are satisfied."
}

cmd_uploads() {
  local tier=$1 arg=${2:---latest}
  local vol; vol=$(tier_field "$tier" 3)
  local file; file=$(pick "$BACKUP_DIR/uploads/$tier" "$arg")
  [ -f "$file" ] || { echo "no such archive $file"; exit 1; }
  docker volume create "$vol" >/dev/null
  read -rp "Restore $(basename "$file") into volume $vol (existing files kept, same names overwritten)? [y/N] " ok
  [ "$ok" = y ] || { echo aborted; exit 1; }
  docker run --rm -v "$vol":/dst -v "$(dirname "$file")":/src:ro alpine sh -c "tar xzf /src/$(basename "$file") -C /dst"
  log "uploads restored into $vol ($(docker run --rm -v "$vol":/d alpine sh -c 'find /d -type f | wc -l') files)"
}

cmd_config() {
  local file; file=$(pick "$BACKUP_DIR/config" "${1:---latest}")
  mkdir -p restored-config
  dec -in "$file" | tar xz -C restored-config
  log "config bundle opened into ./restored-config — copy the env files back by hand:"
  find restored-config -maxdepth 4 -name '.env*' -o -name '*.conf' | sed 's/^/   /'
}

cmd_code() {
  local tier=$1 dir=$2
  local b="$BACKUP_DIR/code/${tier}-latest.bundle"
  [ -f "$b" ] || b=$(ls -1t "$BACKUP_DIR"/code/${tier}_*.bundle | head -1)
  git clone "$b" "$dir" && git -C "$dir" checkout "$([ "$tier" = prod ] && echo main || echo qa)"
  log "code restored into $dir (add the GitHub remote later: git remote set-url origin <url>)"
}

case "${1:-}" in
  fetch)   cmd_fetch ;;
  list)    cmd_list ;;
  db)      cmd_db "${2:?tier}" "${3:-}" "${4:-}" ;;
  uploads) cmd_uploads "${2:?tier}" "${3:-}" ;;
  config)  cmd_config "${2:-}" ;;
  code)    cmd_code "${2:?tier}" "${3:?target dir}" ;;
  *) sed -n 2,16p "$0"; exit 1 ;;
esac
