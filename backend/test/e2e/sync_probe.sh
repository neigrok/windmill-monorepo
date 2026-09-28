#!/usr/bin/env bash
# The sync engine end to end against windmill_server_probe on :$PORT and a THROWAWAY Postgres: this script
# wipes every sync_* and probe_* row of $WM_E2E_DB.
#
# Prereqs: psql "$WM_E2E_DB" -f db/schema.sql -f db/probe.sql, and the probe server running on it:
#   DATABASE_URL="postgresql:///$WM_E2E_DB?host=/tmp" PORT=8089 ./build/windmill_server_probe
# Run:  WM_E2E_DB=<db> PORT=8089 bash test/e2e/sync_probe.sh
set -uo pipefail

PORT="${PORT:-8089}"
BASE="http://localhost:$PORT"
DB="${WM_E2E_DB:?set WM_E2E_DB to a throwaway database}"
EMAIL="sync-probe-e2e@example.com"
OTHER="sync-probe-e2e-other@example.com"
REPLICA="rp_$(openssl rand -hex 16)"
JAR="$(mktemp)"
BODY="$(mktemp)"
pass=0; fail=0
check(){ if [ "$1" = "$2" ]; then echo "  ok   $3"; pass=$((pass+1)); else echo "  FAIL $3 — want [$2] got [$1]"; fail=$((fail+1)); fi; }
field(){ python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d$1, separators=(',',':'), sort_keys=True) if not isinstance(d$1, str) else d$1)" 2>/dev/null; }
sync(){ curl -s -b "$JAR" -H 'Sync-Schema: 2' -H 'content-type: application/json' "$@"; }
bare(){ curl -s -H 'Sync-Schema: 2' -H 'content-type: application/json' "$@"; }
mint_session(){ # email → the secret of a fresh session of that account, minted straight into the table
  local secret; secret="$(openssl rand -hex 24)"
  psql "$DB" -q -c "insert into sessions (token_hash, user_id, expires_ms) select '$(printf '%s' "$secret" | shasum -a 256 | awk '{print $1}')', id, $((NOW+900000)) from users where email = '$1'"
  printf '%s' "$secret"
}
# A push answers only the prefix of its intents its 50 ms budget reaches; a client resends the rest, and so does this.
push_all(){ # ackThrough, the intents as one JSON array → every result, in n order
  python3 - "$BASE" "$SESSION" "$REPLICA" "$ACCOUNT" "$1" "$2" <<'PY'
import json, sys, urllib.request
base, session, replica, account, ack, pending = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]), json.loads(sys.argv[6])
results = []
for _ in range(20):
    if not pending:
        break
    request = urllib.request.Request(f"{base}/v1/sync/push", method="POST",
                                     data=json.dumps({"replica": replica, "account": account, "ackThrough": ack, "intents": pending}).encode(),
                                     headers={"Cookie": f"wm_session={session}", "Sync-Schema": "2", "content-type": "application/json"})
    answered = json.load(urllib.request.urlopen(request))["results"]
    results += answered
    pending = [intent for intent in pending if intent["n"] not in {result["n"] for result in answered}]
print(json.dumps(results, separators=(",", ":"), sort_keys=True))
PY
}
card(){ # n id title
  printf '{"n":%s,"scope":"self/probe","d":[{"t":"card","id":"%s","born":"%s:0:r_e2eaaaaaaaa","life":["alive","%s:0:r_e2eaaaaaaaa"],"f":{"title":["%s","%s:0:r_e2eaaaaaaaa"]}}],"gestureId":"g%s"}' \
    "$1" "$2" "$NOW" "$NOW" "$3" "$NOW" "$1"
}

# ── a clean engine and a session ───────────────────────────────────────────────────────────────
for table in probe_marks_revisions probe_start_receipts probe_copy_receipts probe_marks probe_links probe_tags probe_metas probe_facts probe_days \
             probe_laps probe_runs probe_cards probe_boards sync_spent sync_requests sync_replicas sync_scopes; do
  psql "$DB" -q -c "delete from $table"
done
psql "$DB" -q -c "insert into users (id,email,name) values (gen_random_uuid(),'$EMAIL','Probe') on conflict (email) do nothing"
psql "$DB" -q -c "insert into users (id,email,name) values (gen_random_uuid(),'$OTHER','Other') on conflict (email) do nothing"
ACCOUNT="$(psql "$DB" -tAc "select id from users where email = '$EMAIL'")"
OTHER_ACCOUNT="$(psql "$DB" -tAc "select id from users where email = '$OTHER'")"
SECRET="$(openssl rand -hex 24)"; HASH="$(printf '%s' "$SECRET" | shasum -a 256 | awk '{print $1}')"
NOW="$(python3 -c 'import time;print(int(time.time()*1000))')"
psql "$DB" -q -c "insert into magic_links (token_hash,email,created_ms,expires_ms) values ('$HASH','$EMAIL',$NOW,$((NOW+900000)))"
curl -s -c "$JAR" -X POST "$BASE/v1/auth/verify" -H 'content-type: application/json' -d "{\"token\":\"$SECRET\"}" >/dev/null
SESSION="$(awk '$6 == "wm_session" {print $7}' "$JAR")"
REVOKED="$(mint_session "$EMAIL")"
curl -s -o /dev/null -X POST "$BASE/v1/auth/logout" -H "Cookie: wm_session=$REVOKED"

echo "hello"
curl -s -H 'Sync-Schema: 2' "$BASE/v1/sync/hello" > "$BODY"
check "$(field "['schema']" < "$BODY") $(field "['minSchema']" < "$BODY")" "2 2" "hello names the registry's schema and minSchema"
check "$(field "['as']" < "$BODY")" "null" "a hello with no credential is served as anonymous"
check "$(field ".get('holdsRecords')" < "$BODY")" "null" "and carries no holdsRecords"
sync "$BASE/v1/sync/hello" > "$BODY"
check "$(field "['as']" < "$BODY")" "$ACCOUNT" "a signed-in hello is served as its account"
check "$(field "['holdsRecords']" < "$BODY")" '{"probe":false}' "a fresh account holds no probe records"
check "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/sync/hello")" "400" "a request without Sync-Schema is malformed"
check "$(curl -s -o /dev/null -w '%{http_code}' -H 'Sync-Schema: 1' "$BASE/v1/sync/hello")" "426" "a Sync-Schema below minSchema 2 must upgrade"
check "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/sync/hello?schema=2")" "400" "hello reads its version from the header alone, never ?schema="
check "$(curl -s -o /dev/null -w '%{http_code}' -H 'Sync-Schema: 2' -H 'Sync-Schema: 1' "$BASE/v1/sync/hello") $(curl -s -o /dev/null -w '%{http_code}' -H 'Sync-Schema: 1' -H 'Sync-Schema: 2' "$BASE/v1/sync/hello")" \
  "200 426" "a repeated Sync-Schema is read as Drogon presents it: the first value decides"

echo "a credential sent that does not resolve is 401, never anonymous"
UNAUTH='{"as":null,"error":"unauthenticated"}'
answered(){ python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps({k: d.get(k) for k in ('as','error')}, separators=(',',':')))" 2>/dev/null; }
PULL_SELF='{"scopes":[{"scope":"self/probe","cursor":null}]}'
EMPTY_PUSH="{\"replica\":\"$REPLICA\",\"account\":\"$ACCOUNT\",\"ackThrough\":0,\"intents\":[]}"
while IFS='|' read -r label sent; do
  check "$(curl -s -H 'Sync-Schema: 2' -H "$sent" -w ' %{http_code}' "$BASE/v1/sync/hello" | { read -r body code; echo "$code $(answered <<<"$body")"; })" "401 $UNAUTH" \
    "hello, $label"
  check "$(bare -H "$sent" -w ' %{http_code}' -X POST "$BASE/v1/sync/pull" -d "$PULL_SELF" | { read -r body code; echo "$code $(answered <<<"$body")"; })" "401 $UNAUTH" \
    "pull, $label"
  check "$(bare -H "$sent" -w ' %{http_code}' -X POST "$BASE/v1/sync/push" -d "$EMPTY_PUSH" | { read -r body code; echo "$code $(answered <<<"$body")"; })" "401 $UNAUTH" \
    "push, $label"
done <<CREDENTIALS
a signed-out session's cookie|Cookie: wm_session=$REVOKED
an unknown cookie|Cookie: wm_session=nope
an empty cookie|Cookie: wm_session=
a signed-out session's Bearer|Authorization: Bearer $REVOKED
a Basic header|Authorization: Basic $SESSION
a lowercase bearer|Authorization: bearer $SESSION
a bare token|Authorization: $SESSION
CREDENTIALS
check "$(bare -H "Authorization: Bearer $SESSION" "$BASE/v1/sync/hello" | field "['as']")" "$ACCOUNT" "a Bearer session is served as its account"
check "$(bare -H "Cookie: wm_session=$(mint_session "$OTHER")" -H "Authorization: Bearer $SESSION" -o /dev/null -w '%{http_code}' "$BASE/v1/sync/hello")" "401" \
  "a cookie and a Bearer of two accounts resolve to none"
bare -X POST "$BASE/v1/sync/pull" -d "$PULL_SELF" > "$BODY"
check "$(field "['as']" < "$BODY") $(field "['pages']" < "$BODY")" 'null [{"kind":"not-found","scope":"self/probe"}]' "a pull with no credential is anonymous: self/probe is not-found"

echo "push"
FOREIGN="{\"replica\":\"$REPLICA\",\"account\":\"$OTHER_ACCOUNT\",\"ackThrough\":0,\"intents\":[$(card 1 cardE2E0001 One)]}"
sync -X POST "$BASE/v1/sync/push" -d "$FOREIGN" -w ' %{http_code}' > "$BODY"
check "$(sed 's/ [0-9]*$//' "$BODY" | field "['error']") $(awk '{print $NF}' "$BODY")" "account-mismatch 409" \
  "a fresh replica's push naming another account is account-mismatch"
check "$(psql "$DB" -tAc "select count(*) from sync_replicas where replica = '$REPLICA'")" "0" "and binds nothing"
FIRST="{\"replica\":\"$REPLICA\",\"account\":\"$ACCOUNT\",\"ackThrough\":0,\"intents\":[$(card 1 cardE2E0001 One)]}"
sync -X POST "$BASE/v1/sync/push" -d "$FIRST" > "$BODY"
check "$(field "['results']" < "$BODY")" '[{"n":1,"s":"ok","seq":1}]' "a create is admitted at seq 1"
check "$(field "['as']" < "$BODY")" "$ACCOUNT" "and the answer says whom it was served as"
check "$(psql "$DB" -tAc "select account from sync_replicas where replica = '$REPLICA'")" "$ACCOUNT" "the replica binds to the account the push names"
ANSWER="$(field "['results']" < "$BODY")"
sync -X POST "$BASE/v1/sync/push" -d "$FIRST" > "$BODY"
check "$(field "['results']" < "$BODY")" "$ANSWER" "a resend of n = 1 answers the stored result"
FORKED="{\"replica\":\"$REPLICA\",\"account\":\"$ACCOUNT\",\"ackThrough\":0,\"intents\":[$(card 1 cardE2E0009 Other)]}"
check "$(sync -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sync/push" -d "$FORKED")" "409" "n = 1 with another body is 409"
sync -X POST "$BASE/v1/sync/push" -d "$FORKED" > "$BODY"
check "$(field "['error']" < "$BODY")" "replica-forked" "and the error is replica-forked"
check "$(push_all 1 "[$(card 2 cardE2E0002 Two),$(card 3 cardE2E0003 Three),$(card 4 cardE2E0004 Four)]")" '[{"n":2,"s":"ok","seq":2},{"n":3,"s":"ok","seq":3},{"code":"cap","detail":{"cap":3,"type":"card"},"n":4,"s":"refused"}]' \
  "a fourth card is refused by the cap of 3"
check "$(sync -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sync/push" -d 'not json')" "400" "a body that is not JSON is malformed"
BEYOND="{\"replica\":\"$REPLICA\",\"account\":\"$ACCOUNT\",\"ackThrough\":0,\"intents\":[$(card 9007199254740992 cardE2E0005 Five)]}"
check "$(sync -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sync/push" -d "$BEYOND")" "400" "an n beyond the safe integers is malformed"
EXTRA="{\"replica\":\"$REPLICA\",\"account\":\"$ACCOUNT\",\"ackThrough\":0,\"intents\":[],\"device\":\"phone\"}"
check "$(sync -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sync/push" -d "$EXTRA")" "400" "a body with a key beyond replica, account, ackThrough and intents is malformed"
NO_ACCOUNT="{\"replica\":\"$REPLICA\",\"ackThrough\":0,\"intents\":[]}"
check "$(sync -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sync/push" -d "$NO_ACCOUNT")" "400" "a body without account is malformed"

echo "a push body over 1 MiB (spilled by Drogon to a temp file)"
python3 - "$REPLICA" "$NOW" "$ACCOUNT" > "$BODY.big" <<'PY'
import json, sys
replica, now, account = sys.argv[1], sys.argv[2], sys.argv[3]
stamp = f"{now}:0:r_e2eaaaaaaaa"
intent = {"n": 5, "scope": "self/probe", "d": [{"t": "day", "id": "2026-09-01", "life": ["alive", stamp], "f": {"score": [7, stamp]}}],
          "gestureId": "g" * 1_200_000}
print(json.dumps({"replica": replica, "account": account, "ackThrough": 4, "intents": [intent]}))
PY
sync -X POST "$BASE/v1/sync/push" --data-binary "@$BODY.big" > "$BODY"
check "$(field "['results']" < "$BODY")" '[{"n":5,"s":"ok","seq":4}]' "a 1.2 MB push is read whole and admitted"
python3 -c "print('x' * 2_200_000)" > "$BODY.huge"
check "$(sync -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sync/push" --data-binary "@$BODY.huge")" "413" "a body over 2 MiB is too large, before its shape is read"
check "$(curl -s -o /dev/null -w '%{http_code}' -H 'Sync-Schema: 2' -X POST "$BASE/v1/sync/push" --data-binary "@$BODY.huge")" "401" \
  "a signed-out push over 2 MiB is 401: the principal is checked before the size"
python3 -c "print('x' * 9_000_000)" > "$BODY.transport"
check "$(sync -o "$BODY" -w '%{http_code}' -X POST "$BASE/v1/sync/push" --data-binary "@$BODY.transport")" "413" \
  "a body over the transport's 8 MiB is answered 413 before §9.1's checks"
check "$(grep -c serverTime "$BODY")" "0" "and that 413 is the transport's own, bare of serverTime and epoch"

echo "quanta at any depth"
attach(){ # n scale
  printf '{"n":%s,"scope":"self/probe","d":[{"t":"card","id":"cardE2E0001","born":"%s:0:r_e2eaaaaaaaa","f":{"attachment":[{"id":"pic00001","scale":%s},"%s:1:r_e2eaaaaaaaa"]}}]}' \
    "$1" "$NOW" "$2" "$NOW"
}
check "$(push_all 5 "[$(attach 6 1.2),$(attach 7 1.5)]")" '[{"code":"invalid","n":6,"s":"refused"},{"n":7,"s":"ok","seq":5}]' \
  "a nested number off its domain's quantum is refused invalid, and one on it is admitted"

echo "pull"
python3 -c "import json; print(json.dumps({'scopes': [{'scope': 'self/probe', 'cursor': None}], 'pad': 'x' * 70_000}))" > "$BODY.pull"
check "$(curl -s -o /dev/null -w '%{http_code}' -H 'Sync-Schema: 2' -X POST "$BASE/v1/sync/pull" --data-binary "@$BODY.pull")" "413" \
  "a pull body over 64 KiB is too large, before its shape is read"
check "$(sync -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sync/pull" -d '{"scopes":[{"scope":"self/probe"}]}')" "400" \
  "a pull scope without its cursor is malformed"
check "$(sync -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sync/pull" -d '{"scopes":[{"scope":"self/probe","cursor":1e-400}]}')" "400" \
  "a number that rounds to zero from nonzero makes a body malformed"
sync -X POST "$BASE/v1/sync/pull" -d '{"scopes":[{"scope":"self/probe","cursor":null}]}' > "$BODY"
check "$(field "['pages'][0]['total']" < "$BODY")" "4" "a boot counts every alive row"
check "$(field "['pages'][0]['more']" < "$BODY")" "false" "and ends live at the head"
RECOMPUTED="$(python3 - "$BODY" <<'PY'
import hashlib, json, sys
page = json.load(open(sys.argv[1]))["pages"][0]
def jcs(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
total = sum(int(hashlib.sha256(jcs(row).encode()).hexdigest(), 16) for row in page["rows"]) % (1 << 256)
print("match" if format(total, "064x") == page["digest"] else f"{format(total, '064x')} != {page['digest']}")
PY
)"
check "$RECOMPUTED" "match" "the page's digest is the sum of its rows' hashes, recomputed here"
CURSOR="$(field "['pages'][0]['cursor']" < "$BODY")"
sync -X POST "$BASE/v1/sync/pull" -d "{\"scopes\":[{\"scope\":\"self/probe\",\"cursor\":\"$CURSOR\"}]}" > "$BODY"
check "$(field "['pages'][0]['rows']" < "$BODY")" "[]" "a pull from the head answers an empty live page"
check "$(field "['pages'][0]['more']" < "$BODY")" "false" "with no more"
sync "$BASE/v1/sync/hello" > "$BODY"
check "$(field "['holdsRecords']" < "$BODY")" '{"probe":true}' "the account now holds probe records"

echo "an account holding sync rows never folds into another"
LINK_SECRET="$(openssl rand -hex 24)"
psql "$DB" -q -c "insert into magic_links (token_hash,email,created_ms,expires_ms) values ('$(printf '%s' "$LINK_SECRET" | shasum -a 256 | awk '{print $1}')','$OTHER',$NOW,$((NOW+900000)))"
LINK_BODY="{\"token\":\"$LINK_SECRET\"}"
check "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/auth/link" -H 'content-type: application/json' -d "$LINK_BODY")" "409" \
  "a link from it is refused account-not-empty"
check "$(sync "$BASE/v1/sync/hello" | field "['as']")" "$ACCOUNT" "and its session still resolves"

echo "live (WebSocket /v1/sync/live, python websockets)"
LIVE_REVOKED="$(mint_session "$EMAIL")"
LIVE="$(python3 - "$PORT" "$SESSION" "$REPLICA" "$NOW" "$ACCOUNT" "$REVOKED" "$LIVE_REVOKED" <<'PY'
import asyncio, json, sys, urllib.request
import websockets
port, secret, replica, now, account, revoked, doomed = sys.argv[1:]
live = f"ws://localhost:{port}/v1/sync/live?schema=2"

def push_day(n, day, score):
    stamp = f"{now}:{n}:r_e2eaaaaaaaa"
    body = {"replica": replica, "account": account, "ackThrough": 0, "intents": [{"n": n, "scope": "self/probe",
            "d": [{"t": "day", "id": day, "life": ["alive", stamp], "f": {"score": [score, stamp]}}]}]}
    request = urllib.request.Request(f"http://localhost:{port}/v1/sync/push", data=json.dumps(body).encode(), method="POST",
                                     headers={"Cookie": f"wm_session={secret}", "Sync-Schema": "2", "content-type": "application/json"})
    return json.load(urllib.request.urlopen(request))

def logout(session):
    request = urllib.request.Request(f"http://localhost:{port}/v1/auth/logout", method="POST", headers={"Cookie": f"wm_session={session}"})
    return urllib.request.urlopen(request).status

def mine(frame):
    return json.dumps({**frame, "as": "ME" if frame.get("as") == account else frame.get("as")}, sort_keys=True)

async def frame(ws):
    return json.loads(await asyncio.wait_for(ws.recv(), 5))

async def refused(query, headers):
    try:
        async with websockets.connect(f"ws://localhost:{port}/v1/sync/live{query}", additional_headers=headers):
            return "upgraded"
    except websockets.InvalidStatus as error:
        return error.response.status_code

async def main():
    cookie = {"Cookie": f"wm_session={secret}"}
    print(await refused("", cookie), await refused("?schema=1", cookie), await refused("", {**cookie, "Sync-Schema": "2"}),
          await refused("?schema=2&schema=2", cookie), await refused("?schema=1&schema=2", cookie), await refused("?schema=2&schema=1", cookie),
          await refused("?schema=2", {**cookie, "Sync-Schema": "1"}))
    print(await refused("?schema=2", {"Cookie": f"wm_session={revoked}"}), await refused("?schema=2", {"Cookie": "wm_session=nope"}),
          await refused("?schema=2", {"Authorization": f"Basic {secret}"}), await refused("?schema=2", {"Authorization": f"Bearer {revoked}"}),
          await refused("?schema=2", {"Authorization": f"Bearer {secret}"}))
    async with websockets.connect(live, additional_headers=cookie) as ws, \
               websockets.connect(live, additional_headers={"Authorization": f"Bearer {doomed}"}) as condemned:
        await ws.send(json.dumps({"op": "ping"}))
        print((await frame(ws))["op"])
        await ws.send(json.dumps({"op": "sub", "scopes": ["self/probe", "tree/b_ffffffff"]}))
        print(mine(await frame(ws)))
        await condemned.send(json.dumps({"op": "sub", "scopes": ["self/probe"]}))
        await condemned.send(json.dumps({"op": "ping"}))
        print((await frame(condemned))["op"])
        print(logout(doomed))
        seq = push_day(8, "2026-09-02", 5)["results"][0]["seq"]
        change = await frame(ws)
        print(change["op"], change["scope"], change["seq"] == seq, change["as"] == account, [row["id"] for row in change.get("rows", [])])
        try:
            print("condemned heard", json.dumps(await frame(condemned)))
        except websockets.ConnectionClosed as closed:
            print("condemned closed", closed.rcvd.code if closed.rcvd else None)
    async with websockets.connect(live) as guest:
        await guest.send(json.dumps({"op": "sub", "scopes": ["self/probe"]}))
        print(json.dumps(await frame(guest), sort_keys=True))
    print(await refused("?schema=2", {"Cookie": f"wm_session={secret}", "Origin": "https://elsewhere.example"}))

asyncio.run(main())
PY
)"
check "$(sed -n 1p <<<"$LIVE")" "400 426 400 upgraded upgraded 426 upgraded" \
  "the upgrade reads ?schema= alone, as Drogon presents it: missing, below minSchema, only a header, repeated (the last value decides), and a header beside it ignored"
check "$(sed -n 2p <<<"$LIVE")" "401 401 401 401 upgraded" \
  "an upgrade whose credential does not resolve is 401: a revoked cookie, an unknown one, a Basic header, a revoked Bearer; a live Bearer upgrades"
check "$(sed -n 3p <<<"$LIVE")" "pong" "ping answers pong"
check "$(sed -n 4p <<<"$LIVE")" '{"as": "ME", "op": "not-found", "scope": "tree/b_ffffffff"}' "a sub to an absent tree answers not-found, as the socket's account"
check "$(sed -n 5p <<<"$LIVE")" "pong" "a second socket, on a session about to be revoked, subscribes"
check "$(sed -n 6p <<<"$LIVE")" "204" "its session signs out"
check "$(sed -n 7p <<<"$LIVE")" "change self/probe True True ['2026-09-02']" "a push reaches the subscriber as a change frame at its seq, rows inline, as its account"
check "$(sed -n 8p <<<"$LIVE")" "condemned closed 1008" "the revoked session's socket is closed before any further frame"
check "$(sed -n 9p <<<"$LIVE")" '{"as": null, "op": "not-found", "scope": "self/probe"}' "a sub with no credential to self/probe answers not-found, as null"
check "$(sed -n 10p <<<"$LIVE")" "403" "an upgrade from an origin off the allow-list is refused"

echo "a fact saved whole"
FACTS="$(python3 - "$NOW" <<'PY'
import json, sys
def stamp(counter):
    return f"{sys.argv[1]}:{counter}:r_e2eaaaaaaaa"
def fact(n, life, f=None):
    delta = {"t": "fact", "id": "2027-01-15", "life": life}
    if f:
        delta["f"] = f
    return {"n": n, "scope": "self/probe", "d": [delta]}
print(json.dumps([
    fact(9, ["alive", stamp(9)], {"value": [80, stamp(9)]}),
    fact(10, ["alive", stamp(9)], {"value": [80, stamp(9)], "at": [1, stamp(8)]}),
    fact(11, ["alive", stamp(9)], {"value": [80, stamp(9)], "at": [1, stamp(9)]}),
    fact(12, ["dead", stamp(10)]),
    fact(13, ["alive", stamp(11)], {"value": [82.4, stamp(11)], "at": [3, stamp(11)]}),
]))
PY
)"
check "$(push_all 8 "$FACTS")" \
  '[{"code":"invalid","n":9,"s":"refused"},{"code":"invalid","n":10,"s":"refused"},{"n":11,"s":"ok","seq":7},{"n":12,"s":"ok","seq":8},{"n":13,"s":"ok","seq":9}]' \
  "a put that leaves out a field or splits its stamp is refused invalid; a whole put, its delete and a newer whole put are admitted"
sync -X POST "$BASE/v1/sync/pull" -d '{"scopes":[{"scope":"self/probe","cursor":null}]}' > "$BODY"
SAVED="$(python3 - "$BODY" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))["pages"][0]["rows"]
print(json.dumps([{key: row[key] for key in ("life", "f", "seq")} for row in rows if row["t"] == "fact"], separators=(",", ":"), sort_keys=True))
PY
)"
STAMP="$NOW:11:r_e2eaaaaaaaa"
check "$SAVED" "[{\"f\":{\"at\":[3,\"$STAMP\"],\"value\":[82.4,\"$STAMP\"]},\"life\":[\"alive\",\"$STAMP\"],\"seq\":9}]" \
  "the save newer than the delete keeps the fact, every field at its stamp"

rm -f "$JAR" "$BODY" "$BODY.big" "$BODY.huge" "$BODY.transport" "$BODY.pull"
echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
