#!/usr/bin/env bash
# ===========================================================================
# ops-kit DEPLOY — the ONE way code reaches a tier. Every step that can lose
# data is either impossible from here or preceded by a backup:
#   1. logical dump of the tier's database (backup.sh dump)   ← before anything else
#   2. git fetch + FAST-FORWARD-ONLY checkout of the tier's branch
#   3. docker compose build <app services> + up (the DB image is built only on
#      first bring-up — never rebuilt, so the DB never restarts, unless --rebuild-db)
#   4. migrations (<TIER>_MIGRATE_CMD, run in the API container as the owner role)
#   5. ops/db/harden-privileges.sql (app role cannot DELETE masters) — when OPS_HARDEN_SQL is set
#   6. seeds ONLY when named explicitly: --seed <file>            (<TIER>_SEED_CMD)
#   7. host nginx site copy + test + reload                        — when OPS_NGINX_SITE/OPS_NGINX_SRC are set
#   8. health check: the running git sha (OPS_HEALTH_SHA_FIELD in OPS_HEALTH_PATH) must equal HEAD
#
#   deploy.sh <tier>                          # normal update
#   deploy.sh <tier> --seed <file> [--seed <file>]
#   deploy.sh <tier> --harden-only            # just re-apply DB privileges
#   deploy.sh <tier> --no-pull                # deploy the checkout as-is
#   deploy.sh <tier> --rebuild-db             # the DB image changed: rebuild + RESTART the database (maintenance window)
# ===========================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
TIER="${1:-}"; shift || true
usage() { awk 'NR>2 && /^# =+$/ {exit} NR>2 {sub(/^# ?/, ""); print}' "$0"; exit 2; }
[[ -f "$ROOT/.env.deploy" ]] || { echo "Missing $ROOT/.env.deploy — copy ops/env.deploy.example and fill it in (chmod 600)."; exit 1; }
ops_load; ops_tier "$TIER" || usage

SEEDS=(); PULL=1; HARDEN_ONLY=0; REBUILD_DB=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --seed) SEEDS+=("$2"); shift 2 ;;
    --no-pull) PULL=0; shift ;;
    --harden-only) HARDEN_ONLY=1; shift ;;
    --rebuild-db) REBUILD_DB=1; shift ;;
    *) echo "unknown option $1"; usage ;;
  esac
done

LOG="$BACKUP_DIR/deploy-$TIER.log"; mkdir -p "$BACKUP_DIR"
ts() { ops_ts; }
log() { echo "[$(ts)] [deploy $TIER] $*" | tee -a "$LOG" >&2; }
dc() { ops_dc "$@"; }
# shellcheck disable=SC1091
. "$KIT/bin/mail.sh"
on_fail() {
  local rc=$? line=$1
  [[ $rc -eq 0 ]] && return 0
  log "=== deploy FAILED (exit $rc at line $line) ==="
  alert_mail "[$OPS_LABEL ${TIER^^}] deploy FAILED on $HOST_TAG" "$OPS_KIT_DIR/bin/deploy.sh $TIER failed at $(ts) (exit $rc, script line $line).
Last log lines:
$(tail -n 25 "$LOG")

The pre-deploy dump is under $BACKUP_DIR/dumps/. The stack may be partly updated — check:
  docker compose -f $(basename "$COMPOSE") ps" || true
  exit "$rc"
}
trap 'on_fail $LINENO' ERR

harden() {
  [[ -n "$OPS_HARDEN_SQL" ]] || { log "no OPS_HARDEN_SQL configured — privilege step skipped"; return 0; }
  [[ -n "$APP_PASS" ]] || { log "${TIER_U}_DB_APP_PASS missing in .env.deploy"; return 1; }
  log "applying DB privileges (app role $APP_USER)"
  dc exec -T "$OPS_DB_SERVICE" sh -c "psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" \"\$POSTGRES_DB\" -v app_role='$APP_USER' -v app_pass='$APP_PASS'" \
    < "$(_abs "$OPS_HARDEN_SQL")" 2>&1 | tee -a "$LOG"
}
if [[ "$HARDEN_ONLY" == "1" ]]; then harden; exit 0; fi

cd "$ROOT"
log "=== deploy start (branch $BRANCH) ==="
if dc ps --status running "$OPS_DB_SERVICE" 2>/dev/null | grep -q "$OPS_DB_SERVICE"; then
  "$KIT/bin/backup.sh" "$TIER" dump
else
  log "database not running yet (first bring-up) — no pre-deploy dump"
fi

if [[ "$PULL" == "1" ]]; then
  git fetch origin "$BRANCH" 2>&1 | tee -a "$LOG"
  git checkout -q "$BRANCH"
  git merge --ff-only "origin/$BRANCH" 2>&1 | tee -a "$LOG"
fi
SHA=$(git rev-parse --short HEAD); export GIT_SHA="$SHA"
log "deploying $SHA"

# Build the APP images only. `up -d --build` also rebuilt the database image;
# with every layer cached BuildKit still wrote a fresh manifest, Compose saw a
# changed image and RECREATED the database on every deploy (Assure, 1 Oct
# 2026: a webhook push landed on that restart and was lost). `up -d` builds a
# missing image on first bring-up and otherwise leaves the DB container alone;
# a deliberate database-image change is `--rebuild-db` in a maintenance window.
if [[ "$REBUILD_DB" == "1" ]]; then
  log "rebuilding the $OPS_DB_SERVICE image (--rebuild-db) — the database WILL restart"
  dc build "$OPS_DB_SERVICE" 2>&1 | tee -a "$LOG"
fi
# shellcheck disable=SC2086
dc build $OPS_APP_SERVICES 2>&1 | tee -a "$LOG"
dc up -d 2>&1 | tee -a "$LOG"

log "migrating ($MIGRATE_CMD)"
# shellcheck disable=SC2086
dc run --rm "$OPS_API_SERVICE" $MIGRATE_CMD 2>&1 | tee -a "$LOG"

harden

for s in "${SEEDS[@]:-}"; do
  [[ -n "$s" ]] || continue
  log "seed $s"
  # shellcheck disable=SC2086
  dc run --rm "$OPS_API_SERVICE" $SEED_CMD "$s" 2>&1 | tee -a "$LOG"
done

# shellcheck disable=SC2086
dc up -d $OPS_APP_SERVICES 2>&1 | tee -a "$LOG"

if [[ -n "$OPS_NGINX_SITE" && -n "$OPS_NGINX_SRC" ]]; then
  src="$(_abs "$OPS_NGINX_SRC")"; dst="/etc/nginx/sites-available/$OPS_NGINX_SITE"
  if [[ -w "$dst" || "$(id -u)" == "0" ]]; then cp "$src" "$dst" && nginx -t && systemctl reload nginx
  else sudo cp "$src" "$dst" && sudo nginx -t && sudo systemctl reload nginx; fi
fi

if [[ -n "$HOST" ]]; then
  running=""
  for _ in $(seq 1 30); do
    running=$(curl -fs "https://$HOST$OPS_HEALTH_PATH" | python3 -c '
import json,sys; d=json.load(sys.stdin)
for k in sys.argv[1].split("."): d=d[k]
print(d)' "$OPS_HEALTH_SHA_FIELD" 2>/dev/null || true)
    [[ "$running" == "$SHA" ]] && break
    sleep 2
  done
  if [[ "$running" == "$SHA" ]]; then log "=== deploy OK: https://$HOST is running $SHA ==="
  else log "=== deploy FAILED health check: running '$running', expected '$SHA' — see docker compose logs $OPS_API_SERVICE ==="; exit 1; fi
else
  log "=== deploy done ($SHA); no ${TIER_U}_HOST configured, health not verified ==="
fi
