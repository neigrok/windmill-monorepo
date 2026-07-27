#!/usr/bin/env bash
# Journal Wave 3 — echoes, end-to-end against the LIVE local stack. Locally there is no embedder
# wired (NullEmbedder ⇒ the nightly sweep is a no-op), so this exercises the parts that don't need a
# model: the owner-scoped READ + dismiss over real Postgres rows, that the score is never in the
# wire, and the admin-sweep token gate + report shape. The embed→match→store compute path is unit-
# covered (EchoSweepTest with a fake embedder + fake subscription).
#
# Prereqs: schema applied; server running with the echo admin token, e.g.:
#   set -a && . ./.env && set +a && JOURNAL_ECHO_ADMIN_TOKEN=e2e-echo ./build/windmill_server
# Run:  JOURNAL_ECHO_ADMIN_TOKEN=e2e-echo bash test/e2e/journal_echo.sh
set -uo pipefail

PORT="${PORT:-8088}"; BASE="http://localhost:$PORT"; ORIGIN="${ORIGIN:-http://localhost:5173}"
DB="${WM_E2E_DB:-windmill}"; ADMIN="${JOURNAL_ECHO_ADMIN_TOKEN:-e2e-echo}"
EMAIL="journal-echo-e2e@example.com"; JAR="$(mktemp)"
TODAY="$(date +%F)"; OLD="2025-07-20"; NOW_MS="$(python3 -c 'import time;print(int(time.time()*1000))')"
pass=0; fail=0
check(){ if [ "$1" = "$2" ]; then echo "  ok   $3"; pass=$((pass+1)); else echo "  FAIL $3 — want [$2] got [$1]"; fail=$((fail+1)); fi; }
field(){ python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }
count(){ python3 -c "import sys,json;print(len(json.load(sys.stdin)$1))" 2>/dev/null; }

psql "$DB" -q -c "insert into users (id,email) values (gen_random_uuid(),'$EMAIL') on conflict (email) do nothing"
U="$(psql "$DB" -tAc "select id from users where email='$EMAIL'")"
SECRET="$(openssl rand -hex 24)"; HASH="$(printf '%s' "$SECRET" | shasum -a 256 | awk '{print $1}')"
psql "$DB" -q -c "insert into magic_links (token_hash,email,created_ms,expires_ms) values ('$HASH','$EMAIL',$NOW_MS,$((NOW_MS+900000)))"
curl -s -c "$JAR" -X POST "$BASE/v1/auth/verify" -H 'content-type: application/json' -H "Origin: $ORIGIN" -d "{\"token\":\"$SECRET\"}" >/dev/null
psql "$DB" -q -c "delete from journal_echo where user_id='$U'"
# seed one echo: today's page resonates with the older one (what the nightly sweep would have written)
psql "$DB" -q -c "insert into journal_echo (user_id,trigger_day,match_day,trigger_lo,trigger_hi,match_lo,match_hi,score) values ('$U','$TODAY','$OLD',0,10,0,12,0.8)"

j(){ curl -s -b "$JAR" -H "Origin: $ORIGIN" "$@"; }

# ── read: the owner sees the echo; the score is never on the wire ────────────────────────────────
R="$(j "$BASE/v1/journal/echoes")"
check "$(echo "$R" | count "['echoes']")" "1" "owner reads their one echo"
check "$(echo "$R" | field "['echoes'][0]['matchDay']")" "$OLD" "the echo names the older day"
check "$(echo "$R" | python3 -c "import sys,json;print('score' in json.load(sys.stdin)['echoes'][0])")" "False" "score is presence, never a number"

# ── dismiss retires it for that page ─────────────────────────────────────────────────────────────
CODE="$(j -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/journal/echoes/$TODAY/dismiss")"
check "$CODE" "204" "dismiss answers 204"
check "$(j "$BASE/v1/journal/echoes" | count "['echoes']")" "0" "a dismissed echo is gone from the list"

# ── admin sweep: token-gated, runs, reports (0 found — no embedder wired locally) ────────────────
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/admin/journal/echo/sweep" -d '{}')"
check "$CODE" "403" "echo sweep without the token → 403"
R="$(curl -s -H "X-Admin-Token: $ADMIN" -X POST "$BASE/v1/admin/journal/echo/sweep" -H 'content-type: application/json' -d "{\"asOfMs\":$NOW_MS}")"
check "$(echo "$R" | field "['echoesFound']")" "0" "the sweep runs and reports (no embedder ⇒ 0 found)"

# ── unauth read is owner-only ────────────────────────────────────────────────────────────────────
CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $ORIGIN" "$BASE/v1/journal/echoes")"
check "$CODE" "401" "no session → 401"

echo; echo "$pass passed, $fail failed"; rm -f "$JAR"; [ "$fail" = 0 ]
