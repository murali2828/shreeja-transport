#!/usr/bin/env bash
# ===========================================================================
# ops-kit host WATCHDOG — runs every 2 minutes from cron and E-MAILS when
# anything users depend on is down, and again when it recovers:
#   containers · db · redis (if any) · api_local · api_public · api_ready · web
#   backup (WAL archiving via the app's /health/backup) · backup_job / _dump /
#   _uploads / _config / _code / _masters / _offsite (every copy's freshness) ·
#   backup_guard (off-box shrink guard) · backup_encryption · escrow ·
#   disk_root / disk_backup · nas · tls
# Transition-based alerts (no storms): ALERT_FAIL_THRESHOLD consecutive
# failures → DOWN mail; RECOVERED mail; reminder every ALERT_REMIND_H hours.
# Writes a heartbeat to the NAS for ops/bin/remote-probe.sh.
#
#   healthcheck.sh <tier> check | status | summary | test-mail | install-cron
# ===========================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
TIER="${1:-}"; CMD="${2:-check}"
usage() { awk 'NR>2 && /^# =+$/ {exit} NR>2 {sub(/^# ?/, ""); print}' "$0"; exit 2; }
ops_load; ops_tier "$TIER" || usage
# shellcheck disable=SC1091
. "$KIT/bin/mail.sh"

NAS="${BACKUP_NAS_DIR:-}"; export BACKUP_NAS_DIR="${NAS:-$BACKUP_DIR/nas}"
MON_DIR="$BACKUP_DIR/monitor"; mkdir -p "$MON_DIR"
STATE="$MON_DIR/$TIER-state.json"; LOG="$MON_DIR/$TIER.log"
THRESH="${ALERT_FAIL_THRESHOLD:-2}"; REMIND_H="${ALERT_REMIND_H:-6}"; DISK_PCT="${ALERT_DISK_PCT:-90}"; TLS_DAYS="${ALERT_TLS_DAYS:-14}"

ts() { ops_ts; }
log() { echo "[$(ts)] [$TIER] $*" >> "$LOG"; }
dc() { ops_dc "$@"; }
curl_code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 12 "$1" 2>/dev/null || echo 000; }
RESULTS=()
ok()   { RESULTS+=("$1|OK|$2"); }
fail() { RESULTS+=("$1|FAIL|$2"); }
age_min_of() { echo $(( ( $(date +%s) - $(stat -c %Y "$1") ) / 60 )); }

run_checks() {
  local running missing svc code body newest age_min
  running=$(dc ps --status running --services 2>/dev/null | tr '\n' ' ')
  missing=""
  for svc in $OPS_SERVICES; do [[ " $running " == *" $svc "* ]] || missing+="$svc "; done
  [[ -z "$missing" ]] && ok containers "$OPS_SERVICES running" || fail containers "not running: ${missing}(docker compose -f $(basename "$COMPOSE") ps)"

  if dc exec -T "$OPS_DB_SERVICE" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 \
     && [[ "$(dc exec -T "$OPS_DB_SERVICE" sh -c 'psql -qAtX -U "$POSTGRES_USER" "$POSTGRES_DB" -c "SELECT 1"' 2>/dev/null)" == "1" ]]; then ok db "postgres answers"
  else fail db "Postgres not answering — docker compose logs $OPS_DB_SERVICE"; fi

  if [[ -n "$OPS_REDIS_SERVICE" ]]; then
    local out
    if [[ -n "$REDIS_PASS" ]]; then out=$(dc exec -T "$OPS_REDIS_SERVICE" redis-cli -a "$REDIS_PASS" --no-auth-warning ping 2>/dev/null)
    else out=$(dc exec -T "$OPS_REDIS_SERVICE" redis-cli ping 2>/dev/null); fi
    [[ "$out" == "PONG" ]] && ok redis "PONG" || fail redis "redis not answering PING"
  fi

  if [[ -n "$API_PORT" ]]; then
    code=$(curl_code "http://127.0.0.1:$API_PORT$OPS_HEALTH_PATH")
    [[ "$code" == "200" ]] && ok api_local "HTTP 200 on 127.0.0.1:$API_PORT" || fail api_local "HTTP $code from the API container port $API_PORT — docker compose logs $OPS_API_SERVICE"
  fi

  if [[ -n "$HOST" ]]; then
    code=$(curl_code "https://$HOST$OPS_HEALTH_PATH")
    [[ "$code" == "200" ]] && ok api_public "https://$HOST$OPS_HEALTH_PATH ok" || fail api_public "https://$HOST$OPS_HEALTH_PATH → HTTP $code — DNS / nginx / TLS / api"
    if [[ -n "$OPS_READY_PATH" ]]; then
      code=$(curl_code "https://$HOST$OPS_READY_PATH")
      [[ "$code" == "200" ]] && ok api_ready "app can reach its database" || fail api_ready "HTTP $code from $OPS_READY_PATH — the API cannot reach Postgres"
    fi
    if [[ -n "$OPS_WEB_PATH" ]]; then
      code=$(curl_code "https://$HOST$OPS_WEB_PATH")
      [[ "$code" == "200" ]] && ok web "https://$HOST$OPS_WEB_PATH HTTP 200" || fail web "https://$HOST$OPS_WEB_PATH HTTP $code"
    fi
    if [[ -n "$OPS_BACKUP_HEALTH_PATH" ]]; then
      code=$(curl_code "https://$HOST$OPS_BACKUP_HEALTH_PATH")
      [[ "$code" == "200" ]] && ok backup "WAL archiving alive" || fail backup "HTTP $code from $OPS_BACKUP_HEALTH_PATH — WAL archiving stalled/off ($OPS_KIT_DIR/bin/backup.sh $TIER status)"
    fi
    local notafter days
    notafter=$(echo | openssl s_client -servername "$HOST" -connect "$HOST:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    if [[ -n "$notafter" ]]; then
      days=$(( ( $(date -d "$notafter" +%s) - $(date +%s) ) / 86400 ))
      [[ "$days" -gt "$TLS_DAYS" ]] && ok tls "certificate valid $days more days" || fail tls "TLS certificate expires in $days days ($notafter)"
    else fail tls "could not read the certificate from $HOST:443"; fi
  fi

  local st_file="$BACKUP_DIR/$TIER-status.json"
  if [[ -f "$st_file" ]]; then
    age_min=$(age_min_of "$st_file")
    if (( age_min > 90 )); then fail backup_job "backup.sh $TIER check last ran $age_min min ago — its cron is not running (crontab -l)"
    else
      local probs; probs=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("; ".join(d.get("problems",[])))' "$st_file" 2>/dev/null)
      [[ -z "$probs" ]] && ok backup_job "backup check ran $age_min min ago, no problems" || fail backup_job "$probs"
    fi
    local enc; enc=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); c=d.get("repo_cipher") or ["?"]; f=d.get("files_encrypted"); g=d.get("guard") or {}
print(("repo:"+",".join(c))+" files:"+("enc" if f else "PLAIN")+" guard:"+("BLOCKED" if g.get("blocked") else "ok"))' "$st_file" 2>/dev/null)
    case "$enc" in
      *"guard:BLOCKED"*) fail backup_guard "off-box copy BLOCKED by the shrink guard — the local backup set shrank unexpectedly ($OPS_KIT_DIR/bin/backup.sh $TIER status)" ;;
      *) ok backup_guard "shrink guard clear" ;;
    esac
    if [[ "$enc" == *"repo:aes-256-cbc"* && "$enc" == *"files:enc"* ]]; then ok backup_encryption "repository + files encrypted at rest"
    else fail backup_encryption "backups not fully encrypted at rest ($enc) — BACKUP_REPO_CIPHER_PASS + BACKUP_DATA_PASSPHRASE, then backup.sh $TIER encrypt-repo"; fi
  else fail backup_job "no backup status file — run: $OPS_KIT_DIR/bin/backup.sh $TIER init"; fi

  newest=$(ls -t "$BACKUP_DIR/dumps/$TIER-"*.sql.gz* 2>/dev/null | head -1)
  if [[ -n "$newest" ]]; then age_min=$(age_min_of "$newest"); (( age_min < 26*60 )) && ok backup_dump "newest dump $((age_min/60)) h old" || fail backup_dump "newest logical dump is $((age_min/60)) h old — nightly backup did not run"
  else fail backup_dump "no logical dump for $TIER under $BACKUP_DIR/dumps"; fi
  if [[ -n "$UPLOADS_VOL" && "$UPLOADS_VOL" != "none" ]]; then
    if [[ -f "$BACKUP_DIR/uploads-$TIER/.last-sync" ]]; then
      age_min=$(( ( $(date +%s) - $(cat "$BACKUP_DIR/uploads-$TIER/.last-sync") ) / 60 ))
      (( age_min < 8*60 )) && ok backup_uploads "uploads copied $age_min min ago" || fail backup_uploads "uploads copy is $((age_min/60)) h old — 4-hourly sync not running"
    else fail backup_uploads "uploads never copied — run: $OPS_KIT_DIR/bin/backup.sh $TIER uploads"; fi
  fi
  newest=$(ls -t "$BACKUP_DIR/config/config-$TIER-"*.tar.enc 2>/dev/null | head -1)
  if [[ -n "$newest" ]]; then age_min=$(age_min_of "$newest"); (( age_min < 50*60 )) && ok backup_config "config bundle $((age_min/60)) h old" || fail backup_config "config bundle is $((age_min/60)) h old"
  else fail backup_config "no config bundle yet — set BACKUP_CONFIG_PASSPHRASE and run: backup.sh $TIER config"; fi
  newest=$(ls -t "$BACKUP_DIR/code/$OPS_SLUG-"*.bundle 2>/dev/null | grep -v -- "-latest" | head -1)
  if [[ -n "$newest" ]]; then age_min=$(age_min_of "$newest"); (( age_min < 50*60 )) && ok backup_code "code bundle $((age_min/60)) h old" || fail backup_code "code (git) bundle is $((age_min/60)) h old"
  else fail backup_code "no code (git) bundle yet — run: backup.sh $TIER code"; fi
  if [[ -n "$MASTERS_CMD" ]]; then
    newest=$(ls -td "$BACKUP_DIR/masters-$TIER"/20*/ 2>/dev/null | head -1)
    if [[ -n "$newest" && -f "$newest/manifest.json" ]]; then age_min=$(age_min_of "$newest/manifest.json"); (( age_min < 8*24*60 )) && ok backup_masters "master export $((age_min/1440)) d old" || fail backup_masters "weekly master export is $((age_min/1440)) days old"
    else fail backup_masters "no master export yet — run: docker compose -f $(basename "$COMPOSE") run --rm $OPS_API_SERVICE $MASTERS_CMD"; fi
  fi
  if [[ "${BACKUP_IMAGES:-yes}" != "no" ]]; then
    newest=$(ls -t "$BACKUP_DIR/images/images-$TIER-"*.tar.gz 2>/dev/null | head -1)
    if [[ -n "$newest" ]]; then age_min=$(age_min_of "$newest"); (( age_min < 50*60 )) && ok backup_images "images archive $((age_min/60)) h old" || fail backup_images "docker images archive is $((age_min/60)) h old"
    else fail backup_images "no docker images archive yet — run: backup.sh $TIER images"; fi
  fi
  if [[ -n "${EXPO_TOKEN:-}" ]]; then
    if [[ -f "$BACKUP_DIR/mobile-builds/.last-run" ]]; then age_min=$(( ( $(date +%s) - $(cat "$BACKUP_DIR/mobile-builds/.last-run") ) / 60 )); (( age_min < 9*24*60 )) && ok backup_mobile "mobile artefacts fetched $((age_min/1440)) d ago" || fail backup_mobile "mobile build artefacts are $((age_min/1440)) days old (EXPO_TOKEN valid?)"
    else fail backup_mobile "mobile build artefacts never fetched — run: backup.sh $TIER mobile-builds"; fi
  fi
  if [[ "$OPS_ESCROW" != "no" ]]; then
    newest=$(ls -t "$BACKUP_DIR/escrow/"escrow-*.tar.enc 2>/dev/null | head -1)
    if [[ -n "$newest" ]]; then age_min=$(age_min_of "$newest"); (( age_min < 100*24*60 )) && ok escrow "credentials escrow $((age_min/1440)) d old" || fail escrow "credentials escrow is $((age_min/1440)) days old — escrow.sh check && seal"
    else fail escrow "no credentials escrow bundle — set it up once: $OPS_KIT_DIR/bin/escrow.sh init ($OPS_KIT_DIR/docs/credentials-escrow.md)"; fi
  fi

  local pct
  pct=$(df --output=pcent / | tail -1 | tr -dc '0-9')
  [[ "${pct:-0}" -lt "$DISK_PCT" ]] && ok disk_root "/ at ${pct}%" || fail disk_root "/ is ${pct}% full"
  pct=$(df --output=pcent "$BACKUP_DIR" 2>/dev/null | tail -1 | tr -dc '0-9')
  [[ "${pct:-0}" -lt "$DISK_PCT" ]] && ok disk_backup "$BACKUP_DIR at ${pct}%" || fail disk_backup "$BACKUP_DIR is ${pct}% full — backups will start failing"

  if [[ -n "$NAS" || -n "${BACKUP_FTP_HOST:-}" || -n "${BACKUP_OFFSITE_RSYNC:-}" ]]; then
    if [[ -f "$BACKUP_DIR/.offsite-last" ]]; then
      age_min=$(( ( $(date +%s) - $(cat "$BACKUP_DIR/.offsite-last") ) / 60 ))
      (( age_min < 8*60 )) && ok backup_offsite "off-box copy $age_min min ago" || fail backup_offsite "off-box copy is $((age_min/60)) h old — the 4-hourly offsite step is failing (backup-$TIER.log)"
    else fail backup_offsite "no off-box copy yet — run: backup.sh $TIER offsite"; fi
  fi
  if [[ -n "$NAS" ]]; then
    if mountpoint -q "$NAS" 2>/dev/null && touch "$NAS/.probe-$HOST_TAG" 2>/dev/null; then
      ok nas "$NAS mounted + writable"
      mkdir -p "$NAS/$HOST_TAG" 2>/dev/null; date +%s > "$NAS/$HOST_TAG/heartbeat-$TIER" 2>/dev/null
    else fail nas "$NAS not mounted or not writable"; fi
  fi
}

evaluate() {
  RESULTS_TXT="$(printf '%s\n' "${RESULTS[@]}")" python3 - "$STATE" "$THRESH" "$REMIND_H" "$TIER" "$HOST" "$HOST_TAG" "$OPS_LABEL" "$OPS_KIT_DIR" <<'PY'
import json, sys, time, os
state_file, thresh, remind_h, tier, host, hostname, label, kit = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7], sys.argv[8]
now = time.time()
try: state = json.load(open(state_file))
except Exception: state = {"checks": {}, "last_alert": 0, "down": False}
checks = state.setdefault("checks", {})
results = [l.split('|', 2) for l in os.environ.get('RESULTS_TXT', '').splitlines() if l.strip()]
newly_down, still_down, recovered = [], [], []
for name, st, detail in results:
    c = checks.setdefault(name, {"status": "OK", "fails": 0, "since": None, "detail": ""})
    c["detail"] = detail
    if st == "FAIL":
        c["fails"] += 1
        if c["status"] == "OK" and c["fails"] >= thresh:
            c["status"] = "FAIL"; c["since"] = now; newly_down.append((name, detail))
        elif c["status"] == "FAIL":
            still_down.append((name, detail, c["since"]))
    else:
        if c["status"] == "FAIL": recovered.append((name, detail, c["since"]))
        c["status"] = "OK"; c["fails"] = 0; c["since"] = None
failing = [(n, c["detail"], c["since"]) for n, c in checks.items() if c["status"] == "FAIL"]
remind = failing and (now - state.get("last_alert", 0)) > remind_h * 3600
send = None
def fmt_since(s): return time.strftime('%Y-%m-%d %H:%M', time.localtime(s)) if s else '?'
if newly_down or (remind and not recovered):
    kind = "DOWN" if newly_down else "STILL DOWN"
    lines = [f"{label} {tier.upper()} — {kind} on {hostname} ({host}) at {time.strftime('%Y-%m-%d %H:%M:%S')}", ""]
    if newly_down:
        lines.append("New failures:"); lines += [f"  ✗ {n}: {d}" for n, d in newly_down]
    others = [f for f in failing if f[0] not in dict(newly_down)]
    if others:
        lines.append("Still failing:"); lines += [f"  ✗ {n} (since {fmt_since(s)}): {d}" for n, d, s in others]
    lines += ["", "Checks still OK: " + ", ".join(n for n, s, _ in results if s == "OK"),
              "", f"What to do: {kit}/docs/monitoring-alerts.md → 'When you get this mail'.",
              f"Server: ssh {hostname}; {kit}/bin/healthcheck.sh {tier} status"]
    send = (f"[{label} {tier.upper()}] {kind}: " + ", ".join(n for n, _, _ in failing), "\n".join(lines))
    state["last_alert"] = now; state["down"] = True
elif recovered and not failing:
    dur = max((now - (s or now)) for _, _, s in recovered) / 60
    lines = [f"{label} {tier.upper()} — RECOVERED on {hostname} ({host}) at {time.strftime('%Y-%m-%d %H:%M:%S')}", "",
             f"Back to normal after ~{dur:.0f} min:"] + [f"  ✓ {n}: {d}" for n, d, _ in recovered] + ["", "All checks OK."]
    send = (f"[{label} {tier.upper()}] RECOVERED: " + ", ".join(n for n, _, _ in recovered), "\n".join(lines))
    state["down"] = False; state["last_alert"] = now
elif recovered:
    lines = [f"{label} {tier.upper()} — partial recovery on {hostname}", ""] + [f"  ✓ {n}" for n, _, _ in recovered] + ["", "Still failing:"] + [f"  ✗ {n}: {d}" for n, d, _ in failing]
    send = (f"[{label} {tier.upper()}] partial recovery; still down: " + ", ".join(n for n, _, _ in failing), "\n".join(lines))
    state["last_alert"] = now
state["updated_at"] = now; state["results"] = [{"check": n, "status": s, "detail": d} for n, s, d in results]
tmp = state_file + ".tmp"; json.dump(state, open(tmp, "w"), indent=2); os.replace(tmp, state_file)
if send:
    print("SEND"); print(send[0]); print(send[1])
else:
    print("NOSEND")
PY
}

cmd_check() {
  run_checks
  local out subject body fails
  out=$(evaluate)
  fails=$(printf '%s\n' "${RESULTS[@]}" | grep -c '|FAIL|' || true)
  log "check: $(( ${#RESULTS[@]} - fails )) ok, $fails failing$( [[ $fails -gt 0 ]] && printf ' — %s' "$(printf '%s\n' "${RESULTS[@]}" | grep '|FAIL|' | cut -d'|' -f1 | tr '\n' ' ')" )"
  if [[ "$(echo "$out" | head -1)" == "SEND" ]]; then
    subject=$(echo "$out" | sed -n 2p); body=$(echo "$out" | tail -n +3)
    if alert_mail "$subject" "$body"; then log "mail sent: $subject"; else log "MAIL FAILED: $subject"; fi
  fi
}
cmd_status() {
  run_checks
  printf '%-18s %-5s %s\n' CHECK STATE DETAIL
  for r in "${RESULTS[@]}"; do IFS='|' read -r n s d <<< "$r"; printf '%-18s %-5s %s\n' "$n" "$s" "$d"; done
  [[ -f "$STATE" ]] && python3 -c 'import json,sys,time; d=json.load(open(sys.argv[1])); f=[k for k,v in d["checks"].items() if v["status"]=="FAIL"]; print("\nalert state:", "DOWN: "+", ".join(f) if f else "all OK", "| last alert:", time.strftime("%F %T", time.localtime(d.get("last_alert",0))) if d.get("last_alert") else "never")' "$STATE"
}
cmd_summary() {
  [[ "${ALERT_DAILY_SUMMARY:-false}" == "true" ]] || exit 0
  run_checks
  local fails; fails=$(printf '%s\n' "${RESULTS[@]}" | grep -c '|FAIL|' || true)
  local body; body=$(for r in "${RESULTS[@]}"; do IFS='|' read -r n s d <<< "$r"; printf '  %s %s: %s\n' "$([[ $s == OK ]] && echo ✓ || echo ✗)" "$n" "$d"; done)
  alert_mail "[$OPS_LABEL ${TIER^^}] daily summary — $([[ $fails -eq 0 ]] && echo all OK || echo "$fails problem(s)")" \
"$OPS_LABEL ${TIER^^} on $HOST_TAG ($HOST) — $(date '+%F %T')

$body

$(df -h / "$BACKUP_DIR" 2>/dev/null | tail -n 2 | sed 's/^/  /')"
}
cmd_install_cron() {
  local me; me="$(readlink -f "$0")"; local tmp; tmp=$(mktemp)
  crontab -l 2>/dev/null | grep -v "healthcheck.sh $TIER " > "$tmp" || true
  cat >> "$tmp" <<EOF
# $OPS_LABEL $TIER watchdog ($OPS_KIT_DIR/bin/healthcheck.sh — $OPS_KIT_DIR/docs/monitoring-alerts.md)
*/2 * * * * $me $TIER check >> $LOG 2>&1
0 8 * * * $me $TIER summary >> $LOG 2>&1
EOF
  crontab "$tmp"; rm -f "$tmp"; crontab -l | grep "healthcheck.sh $TIER "
}

case "$CMD" in
  check) cmd_check ;;
  status) cmd_status ;;
  summary) cmd_summary ;;
  test-mail) alert_mail_test ;;
  install-cron) cmd_install_cron ;;
  *) usage ;;
esac
