#!/usr/bin/env bash
# ===========================================================================
# ops-kit shared e-mail (+ optional webhook) sender — sourced by healthcheck.sh,
# backup.sh and deploy.sh. Sends through SMTP with curl (present on every
# Ubuntu), so no mail server is needed on the box. Works with a Google
# Workspace mailbox + App Password or any SMTP relay.
#
# Settings (.env.deploy): ALERT_EMAIL_TO (comma list), ALERT_SMTP_HOST,
#   ALERT_SMTP_PORT (465 smtps | 587 starttls), ALERT_SMTP_USER, ALERT_SMTP_PASS,
#   ALERT_SMTP_FROM (defaults to the user), ALERT_WEBHOOK_URL (Chat/Slack/Teams).
#   alert_mail "subject" "body" → 0 on success;  alert_mail_test
# ===========================================================================
alert_mail() {
  local subject="$1" body="$2"
  local to="${ALERT_EMAIL_TO:-${BACKUP_ALERT_EMAIL:-}}"
  local host="${ALERT_SMTP_HOST:-smtp.gmail.com}" port="${ALERT_SMTP_PORT:-465}"
  local user="${ALERT_SMTP_USER:-}" pass="${ALERT_SMTP_PASS:-}" from="${ALERT_SMTP_FROM:-${ALERT_SMTP_USER:-}}"
  local label="${OPS_LABEL:-Ops}" rc=0
  _alert_webhook "$subject" "$body" || true
  [[ -n "$to" ]] || { echo "alert_mail: ALERT_EMAIL_TO not set — NOT sent: $subject" >&2; return 1; }
  if [[ -n "$user" && -n "$pass" ]]; then
    local msg proto=smtps; msg=$(mktemp)
    [[ "$port" == "587" || "$port" == "25" ]] && proto=smtp
    printf 'From: %s Monitor <%s>\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nX-Priority: 1\r\n\r\n' \
      "$label" "$from" "$to" "$subject" "$(date -R)" > "$msg"
    printf '%s\r\n' "$body" | sed 's/$/\r/' >> "$msg"
    local rcpts=() a addrs
    IFS=',' read -ra addrs <<< "$to"
    for a in "${addrs[@]}"; do a="${a// /}"; [[ -n "$a" ]] && rcpts+=(--mail-rcpt "$a"); done
    curl -sS --max-time 40 --url "$proto://$host:$port" --ssl-reqd --mail-from "$from" "${rcpts[@]}" --user "$user:$pass" -T "$msg" >/dev/null 2>&1 || rc=$?
    rm -f "$msg"
    [[ $rc -eq 0 ]] || echo "alert_mail: SMTP send failed (curl rc=$rc) — $subject" >&2
    return $rc
  fi
  if command -v mail >/dev/null 2>&1; then printf '%s\n' "$body" | mail -s "$subject" "$to"; return $?; fi
  echo "alert_mail: no ALERT_SMTP_USER/PASS and no local mail command — NOT sent: $subject" >&2
  return 1
}
_alert_webhook() {
  [[ -n "${ALERT_WEBHOOK_URL:-}" ]] || return 0
  local text; text=$(printf '%s\n%s' "$1" "$2" | python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))' 2>/dev/null) || return 1
  curl -sS --max-time 15 -H 'Content-Type: application/json' -d "$text" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1
}
alert_mail_test() {
  if alert_mail "[${OPS_LABEL:-Ops}] test alert from $(hostname)" "Test message from the ${OPS_LABEL:-Ops} monitoring scripts on $(hostname) at $(date '+%F %T %Z').
If you can read this, e-mail alerts are working."; then echo "test mail sent to ${ALERT_EMAIL_TO:-${BACKUP_ALERT_EMAIL:-}}"
  else echo "test mail FAILED — check ALERT_SMTP_* in .env.deploy (Gmail needs an App Password, port 465)"; return 1; fi
}
