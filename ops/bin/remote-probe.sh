#!/usr/bin/env bash
# ===========================================================================
# ops-kit REMOTE probe — runs OUTSIDE the application server (on the NAS via
# its task scheduler, or any other Linux box / VM). Needs only bash + curl.
# The host watchdog cannot tell you the server is dead (its cron dies with
# it); this one can:
#   1. HTTPS probe of each application URL — mails when a URL stops answering
#      200 and again when it recovers;
#   2. HEARTBEAT check — healthcheck.sh writes <NAS>/<hostname>/heartbeat-<tier>
#      every 2 minutes; older than HEARTBEAT_MAX_MIN = the server (or its NFS
#      link) is down.
# Copy this file + a probe.env next to it onto the NAS and schedule it every
# 5 minutes. probe.env:
#   LABEL="MyApp"
#   URLS="https://app.example.com/api/v1/health https://qa.example.com/api/v1/health"
#   HEARTBEATS="/volume1/backups/<host>/heartbeat-prod /volume1/backups/<host>/heartbeat-qa"
#   HEARTBEAT_MAX_MIN=10  REMIND_H=6
#   ALERT_EMAIL_TO=… ALERT_SMTP_HOST=… ALERT_SMTP_PORT=465 ALERT_SMTP_USER=… ALERT_SMTP_PASS=…
# ===========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
[[ -f "$HERE/probe.env" ]] && { set -a; . "$HERE/probe.env"; set +a; }
STATE_DIR="${STATE_DIR:-$HERE/state}"; mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/probe.log"
LABEL="${LABEL:-Ops}"
URLS="${URLS:-}"; HEARTBEATS="${HEARTBEATS:-}"; HB_MAX="${HEARTBEAT_MAX_MIN:-10}"; REMIND_H="${REMIND_H:-6}"
ME="$(hostname -s 2>/dev/null || echo nas)"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

send_mail() {
  local to="${ALERT_EMAIL_TO:-}" host="${ALERT_SMTP_HOST:-smtp.gmail.com}" port="${ALERT_SMTP_PORT:-465}"
  local user="${ALERT_SMTP_USER:-}" pass="${ALERT_SMTP_PASS:-}" from="${ALERT_SMTP_FROM:-${ALERT_SMTP_USER:-}}" proto=smtps
  [[ -n "$to" && -n "$user" && -n "$pass" ]] || { log "mail not configured — $1"; return 1; }
  [[ "$port" == "587" || "$port" == "25" ]] && proto=smtp
  local msg; msg="$STATE_DIR/msg.$$"
  printf 'From: %s Remote Probe <%s>\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' "$LABEL" "$from" "$to" "$1" "$(date -R)" > "$msg"
  printf '%s\r\n' "$2" | sed 's/$/\r/' >> "$msg"
  local rcpts=() a addrs; IFS=',' read -ra addrs <<< "$to"; for a in "${addrs[@]}"; do a="${a// /}"; [[ -n "$a" ]] && rcpts+=(--mail-rcpt "$a"); done
  curl -sS --max-time 40 --url "$proto://$host:$port" --ssl-reqd --mail-from "$from" "${rcpts[@]}" --user "$user:$pass" -T "$msg" >/dev/null 2>&1
  local rc=$?; rm -f "$msg"; [[ $rc -eq 0 ]] && log "mail sent: $1" || log "mail FAILED rc=$rc: $1"; return $rc
}

now=$(date +%s)
DOWN=(); UP=(); REMIND=()
transition() {
  local key="$1" okflag="$2" detail="$3"
  local f="$STATE_DIR/$key.state" prev="OK" since=$now last=0
  [[ -f "$f" ]] && read -r prev since last < "$f"
  if [[ "$okflag" == "1" ]]; then
    [[ "$prev" == "FAIL" ]] && { UP+=("$key: $detail (down since $(date -d @"$since" '+%F %H:%M'))"); echo "OK $now 0" > "$f"; }
    [[ -f "$f" ]] || echo "OK $now 0" > "$f"
  else
    if [[ "$prev" == "OK" ]]; then DOWN+=("$key: $detail"); echo "FAIL $now $now" > "$f"
    elif (( now - last > REMIND_H * 3600 )); then REMIND+=("$key: $detail (since $(date -d @"$since" '+%F %H:%M'))"); echo "FAIL $since $now" > "$f"; fi
  fi
  return 0
}
for u in $URLS; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$u" 2>/dev/null || echo 000)
  key=$(echo "$u" | sed 's#https\?://##; s#[^A-Za-z0-9]#_#g')
  if [[ "$code" == "200" ]]; then transition "url_$key" 1 "$u answers 200"; else transition "url_$key" 0 "$u → HTTP $code (unreachable from $ME)"; fi
done
for hb in $HEARTBEATS; do
  key=$(basename "$hb")
  if [[ -f "$hb" ]]; then
    age=$(( (now - $(cat "$hb" 2>/dev/null || echo 0)) / 60 ))
    if (( age <= HB_MAX )); then transition "hb_$key" 1 "server heartbeat $age min old"; else transition "hb_$key" 0 "server heartbeat is $age min old (limit $HB_MAX) — the application server or its NAS link is DOWN"; fi
  else transition "hb_$key" 0 "heartbeat file $hb missing"; fi
done
if ((${#DOWN[@]} + ${#REMIND[@]})); then
  body="$LABEL remote probe on $ME — $(date '+%F %T')"$'\n\n'
  ((${#DOWN[@]})) && body+="NEW failures:"$'\n'"$(printf '  ✗ %s\n' "${DOWN[@]}")"$'\n'
  ((${#REMIND[@]})) && body+="STILL failing:"$'\n'"$(printf '  ✗ %s\n' "${REMIND[@]}")"$'\n'
  body+=$'\n'"If the server itself is down: ops/docs/disaster-recovery.md §3 (rebuild on another server)."
  keys=$(for x in "${DOWN[@]}" "${REMIND[@]}"; do echo "${x%%:*}"; done | paste -sd,)
  send_mail "[$LABEL] $( ((${#DOWN[@]})) && echo DOWN || echo 'STILL DOWN'): $keys" "$body"
fi
if ((${#UP[@]})); then
  keys=$(for x in "${UP[@]}"; do echo "${x%%:*}"; done | paste -sd,)
  send_mail "[$LABEL] RECOVERED: $keys" "$LABEL remote probe on $ME — $(date '+%F %T')"$'\n\n'"$(printf '  ✓ %s\n' "${UP[@]}")"
fi
log "probe: ${#DOWN[@]} new down, ${#REMIND[@]} reminders, ${#UP[@]} recovered"
