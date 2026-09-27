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
REPLICA="rp_$(openssl rand -hex 16)"
JAR="$(mktemp)"
BODY="$(mktemp)"
pass=0; fail=0
check(){ if [ "$1" = "$2" ]; then echo "  ok   $3"; pass=$((pass+1)); else echo "  FAIL $3 — want [$2] got [$1]"; fail=$((fail+1)); fi; }
field(){ python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d$1, separators=(',',':'), sort_keys=True) if not isinstance(d$1, str) else d$1)" 2>/dev/null; }
sync(){ curl -s -b "$JAR" -H 'Sync-Schema: 1' -H 'content-type: application/json' "$@"; }
# A push answers only the prefix of its intents its 50 ms budget reaches; a client resends the rest, and so does this.
push_all(){ # ackThrough, the intents as one JSON array → every result, in n order
  python3 - "$BASE" "$SESSION" "$REPLICA" "$1" "$2" <<'PY'
import json, sys, urllib.request
base, session, replica, ack, pending = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), json.loads(sys.argv[5])
results = []
for _ in range(20):
    if not pending:
        break
    request = urllib.request.Request(f"{base}/v1/sync/push", method="POST",
                                     data=json.dumps({"replica": replica, "ackThrough": ack, "intents": pending}).encode(),
                                     headers={"Cookie": f"wm_session={session}", "Sync-Schema": "1", "content-type": "application/json"})
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
for table in probe_marks_revisions probe_start_receipts probe_copy_receipts probe_marks probe_links probe_tags probe_metas probe_days \
             probe_laps probe_runs probe_cards probe_boards sync_spent sync_requests sync_replicas sync_scopes; do
  psql "$DB" -q -c "delete from $table"
done
psql "$DB" -q -c "insert into users (id,email,name) values (gen_random_uuid(),'$EMAIL','Probe') on conflict (email) do nothing"
SECRET="$(openssl rand -hex 24)"; HASH="$(printf '%s' "$SECRET" | shasum -a 256 | awk '{print $1}')"
NOW="$(python3 -c 'import time;print(int(time.time()*1000))')"
psql "$DB" -q -c "insert into magic_links (token_hash,email,created_ms,expires_ms) values ('$HASH','$EMAIL',$NOW,$((NOW+900000)))"
curl -s -c "$JAR" -X POST "$BASE/v1/auth/verify" -H 'content-type: application/json' -d "{\"token\":\"$SECRET\"}" >/dev/null
SESSION="$(awk '$6 == "wm_session" {print $7}' "$JAR")"

echo "hello"
curl -s -H 'Sync-Schema: 1' "$BASE/v1/sync/hello" > "$BODY"
check "$(field "['schema']" < "$BODY")" "1" "hello names the registry's schema"
check "$(field ".get('holdsRecords')" < "$BODY")" "null" "a signed-out hello carries no holdsRecords"
sync "$BASE/v1/sync/hello" > "$BODY"
check "$(field "['holdsRecords']" < "$BODY")" '{"probe":false}' "a fresh account holds no probe records"
check "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/sync/hello")" "400" "a request without Sync-Schema is malformed"
check "$(curl -s -o /dev/null -w '%{http_code}' -H 'Sync-Schema: 0' "$BASE/v1/sync/hello")" "426" "an older Sync-Schema must upgrade"

echo "push"
FIRST="{\"replica\":\"$REPLICA\",\"ackThrough\":0,\"intents\":[$(card 1 cardE2E0001 One)]}"
sync -X POST "$BASE/v1/sync/push" -d "$FIRST" > "$BODY"
check "$(field "['results']" < "$BODY")" '[{"n":1,"s":"ok","seq":1}]' "a create is admitted at seq 1"
ANSWER="$(field "['results']" < "$BODY")"
sync -X POST "$BASE/v1/sync/push" -d "$FIRST" > "$BODY"
check "$(field "['results']" < "$BODY")" "$ANSWER" "a resend of n = 1 answers the stored result"
FORKED="{\"replica\":\"$REPLICA\",\"ackThrough\":0,\"intents\":[$(card 1 cardE2E0009 Other)]}"
check "$(sync -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sync/push" -d "$FORKED")" "409" "n = 1 with another body is 409"
sync -X POST "$BASE/v1/sync/push" -d "$FORKED" > "$BODY"
check "$(field "['error']" < "$BODY")" "replica-forked" "and the error is replica-forked"
check "$(push_all 1 "[$(card 2 cardE2E0002 Two),$(card 3 cardE2E0003 Three),$(card 4 cardE2E0004 Four)]")" '[{"n":2,"s":"ok","seq":2},{"n":3,"s":"ok","seq":3},{"code":"cap","detail":{"cap":3,"type":"card"},"n":4,"s":"refused"}]' \
  "a fourth card is refused by the cap of 3"
check "$(sync -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sync/push" -d 'not json')" "400" "a body that is not JSON is malformed"
EXTRA="{\"replica\":\"$REPLICA\",\"ackThrough\":0,\"intents\":[],\"device\":\"phone\"}"
check "$(sync -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sync/push" -d "$EXTRA")" "400" "a body with a key beyond replica, ackThrough and intents is malformed"

echo "a push body over 1 MiB (spilled by Drogon to a temp file)"
python3 - "$REPLICA" "$NOW" > "$BODY.big" <<'PY'
import json, sys
replica, now = sys.argv[1], sys.argv[2]
stamp = f"{now}:0:r_e2eaaaaaaaa"
intent = {"n": 5, "scope": "self/probe", "d": [{"t": "day", "id": "2026-09-01", "life": ["alive", stamp], "f": {"score": [7, stamp]}}],
          "gestureId": "g" * 1_200_000}
print(json.dumps({"replica": replica, "ackThrough": 4, "intents": [intent]}))
PY
sync -X POST "$BASE/v1/sync/push" --data-binary "@$BODY.big" > "$BODY"
check "$(field "['results']" < "$BODY")" '[{"n":5,"s":"ok","seq":4}]' "a 1.2 MB push is read whole and admitted"
python3 -c "print('x' * 2_200_000)" > "$BODY.huge"
check "$(sync -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sync/push" --data-binary "@$BODY.huge")" "413" "a body over 2 MiB is too large"

echo "pull"
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

echo "live (WebSocket /v1/sync/live, python websockets)"
LIVE="$(python3 - "$PORT" "$SESSION" "$REPLICA" "$NOW" <<'PY'
import asyncio, json, sys, urllib.request
import websockets
port, secret, replica, now = sys.argv[1:]
live = f"ws://localhost:{port}/v1/sync/live"

def push_day(n, day, score):
    stamp = f"{now}:{n}:r_e2eaaaaaaaa"
    body = {"replica": replica, "ackThrough": 0, "intents": [{"n": n, "scope": "self/probe",
            "d": [{"t": "day", "id": day, "life": ["alive", stamp], "f": {"score": [score, stamp]}}]}]}
    request = urllib.request.Request(f"http://localhost:{port}/v1/sync/push", data=json.dumps(body).encode(), method="POST",
                                     headers={"Cookie": f"wm_session={secret}", "Sync-Schema": "1", "content-type": "application/json"})
    return json.load(urllib.request.urlopen(request))

async def frame(ws):
    return json.loads(await asyncio.wait_for(ws.recv(), 5))

async def refused(headers):
    try:
        async with websockets.connect(live, additional_headers=headers):
            return "upgraded"
    except websockets.InvalidStatus as error:
        return error.response.status_code

async def main():
    print(await refused({"Cookie": f"wm_session={secret}"}), await refused({"Cookie": f"wm_session={secret}", "Sync-Schema": "0"}))
    async with websockets.connect(live, additional_headers={"Cookie": f"wm_session={secret}", "Sync-Schema": "1"}) as ws:
        await ws.send(json.dumps({"op": "ping"}))
        print((await frame(ws))["op"])
        await ws.send(json.dumps({"op": "sub", "scopes": ["self/probe", "tree/b_ffffffff"]}))
        print(json.dumps(await frame(ws), sort_keys=True))
        seq = push_day(6, "2026-09-02", 5)["results"][0]["seq"]
        change = await frame(ws)
        print(change["op"], change["scope"], change["seq"] == seq, [row["id"] for row in change.get("rows", [])])
    async with websockets.connect(live, additional_headers={"Sync-Schema": "1"}) as guest:
        await guest.send(json.dumps({"op": "sub", "scopes": ["self/probe"]}))
        print(json.dumps(await frame(guest), sort_keys=True))
    try:
        async with websockets.connect(live, additional_headers={"Origin": "https://elsewhere.example", "Sync-Schema": "1"}) as stranger:
            await asyncio.wait_for(stranger.recv(), 5)
            print("stranger kept")
    except (websockets.ConnectionClosed, websockets.InvalidStatus):
        print("stranger refused")

asyncio.run(main())
PY
)"
check "$(sed -n 1p <<<"$LIVE")" "400 426" "an upgrade without Sync-Schema is malformed, and one below minSchema must upgrade"
check "$(sed -n 2p <<<"$LIVE")" "pong" "ping answers pong"
check "$(sed -n 3p <<<"$LIVE")" '{"op": "not-found", "scope": "tree/b_ffffffff"}' "a sub to an absent tree answers not-found"
check "$(sed -n 4p <<<"$LIVE")" "change self/probe True ['2026-09-02']" "a push reaches the subscriber as a change frame at its seq, rows inline"
check "$(sed -n 5p <<<"$LIVE")" '{"op": "not-found", "scope": "self/probe"}' "a signed-out sub to self/probe answers not-found"
check "$(sed -n 6p <<<"$LIVE")" "stranger refused" "an upgrade from an origin off the allow-list is closed"

rm -f "$JAR" "$BODY" "$BODY.big" "$BODY.huge"
echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
