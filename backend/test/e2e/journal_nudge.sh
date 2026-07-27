#!/usr/bin/env bash
# Journal Wave 2 — nudges, end-to-end against the LIVE local stack. It drives the whole heartbeat
# through the admin time-travel sweep (no waiting for a real due instant, no real mail), and asserts
# the DECISION LEDGER per-user via psql (deterministic on a shared dev db, unlike the fleet-wide
# report counts). The device's job — materialising next_due_at — is played by PATCHing a past instant.
#
# Prereqs: schema applied; server running with the admin token, e.g.:
#   set -a && . ./.env && set +a && JOURNAL_NUDGE_ADMIN_TOKEN=e2e-admin ./build/windmill_server
# Run:  JOURNAL_NUDGE_ADMIN_TOKEN=e2e-admin bash test/e2e/journal_nudge.sh
set -uo pipefail

PORT="${PORT:-8088}"; BASE="http://localhost:$PORT"; ORIGIN="${ORIGIN:-http://localhost:5173}"
DB="${WM_E2E_DB:-windmill}"; ADMIN="${JOURNAL_NUDGE_ADMIN_TOKEN:-e2e-admin}"
EMAIL="journal-nudge-e2e@example.com"; JAR="$(mktemp)"
TODAY="$(date +%F)"; NOW_MS="$(python3 -c 'import time;print(int(time.time()*1000))')"; PAST_MS=$((NOW_MS - 60000))
pass=0; fail=0
check(){ if [ "$1" = "$2" ]; then echo "  ok   $3"; pass=$((pass+1)); else echo "  FAIL $3 — want [$2] got [$1]"; fail=$((fail+1)); fi; }
field(){ python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }

psql "$DB" -q -c "insert into users (id,email) values (gen_random_uuid(),'$EMAIL') on conflict (email) do nothing"
U="$(psql "$DB" -tAc "select id from users where email='$EMAIL'")"
SECRET="$(openssl rand -hex 24)"; HASH="$(printf '%s' "$SECRET" | shasum -a 256 | awk '{print $1}')"
psql "$DB" -q -c "insert into magic_links (token_hash,email,created_ms,expires_ms) values ('$HASH','$EMAIL',$NOW_MS,$((NOW_MS+900000)))"
curl -s -c "$JAR" -X POST "$BASE/v1/auth/verify" -H 'content-type: application/json' -H "Origin: $ORIGIN" -d "{\"token\":\"$SECRET\"}" >/dev/null
psql "$DB" -q -c "delete from journal_nudge_day where user_id='$U'; delete from journal_nudge where user_id='$U'; delete from journal_page where user_id='$U'"

j(){ curl -s -b "$JAR" -H "Origin: $ORIGIN" "$@"; }
sweep(){ curl -s -H "X-Admin-Token: $ADMIN" -X POST "$BASE/v1/admin/journal/nudge/sweep" -H 'content-type: application/json' -d "$1"; }

# ── settings: the device turns nudges on and pushes a (past) knock time ──────────────────────────
j -X PATCH "$BASE/v1/journal/nudge" -H 'content-type: application/json' \
  -d "{\"enabled\":true,\"channel\":\"email\",\"nextDueAt\":$PAST_MS,\"slotDay\":\"$TODAY\"}" >/dev/null
R="$(j "$BASE/v1/journal/nudge")"
check "$(echo "$R" | field "['enabled']")" "True" "GET nudge shows enabled"
check "$(echo "$R" | field "['adaptive']")" "True" "adaptive true once a knock time is set"

# ── admin sweep is token-gated ───────────────────────────────────────────────────────────────────
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/admin/journal/nudge/sweep" -d '{}')"
check "$CODE" "403" "admin sweep without the token → 403"

# ── the sweep decides + CLAIMS the day (arming is off locally, so it holds instead of mailing) ───
sweep "{\"asOfMs\":$NOW_MS}" >/dev/null
LEDGER="$(psql "$DB" -tAc "select count(*) from journal_nudge_day where user_id='$U' and slot_day='$TODAY'")"
check "$LEDGER" "1" "sweep claims exactly one ledger row for the day"
CLEARED="$(psql "$DB" -tAc "select next_due_at is null from journal_nudge where user_id='$U'")"
check "$CLEARED" "t" "the served instant is cleared so it can't fire twice"

# claim is a mutex: a second sweep at the same slot adds nothing
sweep "{\"asOfMs\":$NOW_MS}" >/dev/null
LEDGER2="$(psql "$DB" -tAc "select count(*) from journal_nudge_day where user_id='$U' and slot_day='$TODAY'")"
check "$LEDGER2" "1" "a second sweep does not double-claim the day"

# ── skip-if-written: a fresh slot on a day the user already wrote → skipped, reason already-wrote ─
TOM="$(date -v+1d +%F 2>/dev/null || date -d tomorrow +%F)"
psql "$DB" -q -c "insert into journal_page (user_id,day,body,stamp_ms) values ('$U','$TOM','wrote it',10) on conflict do nothing"
j -X PATCH "$BASE/v1/journal/nudge" -H 'content-type: application/json' \
  -d "{\"nextDueAt\":$PAST_MS,\"slotDay\":\"$TOM\"}" >/dev/null
sweep "{\"asOfMs\":$NOW_MS}" >/dev/null
REASON="$(psql "$DB" -tAc "select reason from journal_nudge_day where user_id='$U' and slot_day='$TOM'")"
check "$REASON" "already-wrote" "a day already written skips with reason already-wrote"

# ── dry run decides but writes nothing ───────────────────────────────────────────────────────────
psql "$DB" -q -c "delete from journal_nudge_day where user_id='$U' and slot_day='$TODAY'"
j -X PATCH "$BASE/v1/journal/nudge" -H 'content-type: application/json' \
  -d "{\"nextDueAt\":$PAST_MS,\"slotDay\":\"$TODAY\"}" >/dev/null
sweep "{\"asOfMs\":$NOW_MS,\"dryRun\":true}" >/dev/null
DRY="$(psql "$DB" -tAc "select count(*) from journal_nudge_day where user_id='$U' and slot_day='$TODAY'")"
check "$DRY" "0" "a dry run claims nothing"

echo; echo "$pass passed, $fail failed"; rm -f "$JAR"; [ "$fail" = 0 ]
