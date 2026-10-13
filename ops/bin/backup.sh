#!/usr/bin/env bash
# ===========================================================================
# ops-kit BACKUPS — everything the app needs to come back on ANOTHER server:
#   database  : pgBackRest (PITR; repo1 local + repo2 NAS + optional repo3 S3) + nightly pg_dump
#   uploads   : the Docker uploads volume (files users added) → off-box
#   config    : encrypted bundle of .env files, pgBackRest conf.d (incl. the repo cipher), nginx site, TLS cert
#   masters   : the project's optional master-data export (sealed, encrypted)
#   code      : nightly `git bundle` of the whole repository (every branch + tag)
#   escrow    : the encrypted credentials escrow (ops/bin/escrow.sh)
# plus off-box copies guarded against a shrunk/wiped local set, and a health check.
# Companion: ops/bin/restore.sh. Guides: ops/docs/backup-restore.md, ops/docs/disaster-recovery.md.
#
#   backup.sh <tier> init              # once: stanza (+NAS repo2, cipher) + first full backup
#   backup.sh <tier> backup [full|diff|incr]   # cron 01:15 — base backup → dump → uploads → config → code → masters → escrow → offsite → check
#   backup.sh <tier> dump | uploads | config | code | masters-seal | escrow | images | mobile-builds | offsite   # the individual steps
#   backup.sh <tier> restore-images [<archive>]      # docker load the saved images on a new server (no Docker Hub / npm needed)
#   backup.sh <tier> check             # cron */30: archiving + backup age + NAS + guard; exit 1 on trouble
#   backup.sh <tier> status | info | verify | prune
#   backup.sh <tier> restore-uploads [<source dir>]   # NAS (or dir) → uploads volume (DR)
#   backup.sh <tier> restore-config <bundle.tar.enc>  # decrypt a config bundle into ./restored-config/
#   backup.sh <tier> restore-offsite [<old-host>]     # FTP copy → BACKUP_DIR on a new server (DR)
#   backup.sh <tier> encrypt-repo      # ONE-TIME: switch the repository to AES-256 at rest (brief DB stop)
#   backup.sh <tier> prune-plain       # delete the pre-encryption repository copies once past retention
#   backup.sh <tier> guard-reset       # accept the current repository as the new baseline for the shrink guard
#   backup.sh <tier> install-cron
#
# Settings: ops.env (identity) + .env.deploy (secrets) — see ops/ops.env.example, ops/env.deploy.example.
# ===========================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
TIER="${1:-}"; CMD="${2:-}"; ARG="${3:-}"
usage() { awk 'NR>2 && /^# =+$/ {exit} NR>2 {sub(/^# ?/, ""); print}' "$0"; exit 2; }
[[ -n "$TIER" && -n "$CMD" ]] || usage
ops_load; ops_tier "$TIER" || usage
NAS="${BACKUP_NAS_DIR:-}"
LOG="$BACKUP_DIR/backup-$TIER.log"
STATUS_FILE="$BACKUP_DIR/$TIER-status.json"
GUARD_FILE="$BACKUP_DIR/.offsite-guard-$TIER.json"
MAX_LAG_MIN="${BACKUP_MAX_ARCHIVE_LAG_MIN:-15}"; MAX_AGE_H="${BACKUP_MAX_AGE_HOURS:-26}"
export BACKUP_NAS_DIR="${NAS:-$BACKUP_DIR/nas}"
CONFD="$KIT/postgres/conf.d"

ts() { ops_ts; }
log() { echo "[$(ts)] [$TIER] $*" | tee -a "$LOG" >&2; }
dc() { ops_dc "$@"; }
pgx() { dc exec -T -u postgres "$OPS_DB_SERVICE" "$@"; }
pgb() { pgx pgbackrest --stanza=main "$@"; }
sql() { dc exec -T "$OPS_DB_SERVICE" sh -c 'psql -v ON_ERROR_STOP=1 -qAtX -U "$POSTGRES_USER" "$POSTGRES_DB"'; }
# shellcheck disable=SC1091
. "$KIT/bin/mail.sh"
alert() {
  log "ALERT: $*"
  alert_mail "[$OPS_LABEL ${TIER^^}] backup problem on $HOST_TAG" "$OPS_LABEL $TIER backups on $(hostname) — $(ts)

$*

Check: $OPS_KIT_DIR/bin/backup.sh $TIER status   ($OPS_KIT_DIR/docs/backup-restore.md §3)" || true
}
nas_ok() { [[ -n "$NAS" ]] && mountpoint -q "$NAS" 2>/dev/null; }
# ANY unexpected failure mails before the script dies — a backup that silently
# stops running is the failure mode this exists to prevent.
on_err() {
  local rc=$? line=$1
  [[ "$CMD" == "check" || "$CMD" == "status" ]] && exit "$rc"
  log "FAILED: command '$CMD' exit $rc at line $line"
  alert "backup.sh $TIER $CMD FAILED (exit $rc at script line $line).
Last log lines:
$(tail -n 20 "$LOG" 2>/dev/null)"
  exit "$rc"
}
trap 'on_err $LINENO' ERR
tools() {
  local want have
  want=$(md5sum "$KIT/tools/Dockerfile" | cut -c1-12)
  have=$(docker image inspect "$TOOLS_IMG" --format '{{ index .Config.Labels "ops.tools" }}' 2>/dev/null || true)
  [[ "$have" == "$want" ]] || docker build -q --label "ops.tools=$want" -t "$TOOLS_IMG" "$KIT/tools" >/dev/null
}
enc_stream() { docker run --rm -i -e PASS="$DATA_PASS" "$TOOLS_IMG" openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:PASS; }
dec_stream() { docker run --rm -i -e PASS="$DATA_PASS" "$TOOLS_IMG" openssl enc -d -aes-256-cbc -pbkdf2 -pass env:PASS; }
has_uploads() { [[ -n "$UPLOADS_VOL" && "$UPLOADS_VOL" != "none" ]]; }

prepare_dirs() {
  mkdir -p "$REPO" "$DUMPS" "$MASTERS" "$UPLOADS_DIR" "$CONFIGS" "$CODE" "$ESCROW" "$BACKUP_NAS_DIR/pg-$TIER"
  if nas_ok; then mkdir -p "$NAS/pg-$TIER" "$NAS/$HOST_TAG"; fi
  dc exec -T -u root "$OPS_DB_SERVICE" chown -R postgres:postgres /backups /nas 2>/dev/null || true
  [[ -n "$MASTERS_CMD" ]] && dc exec -T -u root "$OPS_API_SERVICE" chown -R node:node "$OPS_MASTERS_CONTAINER_DIR" 2>/dev/null || true
}

cmd_init() {
  log "init: repo1=$REPO nas=${NAS:-<not set>}"
  dc up -d "$OPS_DB_SERVICE"
  prepare_dirs
  if nas_ok && [[ ! -f "$CONFD/nas-repo.conf" ]]; then
    cp "$CONFD/nas-repo.conf.example" "$CONFD/nas-repo.conf"
    log "NAS mounted → enabled pgBackRest repo2 ($CONFD/nas-repo.conf); restarting $OPS_DB_SERVICE to load it"
    dc restart "$OPS_DB_SERVICE"; sleep 5
  fi
  if [[ -n "${BACKUP_REPO_CIPHER_PASS:-}" && ! -f "$CIPHER_CONF" && -z "$(ls -A "$REPO" 2>/dev/null)" ]]; then
    write_cipher_conf; dc up -d --force-recreate "$OPS_DB_SERVICE"; sleep 5
  else
    fix_cipher_perms     # a re-run after a failed first init: make the existing file readable by the DB container
  fi
  pgb stanza-create 2>&1 | tee -a "$LOG" || pgb stanza-upgrade 2>&1 | tee -a "$LOG"
  pgb check 2>&1 | tee -a "$LOG"
  log "first full backup"
  pgb backup --type=full 2>&1 | tee -a "$LOG"
  cmd_dump; cmd_uploads; cmd_config; cmd_code; cmd_masters_seal || true; cmd_escrow || true; cmd_images || true; cmd_mobile_builds || true
  cmd_guard_reset >/dev/null
  cmd_offsite || true
  cmd_status
  log "init done — now: $0 $TIER install-cron   and a restore drill ($OPS_KIT_DIR/docs/backup-restore.md §5)"
}

cmd_backup() {
  local type="${ARG:-}"
  if [[ -z "$type" ]]; then [[ "$(date +%u)" == "7" ]] && type=full || type=diff; fi
  log "backup type=$type"
  prepare_dirs
  pgb backup --type="$type" 2>&1 | tee -a "$LOG"
  cmd_dump
  cmd_uploads      || alert "uploads copy failed"
  cmd_config       || alert "config bundle failed"
  cmd_code         || alert "code (git bundle) failed"
  cmd_masters_seal || alert "master-export sealing failed"
  cmd_escrow       || alert "credentials escrow sealing failed"
  cmd_images       || alert "docker images archive failed"
  [[ "$(date +%u)" == "7" ]] && { cmd_mobile_builds || alert "mobile build artefacts fetch failed"; }
  cmd_offsite      || alert "offsite copy failed"
  cmd_check
}

cmd_dump() {
  mkdir -p "$DUMPS"
  local base="$DUMPS/$TIER-$(date +%F-%H%M).sql.gz" out
  if [[ -n "$DATA_PASS" ]]; then
    tools; out="$base.enc"
    log "logical dump (encrypted) → $out"
    dc exec -T "$OPS_DB_SERVICE" sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip | enc_stream > "$out"
    # round-trip check over the WHOLE file (a "first MB" head/gzip -t shortcut
    # fails every dump over 1 MB: broken pipe under pipefail + truncated gzip).
    dec_stream < "$out" | gzip -t 2>>"$LOG" || { rm -f "$out"; alert "dump $out failed its decrypt/gzip check (BACKUP_DATA_PASSPHRASE?)"; return 1; }
  else
    out="$base"
    log "logical dump (PLAIN — set BACKUP_DATA_PASSPHRASE to encrypt) → $out"
    dc exec -T "$OPS_DB_SERVICE" sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$out"
    gzip -t "$out"
  fi
  [[ $(stat -c %s "$out") -gt 10000 ]] || { alert "dump $out is suspiciously small"; return 1; }
  find "$DUMPS" \( -name "$TIER-*.sql.gz" -o -name "$TIER-*.sql.gz.enc" \) -mtime +14 -delete
  log "dump ok ($(du -h "$out" | cut -f1))"
}

cmd_uploads() {
  has_uploads || { log "uploads: no uploads volume configured for $TIER — skipped"; return 0; }
  tools; mkdir -p "$UPLOADS_DIR"
  log "uploads volume ${UPLOADS_VOL_NAME} → $UPLOADS_DIR"
  docker run --rm -v "${UPLOADS_VOL_NAME}:/src:ro" -v "$UPLOADS_DIR:/dst" "$TOOLS_IMG" \
    rsync -a --delete --exclude '.last-sync' /src/ /dst/ 2>&1 | tail -n 3 | tee -a "$LOG"
  date +%s > "$UPLOADS_DIR/.last-sync"
  log "uploads ok ($(du -sh "$UPLOADS_DIR" | cut -f1), $(find "$UPLOADS_DIR" -type f | wc -l) files)"
}

cmd_config() {
  [[ -n "${BACKUP_CONFIG_PASSPHRASE:-}" ]] || { log "config: BACKUP_CONFIG_PASSPHRASE not set — skipping (set it in .env.deploy)"; return 0; }
  tools; mkdir -p "$CONFIGS"
  local stage; stage=$(mktemp -d); local out="$CONFIGS/config-$TIER-$HOST_TAG-$(date +%F).tar.enc"
  mkdir -p "$stage/repo" "$stage/nginx" "$stage/ssl" "$stage/conf.d"
  cp "$ROOT/.env.deploy" "$stage/repo/.env.deploy"
  cp "$ROOT/ops.env" "$stage/repo/ops.env"
  # EVERY tier's app env file goes into EVERY bundle (not just this tier's), so
  # either tier's bundle rebuilds the whole box; kept at its repo-relative path.
  local t tu n f rel
  for t in $OPS_TIERS; do
    tu="${t^^}"; n="${tu}_ENV_FILE"; f="$(_abs "${!n:-}")"
    [[ -n "$f" && -f "$f" ]] || continue
    rel="${f#"$ROOT"/}"; mkdir -p "$stage/repo/$(dirname "$rel")"; cp "$f" "$stage/repo/$rel"
  done
  [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]] && cp "$ENV_FILE" "$stage/repo/$(basename "$ENV_FILE")"   # this tier's, at the old flat path too
  # OPS_CONFIG_EXTRA: space-separated globs (repo-relative or absolute) of any
  # other secret/config files the project keeps outside git — a second app's
  # env, a gateway conf with keys, a service-account file.
  local g
  for g in ${OPS_CONFIG_EXTRA:-}; do
    for f in $(compgen -G "$(_abs "$g")" 2>/dev/null); do
      [[ -f "$f" ]] || continue
      rel="${f#"$ROOT"/}"; [[ "$rel" == /* ]] && rel="extra$rel"
      mkdir -p "$stage/repo/$(dirname "$rel")"; cp "$f" "$stage/repo/$rel"
    done
  done
  cp "$CONFD"/*.conf "$stage/conf.d/" 2>/dev/null || true
  # ALL nginx sites (a second site — an API gateway with keys — is as vital as
  # the app's own) + the main nginx.conf + which sites are enabled.
  cp /etc/nginx/sites-available/* "$stage/nginx/" 2>/dev/null || true
  [[ -f /etc/nginx/nginx.conf ]] && cp /etc/nginx/nginx.conf "$stage/nginx/nginx.conf" 2>/dev/null || true
  ls -1 /etc/nginx/sites-enabled/ > "$stage/nginx/sites-enabled.txt" 2>/dev/null || true
  [[ -f /etc/docker/daemon.json ]] && { mkdir -p "$stage/docker"; cp /etc/docker/daemon.json "$stage/docker/" 2>/dev/null || true; }
  if [[ -d /etc/nginx/ssl ]]; then
    { cp -r /etc/nginx/ssl/. "$stage/ssl/" 2>/dev/null || sudo -n cp -r /etc/nginx/ssl/. "$stage/ssl/" 2>/dev/null; } \
      || log "config: could not read /etc/nginx/ssl (needs root) — TLS cert NOT in bundle; keep a copy in the vault"
  fi
  crontab -l > "$stage/crontab.txt" 2>/dev/null || true
  git -C "$ROOT" rev-parse HEAD > "$stage/git-sha.txt"
  if compgen -G "$HOME/.ssh/id_*" >/dev/null; then mkdir -p "$stage/ssh"; cp "$HOME"/.ssh/id_* "$stage/ssh/" 2>/dev/null; cp "$HOME/.ssh/known_hosts" "$stage/ssh/" 2>/dev/null || true; fi
  docker run --rm -v "$stage:/in:ro" -v "$CONFIGS:/out" -e PASS="$BACKUP_CONFIG_PASSPHRASE" "$TOOLS_IMG" \
    sh -c 'tar cf - -C /in . | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:PASS -out /out/'"$(basename "$out")"
  rm -rf "$stage"
  find "$CONFIGS" -name "config-$TIER-*.tar.enc" -mtime +60 -delete
  log "config bundle ok → $out"
}

cmd_restore_config() {
  [[ -f "$ARG" ]] || { echo "usage: $0 $TIER restore-config <bundle.tar.enc>"; exit 2; }
  [[ -n "${BACKUP_CONFIG_PASSPHRASE:-}" ]] || { read -r -s -p "Config bundle passphrase: " BACKUP_CONFIG_PASSPHRASE; echo; }
  tools; local out="$ROOT/restored-config"; mkdir -p "$out"
  docker run --rm -v "$(dirname "$(readlink -f "$ARG")"):/in:ro" -v "$out:/out" -e PASS="$BACKUP_CONFIG_PASSPHRASE" "$TOOLS_IMG" \
    sh -c 'openssl enc -d -aes-256-cbc -pbkdf2 -pass env:PASS -in /in/'"$(basename "$ARG")"' | tar xf - -C /out'
  echo "Decrypted into $out — 'cp -r repo/. <checkout>' (.env.deploy, ops.env, EVERY tier's app env file + extras at their repo paths), conf.d/* into $OPS_KIT_DIR/postgres/conf.d/ (chown 999:999 cipher.conf), nginx/*.conf into /etc/nginx/sites-available (re-link per nginx/sites-enabled.txt), ssl/ into /etc/nginx/ssl, ssh/ into ~/.ssh ($OPS_KIT_DIR/docs/disaster-recovery.md §3 step 3)."
}

cmd_code() {
  mkdir -p "$CODE"
  local out="$CODE/$OPS_SLUG-$HOST_TAG-$(date +%F).bundle" tmp="$CODE/.$OPS_SLUG-$(date +%F).bundle.tmp"
  git -C "$ROOT" fetch --all --prune -q 2>>"$LOG" || log "code: git fetch failed (no network / deploy key?) — bundling the refs already present"
  if [[ "$(git -C "$ROOT" rev-parse --is-shallow-repository)" == "true" ]]; then
    git -C "$ROOT" fetch --unshallow -q 2>>"$LOG" || { log "code: checkout is SHALLOW and --unshallow failed — no bundle written"; return 1; }
  fi
  log "code bundle → $out (HEAD $(git -C "$ROOT" rev-parse --short HEAD) on $(git -C "$ROOT" rev-parse --abbrev-ref HEAD))"
  rm -f "$tmp"
  git -C "$ROOT" bundle create "$tmp" --all >>"$LOG" 2>&1
  if ! git -C "$ROOT" bundle verify "$tmp" >>"$LOG" 2>&1; then rm -f "$tmp"; log "code: git bundle verify FAILED — bundle discarded"; return 1; fi
  mv -f "$tmp" "$out"
  ln -sfn "$(basename "$out")" "$CODE/$OPS_SLUG-latest.bundle"
  find "$CODE" -name "$OPS_SLUG-*.bundle" -type f -mtime +30 -delete
  log "code bundle ok → $out ($(du -h "$out" | cut -f1); $(git -C "$ROOT" bundle list-heads "$out" | wc -l) refs)"
}

# Master exports (optional): the project's job writes <MASTERS>/<date>/… with a
# manifest.json. Plain folders stay here; only encrypted archives go off-box.
cmd_masters_seal() {
  [[ -n "$MASTERS_CMD" ]] || return 0
  [[ -n "$DATA_PASS" ]] || { log "masters: no BACKUP_DATA_PASSPHRASE — plain export folders are mirrored off-box as-is"; return 0; }
  tools; local d name out n=0
  for d in "$MASTERS"/20*/; do
    [[ -d "$d" && -f "$d/manifest.json" ]] || continue
    name="$(basename "$d")"; out="$MASTERS/masters-$TIER-$name.tar.enc"
    [[ -f "$out" && "$out" -nt "$d/manifest.json" ]] && continue
    docker run --rm -v "$MASTERS:/m" -e PASS="$DATA_PASS" "$TOOLS_IMG" \
      sh -c "tar cf - -C /m '$name' | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:PASS -out /m/$(basename "$out").tmp && mv /m/$(basename "$out").tmp /m/$(basename "$out")"
    n=$((n+1))
  done
  find "$MASTERS" -name "masters-$TIER-*.tar.enc" -mtime +56 -delete
  log "masters: $n export folder(s) sealed"
}

# ---- DOCKER IMAGES (rebuild without Docker Hub / npm) ------------------------
IMAGES="$BACKUP_DIR/images"
tier_images() { { grep -E '^\s*image:' "$COMPOSE" | awk '{print $2}'; echo "$TOOLS_IMG"; } | sort -u; }
cmd_images() {
  [[ "${BACKUP_IMAGES:-yes}" != "no" ]] || { log "images: BACKUP_IMAGES=no — skipped"; return 0; }
  mkdir -p "$IMAGES"
  local out="$IMAGES/images-$TIER-$(date +%F).tar.gz" tmp="$IMAGES/.images-$TIER.tar.gz.tmp" list=() img
  while read -r img; do docker image inspect "$img" >/dev/null 2>&1 && list+=("$img") || log "images: $img not present locally — skipped"; done < <(tier_images)
  [[ ${#list[@]} -gt 0 ]] || { log "images: nothing to save"; return 0; }
  log "images: saving ${list[*]} → $out"
  docker save "${list[@]}" | gzip -1 > "$tmp" && mv -f "$tmp" "$out"
  [[ $(stat -c %s "$out") -gt 1000000 ]] || { rm -f "$out"; alert "images archive $out is suspiciously small"; return 1; }
  ls -t "$IMAGES"/images-"$TIER"-*.tar.gz 2>/dev/null | tail -n +3 | xargs -r rm -f
  log "images ok ($(du -h "$out" | cut -f1))"
}
cmd_restore_images() {
  local f="${ARG:-$(ls -t "$IMAGES"/images-"$TIER"-*.tar.gz 2>/dev/null | head -1)}"
  [[ -f "$f" ]] || { echo "no images archive found (expected $IMAGES/images-$TIER-*.tar.gz)"; exit 1; }
  log "restore-images: docker load < $f"
  gunzip -c "$f" | docker load 2>&1 | tee -a "$LOG"
  log "restore-images done — now: $OPS_KIT_DIR/bin/deploy.sh $TIER --no-pull"
}

# ---- MOBILE APP BINARIES (Expo EAS artefacts; needs EXPO_TOKEN + OPS_MOBILE_DIR) ----
MOBILE_DIR="$BACKUP_DIR/mobile-builds"
cmd_mobile_builds() {
  [[ -n "${EXPO_TOKEN:-}" ]] || { log "mobile-builds: EXPO_TOKEN not set — skipped"; return 0; }
  local mdir="$(_abs "${OPS_MOBILE_DIR:-mobile}")"
  [[ -d "$mdir" ]] || { log "mobile-builds: no $mdir — skipped"; return 0; }
  mkdir -p "$MOBILE_DIR"
  local json plat
  json=$(docker run --rm -e EXPO_TOKEN="$EXPO_TOKEN" -v "$mdir:/app:ro" -w /app node:20-alpine     sh -c 'npx --yes eas-cli@latest build:list --json --non-interactive --status finished --limit 10 2>/dev/null') || { alert "mobile-builds: eas build:list failed (token? network?)"; return 1; }
  for plat in android ios; do
    local url ver id profile out
    read -r id ver profile url < <(python3 -c '
import json,sys
plat=sys.argv[1]; builds=json.loads(sys.stdin.read() or "[]")
for b in builds:
    if str(b.get("platform","")).lower()==plat and b.get("artifacts",{}).get("buildUrl"):
        print(b["id"], b.get("appVersion","?"), b.get("buildProfile","?"), b["artifacts"]["buildUrl"]); break' "$plat" <<< "$json")
    [[ -n "${url:-}" ]] || { log "mobile-builds: no finished $plat build with an artefact"; continue; }
    out="$MOBILE_DIR/$plat-$profile-$ver-${id:0:8}.$( [[ "$url" == *.apk ]] && echo apk || [[ "$plat" == ios ]] && echo ipa || echo aab )"
    [[ -f "$out" ]] && { log "mobile-builds: $plat newest already saved"; continue; }
    log "mobile-builds: $plat → $(basename "$out")"
    curl -fsSL --max-time 900 -o "$out.tmp" "$url" && mv -f "$out.tmp" "$out" || { rm -f "$out.tmp"; alert "mobile-builds: download of $plat artefact failed"; continue; }
    ls -t "$MOBILE_DIR/$plat-"* 2>/dev/null | tail -n +4 | xargs -r rm -f
  done
  date +%s > "$MOBILE_DIR/.last-run"
  log "mobile-builds ok"
}

cmd_escrow() {
  [[ "$OPS_ESCROW" != "no" ]] || return 0
  [[ -d "$ROOT/.escrow" ]] || { log "escrow: $ROOT/.escrow not set up — run $OPS_KIT_DIR/bin/escrow.sh init ($OPS_KIT_DIR/docs/credentials-escrow.md)"; return 0; }
  "$KIT/bin/escrow.sh" seal --quiet 2>&1 | tee -a "$LOG"
}

cmd_restore_uploads() {
  has_uploads || { echo "no uploads volume configured for $TIER"; exit 1; }
  local src="${ARG:-}"
  [[ -n "$src" ]] || { nas_ok && src="$NAS/$HOST_TAG/uploads-$TIER" || src="$UPLOADS_DIR"; }
  [[ -d "$src" ]] || { echo "source dir not found: $src"; exit 1; }
  tools; docker volume create "${UPLOADS_VOL_NAME}" >/dev/null
  log "restore uploads: $src → volume ${UPLOADS_VOL_NAME}"
  docker run --rm -v "$src:/src:ro" -v "${UPLOADS_VOL_NAME}:/dst" "$TOOLS_IMG" sh -c "rsync -a /src/ /dst/ && chown -R ${OPS_UPLOADS_UID:-1000}:${OPS_UPLOADS_UID:-1000} /dst"
  log "uploads restored ($(find "$src" -type f | wc -l) files)"
}

# ---- SHRINK GUARD (see ops/docs/backup-restore.md §1d) ---------------------
repo_shape() {
  local info count newest dumps
  info=$(pgb info --output=json --log-level-console=off 2>/dev/null | sed -n '/^\[/,$p' || true)
  [[ "$info" == \[* ]] || info='[]'
  read -r count newest < <(python3 -c '
import json,sys
info=json.loads(sys.argv[1]); c=0; n=0
for s in info:
    for b in s.get("backup",[]):
        c+=1; n=max(n,int(b["timestamp"]["stop"]))
print(c,n)' "$info")
  dumps=$(find "$DUMPS" -maxdepth 1 -name "$TIER-*.sql.gz*" 2>/dev/null | wc -l)
  echo "$count $newest $dumps"
}
offsite_guard() {
  [[ "${BACKUP_OFFSITE_FORCE:-0}" == "1" ]] && { log "guard: BACKUP_OFFSITE_FORCE=1 — skipped"; return 0; }
  local count newest dumps pc pn pd why=""
  read -r count newest dumps < <(repo_shape)
  if [[ -f "$GUARD_FILE" ]]; then
    read -r pc pn pd < <(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("backups",0), d.get("newest_stop",0), d.get("dumps",0))' "$GUARD_FILE")
    local max_drop="${BACKUP_GUARD_MAX_DROP:-2}"
    (( count == 0 && pc > 0 )) && why="repository has NO backup sets (had $pc)"
    (( count < pc - max_drop )) && why="repository shrank from $pc to $count backup sets (limit $max_drop)"
    (( newest < pn )) && why="newest backup is OLDER than at the last copy — a backup set disappeared"
    (( dumps == 0 && pd > 0 )) && why="dumps directory is EMPTY (had $pd)"
  fi
  if [[ -n "$why" ]]; then
    python3 -c 'import json,sys,time; d=json.load(open(sys.argv[1])); d["blocked"]=True; d["blocked_since"]=d.get("blocked_since") or time.time(); d["blocked_reason"]=sys.argv[2]; json.dump(d,open(sys.argv[1],"w"),indent=2)' "$GUARD_FILE" "$why"
    alert "OFF-BOX COPY BLOCKED by the shrink guard: $why.
The off-box copies were left untouched. If this is expected (a deliberate repository change), run:
  $OPS_KIT_DIR/bin/backup.sh $TIER guard-reset
If it is NOT expected, treat this server as compromised/damaged: do not touch the off-box copies, start $OPS_KIT_DIR/docs/disaster-recovery.md."
    return 1
  fi
  return 0
}
guard_record() {
  local count newest dumps; read -r count newest dumps < <(repo_shape)
  python3 -c 'import json,sys,time; json.dump({"backups":int(sys.argv[2]),"newest_stop":int(sys.argv[3]),"dumps":int(sys.argv[4]),"recorded_at":time.time(),"blocked":False}, open(sys.argv[1],"w"), indent=2)' "$GUARD_FILE" "$count" "$newest" "$dumps"
}
cmd_guard_reset() { guard_record; log "guard: baseline reset to $(tr -d '\n ' < "$GUARD_FILE")"; }

FTP_HOST="${BACKUP_FTP_HOST:-}"
ftp_dest() { local b="${BACKUP_FTP_DIR:-}"; b="${b#/}"; b="${b%/}"; [[ -n "$b" ]] && echo "$b/${1:-$HOST_TAG}" || echo "${1:-$HOST_TAG}"; }
cmd_offsite() {
  local did=0 del="--delete" ldel="--delete"
  [[ "${BACKUP_OFFSITE_DELETE:-yes}" == "no" ]] && { del=""; ldel=""; }
  offsite_guard || return 1
  local mex=""; [[ -n "$DATA_PASS" && -n "$MASTERS_CMD" ]] && mex="--exclude=masters-*/20*/"
  if nas_ok; then
    log "offsite → NAS $NAS/$HOST_TAG"
    tools; mkdir -p "$NAS/$HOST_TAG"
    # shellcheck disable=SC2086
    docker run --rm -v "$BACKUP_DIR:/src:ro" -v "$NAS/$HOST_TAG:/dst" "$TOOLS_IMG" \
      rsync -a $del $mex --exclude 'backup-*.log' --exclude '/nas/' --exclude '/monitor/' --exclude '.probe-*' /src/ /dst/ 2>&1 | tee -a "$LOG"
    [[ ${PIPESTATUS[0]} -eq 0 ]] || { alert "rsync to NAS $NAS FAILED — see $LOG"; return 1; }
    did=1
  elif [[ -n "$NAS" ]]; then
    alert "NAS $NAS is NOT mounted — no off-box copy this run (check /etc/fstab, then: mount $NAS)"
  fi
  if [[ -n "$FTP_HOST" ]]; then
    [[ -n "${BACKUP_FTP_USER:-}" && -n "${BACKUP_FTP_PASS:-}" ]] || { alert "BACKUP_FTP_USER / BACKUP_FTP_PASS not set in .env.deploy"; return 1; }
    local port="${BACKUP_FTP_PORT:-21}" tls="${BACKUP_FTP_TLS:-auto}" force=no allow=yes dest
    case "$tls" in yes) force=yes ;; no) allow=no ;; esac
    dest="$(ftp_dest)"
    log "offsite → FTP ${BACKUP_FTP_USER}@$FTP_HOST:$port $dest (tls=$tls)"
    tools
    docker run --rm -v "$BACKUP_DIR:/src:ro" -e LFTP_PASSWORD="$BACKUP_FTP_PASS" "$TOOLS_IMG" lftp -e "
      set cmd:interactive no; set ftp:ssl-allow $allow; set ftp:ssl-force $force; set ssl:verify-certificate no;
      set net:timeout 30; set net:max-retries 3; set net:reconnect-interval-base 5; set xfer:log no;
      open --env-password -u '$BACKUP_FTP_USER' -p $port 'ftp://$FTP_HOST' || exit 1;
      mkdir -pf '$dest';
      mirror -R $ldel --only-newer --dereference --parallel=2 --exclude-glob 'backup-*.log' --exclude '^nas/' --exclude '^monitor/' --exclude-glob '.probe-*' $( [[ -n "$mex" ]] && echo "--exclude '^masters-[^/]*/20[^/]*/'" ) /src '$dest';
      quit" 2>&1 | tee -a "$LOG"
    [[ ${PIPESTATUS[0]} -eq 0 ]] || { alert "FTP mirror to $FTP_HOST FAILED — see $LOG (login? FTPS? path '$dest'?)"; return 1; }
    did=1
  fi
  if [[ -n "${BACKUP_OFFSITE_RSYNC:-}" ]]; then
    log "offsite → $BACKUP_OFFSITE_RSYNC"
    # shellcheck disable=SC2086
    rsync -az $del $mex --exclude 'backup-*.log' --exclude 'nas/' --exclude 'monitor/' "$BACKUP_DIR/" "$BACKUP_OFFSITE_RSYNC/" 2>&1 | tee -a "$LOG"
    did=1
  fi
  if [[ "$did" == "1" ]]; then date +%s > "$BACKUP_DIR/.offsite-last"; guard_record; log "offsite ok"
  else log "offsite: no BACKUP_NAS_DIR / BACKUP_FTP_HOST / BACKUP_OFFSITE_RSYNC set — backups stay on THIS box only"; fi
}

cmd_restore_offsite() {
  [[ -n "$FTP_HOST" ]] || { echo "BACKUP_FTP_HOST not set — for an NFS NAS use restore.sh --from-nas"; exit 2; }
  local src port="${BACKUP_FTP_PORT:-21}"; src="$(ftp_dest "${ARG:-$HOST_TAG}")"
  mkdir -p "$BACKUP_DIR"; tools
  log "restore-offsite: FTP $src → $BACKUP_DIR"
  docker run --rm -v "$BACKUP_DIR:/dst" -e LFTP_PASSWORD="$BACKUP_FTP_PASS" "$TOOLS_IMG" lftp -e "
    set cmd:interactive no; set ftp:ssl-allow yes; set ssl:verify-certificate no; set net:timeout 30; set net:max-retries 3;
    open --env-password -u '$BACKUP_FTP_USER' -p $port 'ftp://$FTP_HOST' || exit 1;
    mirror --only-newer --parallel=2 '$src' /dst; quit" 2>&1 | tee -a "$LOG"
  [[ ${PIPESTATUS[0]} -eq 0 ]] || { log "restore-offsite FAILED — see $LOG"; return 1; }
  log "restore-offsite done — now: restore.sh $TIER --latest   (repo1 is $REPO)"
}

# ---- REPOSITORY ENCRYPTION ---------------------------------------------------
repo_indexes() {
  local idx="1"
  [[ -f "$CONFD/nas-repo.conf" ]] && idx="$idx 2"
  [[ -f "$CONFD/s3-repo.conf" ]] && idx="$idx $(grep -o 'repo[0-9]-type' "$CONFD/s3-repo.conf" | head -1 | tr -dc '0-9')"
  echo "$idx" | tr ' ' '\n' | sort -un | tr '\n' ' '
}
write_cipher_conf() {
  [[ -n "${BACKUP_REPO_CIPHER_PASS:-}" ]] || { log "cipher: BACKUP_REPO_CIPHER_PASS not set"; return 1; }
  tools; local tmp; tmp=$(mktemp)
  { echo "# Generated by backup.sh — pgBackRest repository encryption. DO NOT COMMIT. Passphrase also in the vault."; echo "[global]"
    for i in $(repo_indexes); do echo "repo${i}-cipher-type=aes-256-cbc"; echo "repo${i}-cipher-pass=$BACKUP_REPO_CIPHER_PASS"; done; } > "$tmp"
  cp "$tmp" "$CIPHER_CONF"; rm -f "$tmp"
  fix_cipher_perms
  log "cipher: wrote $CIPHER_CONF for repo indexes [$(repo_indexes)]"
}
# cipher.conf must be readable by the postgres user INSIDE the DB container
# only: uid 999 on Debian images, 70 on Alpine — read it from the container.
fix_cipher_perms() {
  [[ -f "$CIPHER_CONF" ]] || return 0
  local uid; uid=$(pgx id -u 2>/dev/null | tr -dc '0-9'); uid="${uid:-999}"
  tools; docker run --rm -v "$CONFD:/c" "$TOOLS_IMG" sh -c "chown $uid:$uid /c/cipher.conf && chmod 600 /c/cipher.conf"
}
repo_is_encrypted() { pgb info --output=json --log-level-console=off 2>/dev/null | sed -n '/^\[/,$p' | python3 -c 'import json,sys
info=json.load(sys.stdin); print("yes" if any(r.get("cipher","none")!="none" for s in info for r in s.get("repo",[])) else "no")' 2>/dev/null || echo unknown; }
cmd_encrypt_repo() {
  [[ -n "${BACKUP_REPO_CIPHER_PASS:-}" ]] || { echo "Set BACKUP_REPO_CIPHER_PASS in .env.deploy first (openssl rand -base64 32; vault + sealed envelope)."; exit 2; }
  if [[ -f "$CONFD/s3-repo.conf" && "${BACKUP_REPO_CIPHER_S3_OK:-0}" != "1" ]]; then
    echo "An S3 repository is configured: point it at a NEW bucket/path first, then re-run with BACKUP_REPO_CIPHER_S3_OK=1."; exit 2
  fi
  if [[ "$(repo_is_encrypted)" == "yes" ]]; then log "encrypt-repo: repository is already encrypted — nothing to do"; exit 0; fi
  local stamp; stamp=$(date +%F-%H%M)
  cat <<EOF
About to switch the $TIER pgBackRest repository to AES-256 at rest:
  1. stop the $TIER stack (≈1–2 min of downtime)
  2. move $REPO → $REPO.plain-$stamp$( nas_ok && echo " (and $NAS/pg-$TIER → .plain-$stamp)" )
  3. write $OPS_KIT_DIR/postgres/conf.d/cipher.conf, start the database, create the stanza, take a FULL backup
  4. reset the shrink guard so the next off-box copy accepts the new (smaller) repository
The plain copies stay until:  $0 $TIER prune-plain   (after the old PITR window, ≥ 4 weeks)
EOF
  read -r -p "Type the tier name ($TIER) to continue: " confirm; [[ "$confirm" == "$TIER" ]] || { log "encrypt-repo aborted"; exit 1; }
  log "encrypt-repo: stopping the $TIER stack"
  dc stop
  mv "$REPO" "$REPO.plain-$stamp"; mkdir -p "$REPO"
  if nas_ok && [[ -d "$NAS/pg-$TIER" ]]; then mv "$NAS/pg-$TIER" "$NAS/pg-$TIER.plain-$stamp"; mkdir -p "$NAS/pg-$TIER"; fi
  write_cipher_conf
  dc up -d --force-recreate "$OPS_DB_SERVICE"
  for _ in $(seq 1 60); do dc exec -T "$OPS_DB_SERVICE" pg_isready -U "$DB_USER" >/dev/null 2>&1 && break; sleep 2; done
  prepare_dirs
  pgb stanza-create 2>&1 | tee -a "$LOG"
  pgb check 2>&1 | tee -a "$LOG"
  log "encrypt-repo: first FULL backup into the encrypted repository"
  pgb backup --type=full 2>&1 | tee -a "$LOG"
  dc up -d
  [[ "$(repo_is_encrypted)" == "yes" ]] || { alert "encrypt-repo: repository does NOT report a cipher after the switch — investigate before the next backup"; exit 1; }
  cmd_guard_reset
  cmd_offsite || true
  log "encrypt-repo done. Plain copies: $REPO.plain-$stamp — remove with '$0 $TIER prune-plain' after the old PITR window. Run a restore drill now: $OPS_KIT_DIR/bin/restore.sh $TIER --latest"
}
cmd_prune_plain() {
  local keep="${BACKUP_PLAIN_REPO_KEEP_DAYS:-28}" d n=0
  for d in "$REPO".plain-* $( nas_ok && ls -d "$NAS/pg-$TIER".plain-* 2>/dev/null ); do
    [[ -d "$d" ]] || continue
    if [[ $(( ( $(date +%s) - $(stat -c %Y "$d") ) / 86400 )) -lt "$keep" ]]; then log "prune-plain: $d is younger than $keep days — kept"; continue; fi
    tools; docker run --rm -v "$(dirname "$d"):/p" "$TOOLS_IMG" rm -rf "/p/$(basename "$d")"; n=$((n+1)); log "prune-plain: removed $d"
  done
  log "prune-plain: $n plain repository copies removed"
}

gather_status() {
  local archiver backups nas_state
  archiver=$(sql <<'SQL'
SELECT json_build_object(
  'archive_mode', current_setting('archive_mode'),
  'archived_count', archived_count,
  'last_archived_wal', last_archived_wal,
  'last_archived_at', last_archived_time,
  'archive_lag_min', COALESCE(extract(epoch FROM now() - last_archived_time)/60, -1)::int,
  'failed_count', failed_count,
  'last_failed_wal', last_failed_wal,
  'last_failed_at', last_failed_time,
  'wal_files_waiting', (SELECT count(*) FROM pg_ls_dir('pg_wal/archive_status') f WHERE f LIKE '%.ready'))::text
FROM pg_stat_archiver;
SQL
)
  backups=$(pgb info --output=json --log-level-console=off 2>/dev/null | sed -n '/^\[/,$p' || true)
  [[ "$backups" == \[* ]] || backups='[]'
  if [[ -z "$NAS" ]]; then nas_state=unset; elif nas_ok; then nas_state=mounted; else nas_state=NOT_MOUNTED; fi
  [[ "$nas_state" == "unset" && ( -n "$FTP_HOST" || -n "${BACKUP_OFFSITE_RSYNC:-}" ) ]] && nas_state=ftp
  local guard='{}'; [[ -f "$GUARD_FILE" ]] && guard=$(cat "$GUARD_FILE")
  local dumps_enc=no; [[ -n "$DATA_PASS" ]] && dumps_enc=yes
  python3 - "$archiver" "$backups" "$MAX_LAG_MIN" "$MAX_AGE_H" "$TIER" "$nas_state" "$guard" "$dumps_enc" "$OPS_KIT_DIR" <<'PY'
import json, sys, datetime, time
arch = json.loads(sys.argv[1]); info = json.loads(sys.argv[2])
max_lag, max_age, tier, nas = int(sys.argv[3]), float(sys.argv[4]), sys.argv[5], sys.argv[6]
guard = json.loads(sys.argv[7] or '{}'); dumps_enc = sys.argv[8] == 'yes'; kit = sys.argv[9]
latest = None; count = 0; repos = set(); ciphers = set()
for stanza in info:
    for r in stanza.get('repo', []): repos.add(r.get('key')); ciphers.add(r.get('cipher', 'none'))
    for b in stanza.get('backup', []):
        count += 1
        stop = b['timestamp']['stop']
        if latest is None or stop > latest['stop']:
            latest = {'label': b['label'], 'type': b['type'], 'stop': stop, 'size_mb': round(b['info'].get('size', 0)/1048576, 1)}
age_h = (time.time() - latest['stop'])/3600 if latest else None
problems = []
if arch.get('archive_mode') != 'on': problems.append('archive_mode is off')
if arch.get('archive_lag_min', -1) < 0: problems.append('no WAL archived yet')
elif arch['archive_lag_min'] > max_lag and arch.get('wal_files_waiting', 0) > 0:
    problems.append(f"WAL archiving stalled: {arch['wal_files_waiting']} segments waiting, last archived {arch['archive_lag_min']} min ago")
if arch.get('last_failed_at') and (not arch.get('last_archived_at') or arch['last_failed_at'] > arch['last_archived_at']):
    problems.append(f"last archive attempt FAILED ({arch.get('last_failed_wal')})")
if latest is None: problems.append('no base backup in repository')
elif age_h > max_age: problems.append(f"newest base backup is {age_h:.1f} h old ({latest['label']})")
if nas == 'NOT_MOUNTED': problems.append('NAS share is not mounted — repo2 and off-box copies are not being written')
if guard.get('blocked'):
    since = datetime.datetime.fromtimestamp(guard.get('blocked_since') or time.time()).strftime('%Y-%m-%d %H:%M')
    problems.append(f"off-box copy BLOCKED by the shrink guard since {since}: {guard.get('blocked_reason')} — investigate, then `{kit}/bin/backup.sh {tier} guard-reset` if deliberate")
warnings = []
if nas == 'unset': warnings.append('no NAS/off-box target configured (BACKUP_NAS_DIR / BACKUP_FTP_HOST) — backups exist only on this server')
if nas == 'ftp': warnings.append('off-box copy is an FTP mirror (nightly + 4-hourly), not a live NAS repo — the copy lags by up to 4 h')
if ciphers and ciphers == {'none'}: warnings.append(f'pgBackRest repository is NOT encrypted at rest — set BACKUP_REPO_CIPHER_PASS and run: {kit}/bin/backup.sh {tier} encrypt-repo')
if not dumps_enc: warnings.append('logical dumps / master exports / escrow are NOT encrypted — set BACKUP_DATA_PASSPHRASE (or BACKUP_CONFIG_PASSPHRASE)')
out = {'tier': tier, 'checked_at': datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
       'ok': not problems, 'problems': problems, 'warnings': warnings, 'nas': nas, 'repos': sorted(repos),
       'repo_cipher': sorted(ciphers), 'files_encrypted': dumps_enc, 'guard': guard, 'archiver': arch,
       'backups': count, 'latest_backup': latest and {**latest, 'stop_at': datetime.datetime.fromtimestamp(latest['stop']).astimezone().isoformat(timespec='seconds'), 'age_hours': round(age_h, 1)}}
print(json.dumps(out, indent=2, default=str))
PY
}

cmd_status() { local st; st=$(gather_status); echo "$st" | tee "$STATUS_FILE"; }

cmd_check() {
  local st ok
  st=$(gather_status); echo "$st" > "$STATUS_FILE"
  ok=$(echo "$st" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ok" if d["ok"] else "\n".join(d["problems"]))')
  if [[ "$ok" == "ok" ]]; then
    log "check ok: $(python3 - "$STATUS_FILE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); l = d.get('latest_backup') or {}; a = d.get('archiver') or {}
s = f"latest {l.get('type')} {l.get('label')} {l.get('age_hours')}h old; WAL lag {a.get('archive_lag_min')} min; repos {d.get('repos')}; cipher {d.get('repo_cipher')}; nas {d.get('nas')}"
if d.get('warnings'): s += ' — WARNING: ' + '; '.join(d['warnings'])
print(s)
PY
)"
  else
    alert "$ok"; return 1
  fi
}

cmd_install_cron() {
  local me; me="$(readlink -f "$0")"
  local tmp; tmp=$(mktemp)
  crontab -l 2>/dev/null | grep -v "backup.sh $TIER " > "$tmp" || true
  cat >> "$tmp" <<EOF
# $OPS_LABEL $TIER backups ($OPS_KIT_DIR/bin/backup.sh — $OPS_KIT_DIR/docs/backup-restore.md)
15 1 * * * $me $TIER backup >> $LOG 2>&1
*/30 * * * * $me $TIER check >> $LOG 2>&1
0 */4 * * * $me $TIER uploads >> $LOG 2>&1 && $me $TIER offsite >> $LOG 2>&1
30 4 * * 0 $me $TIER verify >> $LOG 2>&1
EOF
  crontab "$tmp"; rm -f "$tmp"
  crontab -l | grep "backup.sh $TIER "
}

case "$CMD" in
  init) cmd_init ;;
  backup) cmd_backup ;;
  dump) cmd_dump ;;
  uploads) cmd_uploads ;;
  config) cmd_config ;;
  code) cmd_code ;;
  masters-seal) cmd_masters_seal ;;
  escrow) cmd_escrow ;;
  images) cmd_images ;;
  restore-images) cmd_restore_images ;;
  mobile-builds) cmd_mobile_builds ;;
  restore-uploads) cmd_restore_uploads ;;
  restore-config) cmd_restore_config ;;
  check) cmd_check ;;
  status) cmd_status ;;
  info) pgb info ;;
  verify) log "verify"; pgb verify 2>&1 | tee -a "$LOG" ;;
  prune) pgb expire 2>&1 | tee -a "$LOG" ;;
  offsite) cmd_offsite ;;
  restore-offsite) cmd_restore_offsite ;;
  encrypt-repo) cmd_encrypt_repo ;;
  prune-plain) cmd_prune_plain ;;
  guard-reset) cmd_guard_reset ;;
  install-cron) cmd_install_cron ;;
  *) usage ;;
esac
