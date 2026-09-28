#!/usr/bin/env bash
# The probe app end to end (engine design §10): builds SyncProbe, boots two simulators of its own, and runs each
# scenario against windmill_server_probe, asserting the server's side through the backend's reads: a pull under the
# scenario account's token (REST), and psql for the replica table REST does not expose.
#
# Prereqs: the probe server on a THROWAWAY database (backend/RUNNING.md, "the probe server"):
#   cd backend && DATABASE_URL="postgresql:///wm_sync_m10?host=/tmp" PORT=8089 ./build/windmill_server_probe
# Run:  WM_E2E_DB=wm_sync_m10 bash apps/ios/SyncProbe/e2e.sh [scenario ...]
#   scenarios: launch-arguments leave-flush relaunch-release live fork-guard reauth revoked-pull clock-skew clock-jump
#   epoch-change lineage (default: all)
# Env: PORT (8089); SIM_A / SIM_B reuse booted simulators instead of making two; KEEP_SIMULATORS=1 keeps the ones made;
#   PROBE_APP=<path to SyncProbe.app> installs that build instead of building one.
set -uo pipefail

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8089}"
BASE="http://127.0.0.1:$PORT"
DB="${WM_E2E_DB:?set WM_E2E_DB to the throwaway database of the probe server}"
BUNDLE="works.windmill.syncprobe"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/syncprobe-e2e.XXXXXX")"
RUN="$(date +%s)"
MADE=()
pass=0; fail=0

check(){ if [ "$1" = "$2" ]; then echo "  ok   $3"; pass=$((pass+1)); else echo "  FAIL $3 — want [$2] got [$1]"; fail=$((fail+1)); fi; }

cleanup(){
  if [ "${KEEP_SIMULATORS:-0}" != 1 ]; then
    for sim in "${MADE[@]+"${MADE[@]}"}"; do xcrun simctl shutdown "$sim" >/dev/null 2>&1; xcrun simctl delete "$sim"; done
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── the app and the phones ─────────────────────────────────────────────────────────────────────────
build(){
  if [ -n "${PROBE_APP:-}" ]; then APP="$PROBE_APP"; return; fi
  (cd "$HERE" && xcodegen generate --quiet) || exit 1
  xcodebuild build -quiet -project "$HERE/SyncProbe.xcodeproj" -scheme SyncProbe -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$WORK/derived" || exit 1
  APP="$WORK/derived/Build/Products/Debug-iphonesimulator/SyncProbe.app"
}

phone(){ # variable → that variable names a booted simulator made for this run, which cleanup deletes
  local udid; udid="$(xcrun simctl create "SyncProbe e2e $1" "iPhone 17" 2>/dev/null)" || exit 1
  MADE+=("$udid"); xcrun simctl boot "$udid" || exit 1; xcrun simctl bootstatus "$udid" >/dev/null
  eval "$1=$udid"
}

container(){ xcrun simctl get_app_container "$1" "$BUNDLE" data; }

fresh(){ # phone → the app installed anew, its container empty
  xcrun simctl terminate "$1" "$BUNDLE" >/dev/null 2>&1
  xcrun simctl uninstall "$1" "$BUNDLE" >/dev/null 2>&1
  xcrun simctl install "$1" "$APP" || exit 1
}

# ── a launch: one scenario phase, its report and its signals in the app's own container ───────────────
launch(){ # phone phase scenario [launch arguments…]
  local phone="$1" phase="$2" scenario="$3"; shift 3
  local root; root="$(container "$phone")" && [ -n "$root" ] || { echo "no container for $BUNDLE on $phone"; exit 1; }
  local dir="$root/tmp/e2e"
  rm -rf "$dir/$phase.json" "$dir/signals"; mkdir -p "$dir/signals"
  xcrun simctl launch --terminate-running-process --stdout="$WORK/$phase.log" --stderr="$WORK/$phase.log" "$phone" "$BUNDLE" \
    -scenario "$scenario" -report "$dir/$phase.json" -signals "$dir/signals" -backend "$BASE" "$@" >/dev/null || exit 1
}

report(){ echo "$(container "$1")/tmp/e2e/$2.json"; }

await_report(){ # phone phase seconds → passed true/false/missing
  local file; file="$(report "$1" "$2")"
  for _ in $(seq 1 $(( $3 * 5 ))); do [ -f "$file" ] && break; sleep 0.2; done
  [ -f "$file" ] || { echo "missing"; return; }
  python3 - "$file" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
print("true" if report["passed"] else "false")
if not report["passed"]:
    print("    failure:", report.get("failure"), file=sys.stderr)
PY
}

field(){ python3 -c "import json,sys; r=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))" "$1" "$2"; }

step(){ field "$1" "next(s['detail'] for s in r['steps'] if s['step'] == '$2')"; }

await_signal(){ # phone name seconds → yes/no
  local file; file="$(container "$1")/tmp/e2e/signals/$2"
  for _ in $(seq 1 $(( $3 * 5 ))); do [ -f "$file" ] && { echo yes; return; }; sleep 0.2; done
  echo no
}

signal(){ touch "$(container "$1")/tmp/e2e/signals/$2"; }

# ── the server's side ─────────────────────────────────────────────────────────────────────────────────
sign_in(){ # email → ACCOUNT and TOKEN from the dev sign-in
  local answer; answer="$(curl -s -X POST "$BASE/v1/dev/sign-in" -d "{\"email\":\"$1\"}")"
  ACCOUNT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["account"])' "$answer")"
  TOKEN="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["token"])' "$answer")"
}

# The account's alive cards as the server holds them, pulled from boot under its token: "title@bornMs" sorted, or
# titles alone; "error: …" when the server could not be read, so no check of an empty answer passes on it.
server_cards(){ # token [born]
  python3 - "$BASE" "$1" "${2:-}" <<'PY'
import json, sys, urllib.request
base, token, born = sys.argv[1], sys.argv[2], sys.argv[3] == "born"
cursor, cards = None, []
while True:
    request = urllib.request.Request(f"{base}/v1/sync/pull", method="POST",
        data=json.dumps({"scopes": [{"scope": "self/probe", "cursor": cursor}]}).encode(),
        headers={"Authorization": f"Bearer {token}", "Sync-Schema": "1", "content-type": "application/json"})
    try:
        page = json.load(urllib.request.urlopen(request))["pages"][0]
    except Exception as error:
        print(f"error: {error}"); sys.exit(1)
    if page["kind"] != "rows":
        print(page["kind"]); sys.exit()
    for row in page["rows"]:
        if row["t"] == "card" and row["life"][0] == "alive":
            cards.append(f'{row["f"]["title"][0]}@{row["born"].split(":")[0]}' if born else row["f"]["title"][0])
    cursor = page["cursor"]
    if not page["more"]:
        break
print(",".join(sorted(cards)))
PY
}

now_ms(){ python3 -c 'import time; print(int(time.time() * 1000))'; }

# Each card born within a minute of now: stamped on the server's clock, not the phone's.
born_recently(){ # "title@ms,…" → yes/no
  python3 -c "import sys,time; now=time.time()*1000; print('yes' if all(abs(now - int(c.split('@')[1])) < 60_000 for c in sys.argv[1].split(',')) else 'no')" "$1"
}

replicas(){ psql -h /tmp -d "$DB" -Atc "select count(*) from sync_replicas where account = '$1' and last_n > 0"; }

# ── the scenarios ─────────────────────────────────────────────────────────────────────────────────────
scenario_leave_flush(){
  echo "leave flush"
  sign_in "leave-$RUN@example.com"; fresh "$A"
  launch "$A" leave leave-flush -account "$ACCOUNT" -token "$TOKEN" -holdMs 60000
  check "$(await_signal "$A" committed 30)" yes "the probe committed a card held for 60 s"
  check "$(server_cards "$TOKEN")" "" "the server has nothing while it is held"
  xcrun simctl launch "$A" com.apple.Preferences >/dev/null
  local cards=""; for _ in $(seq 1 25); do cards="$(server_cards "$TOKEN")"; [ -n "$cards" ] && break; sleep 0.2; done
  check "$cards" "Leave" "within 5 s of leaving, the server has the card"
  sleep 2
  xcrun simctl launch "$A" "$BUNDLE" >/dev/null
  check "$(await_report "$A" leave 15)" true \
    "brought back: the card was pushed inside the leave's background time, before its release time, and Undo is gone"
}

scenario_relaunch_release(){
  echo "relaunch release"
  sign_in "relaunch-$RUN@example.com"; fresh "$A"
  launch "$A" relaunch-commit relaunch-release/commit -account "$ACCOUNT" -token "$TOKEN" -holdMs 60000
  check "$(await_report "$A" relaunch-commit 30)" true "a card is committed and held"
  xcrun simctl terminate "$A" "$BUNDLE"
  sleep 1
  check "$(server_cards "$TOKEN")" "" "terminated while held, nothing was sent"
  launch "$A" relaunch-check relaunch-release/check -holdMs 60000
  check "$(await_report "$A" relaunch-check 30)" true \
    "relaunched with no token, the Keychain had it; the start released the card before the first frame, with no Undo, and sent it"
  check "$(server_cards "$TOKEN")" "Relaunch" "the server has the card"
}

scenario_live(){
  echo "live convergence"
  sign_in "live-$RUN@example.com"; fresh "$A"; fresh "$B"
  launch "$B" live-watch live/watch -account "$ACCOUNT" -token "$TOKEN"
  check "$(await_signal "$B" watching 30)" yes "phone B follows self/probe live"
  launch "$A" live-commit live/commit -account "$ACCOUNT" -token "$TOKEN"
  check "$(await_report "$A" live-commit 30)" true "phone A committed the card and it was confirmed"
  check "$(await_report "$B" live-watch 40)" true "phone B drew it from a change frame carrying its row, pulling nothing"
  check "$(server_cards "$TOKEN")" "Live" "the server has the card"
}

scenario_fork_guard(){
  echo "fork guard"
  sign_in "fork-$RUN@example.com"; local first="$TOKEN"; fresh "$A"; fresh "$B"
  launch "$A" fork-origin fork-guard/origin -account "$ACCOUNT" -token "$first"
  check "$(await_report "$A" fork-origin 30)" true "phone A synced a card"
  xcrun simctl terminate "$A" "$BUNDLE"
  local from to; from="$(container "$A")/Library/Application Support/WindmillSync"; to="$(container "$B")/Library/Application Support/WindmillSync"
  mkdir -p "$to"
  for file in "$from"/*; do case "$(basename "$file")" in fork-guard|*-shm) ;; *) cp "$file" "$to/";; esac; done
  check "$(ls "$to" | tr '\n' ' ')" "sync.sqlite sync.sqlite-wal " "phone B holds A's store and not its fork guard's copy"
  sign_in "fork-$RUN@example.com"
  launch "$B" fork-clone fork-guard/clone -account "$ACCOUNT" -token "$TOKEN"
  check "$(await_report "$B" fork-clone 30)" true "phone B re-identified and pushed as a replica of its own, never refused as forked"
  launch "$A" fork-again fork-guard/origin-again -account "$ACCOUNT" -token "$first"
  check "$(await_report "$A" fork-again 30)" true "phone A kept its replica and pushed again, never refused as forked"
  local origin clone again
  origin="$(step "$(report "$A" fork-origin)" "the replica")"; clone="$(step "$(report "$B" fork-clone)" "the replica")"
  again="$(step "$(report "$A" fork-again)" "the replica")"
  check "$([ "$origin" = "$again" ] && [ "$origin" != "$clone" ] && echo distinct)" distinct "A kept $origin; B is $clone"
  check "$(replicas "$ACCOUNT")" 2 "the server holds two replicas of the account, each with pushes"
  check "$(server_cards "$TOKEN")" "Again,Clone,Origin" "the server has every card"
}

scenario_reauth(){
  echo "401 and re-authentication"
  sign_in "reauth-$RUN@example.com"; local first="$TOKEN"; fresh "$A"
  launch "$A" reauth-pause reauth/pause -account "$ACCOUNT" -token "$first"
  check "$(await_signal "$A" synced 30)" yes "phone A synced a card"
  check "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/auth/logout" -H "Authorization: Bearer $first")" 204 \
    "the session is revoked on the backend"
  signal "$A" revoked
  check "$(await_report "$A" reauth-pause 30)" true "the next push answered 401, the replica paused and the status asks to re-authenticate"
  sign_in "reauth-$RUN@example.com"
  launch "$A" reauth-resume reauth/resume -account "$ACCOUNT" -token "$TOKEN"
  check "$(await_report "$A" reauth-resume 30)" true "the launch token cleared the pause and the card waiting went"
  check "$(server_cards "$TOKEN")" "After,Before" "the server has both cards"
}

scenario_revoked_pull(){
  echo "a pull under a revoked session"
  sign_in "revoked-$RUN@example.com"; local first="$TOKEN"; fresh "$A"
  launch "$A" revoked-pause revoked-pull/pause -account "$ACCOUNT" -token "$first"
  check "$(await_signal "$A" synced 30)" yes "phone A synced a card"
  check "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/auth/logout" -H "Authorization: Bearer $first")" 204 \
    "the session is revoked on the backend"
  signal "$A" revoked
  check "$(await_report "$A" revoked-pause 30)" true "coming back pulled under it, answered as no one's: the phone kept the card and paused"
  sign_in "revoked-$RUN@example.com"
  launch "$A" revoked-resume revoked-pull/resume -account "$ACCOUNT" -token "$TOKEN"
  check "$(await_report "$A" revoked-resume 30)" true "the launch token cleared the pause, and the card is still drawn"
  check "$(server_cards "$TOKEN")" "Before" "the server has the card"
}

scenario_clock_skew(){
  echo "clock skew"
  sign_in "skew-$RUN@example.com"; fresh "$A"
  launch "$A" skew clock-skew -account "$ACCOUNT" -token "$TOKEN"
  check "$(await_report "$A" skew 60)" true "a commit stamped 10 min ahead was refused clock-skew, restamped and accepted, with no notice"
  local cards; cards="$(server_cards "$TOKEN" born)"
  check "${cards%@*}" "Skew" "the server has the card"
  check "$(born_recently "$cards")" yes "born on the server's clock ($cards, now $(now_ms))"
}

scenario_clock_jump(){
  echo "clock jump across a kill"
  sign_in "jump-$RUN@example.com"; fresh "$A"
  launch "$A" jump-before clock-jump/before -account "$ACCOUNT" -token "$TOKEN"
  check "$(await_report "$A" jump-before 30)" true "synced with the clock as it is"
  launch "$A" jump-after clock-jump/after -account "$ACCOUNT" -token "$TOKEN" -skewMs 600000
  check "$(await_report "$A" jump-after 30)" true "relaunched 10 min ahead: the first sample replaced the old ones, nothing refused clock-skew"
  local cards; cards="$(server_cards "$TOKEN" born)"
  check "$(born_recently "$cards")" yes "both cards born on the server's clock ($cards, now $(now_ms))"
}

scenario_epoch_change(){
  echo "epoch change"
  sign_in "epoch-$RUN@example.com"; fresh "$A"
  launch "$A" epoch epoch-change -account "$ACCOUNT" -token "$TOKEN"
  check "$(await_signal "$A" synced 30)" yes "phone A synced a card"
  check "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/dev/sync/epoch")" 200 "the server's epoch is regenerated"
  signal "$A" regenerated
  check "$(await_report "$A" epoch 40)" true "the card across the change landed, the replica re-identified and booted again"
  check "$(replicas "$ACCOUNT")" 2 "the server holds the replica from before the change and the one after, each with pushes"
  check "$(server_cards "$TOKEN")" "After,Before,Later" "the server has every card"
}

scenario_lineage(){
  echo "sign-in lineage"
  sign_in "lineage-$RUN@example.com"; fresh "$A"
  launch "$A" lineage-seed lineage/seed -account "$ACCOUNT" -token "$TOKEN"
  check "$(await_report "$A" lineage-seed 30)" true "the account holds a record"
  fresh "$A"
  launch "$A" lineage-add lineage/add -account "$ACCOUNT" -token "$TOKEN"
  check "$(await_report "$A" lineage-add 30)" true "signed out, a card; at sign-in the decision counted it, and Add pushed it"
  check "$(server_cards "$TOKEN")" "Added,Seed" "the server has the added card"
  fresh "$A"
  launch "$A" lineage-discard lineage/discard -account "$ACCOUNT" -token "$TOKEN"
  check "$(await_report "$A" lineage-discard 30)" true "signed out, a card; Discard dropped it"
  check "$(server_cards "$TOKEN")" "Added,Seed" "the server never had the dropped card"
}

scenario_launch_arguments(){
  echo "the probe's launch arguments"
  fresh "$A"
  launch "$A" launch-arguments launch-arguments -token -dashed_token-0
  check "$(await_report "$A" launch-arguments 30)" true "a token that begins with a dash is read whole"
}

# ── the run ───────────────────────────────────────────────────────────────────────────────────────────
curl -s -o /dev/null -H 'Sync-Schema: 1' "$BASE/v1/sync/hello" || { echo "no probe server on $BASE"; exit 1; }
build
A="${SIM_A:-}"; B="${SIM_B:-}"
[ -n "$A" ] || phone A
[ -n "$B" ] || phone B
for scenario in "${@:-launch-arguments leave-flush relaunch-release live fork-guard reauth revoked-pull clock-skew clock-jump epoch-change lineage}"; do
  for name in $scenario; do
    if declare -F "scenario_${name//-/_}" >/dev/null; then "scenario_${name//-/_}"; else check "$name" "a scenario" "a scenario is named $name"; fi
  done
done
echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
