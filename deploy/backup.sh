#!/bin/bash
# =============================================================================
# Shreeja TMS — backup of every tier on this server + encrypted mirror to the NAS
#
#   deploy/backup.sh run              nightly: dumps, uploads, config, code, mirror
#   deploy/backup.sh dumps            DB dumps only (all tiers)
#   deploy/backup.sh uploads          uploads volumes only
#   deploy/backup.sh config           env files + compose + nginx + crontab (encrypted)
#   deploy/backup.sh code             git bundles of both repos
#   deploy/backup.sh mirror           push BACKUP_DIR to the NAS FTP (with shrink guard)
#   deploy/backup.sh status           what exists locally and on the NAS, freshness
#   deploy/backup.sh guard-reset      clear the shrink guard after you understand why it fired
#   deploy/backup.sh install-cron     01:15 nightly run · 4-hourly uploads+mirror
#
# Settings: deploy/backup.env (copy from backup.env.example). Needs: docker,
# openssl, git, lftp (apt install lftp). Runs as the deploy user; DB
# credentials come from inside the container, never from the host.
#
# What is protected            Encrypted   Where
#   Postgres (pg_dump -Fc)       yes        dumps/<tier>/
#   uploads volume (documents)   no*        uploads/<tier>/      *access-controlled share
#   .env / compose / nginx       yes        config/
#   git repos (all branches)     no         code/
# Restore: deploy/restore.sh. Strategy + drills: docs/BACKUP_RESTORE_STRATEGY.md
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${BACKUP_ENV:-$HERE/backup.env}"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (copy backup.env.example)"; exit 2; }
# shellcheck disable=SC1090
. "$ENV_FILE"

: "${BACKUP_DIR:?}" "${BACKUP_PASSPHRASE:?}" "${TIERS:?}"
export BACKUP_PASSPHRASE
STAMP="$(date +%Y%m%d_%H%M%S)"
LOG="$BACKUP_DIR/backup.log"
mkdir -p "$BACKUP_DIR"/{dumps,uploads,config,code,state}

log()  { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }
die()  { log "ERROR: $*"; alert "TMS backup FAILED: $*"; exit 1; }
alert() {
  [ -n "${ALERT_EMAIL_TO:-}" ] && command -v mail >/dev/null 2>&1 \
    && echo "$1 (host $(hostname), $(date))" | mail -s "$1" "$ALERT_EMAIL_TO" || true
}
enc() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE; }

each_tier() { # callback name tier db_container uploads_volume repo_dir env_file
  local cb="$1"
  while IFS='|' read -r name dbc vol repo envf; do
    [ -z "$name" ] && continue
    repo="$(eval echo "$repo")"
    "$cb" "$name" "$dbc" "$vol" "$repo" "$envf"
  done <<< "$TIERS"
}

# ── dumps ────────────────────────────────────────────────────────────────────
dump_tier() {
  local name=$1 dbc=$2
  local out="$BACKUP_DIR/dumps/$name/${name}_${STAMP}.dump.enc"
  mkdir -p "$(dirname "$out")"
  if ! docker inspect -f '{{.State.Running}}' "$dbc" 2>/dev/null | grep -q true; then
    log "skip dump $name: container $dbc not running"; return 0
  fi
  # custom format → pg_restore can restore selectively and in parallel
  docker exec "$dbc" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' | enc > "$out"
  local sz; sz=$(stat -c%s "$out")
  [ "$sz" -ge 10240 ] || die "dump $name is only $sz bytes"
  # prove it decrypts and is a valid archive before we trust it
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$out" \
    | docker exec -i "$dbc" pg_restore -l >/dev/null 2>&1 || die "dump $name failed pg_restore -l check"
  log "dump $name ok $(du -h "$out" | cut -f1) → $out"
  find "$BACKUP_DIR/dumps/$name" -name '*.dump.enc' -mtime "+${KEEP_DAYS_DUMPS:-14}" -delete
}

# ── uploads ──────────────────────────────────────────────────────────────────
uploads_tier() {
  local name=$1 vol=$3
  local out="$BACKUP_DIR/uploads/$name/${name}_uploads_${STAMP}.tar.gz"
  mkdir -p "$(dirname "$out")"
  docker volume inspect "$vol" >/dev/null 2>&1 || { log "skip uploads $name: volume $vol missing"; return 0; }
  docker run --rm -v "$vol":/src:ro -v "$BACKUP_DIR/uploads/$name":/dst alpine \
    sh -c "tar czf /dst/$(basename "$out") -C /src ." || die "uploads $name tar failed"
  tar tzf "$out" >/dev/null || die "uploads $name archive unreadable"
  log "uploads $name ok $(du -h "$out" | cut -f1)"
  find "$BACKUP_DIR/uploads/$name" -name '*.tar.gz' -mtime "+${KEEP_DAYS_UPLOADS:-7}" -delete
}

# ── config bundle (every tier's env + compose + nginx + crontab) ─────────────
config_bundle() {
  local tmp; tmp=$(mktemp -d)
  add() { [ -e "$1" ] && { mkdir -p "$tmp/$(dirname "${1#/}")"; cp -a "$1" "$tmp/${1#/}"; } || true; }
  add_tier_cfg() { local repo=$4 envf=$5
    add "$repo/$envf"; add "$repo/docker-compose.yml"; add "$repo/docker-compose.qa.yml"; add "$repo/deploy/backup.env"; }
  each_tier add_tier_cfg
  add /etc/nginx/nginx.conf; add /etc/nginx/sites-available; add /etc/nginx/sites-enabled; add /etc/nginx/conf.d
  add /etc/letsencrypt/live; add /etc/letsencrypt/renewal
  add /etc/docker/daemon.json
  crontab -l > "$tmp/crontab.$(whoami).txt" 2>/dev/null || true
  docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' > "$tmp/docker-images.txt" 2>/dev/null || true
  local out="$BACKUP_DIR/config/config_${STAMP}.tar.gz.enc"
  tar czf - -C "$tmp" . | enc > "$out"
  rm -rf "$tmp"
  log "config bundle ok $(du -h "$out" | cut -f1) (open with: openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in FILE | tar xz)"
  find "$BACKUP_DIR/config" -name '*.tar.gz.enc' -mtime "+${KEEP_DAYS_CONFIG:-60}" -delete
}

# ── code bundles ─────────────────────────────────────────────────────────────
code_tier() {
  local name=$1 repo=$4
  [ -d "$repo/.git" ] || { log "skip code $name: $repo is not a git repo"; return 0; }
  local out="$BACKUP_DIR/code/${name}_${STAMP}.bundle"
  git -C "$repo" bundle create "$out" --all >/dev/null 2>&1 || die "git bundle $name failed"
  git bundle verify "$out" >/dev/null 2>&1 || die "git bundle $name unverifiable"
  ln -sf "$(basename "$out")" "$BACKUP_DIR/code/${name}-latest.bundle"
  log "code $name ok $(du -h "$out" | cut -f1)"
  find "$BACKUP_DIR/code" -name "${name}_*.bundle" -mtime "+${KEEP_DAYS_CODE:-30}" -delete
}

# ── NAS mirror with shrink guard ─────────────────────────────────────────────
mirror() {
  : "${FTP_HOST:?}" "${FTP_USER:?}" "${FTP_PASS:?}" "${FTP_DIR:?}"
  command -v lftp >/dev/null || die "lftp not installed (apt install lftp)"
  local now last; now=$(du -sb "$BACKUP_DIR" --exclude=backup.log --exclude=state | cut -f1)
  last=$(cat "$BACKUP_DIR/state/last_size" 2>/dev/null || echo 0)
  if [ -f "$BACKUP_DIR/state/guard_blocked" ]; then
    die "mirror blocked by shrink guard since $(cat "$BACKUP_DIR/state/guard_blocked"); run: backup.sh guard-reset"
  fi
  if [ "$last" -gt 0 ] && [ "$now" -lt $(( last * (100 - ${GUARD_SHRINK_PCT:-40}) / 100 )) ]; then
    date > "$BACKUP_DIR/state/guard_blocked"
    die "local backup set shrank from $last to $now bytes — mirror refused (guard)"
  fi
  local tls="set ftp:ssl-allow no"
  [ "${FTP_TLS:-no}" = yes ] && tls="set ftp:ssl-force yes; set ftp:ssl-protect-data yes"
  # mirror -R = upload; no --delete: the NAS keeps what the server lost (snapshots add history)
  lftp -u "$FTP_USER","$FTP_PASS" -p "${FTP_PORT:-21}" "$FTP_HOST" -e "
    $tls; set net:max-retries 3; set net:timeout 60;
    mkdir -p $FTP_DIR;
    mirror -R --only-newer --no-perms --exclude-glob state/ --exclude-glob backup.log --exclude-glob '*.tmp' \
      $BACKUP_DIR $FTP_DIR;
    bye" >> "$LOG" 2>&1 || die "FTP mirror failed (see $LOG)"
  echo "$now" > "$BACKUP_DIR/state/last_size"
  date '+%F %T' > "$BACKUP_DIR/state/last_mirror"
  log "mirror ok → ftp://$FTP_HOST$FTP_DIR ($(numfmt --to=iec "$now"))"
}

status() {
  echo "== local: $BACKUP_DIR"
  for d in dumps uploads config code; do
    printf '%-8s ' "$d"; f=$(find "$BACKUP_DIR/$d" -type f ! -name '*-latest.bundle' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1)
    [ -n "$f" ] && echo "newest: $(date -d @${f%% *} '+%F %T')  $(basename "${f#* }")" || echo "NONE"
  done
  echo "last mirror: $(cat "$BACKUP_DIR/state/last_mirror" 2>/dev/null || echo NEVER)"
  [ -f "$BACKUP_DIR/state/guard_blocked" ] && echo "GUARD BLOCKED since $(cat "$BACKUP_DIR/state/guard_blocked")"
  echo "disk: $(df -h "$BACKUP_DIR" | awk 'NR==2{print $4" free of "$2}')"
  if command -v lftp >/dev/null && [ -n "${FTP_HOST:-}" ]; then
    echo "== NAS: ftp://$FTP_HOST$FTP_DIR"
    lftp -u "$FTP_USER","$FTP_PASS" -p "${FTP_PORT:-21}" "$FTP_HOST" -e "set ftp:ssl-allow no; du -s $FTP_DIR/dumps $FTP_DIR/uploads $FTP_DIR/config $FTP_DIR/code; bye" 2>&1 | sed 's/^/  /'
  fi
}

install_cron() {
  local me="$HERE/backup.sh"
  ( crontab -l 2>/dev/null | grep -v "$me" ;
    echo "15 1 * * * $me run >> $BACKUP_DIR/cron.log 2>&1" ;
    echo "0 */4 * * * $me uploads-mirror >> $BACKUP_DIR/cron.log 2>&1" ) | crontab -
  log "cron installed: 01:15 full run, every 4 h uploads+mirror"
}

case "${1:-run}" in
  run)     each_tier dump_tier; each_tier uploads_tier; config_bundle; each_tier code_tier; mirror; log "RUN COMPLETE" ;;
  dumps)   each_tier dump_tier ;;
  uploads) each_tier uploads_tier ;;
  uploads-mirror) each_tier uploads_tier; mirror ;;
  config)  config_bundle ;;
  code)    each_tier code_tier ;;
  mirror)  mirror ;;
  status)  status ;;
  guard-reset) rm -f "$BACKUP_DIR/state/guard_blocked" "$BACKUP_DIR/state/last_size"; log "guard reset by $(whoami)" ;;
  install-cron) install_cron ;;
  *) sed -n 2,20p "$0"; exit 1 ;;
esac
