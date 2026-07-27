#!/usr/bin/env bash
# Journal Wave 1 — end-to-end against the LIVE local stack (windmill_server on :$PORT + Postgres).
#
# It mints a real session the way the app does (magic-link row → /v1/auth/verify → wm_session
# cookie), then drives the journal REST surface and asserts the behaviour that only shows up when
# the SQL, the HTTP layer and the wire boundary run together: LWW convergence across two "devices",
# the invisible revision trail, the delta feed, export, and the owner-only 401.
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
R="$(put '{"body":"first light","mood":4,"energy":2,"source":"typed","stamp":"100:0:devA"}')"
check "$(echo "$R" | field "['body']")" "first light" "PUT stores the page"
check "$(echo "$R" | field "['mood']")" "4" "PUT stores mood"

R="$(j "$BASE/v1/journal/page/$DAY")"
check "$(echo "$R" | field "['body']")" "first light" "GET returns the page"

# LWW: an older stamp from another device loses, and the response is the WINNER, not the stale write
R="$(put '{"body":"STALE","mood":1,"energy":1,"source":"typed","stamp":"50:0:devB"}')"
check "$(echo "$R" | field "['body']")" "first light" "older stamp loses (winner returned)"

# LWW: a newer stamp wins
R="$(put '{"body":"clearer now","mood":5,"energy":3,"source":"spoken","stamp":"200:0:devB"}')"
check "$(echo "$R" | field "['body']")" "clearer now" "newer stamp wins"
check "$(echo "$R" | field "['source']")" "spoken" "source=spoken persists"

# the invisible safety net: exactly the one superseded body ('first light'); the ignored STALE wrote nothing
REV="$(psql "$DB" -tAc "select count(*) from journal_page_revision where user_id='$USER_ID'")"
check "$REV" "1" "superseded body kept as one revision"

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
