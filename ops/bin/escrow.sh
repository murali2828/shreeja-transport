#!/usr/bin/env bash
# ===========================================================================
# ops-kit credentials ESCROW — the keys and accounts that live OUTSIDE this
# server (app signing keys, store / push / cloud service accounts, third-party
# logins) that no database or code backup covers. Register + procedure:
# ops/docs/credentials-escrow.md. Required items: ops/escrow.manifest.
#
#   escrow.sh init            # create <repo>/.escrow/ (git-ignored) with a README
#   escrow.sh check           # required items present / missing; exit 1 if any missing
#   escrow.sh seal [--quiet]  # AES-256 bundle → $BACKUP_DIR/escrow/escrow-<host>-<date>.tar.enc
#   escrow.sh list
#   escrow.sh open <bundle>   # decrypt into <repo>/restored-escrow/ (DR / drill)
# Passphrase: BACKUP_DATA_PASSPHRASE (falls back to BACKUP_CONFIG_PASSPHRASE).
# THE PASSPHRASES THEMSELVES MUST NOT BE INSIDE THE ESCROW (vault + envelope).
# ===========================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CMD="${1:-}"; ARG="${2:-}"
ops_load
STAGE="$ROOT/.escrow"; OUT="$BACKUP_DIR/escrow"; MANIFEST="$KIT/escrow.manifest"
PASS="$DATA_PASS"
QUIET=0; [[ "${2:-}" == "--quiet" || "${3:-}" == "--quiet" ]] && QUIET=1
say() { [[ "$QUIET" == "1" ]] || echo "$*"; }
tools() { docker image inspect "$TOOLS_IMG" >/dev/null 2>&1 || docker build -q -t "$TOOLS_IMG" "$KIT/tools" >/dev/null; }

cmd_init() {
  mkdir -p "$STAGE"/{mobile,cloud,accounts}; chmod 700 "$STAGE"
  [[ -f "$STAGE/README.md" ]] || cat > "$STAGE/README.md" <<'EOF'
# Credentials escrow staging area (git-ignored, chmod 700)

Put EXPORTED credential files here, then run `ops/bin/escrow.sh check` and
`ops/bin/escrow.sh seal`. The register (what each item is, how to export it,
the two custodians, rotation) is ops/docs/credentials-escrow.md; the required
file list is ops/escrow.manifest — edit both for THIS project.

  mobile/    app signing keys (Android keystore + credentials.json, APNs .p8, ASC API key, dist cert …) — if the project has an app
  cloud/     service-account keys: push (FCM), store publishing, object storage, mail, DNS API …
  accounts/  accounts.md — every third-party account → vault entry name, custodians, where the 2FA recovery codes are

Never put the backup passphrases in here — a bundle must not contain the key that opens it.
EOF
  echo "escrow staging created at $STAGE — fill it per $OPS_KIT_DIR/docs/credentials-escrow.md, then: $0 check && $0 seal"
}
cmd_check() {
  [[ -d "$STAGE" ]] || { echo "no $STAGE — run: $0 init"; exit 1; }
  local missing=0 present=0 line glob opt found
  while IFS= read -r line; do
    line="${line%%#*}"; line="$(echo "$line" | xargs)"; [[ -n "$line" ]] || continue
    opt=0; [[ "$line" == \?* ]] && { opt=1; line="${line#?}"; }
    glob="$line"
    # shellcheck disable=SC2086
    found=$(cd "$STAGE" && ls -1 $glob 2>/dev/null | head -1 || true)
    if [[ -n "$found" ]]; then present=$((present+1)); say "  ✓ $glob"
    elif [[ "$opt" == "1" ]]; then say "  · $glob  (optional, absent)"
    else missing=$((missing+1)); say "  ✗ $glob  MISSING"; fi
  done < "$MANIFEST"
  say "escrow check: $present present, $missing required missing"
  [[ "$missing" -eq 0 ]]
}
cmd_seal() {
  [[ -d "$STAGE" ]] || { say "escrow: no $STAGE (run: $0 init)"; exit 0; }
  [[ -n "$PASS" ]] || { echo "escrow: BACKUP_DATA_PASSPHRASE / BACKUP_CONFIG_PASSPHRASE not set — cannot seal"; exit 1; }
  if grep -rqs -e "$PASS" "$STAGE" 2>/dev/null; then echo "escrow: REFUSED — a file in $STAGE contains the backup passphrase itself."; exit 1; fi
  tools; mkdir -p "$OUT"
  local out="$OUT/escrow-$HOST_TAG-$(date +%F).tar.enc" tmp="$OUT/escrow-$HOST_TAG-$(date +%F).tar.enc.tmp"
  cmd_check >/dev/null 2>&1 || say "escrow: WARNING — required items are missing (run: $0 check); sealing what is present"
  docker run --rm -v "$STAGE:/in:ro" -v "$OUT:/out" -e PASS="$PASS" "$TOOLS_IMG" \
    sh -c 'tar cf - -C /in . | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:PASS -out /out/'"$(basename "$tmp")" && mv -f "$tmp" "$out"
  ls -t "$OUT"/escrow-*.tar.enc 2>/dev/null | tail -n +13 | xargs -r rm -f
  say "escrow sealed → $out ($(du -h "$out" | cut -f1))"
}
cmd_list() { ls -lt "$OUT"/escrow-*.tar.enc 2>/dev/null || echo "no escrow bundles under $OUT"; }
cmd_open() {
  [[ -f "$ARG" ]] || { echo "usage: $0 open <bundle.tar.enc>"; exit 2; }
  [[ -n "$PASS" ]] || { read -r -s -p "Escrow passphrase: " PASS; echo; }
  tools; local dest="$ROOT/restored-escrow"; mkdir -p "$dest"; chmod 700 "$dest"
  docker run --rm -v "$(dirname "$(readlink -f "$ARG")"):/in:ro" -v "$dest:/out" -e PASS="$PASS" "$TOOLS_IMG" \
    sh -c 'openssl enc -d -aes-256-cbc -pbkdf2 -pass env:PASS -in /in/'"$(basename "$ARG")"' | tar xf - -C /out'
  echo "decrypted into $dest — verify, then delete the folder (shred -u) when done"
}
case "$CMD" in
  init) cmd_init ;; check) cmd_check ;; seal) cmd_seal ;; list) cmd_list ;; open) cmd_open ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
