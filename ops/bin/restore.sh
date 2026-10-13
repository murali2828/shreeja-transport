#!/usr/bin/env bash
# ===========================================================================
# ops-kit Postgres RESTORE — point-in-time (pgBackRest) or from a logical dump.
# NEVER restores over the live database directly: the chosen point is first
# rebuilt in a SCRATCH cluster (own Docker volume, own container on
# 127.0.0.1:5599), verified (row counts printed), and only `--swap` — with a
# typed confirmation — replaces the tier's data, after tarring the current data
# directory as a safety copy. Guide + drill: ops/docs/backup-restore.md.
#
#   restore.sh <tier> --time "2026-09-05 23:14:00+05:30" [--swap]   # PITR to that second
#   restore.sh <tier> --latest [--swap]                             # newest backup + all WAL
#   restore.sh <tier> --backup 20260906-011500F [--swap]            # a specific backup set
#   restore.sh <tier> --dump <BACKUP_DIR>/dumps/<tier>-<date>.sql.gz[.enc] [--swap]
#   restore.sh <tier> --latest --from-nas --swap                    # DR on a NEW server: repository read from the NAS
#   restore.sh <tier> --cleanup                                     # remove the scratch container/volume
# ===========================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
TIER="${1:-}"; shift || true
usage() { awk 'NR>2 && /^# =+$/ {exit} NR>2 {sub(/^# ?/, ""); print}' "$0"; exit 2; }
ops_load; ops_tier "$TIER" || usage

MODE=""; TARGET=""; SWAP=0; FROM_NAS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --time)   MODE=time;   TARGET="$2"; shift 2 ;;
    --latest) MODE=latest; shift ;;
    --backup) MODE=backup; TARGET="$2"; shift 2 ;;
    --dump)   MODE=dump;   TARGET="$2"; shift 2 ;;
    --swap)   SWAP=1; shift ;;
    --from-nas) FROM_NAS=1; shift ;;
    --cleanup) MODE=cleanup; shift ;;
    *) echo "unknown option $1"; usage ;;
  esac
done
[[ -n "$MODE" ]] || usage
[[ -n "$DB_PASS" ]] || { echo "${TIER_U}_DB_PASS missing in .env.deploy"; exit 1; }

IMAGE="$DB_IMAGE"
SCRATCH_VOL="$PROJECT-restore"; SCRATCH_CT="$PROJECT-restore"
LIVE_VOL="$PGVOL_NAME"
PORT=5599
LOG="$BACKUP_DIR/restore-$TIER.log"
CONFD="$KIT/postgres/conf.d"

ts() { ops_ts; }
log() { echo "[$(ts)] [$TIER restore] $*" | tee -a "$LOG" >&2; }
dc() { ops_dc "$@"; }
scratch_psql() { docker exec -i "$SCRATCH_CT" psql -v ON_ERROR_STOP=1 -qAtX -U "$DB_USER" "$DB_NAME" "$@"; }
cleanup_scratch() { docker rm -f "$SCRATCH_CT" >/dev/null 2>&1 || true; docker volume rm "$SCRATCH_VOL" >/dev/null 2>&1 || true; }
[[ "$MODE" == "cleanup" ]] && { cleanup_scratch; log "scratch container + volume removed"; exit 0; }

docker image inspect "$IMAGE" >/dev/null 2>&1 || { log "building $IMAGE"; dc build "$OPS_DB_SERVICE"; }

if [[ "$FROM_NAS" == "1" && "$MODE" != "dump" ]]; then
  NAS="${BACKUP_NAS_DIR:?BACKUP_NAS_DIR must be set in .env.deploy for --from-nas}"
  mountpoint -q "$NAS" || { log "NAS $NAS is not mounted"; exit 1; }
  src=""
  for cand in "$NAS/pg-$TIER" $(ls -d "$NAS"/*/pg-"$TIER" 2>/dev/null); do
    [[ -d "$cand/archive/main" && -d "$cand/backup/main" ]] && { src="$cand"; break; }
  done
  [[ -n "$src" ]] || { log "no pgBackRest repository for stanza main found under $NAS"; exit 1; }
  log "seeding local repository $REPO from $src"
  mkdir -p "$REPO"; rsync -a "$src/" "$REPO/"
  docker run --rm -v "$REPO:/backups" alpine:3.20 chown -R 999:999 /backups
fi

log "MODE=$MODE TARGET=${TARGET:-} — fresh scratch cluster on volume $SCRATCH_VOL"
cleanup_scratch
docker volume create "$SCRATCH_VOL" >/dev/null
common_mounts=(-v "$SCRATCH_VOL:/var/lib/postgresql/data" -v "$REPO:/backups" -v "$CONFD:/etc/pgbackrest/conf.d:ro" -e "PGBACKREST_PG1_USER=$DB_USER")

if [[ "$MODE" == "dump" ]]; then
  [[ -f "$TARGET" ]] || { log "dump file not found: $TARGET"; exit 1; }
  if [[ "$TARGET" == *.enc ]]; then
    [[ -n "$DATA_PASS" ]] || { read -r -s -p "Data passphrase (BACKUP_DATA_PASSPHRASE) for $TARGET: " DATA_PASS; echo; }
    docker image inspect "$TOOLS_IMG" >/dev/null 2>&1 || docker build -q -t "$TOOLS_IMG" "$KIT/tools" >/dev/null
    plain="$BACKUP_DIR/.restore-$TIER-$$.sql.gz"; trap 'rm -f "$plain"' EXIT
    log "decrypting $TARGET"
    docker run --rm -i -e PASS="$DATA_PASS" "$TOOLS_IMG" openssl enc -d -aes-256-cbc -pbkdf2 -pass env:PASS < "$TARGET" > "$plain" || { log "decrypt FAILED — wrong passphrase?"; exit 1; }
    gzip -t "$plain" || { log "decrypted file is not a valid gzip — wrong passphrase?"; exit 1; }
    TARGET="$plain"
  fi
  log "starting empty scratch cluster"
  docker run -d --name "$SCRATCH_CT" "${common_mounts[@]}" -e "POSTGRES_USER=$DB_USER" -e "POSTGRES_PASSWORD=$DB_PASS" -e "POSTGRES_DB=$DB_NAME" \
    -e "TZ=$OPS_TZ" -e "PGTZ=$OPS_TZ" -p "127.0.0.1:$PORT:5432" "$IMAGE" postgres -c archive_mode=off >/dev/null
  for _ in $(seq 1 60); do docker exec "$SCRATCH_CT" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 && break; sleep 2; done
  scratch_psql -c "CREATE ROLE \"$APP_USER\" LOGIN PASSWORD 'restore-placeholder' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT" >/dev/null 2>&1 || true
  log "loading $TARGET"
  gunzip -c "$TARGET" | docker exec -i "$SCRATCH_CT" psql -qX -U "$DB_USER" "$DB_NAME" 2> >(grep -v '^$' | tee -a "$LOG" >&2 | tail -n 20 >/dev/null) >/dev/null || true
else
  restore_args=(--stanza=main restore)
  case "$MODE" in
    time)   restore_args+=(--type=time "--target=$TARGET" --target-action=promote) ;;
    backup) restore_args+=(--set="$TARGET" --type=immediate --target-action=promote) ;;
    latest) ;;
  esac
  log "pgbackrest ${restore_args[*]}"
  docker run --rm --user postgres "${common_mounts[@]}" "$IMAGE" pgbackrest "${restore_args[@]}" 2>&1 | tee -a "$LOG"
  log "starting scratch cluster to replay WAL (archive_mode=off)"
  docker run -d --name "$SCRATCH_CT" "${common_mounts[@]}" -e "POSTGRES_PASSWORD=$DB_PASS" \
    -e "TZ=$OPS_TZ" -e "PGTZ=$OPS_TZ" -p "127.0.0.1:$PORT:5432" "$IMAGE" postgres -c archive_mode=off >/dev/null
  for _ in $(seq 1 150); do
    if docker exec "$SCRATCH_CT" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      inrec=$(scratch_psql -c "SELECT pg_is_in_recovery()" 2>/dev/null || echo t)
      [[ "$inrec" == "f" ]] && break
    fi
    sleep 2
  done
  [[ "$(scratch_psql -c 'SELECT pg_is_in_recovery()')" == "f" ]] || { log "scratch cluster did not finish recovery — see: docker logs $SCRATCH_CT"; exit 1; }
fi

log "scratch cluster ready on 127.0.0.1:$PORT (user $DB_USER, db $DB_NAME). Verification:"
if [[ -n "$OPS_VERIFY_SQL" && -f "$(_abs "$OPS_VERIFY_SQL")" ]]; then
  scratch_psql < "$(_abs "$OPS_VERIFY_SQL")" | tee -a "$LOG"
else
  scratch_psql <<'SQL' | tee -a "$LOG"
SELECT 'now() in restored cluster: ' || now();
SELECT rpad(tablename, 40) || (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM ' || quote_ident(tablename), false, true, '')))[1]::text
  FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
SQL
fi

if [[ "$SWAP" != "1" ]]; then
  cat <<EOF

Inspect it:   psql -h 127.0.0.1 -p $PORT -U $DB_USER $DB_NAME
Adopt it:     $0 $TIER --$MODE${TARGET:+ "$TARGET"} --swap
Discard it:   $0 $TIER --cleanup
EOF
  exit 0
fi

echo; echo "About to REPLACE the live $TIER database ($LIVE_VOL) with the restored copy."
echo "The current data directory is first archived to $BACKUP_DIR/pre-restore-$TIER-*.tar.gz."
read -r -p "Type the tier name ($TIER) to continue: " confirm
[[ "$confirm" == "$TIER" ]] || { log "swap aborted"; exit 1; }

log "stopping the $TIER stack"
dc stop
docker stop "$SCRATCH_CT" >/dev/null
safety="$BACKUP_DIR/pre-restore-$TIER-$(date +%F-%H%M%S).tar.gz"
log "safety copy of the current data directory → $safety"
docker run --rm -v "$LIVE_VOL:/data:ro" -v "$BACKUP_DIR:/out" alpine:3.20 sh -c "tar czf /out/$(basename "$safety") -C /data ."
log "copying restored cluster into $LIVE_VOL"
docker run --rm -v "$SCRATCH_VOL:/src:ro" -v "$LIVE_VOL:/dst" alpine:3.20 sh -c 'rm -rf /dst/* /dst/.[!.]* 2>/dev/null; cp -a /src/. /dst/'
log "starting the $TIER stack"
dc up -d
for _ in $(seq 1 30); do dc exec -T "$OPS_DB_SERVICE" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 && break; sleep 2; done
if [[ -n "$OPS_HARDEN_SQL" ]]; then
  log "re-applying DB privileges"
  "$KIT/bin/deploy.sh" "$TIER" --harden-only || log "WARNING: harden step failed — run $OPS_KIT_DIR/bin/deploy.sh $TIER --harden-only"
fi
log "taking a fresh FULL backup on the new timeline"
"$KIT/bin/backup.sh" "$TIER" backup full || log "WARNING: post-restore backup failed — run backup.sh $TIER backup full"
cleanup_scratch
log "restore complete. Check the application health endpoint and log in."
