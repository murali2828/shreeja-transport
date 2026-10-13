#!/usr/bin/env bash
# ===========================================================================
# ops-kit shared loader — sourced by every script in ops/bin. Reads
#   <repo>/ops.env       project identity + per-tier settings (COMMITTED, no secrets)
#   <repo>/.env.deploy   secrets (git-ignored; template in ops/env.deploy.example)
# and resolves the current tier into plain variables the scripts use.
#
# Callers set ROOT (the repository root) before sourcing, then:
#   ops_load           # ops.env + .env.deploy → OPS_* and BACKUP_*/ALERT_* vars
#   ops_tier <tier>    # → COMPOSE PROJECT BRANCH HOST API_PORT ENV_FILE DB_* APP_* PGVOL UPLOADS_VOL MIGRATE_CMD …
#
# Per-tier values are read from ops.env as <TIER>_<NAME> (QA_HOST, PROD_HOST …)
# with defaults derived from OPS_SLUG + the tier, so a project that follows
# the conventions needs only a handful of lines. See ops/ops.env.example.
# ===========================================================================

ops_load() {
  [[ -f "$ROOT/ops.env" ]] || { echo "Missing $ROOT/ops.env — copy ops/ops.env.example to the repo root and fill it in."; exit 1; }
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/ops.env"
  # shellcheck disable=SC1091
  [[ -f "$ROOT/.env.deploy" ]] && . "$ROOT/.env.deploy"
  set +a
  OPS_SLUG="${OPS_SLUG:?OPS_SLUG missing in ops.env}"
  OPS_LABEL="${OPS_LABEL:-${OPS_SLUG^^}}"
  OPS_TIERS="${OPS_TIERS:-qa prod}"
  OPS_KIT_DIR="${OPS_KIT_DIR:-ops}"
  KIT="$ROOT/$OPS_KIT_DIR"
  OPS_APP_DIR="${OPS_APP_DIR:-$ROOT}"
  BACKUP_DIR="${BACKUP_DIR:-${OPS_BACKUP_DIR:-$OPS_APP_DIR/backups}}"; export BACKUP_DIR
  OPS_DB_SERVICE="${OPS_DB_SERVICE:-postgres}"
  OPS_API_SERVICE="${OPS_API_SERVICE:-api}"
  OPS_REDIS_SERVICE="${OPS_REDIS_SERVICE-redis}"          # set to "" in ops.env when the stack has no Redis
  OPS_SERVICES="${OPS_SERVICES:-$OPS_DB_SERVICE ${OPS_REDIS_SERVICE} $OPS_API_SERVICE web}"
  OPS_APP_SERVICES="${OPS_APP_SERVICES:-$OPS_API_SERVICE web}"
  OPS_HEALTH_PATH="${OPS_HEALTH_PATH:-/api/v1/health}"
  OPS_READY_PATH="${OPS_READY_PATH-/api/v1/health/ready}"       # "" = skip
  OPS_BACKUP_HEALTH_PATH="${OPS_BACKUP_HEALTH_PATH-/api/v1/health/backup}"   # "" = skip
  OPS_WEB_PATH="${OPS_WEB_PATH-/}"                               # "" = skip
  OPS_HEALTH_SHA_FIELD="${OPS_HEALTH_SHA_FIELD:-data.git_sha}"
  OPS_NGINX_SITE="${OPS_NGINX_SITE:-}"; OPS_NGINX_SRC="${OPS_NGINX_SRC:-}"
  OPS_HARDEN_SQL="${OPS_HARDEN_SQL:-}"; OPS_VERIFY_SQL="${OPS_VERIFY_SQL:-}"
  OPS_MASTERS_CMD="${OPS_MASTERS_CMD:-}"
  OPS_MASTERS_CONTAINER_DIR="${OPS_MASTERS_CONTAINER_DIR:-/app/backups/masters}"
  OPS_ESCROW="${OPS_ESCROW:-yes}"
  OPS_CODE_REMOTE="${OPS_CODE_REMOTE:-}"
  OPS_TZ="${OPS_TZ:-UTC}"
  TOOLS_IMG="${OPS_SLUG}-backup-tools"
  HOST_TAG="$(hostname -s)"
  # Encryption at rest: files (dumps, master exports, escrow) + the pgBackRest repository
  DATA_PASS="${BACKUP_DATA_PASSPHRASE:-${BACKUP_CONFIG_PASSPHRASE:-}}"
  CIPHER_CONF="$KIT/postgres/conf.d/cipher.conf"
}

# tvar NAME DEFAULT → the value of <TIER_U>_NAME, else DEFAULT
tvar() { local n="${TIER_U}_$1"; printf '%s' "${!n:-$2}"; }
_abs() { [[ -z "$1" || "$1" == /* ]] && printf '%s' "$1" || printf '%s' "$ROOT/$1"; }

ops_tier() {
  TIER="${1:-}"
  [[ -n "$TIER" && " $OPS_TIERS " == *" $TIER "* ]] || { echo "tier must be one of: $OPS_TIERS"; return 2; }
  TIER_U="${TIER^^}"
  COMPOSE="$(_abs "$(tvar COMPOSE "docker-compose.$TIER.yml")")"
  PROJECT="$(tvar PROJECT "$OPS_SLUG-$TIER")"                  # compose project name — must equal `name:` in the compose file
  BRANCH="$(tvar BRANCH "$( [[ "$TIER" == prod ]] && echo main || echo "$TIER" )")"
  HOST="$(tvar HOST "")"                                       # public hostname (no scheme); "" = no public checks
  API_PORT="$(tvar API_PORT "")"                               # host port the API container publishes; "" = skip local check
  ENV_FILE="$(_abs "$(tvar ENV_FILE "")")"                     # the app's env file (goes into the config bundle)
  DB_USER="$(tvar DB_USER "${OPS_SLUG}_${TIER}_user")"         # OWNER role (migrations/backups)
  DB_NAME="$(tvar DB_NAME "${OPS_SLUG}_${TIER}_db")"
  DB_PASS="$(tvar DB_PASS "")"
  APP_USER="$(tvar DB_APP_USER "${OPS_SLUG}_${TIER}_app")"     # runtime role (no DELETE on masters)
  APP_PASS="$(tvar DB_APP_PASS "")"
  REDIS_PASS="$(tvar REDIS_PASS "")"
  PGVOL="$(tvar PGDATA_VOL "${TIER}_pgdata")"                  # compose volume name WITHOUT the project prefix
  UPLOADS_VOL="$(tvar UPLOADS_VOL "${TIER}_uploads")"          # "" or "none" = no uploads volume to back up
  DB_IMAGE="$(tvar DB_IMAGE "$PROJECT-postgres")"
  # Optional overrides for stacks that predate the kit's naming:
  #   <TIER>_COMPOSE_ENV   space-separated env files passed to every `docker compose`
  #                        call as --env-file (interpolation; e.g. ".env.qa .env.deploy")
  #   <TIER>_PGDATA_VOLUME / <TIER>_UPLOADS_VOLUME   full docker volume names when the
  #                        compose file pins `name:` on its volumes [<project>_<vol>]
  COMPOSE_ENV_ARGS=(); for f in $(tvar COMPOSE_ENV ""); do COMPOSE_ENV_ARGS+=(--env-file "$(_abs "$f")"); done
  PGVOL_NAME="$(tvar PGDATA_VOLUME "${PROJECT}_${PGVOL}")"
  UPLOADS_VOL_NAME="$(tvar UPLOADS_VOLUME "${PROJECT}_${UPLOADS_VOL}")"
  MIGRATE_CMD="$(tvar MIGRATE_CMD "npm run migrate")"
  SEED_CMD="$(tvar SEED_CMD "npm run seed:one --")"            # a seed file name is appended
  MASTERS_CMD="$(tvar MASTERS_CMD "$OPS_MASTERS_CMD")"         # "" = the project has no master export
  REPO="$BACKUP_DIR/pg-$TIER"; DUMPS="$BACKUP_DIR/dumps"; MASTERS="$BACKUP_DIR/masters-$TIER"
  UPLOADS_DIR="$BACKUP_DIR/uploads-$TIER"; CONFIGS="$BACKUP_DIR/config"; CODE="$BACKUP_DIR/code"; ESCROW="$BACKUP_DIR/escrow"
  return 0
}

ops_ts() { date '+%F %T'; }

# docker compose for the current tier: explicit project name + optional env files.
ops_dc() { docker compose -p "$PROJECT" -f "$COMPOSE" "${COMPOSE_ENV_ARGS[@]}" "$@"; }
