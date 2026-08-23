#!/usr/bin/env bash
# Journal, end-to-end against the live local stack (windmill_server on :$PORT + Postgres).
#
# Prereqs: schema applied (psql windmill -f db/schema.sql) and the server running with .env:
#   set -a && . ./.env && set +a && ./build/windmill_server
# Run:  bash test/e2e/journal.sh
set -uo pipefail

PORT="${PORT:-8088}"
BASE="http://localhost:$PORT"
ORIGIN="${ORIGIN:-http://localhost:5173}"
DB="${WM_E2E_DB:-windmill}"
EMAIL="journal-e2e@example.com"
DAY="2026-07-27"
JAR="$(mktemp)"
pass=0; fail=0
check(){ if [ "$1" = "$2" ]; then echo "  ok   $3"; pass=$((pass+1)); else echo "  FAIL $3 — want [$2] got [$1]"; fail=$((fail+1)); fi; }
field(){ python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }
count(){ python3 -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null; }

# ── session ────────────────────────────────────────────────────────────────────────────────────
psql "$DB" -q -c "insert into users (id,email) values (gen_random_uuid(),'$EMAIL') on conflict (email) do nothing"
USER_ID="$(psql "$DB" -tAc "select id from users where email='$EMAIL'")"
SECRET="$(openssl rand -hex 24)"; HASH="$(printf '%s' "$SECRET" | shasum -a 256 | awk '{print $1}')"
NOW="$(python3 -c 'import time;print(int(time.time()*1000))')"
psql "$DB" -q -c "insert into magic_links (token_hash,email,created_ms,expires_ms) values ('$HASH','$EMAIL',$NOW,$((NOW+900000)))"
curl -s -c "$JAR" -X POST "$BASE/v1/auth/verify" -H 'content-type: application/json' -H "Origin: $ORIGIN" -d "{\"token\":\"$SECRET\"}" >/dev/null
# clean slate for a repeatable run
psql "$DB" -q -c "delete from journal_page where user_id='$USER_ID'; delete from journal_page_revision where user_id='$USER_ID'"

j(){ curl -s -b "$JAR" -H "Origin: $ORIGIN" "$@"; }
put(){ j -X PUT "$BASE/v1/journal/page/$DAY" -H 'content-type: application/json' -d "$1"; }

# ── the canvas ───────────────────────────────────────────────────────────────────────────────
R="$(put '{"body":"first light","mood":7,"energy":5,"source":"typed","stamp":"100:0:devA"}')"
check "$(echo "$R" | field "['body']")" "first light" "PUT stores the page"
check "$(echo "$R" | field "['mood']")" "7" "PUT stores mood"
check "$(echo "$R" | field "['energy']")" "5" "PUT stores energy"

R="$(j "$BASE/v1/journal/page/$DAY")"
check "$(echo "$R" | field "['body']")" "first light" "GET returns the page"

# LWW: an older stamp from another device loses, and the response is the WINNER, not the stale write
R="$(put '{"body":"STALE","mood":1,"energy":2,"source":"typed","stamp":"50:0:devB"}')"
check "$(echo "$R" | field "['body']")" "first light" "older stamp loses (winner returned)"

# LWW: a newer stamp wins
R="$(put '{"body":"clearer now","mood":9,"energy":8,"source":"spoken","stamp":"200:0:devB"}')"
check "$(echo "$R" | field "['body']")" "clearer now" "newer stamp wins"
check "$(echo "$R" | field "['source']")" "spoken" "source=spoken persists"

# The 0..10 contract: 0 is an answer, null is silence, and the two never collapse into each other.
R="$(put '{"body":"the floor","mood":0,"energy":0,"source":"typed","stamp":"300:0:devB"}')"
check "$(echo "$R" | field "['mood']")" "0" "mood 0 stores as zero, not as unset"
check "$(echo "$R" | field "['energy']")" "0" "energy 0 stores as zero, not as unset"
check "$(psql "$DB" -tAc "select mood is null from journal_page where user_id='$USER_ID'")" "f" \
      "a stored 0 is not a SQL null"

R="$(put '{"body":"unanswered","mood":null,"energy":null,"source":"typed","stamp":"400:0:devB"}')"
check "$(echo "$R" | field "['mood']")" "None" "null mood comes back null"
check "$(echo "$R" | field "['energy']")" "None" "null energy comes back null"
check "$(psql "$DB" -tAc "select mood is null and energy is null from journal_page where user_id='$USER_ID'")" "t" \
      "an unanswered scale is a SQL null"

# Out of range narrows to unset; a bad scale never costs the writer their page.
R="$(put '{"body":"eleven","mood":11,"energy":-1,"source":"typed","stamp":"500:0:devB"}')"
check "$(echo "$R" | field "['body']")" "eleven" "an out-of-range scale still stores the body"
check "$(echo "$R" | field "['mood']")" "None" "mood 11 narrows to null"
check "$(echo "$R" | field "['energy']")" "None" "energy -1 narrows to null"

# Back to a real page for the reads below.
R="$(put '{"body":"clearer now","mood":9,"energy":8,"source":"spoken","stamp":"600:0:devB"}')"
check "$(echo "$R" | field "['mood']")" "9" "the whole range round trips"

# the invisible safety net: exactly the one superseded body ('first light'); the ignored STALE wrote nothing
REV="$(psql "$DB" -tAc "select count(*) from journal_page_revision where user_id='$USER_ID'")"
check "$REV" "5" "every superseded body kept as its own revision; the ignored STALE wrote none"

# delta feed (sync / search index): everything past the unset cursor
R="$(j "$BASE/v1/journal/pages?since=0:0:")"
check "$(echo "$R" | count)" "1" "since feed returns the page"

# export envelope
R="$(j "$BASE/v1/journal/export")"
check "$(echo "$R" | field "['pages'][0]['body']")" "clearer now" "export returns the winning body"

# owner-only: no session → 401 (no public surface)
CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $ORIGIN" "$BASE/v1/journal/export")"
check "$CODE" "401" "no session → 401"

echo; echo "$pass passed, $fail failed"; rm -f "$JAR"; [ "$fail" = 0 ]
