#!/bin/bash
# Read-only acceptance test for the Assure integration API (API_SPEC_v1.md §9).
# Only GETs are issued; nothing is written anywhere except stdout.
#
#   TMS_URL=https://qatms.shreejamilk.com ASSURE_API_KEY=<key> ./verify_assure_api.sh
#
# Needs curl + python3. If the sample CSVs (trips_*.csv / loadings_*.csv /
# receipts_*.csv) sit in ../samples/ next to this script, the id sets returned
# for the sample week are compared against them (spec §9.2). Exits non-zero on
# any FAIL.
set -uo pipefail

TMS_URL="${TMS_URL:-https://qatms.shreejamilk.com}"
TMS_URL="${TMS_URL%/}"
BASE="$TMS_URL/api/integrations/assure"
FROM="${FROM_DATE:-2026-08-01}"
TO="${TO_DATE:-2026-08-07}"
SAMPLES="$(cd "$(dirname "$0")/../samples" 2>/dev/null && pwd || true)"

if [ -z "${ASSURE_API_KEY:-}" ]; then
  echo "ASSURE_API_KEY is not set" >&2; exit 2
fi

FAILS=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILS=$((FAILS+1)); }
check() { # check <ok:0|1> <label>
  if [ "$1" = 0 ]; then pass "$2"; else fail "$2"; fi
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# get <name> <path-with-query> [key]  → writes $TMP/<name>.body, echoes HTTP status
get() {
  local name="$1" path="$2" key="${3:-$ASSURE_API_KEY}"
  curl -sS -o "$TMP/$name.body" -w '%{http_code}' -H "X-Assure-Key: $key" "$BASE$path" 2>/dev/null || echo 000
}
# py <name> <python expression over j (parsed body)> → prints result
py() { python3 -c "import json,sys; j=json.load(open(sys.argv[1])); print($2)" "$TMP/$1.body" 2>/dev/null; }
code_of() { py "$1" "j.get('code','')"; }

echo "== Assure API acceptance against $BASE ($FROM .. $TO) =="

# 1. ping
st=$(get ping /ping)
check $([ "$st" = 200 ] && [ "$(py ping "j.get('ok') is True and j.get('contract')=='assure-v1'")" = True ] && echo 0 || echo 1) \
  "ping → 200 with contract assure-v1 (got $st)"
st=$(get ping_bad /ping "wrong-key-$RANDOM")
check $([ "$st" = 401 ] && [ "$(code_of ping_bad)" = UNAUTHORIZED ] && echo 0 || echo 1) \
  "ping with wrong key → 401 UNAUTHORIZED (got $st)"
st=$(get ping_nokey /ping "")
check $([ "$st" = 401 ] && echo 0 || echo 1) "ping with no key → 401 (got $st)"

# 6. validation errors
st=$(get wide "/trips?from_date=2026-06-01&to_date=2026-08-30")
check $([ "$st" = 400 ] && [ "$(code_of wide)" = RANGE_TOO_WIDE ] && echo 0 || echo 1) \
  "90-day range → 400 RANGE_TOO_WIDE (got $st $(code_of wide))"
st=$(get nofilter "/trips")
check $([ "$st" = 400 ] && [ "$(code_of nofilter)" = MISSING_FILTER ] && echo 0 || echo 1) \
  "no params → 400 MISSING_FILTER (got $st $(code_of nofilter))"

# 2. sample-week rows per endpoint (single page, limit=2000) + CSV comparison
compare_csv() { # compare_csv <name> <id key> <csv glob prefix>
  local name="$1" key="$2" prefix="$3"
  local csv
  csv=$(ls "$SAMPLES"/${prefix}_${FROM}_${TO}.csv 2>/dev/null | head -1)
  if [ -z "$csv" ]; then echo "SKIP  $name: no $prefix CSV in $SAMPLES"; return; fi
  local out
  out=$(python3 - "$TMP/$name.body" "$csv" "$key" <<'PY'
import json, csv, sys
j = json.load(open(sys.argv[1])); key = sys.argv[3]
api = {int(r[key]) for r in j['data']}
with open(sys.argv[2], newline='') as f:
    rows = list(csv.DictReader(f))
ref = {int(r[key]) for r in rows}
missing = sorted(ref - api); extra = sorted(api - ref)
ok = (len(rows) == j['count']) and not missing and not extra
print(f"{'OK' if ok else 'DIFF'} csv_rows={len(rows)} api_rows={j['count']} missing={missing[:10]} extra={extra[:10]}")
PY
)
  check $([ "${out%% *}" = OK ] && echo 0 || echo 1) "$name: row count + id set equal to $(basename "$csv") — $out"
}

for ep in trips:trip_plan_id loadings:loading_id receipts:receipt_id; do
  name="${ep%%:*}"; key="${ep##*:}"
  st=$(get "$name" "/$name?from_date=$FROM&to_date=$TO&limit=2000")
  n=$(py "$name" "j.get('count',-1)")
  check $([ "$st" = 200 ] && [ "${n:-0}" -gt 0 ] && echo 0 || echo 1) "$name $FROM..$TO → 200, count=$n"
  [ "$st" = 200 ] && compare_csv "$name" "$key" "$name"
done

# 3. paging walk over /trips with limit=100
ok=1; ids=""; after=0; pages=0; dup=0
while :; do
  st=$(get "page" "/trips?from_date=$FROM&to_date=$TO&limit=100&after_id=$after")
  [ "$st" = 200 ] || break
  pages=$((pages+1))
  pageids=$(py page "' '.join(str(r['trip_plan_id']) for r in j['data'])")
  ids="$ids $pageids"
  nxt=$(py page "j.get('next_after_id')")
  [ "$nxt" = None ] && { ok=0; break; }
  after="$nxt"
  [ "$pages" -gt 100 ] && break
done
if [ "$ok" = 0 ]; then
  res=$(python3 - "$TMP/trips.body" "$ids" <<'PY'
import json, sys
single = sorted(int(r['trip_plan_id']) for r in json.load(open(sys.argv[1]))['data'])
walked = [int(x) for x in sys.argv[2].split()]
dups = len(walked) - len(set(walked))
print('OK' if (sorted(set(walked)) == single and dups == 0) else f'DIFF walked={len(walked)} dups={dups} single={len(single)}')
PY
)
  check $([ "$res" = OK ] && echo 0 || echo 1) "paging walk limit=100 ($pages pages) == single fetch, no dups/gaps — $res"
else
  fail "paging walk did not terminate cleanly (last status $st after $pages pages)"
fi

# 7. formats: +05:30 offset, numeric qty_kgs, nulls
fmt=$(python3 - "$TMP/loadings.body" "$TMP/trips.body" <<'PY'
import json, sys
L = json.load(open(sys.argv[1])); T = json.load(open(sys.argv[2]))
probs = []
if not str(L.get('server_time','')).endswith('+05:30'): probs.append('server_time offset')
rows = L['data']
if rows:
    if not str(rows[0]['updated_at']).endswith('+05:30'): probs.append('loadings.updated_at offset')
    if not any(isinstance(r['qty_kgs'], (int, float)) for r in rows): probs.append('qty_kgs not a number')
    if any(isinstance(r['qty_kgs'], str) for r in rows): probs.append('qty_kgs is a string')
    if any(v == '' or v == 'NULL' for r in rows for v in r.values()): probs.append('blank/NULL strings present')
trows = T['data']
if trows:
    if not str(trows[0]['created_at']).endswith('+05:30'): probs.append('trips.created_at offset')
    if not all(len(str(r['plan_for_date'])) == 10 for r in trows): probs.append('plan_for_date not YYYY-MM-DD')
print('OK' if not probs else 'DIFF ' + '; '.join(probs))
PY
)
check $([ "$fmt" = OK ] && echo 0 || echo 1) "timestamps end with +05:30, qty_kgs numeric, no blank strings — $fmt"

echo
if [ "$FAILS" = 0 ]; then echo "ALL PASS"; exit 0; else echo "$FAILS FAILED"; exit 1; fi
