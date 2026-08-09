#!/usr/bin/env bash
# Journal echoes, end-to-end against the LIVE local stack. Locally there is usually no embedder and
# no curator wired, so every pass — the one a save triggers and the six-hourly repair one — is a
# quiet no-op; what this drives is everything downstream
# of it, over real Postgres rows: the owner-scoped READ and its honest cut, the anchoring hint, the
# three dismissal doors and the route order that makes them reachable, and the admin door's gate and
# report shape. The embed→select→curate compute path is unit-covered (EchoSweepTest).
#
# The rows below are planted the way a finished pass would have left them — journal_span carries the
# passage text and the sha256 of its NORMALISED form, because dismissal keys on content and not on
# an id, and journal_echo names two span ids and never two pages.
#
# Prereqs: schema applied; server running with the echo admin token, e.g.:
#   set -a && . ./.env && set +a && JOURNAL_ECHO_ADMIN_TOKEN=e2e-echo ./build/windmill_server
# Run:  JOURNAL_ECHO_ADMIN_TOKEN=e2e-echo bash test/e2e/journal_echo.sh
set -uo pipefail

PORT="${PORT:-8088}"; BASE="http://localhost:$PORT"; ORIGIN="${ORIGIN:-http://localhost:5173}"
DB="${WM_E2E_DB:-windmill}"; ADMIN="${JOURNAL_ECHO_ADMIN_TOKEN:-e2e-echo}"
EMAIL="journal-echo-e2e@example.com"; JAR="$(mktemp)"
TODAY="$(date +%F)"; OLD="2024-01-01"; NOW_MS="$(python3 -c 'import time;print(int(time.time()*1000))')"
TRIGGER="i like c++ these days, more than i expected to."
MATCH="i want to learn c++ properly one of these years, and not just skim it again."
pass=0; fail=0
check(){ if [ "$1" = "$2" ]; then echo "  ok   $3"; pass=$((pass+1)); else echo "  FAIL $3 — want [$2] got [$1]"; fail=$((fail+1)); fi; }
field(){ python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }
count(){ python3 -c "import sys,json;print(len(json.load(sys.stdin)$1))" 2>/dev/null; }

psql "$DB" -q -c "insert into users (id,email) values (gen_random_uuid(),'$EMAIL') on conflict (email) do nothing"
U="$(psql "$DB" -tAc "select id from users where email='$EMAIL'")"
SECRET="$(openssl rand -hex 24)"; HASH="$(printf '%s' "$SECRET" | shasum -a 256 | awk '{print $1}')"
psql "$DB" -q -c "insert into magic_links (token_hash,email,created_ms,expires_ms) values ('$HASH','$EMAIL',$NOW_MS,$((NOW_MS+900000)))"
curl -s -c "$JAR" -X POST "$BASE/v1/auth/verify" -H 'content-type: application/json' -H "Origin: $ORIGIN" -d "{\"token\":\"$SECRET\"}" >/dev/null

# A clean slate, and then one echo planted whole: two pages, two passages, one kept pair. The
# vector is a stub — the read path never decodes one; only a derivation does.
psql "$DB" -q <<SQL
delete from journal_echo where user_id='$U';
delete from journal_echo_dismissal where user_id='$U';
delete from journal_echo_offer_dismissal where user_id='$U';
delete from journal_span where user_id='$U';
delete from journal_page where user_id='$U';
delete from paddle_subscriptions where user_id='$U';
insert into journal_page (user_id,day,body,stamp_ms) values
  ('$U','$TODAY',\$\$$TRIGGER\$\$,10), ('$U','$OLD',\$\$$MATCH\$\$,10);
insert into journal_span (user_id,span_id,day,ord,lo,hi,text,text_sha256,vector,embed_version,body_stamp_ms)
values ('$U',900001,'$TODAY',0,0,length(\$\$$TRIGGER\$\$),\$\$$TRIGGER\$\$,
        sha256(convert_to(\$\$$TRIGGER\$\$,'UTF8')),'\x00'::bytea,'e2e',10),
       ('$U',900002,'$OLD',0,0,length(\$\$$MATCH\$\$),\$\$$MATCH\$\$,
        sha256(convert_to(\$\$$MATCH\$\$,'UTF8')),'\x00'::bytea,'e2e',10);
insert into journal_echo (user_id,trigger_day,trigger_span_id,match_day,match_span_id,cosine,relation,match_is_self,curator_version)
values ('$U','$TODAY',900001,'$OLD',900002,0.81,0.9,true,'e2e/high/deadbeef');
SQL

j(){ curl -s -b "$JAR" -H "Origin: $ORIGIN" "$@"; }
post(){ j -o /dev/null -w '%{http_code}' -X POST "$BASE$1"; }

# ── the read: grouped by the page that carries them, and the corpus floor is served ──────────────
R="$(j "$BASE/v1/journal/echoes")"
check "$(echo "$R" | count "['pages']")" "1" "one page carries echoes"
check "$(echo "$R" | field "['pages'][0]['day']")" "$TODAY" "the page is the one that triggered it"
check "$(echo "$R" | count "['pages'][0]['matches']")" "1" "and it carries one match"
check "$(echo "$R" | field "['pages'][0]['matches'][0]['day']")" "$OLD" "the match names the older day"
check "$(echo "$R" | field "['pagesWritten']")" "2" "pagesWritten is served — the browser cannot count what it has not synced"
check "$(echo "$R" | python3 -c "import sys,json;print('cosine' in json.dumps(json.load(sys.stdin)))")" "False" \
  "no score on the wire — presence, never a number"

# ── the honest cut: no subscription means the opening words and the count withheld ───────────────
check "$(echo "$R" | field "['pages'][0]['entitled']")" "False" "an unsubscribed reader is not entitled"
check "$(echo "$R" | field "['pages'][0]['matches'][0]['text']")" "i want to learn c++ properly one of" \
  "the cut is the real opening words, not a blur"
check "$(echo "$R" | field "['pages'][0]['matches'][0]['withheldWords']")" "8" "and it says how many it kept back"

# ── entitled: the passage whole, and the anchoring hint with it ──────────────────────────────────
psql "$DB" -q -c "insert into paddle_subscriptions (subscription_id,customer_id,user_id,status) values ('sub_e2e_echo','ctm_e2e_echo','$U','active') on conflict (subscription_id) do update set status='active', user_id='$U'"
R="$(j "$BASE/v1/journal/echoes")"
check "$(echo "$R" | field "['pages'][0]['entitled']")" "True" "a live subscription is entitled"
check "$(echo "$R" | field "['pages'][0]['matches'][0]['text']")" "$MATCH" "and is served the passage whole"
check "$(echo "$R" | field "['pages'][0]['matches'][0]['withheldWords']")" "0" "nothing withheld"
check "$(echo "$R" | field "['pages'][0]['matches'][0]['occurrenceHint']")" "0" "which occurrence of that text the passage is"

# ── "Not now": retires the OFFER and nothing else. This also proves the route order — the offer
#    door is registered before {matchDay}, which binds the literal "offer" quite happily. ─────────
check "$(post "/v1/journal/echoes/$TODAY/offer/dismiss")" "204" "declining the offer answers 204, not 400 bad date"
R="$(j "$BASE/v1/journal/echoes")"
check "$(echo "$R" | field "['pages'][0]['offerRetired']")" "True" "the decline is served back, so no device has to remember it"
check "$(echo "$R" | count "['pages'][0]['matches']")" "1" "and every echo on the page survives it"
check "$(post "/v1/journal/echoes/$TODAY/offer/dismiss")" "204" "declining twice is declining once"

# ── the relevance signal, and then the pair door ─────────────────────────────────────────────────
check "$(post "/v1/journal/echoes/$TODAY/$OLD/opened")" "204" "opening the older page is logged, and answers 204"
check "$(post "/v1/journal/echoes/$TODAY/$OLD/dismiss")" "204" "retiring one pairing answers 204"
check "$(j "$BASE/v1/journal/echoes" | count "['pages']")" "0" "the only pairing is gone, and no empty page is served"
check "$(psql "$DB" -tAc "select count(*) from journal_echo_dismissal where user_id='$U'")" "1" \
  "dismissal is stored on CONTENT, so re-deriving the page cannot resurrect it"

# ── the page door: one tap retires the whole panel, in one request ───────────────────────────────
psql "$DB" -q -c "delete from journal_echo_dismissal where user_id='$U'"
check "$(j "$BASE/v1/journal/echoes" | count "['pages']")" "1" "the echo is back once the dismissal is lifted"
check "$(post "/v1/journal/echoes/$TODAY/dismiss")" "204" "\"Not useful\" answers 204"
check "$(j "$BASE/v1/journal/echoes" | count "['pages']")" "0" "and the whole page is faded"

# ── the admin door: token-gated, one knob, and it reports a pass ─────────────────────────────────
check "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/admin/journal/echo/sweep" -d '{}')" "403" \
  "the sweep without the token → 403"
check "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Admin-Token: $ADMIN" -X POST "$BASE/v1/admin/journal/echo/sweep?sinceMs=-5")" "400" \
  "a malformed sinceMs → 400, never a wrapped one"
R="$(curl -s -H "X-Admin-Token: $ADMIN" -X POST "$BASE/v1/admin/journal/echo/sweep" -H 'content-type: application/json' -d "{\"sinceMs\":$NOW_MS}")"
check "$(echo "$R" | field "['pagesDerived']")" "0" "the sweep runs and reports (unwired boundary ⇒ a quiet no-op)"
check "$(echo "$R" | field "['pagesFailed']")" "0" "and a no-op is not a failure"

# ── owner only ───────────────────────────────────────────────────────────────────────────────────
check "$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $ORIGIN" "$BASE/v1/journal/echoes")" "401" "no session → 401"

psql "$DB" -q -c "delete from paddle_subscriptions where user_id='$U'"
echo; echo "$pass passed, $fail failed"; rm -f "$JAR"; [ "$fail" = 0 ]
