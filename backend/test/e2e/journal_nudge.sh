#!/usr/bin/env bash
# Journal Wave 2 — nudges, end-to-end against the LIVE local stack. It drives the whole heartbeat
# through the admin sweep at the REAL clock — the device pushes a knock time in the past, so nothing
# waits for a real due instant — and asserts
# the DECISION LEDGER per-user via psql (deterministic on a shared dev db, unlike the fleet-wide
# report counts). The device's job — materialising next_due_at — is played by PATCHing a past instant.
#
# Prereqs: schema applied; server running with the admin token AND armed for the e2e user — the
# settings PATCH below is refused for anyone the arming gate does not name, so a dark server fails
# the first check. Run it once to mint the user, then:
#   U=$(psql windmill -tAc "select id from users where email='journal-nudge-e2e@example.com'")
#   set -a && . ./.env && set +a && JOURNAL_NUDGE_ENABLED=true JOURNAL_NUDGE_ALLOWLIST=$U \
#     JOURNAL_NUDGE_ADMIN_TOKEN=e2e-admin ./build/windmill_server
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
sweep '{}' >/dev/null
LEDGER="$(psql "$DB" -tAc "select count(*) from journal_nudge_day where user_id='$U' and slot_day='$TODAY'")"
check "$LEDGER" "1" "sweep claims exactly one ledger row for the day"
CLEARED="$(psql "$DB" -tAc "select next_due_at is null from journal_nudge where user_id='$U'")"
check "$CLEARED" "t" "the served instant is cleared so it can't fire twice"

# claim is a mutex: a second sweep at the same slot adds nothing
sweep '{}' >/dev/null
LEDGER2="$(psql "$DB" -tAc "select count(*) from journal_nudge_day where user_id='$U' and slot_day='$TODAY'")"
check "$LEDGER2" "1" "a second sweep does not double-claim the day"

# ── skip-if-written: a fresh slot on a day the user already wrote → skipped, reason already-wrote ─
TOM="$(date -v+1d +%F 2>/dev/null || date -d tomorrow +%F)"
psql "$DB" -q -c "insert into journal_page (user_id,day,body,stamp_ms) values ('$U','$TOM','wrote it',10) on conflict do nothing"
j -X PATCH "$BASE/v1/journal/nudge" -H 'content-type: application/json' \
  -d "{\"nextDueAt\":$PAST_MS,\"slotDay\":\"$TOM\"}" >/dev/null
sweep '{}' >/dev/null
REASON="$(psql "$DB" -tAc "select reason from journal_nudge_day where user_id='$U' and slot_day='$TOM'")"
check "$REASON" "already-wrote" "a day already written skips with reason already-wrote"

# ── dry run decides but writes nothing ───────────────────────────────────────────────────────────
psql "$DB" -q -c "delete from journal_nudge_day where user_id='$U' and slot_day='$TODAY'"
j -X PATCH "$BASE/v1/journal/nudge" -H 'content-type: application/json' \
  -d "{\"nextDueAt\":$PAST_MS,\"slotDay\":\"$TODAY\"}" >/dev/null
sweep '{"dryRun":true}' >/dev/null
DRY="$(psql "$DB" -tAc "select count(*) from journal_nudge_day where user_id='$U' and slot_day='$TODAY'")"
check "$DRY" "0" "a dry run claims nothing"

# ── a wet time-travelling sweep: refused while armed, forced dry while dark ──────────────────────
# asOfMs used to run WET here, which against an armed deploy mails the allowlist early and eats the
# genuine knock it claims on the way. TWO rules replaced that and which one answers depends on how
# this server was started, so each is asserted by its own evidence — an unclaimed day is what both
# look like, and checking only that proves neither. The prereq above arms the server, so a normal
# run takes the 409 branch; the dry branch is what a dark server (with a seeded row) answers, and
# is also pinned in NudgeApiTest.
ARMED="$(j "$BASE/v1/journal/nudge" | field "['armed']")"
TRAVEL_BODY="$(mktemp)"
TRAVEL="$(curl -s -o "$TRAVEL_BODY" -w '%{http_code}' -H "X-Admin-Token: $ADMIN" -X POST \
  "$BASE/v1/admin/journal/nudge/sweep" -H 'content-type: application/json' \
  -d "{\"asOfMs\":$NOW_MS,\"dryRun\":false}")"
if [ "$ARMED" = "True" ]; then
  check "$TRAVEL" "409" "armed: a wet as-of sweep is refused outright"
  check "$(field "['error']" < "$TRAVEL_BODY")" "asOfMs is refused while nudges are enabled" \
    "armed: and the refusal names its reason"
else
  check "$TRAVEL" "200" "dark: a wet as-of sweep is answered"
  check "$(field "['claimed']" < "$TRAVEL_BODY")" "0" "dark: forced to be a rehearsal"
  check "$(field "['wouldSend']" < "$TRAVEL_BODY")" "1" "dark: and still says what would have gone out"
fi
rm -f "$TRAVEL_BODY"
TRAVELLED="$(psql "$DB" -tAc "select count(*) from journal_nudge_day where user_id='$U' and slot_day='$TODAY'")"
check "$TRAVELLED" "0" "either way the day is never claimed"

echo; echo "$pass passed, $fail failed"; rm -f "$JAR"; [ "$fail" = 0 ]
