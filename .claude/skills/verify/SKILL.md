---
name: verify
description: Run the full Windmill stack locally (Postgres + C++ backend + vite) and drive it end-to-end, including MCP edits against a live browser page.
---

# Verifying Windmill locally

## Launch

```sh
# 1. Postgres — db `windmill`; schema.sql is idempotent, re-apply after pulling
pg_isready
psql windmill -f backend/db/schema.sql

# 2. Backend — rebuild first; a stale binary silently lacks newer wiring
cmake --build backend/build --target windmill_server -j 8
cd backend && set -a && . ./.env && set +a && ./build/windmill_server
# Override one variable for a session by sourcing first, then prefixing just that one:
cd backend && set -a && . ./.env && set +a && WINDMILL_MCP_USER=<uuid> ./build/windmill_server

# 3. Frontend — vite.config.js pins port 5173
cd web && npm run dev
```

Env comes from `backend/.env` (gitignored; `.env.example` documents every variable). Do not paste
a multi-variable incantation onto the command line.

- Stop the server **by port**: `lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill`. Never `pkill -f windmill_server`
  — several agents share this machine and it takes all of their backends too.
- **Pin the two ports: backend 8088, vite 5173.** Outside a production build
  `web/src/shell/apiBase.js` falls back to `http://localhost:8088` (and
  `ws://localhost:8088/v1/socket`) unless `VITE_API_BASE_URL` is set, and
  `WINDMILL_ALLOWED_ORIGINS=http://localhost:5173` is what lets the page's credentialed fetches
  through CORS. Either one wrong and the page renders chrome and says *"Couldn't load this
  roadmap…"*, which reads like a broken tree. A second full stack therefore needs both overridden
  (`VITE_API_BASE_URL` at its backend, `WINDMILL_ALLOWED_ORIGINS` at its vite origin); otherwise
  give parallel agents disjoint ports for backend-only probing (curl/MCP) and keep 8088+5173 for
  whoever needs a browser.
- A throwaway database keeps a probe's rows away from everyone else's: `createdb -h /tmp <name>`,
  apply `schema.sql` to it, point `DATABASE_URL` at it, and `dropdb -h /tmp <name>` once the server
  on it is stopped.

## Backend suites

Run each recipe from the repository root. The first runs without Postgres, even if the shell has
database settings; the second creates and removes two isolated databases. Both run serially.

```sh
cmake -S backend -B backend/build
cmake --build backend/build -j8
env -u WM_PG_TEST -u DATABASE_URL -u WM_SYNC_DATABASE_URL \
  ctest --test-dir backend/build --parallel 1 -V
```

The four C++ suites are `domain`, `mcp`, `sync` and `adapters`; five script checks cover deployment,
authentication comparison, log shutdown and the restore epoch tool.

Each binary ends with `N/M cases passed, X stopped before the end, Y skipped, Z assertion(s)
failed`. Read all four numbers: *skipped* is never a pass, and a case a `REQUIRE` cut short counts
as *stopped before the end*. `--output-on-failure` prints nothing while green, so use `-V` when the
skip count is what you came for.

Postgres cases in all four binaries skip without `WM_PG_TEST`. They require two fresh databases:
`DATABASE_URL` with `schema.sql`, and `WM_SYNC_DATABASE_URL` with both `schema.sql` and `probe.sql`.
The sync suite and gym door cases in `mcp` and `adapters` share the latter and must run serially.
Set `WM_VERIFY_DB_PREFIX` to choose a database prefix; its default includes the shell's process id.

```sh
(
  set -eu
  cmake -S backend -B backend/build
  cmake --build backend/build -j8
  WM_VERIFY_DB_PREFIX=${WM_VERIFY_DB_PREFIX:-wm_verify_$$}
  VERIFY_REST_DB="${WM_VERIFY_DB_PREFIX}_rest"
  VERIFY_SYNC_DB="${WM_VERIFY_DB_PREFIX}_sync"
  createdb -h /tmp "$VERIFY_REST_DB"
  trap 'dropdb -h /tmp "$VERIFY_REST_DB"' EXIT
  createdb -h /tmp "$VERIFY_SYNC_DB"
  trap 'dropdb -h /tmp "$VERIFY_REST_DB"; dropdb -h /tmp "$VERIFY_SYNC_DB"' EXIT
  DATABASE_URL="postgresql:///$VERIFY_REST_DB?host=/tmp"
  WM_SYNC_DATABASE_URL="postgresql:///$VERIFY_SYNC_DB?host=/tmp"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/db/schema.sql
  psql "$WM_SYNC_DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/db/schema.sql -f backend/db/probe.sql
  WM_PG_TEST=1 DATABASE_URL="$DATABASE_URL" WM_SYNC_DATABASE_URL="$WM_SYNC_DATABASE_URL" \
    ctest --test-dir backend/build --parallel 1 -V
)
```

The Docker build runs the first gate without a database; backend CI then runs all four C++ suites
in that image against Postgres 16 with both databases. Run the Postgres recipe before pushing a
change to a repository, write door or table. The subshell removes its databases on success or failure.

## Signing in without mail

`sessions.token_hash` is a plain `sha256(secret)` hex digest, so mint a session directly and skip
the magic-link flow:

```sh
SECRET=$(openssl rand -hex 24); HASH=$(printf '%s' "$SECRET" | shasum -a 256 | awk '{print $1}')
PROBE_USER_ID=$(uuidgen | tr 'A-Z' 'a-z')
NOW=$(python3 -c "import time;print(int(time.time()*1000))")
psql windmill -q -c "INSERT INTO users (id,email) VALUES ('$PROBE_USER_ID','probe-$RANDOM@example.com')"
psql windmill -q -c "INSERT INTO sessions (token_hash,user_id,expires_ms) \
  VALUES ('$HASH','$PROBE_USER_ID',$((NOW+86400000)))"
# either header works — the caller seam reads the cookie OR the bearer:
curl -s localhost:8088/v1/gym/exercises -H "Authorization: Bearer $SECRET"
```

Record ids are global, so prefix anything you seed (`ses_probe*`, `set_probe*`) and a parallel
agent's ids never collide with yours. Deleting the `users` row cascades to sessions and gym/journal
rows. Roadmap rows do not cascade: remove scratch trees separately (below). The engine's tables
hold the account too, so clear them first. For complete teardown, stop the server and drop its
throwaway database as described under Launch.

```sh
psql windmill -q -v ON_ERROR_STOP=1 <<SQL
begin;
delete from sync_spent where scope_key in (select key from sync_scopes where owner='$PROBE_USER_ID');
delete from sync_requests where account='$PROBE_USER_ID';
delete from sync_replicas where account='$PROBE_USER_ID';
delete from sync_scopes where owner='$PROBE_USER_ID';
delete from users where id='$PROBE_USER_ID';
commit;
SQL
```

## Driving MCP

MCP is HTTP JSON-RPC at `localhost:8088/mcp`. Two bearers open it:

- `devtoken` (`WINDMILL_MCP_TOKEN`) acts as `WINDMILL_MCP_USER`, which must be a real uuid in
  `users`; a non-uuid 500s on `roadmap_create_tree`.
- A **personal MCP key** acts as the account that minted it, with no restart. Mint one with any
  session of that account: `POST /v1/mcp-keys` answers the key's `token` once.

A session is required: `initialize` returns the `Mcp-Session-Id` every later call must carry.

```sh
MCP=$(curl -s -X POST localhost:8088/v1/mcp-keys -H "Authorization: Bearer $SECRET" \
  -H 'content-type: application/json' -d '{"name":"verify"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')   # or MCP=devtoken
SID=$(curl -si localhost:8088/mcp -H "Authorization: Bearer $MCP" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}' \
  | grep -i mcp-session-id | tr -d '\r' | awk '{print $2}')
mcp() {   # mcp <tool> '<arguments JSON>'
  curl -s localhost:8088/mcp -H "Authorization: Bearer $MCP" -H "Mcp-Session-Id: $SID" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
  echo
}
mcp roadmap_create_tree '{"title":"Scratch"}'
```

Tool names carry their product: `roadmap_*`, `gym_*`. `tools/list` lists what the bearer's grant
allows. A refused call still answers JSON-RPC success: `result.isError` is true and the content is a
sentence naming the next call, with no machine code.

### Scratch trees

Make scratch trees with `roadmap_create_tree`, never raw SQL. Open at `localhost:5173/#/app/<treeId>`.
Clean up afterwards: rows in `trees`, `tree_nodes`, `tree_edges`, `tree_kinds`, `tree_ops`.

A tree belongs to the account MCP acts as, and the page must be that same user or the tree reports
"Couldn't load this roadmap". Act as the browser's user rather than doing ownership surgery in SQL:

1. **Mint a browser session.** Local mail can't send (502, no Resend key), but
   `magic_links.token_hash` is a plain `sha256(secret)`, so write your own row and redeem it:
   ```sh
   LINK=$(openssl rand -hex 24); HASH=$(printf '%s' "$LINK" | shasum -a 256 | awk '{print $1}')
   NOW=$(python3 -c "import time;print(int(time.time()*1000))")
   psql windmill -q -c "INSERT INTO magic_links (token_hash,email,created_ms,expires_ms) \
     VALUES ('$HASH','dev@example.com',$NOW,$((NOW+900000)))"
   curl -si -X POST localhost:8088/v1/auth/verify -H 'content-type: application/json' \
     -H 'Origin: http://localhost:5173' -d "{\"token\":\"$LINK\"}"   # → Set-Cookie: wm_session=…
   ```
   Use a domain with a dot — the email validator rejects `dev@localhost` as unfinished.
2. **Mint a personal MCP key with that cookie's value as the bearer**, then `roadmap_create_tree` +
   `roadmap_import_subgraph`. The tree is natively owned by the signed-in browser user, so
   `#/app/<id>` works and shows the owner surfaces (edit rows, add-step, share).
3. Set the cookie before navigating — over CDP that is `Network.setCookie {name:'wm_session',
   value:…, domain:'localhost', path:'/'}`.

**Rooms are cached in the running server.** A `psql` change to a tree's `visibility` or `owner_id`
is invisible until restart once the server has opened that room. Arrange ownership before the room
is first opened rather than editing rows and restarting.

## Browser checks

Use the [roadmap capture rig](../../../web/scripts/roadmap-rig/APPARATUS.md) for authenticated
desktop/phone screenshots, selection checks and caption measurements. It waits for explicit scene
settlement; the canvas's continuous animation loop makes page-idle checks unsuitable.

The rig uses SwiftShader and cannot establish hardware frame rate. Use a hardware-backed browser
for timing and native interactions. Check the reduced-motion preference before judging animation.
Keep browser sessions bound to the account MCP acts as.

## Gym — driving the training log

Gym and journal records change only through the sync engine: the apps push to `/v1/sync`, and MCP,
the Coach and the import door admit as the server. Gym REST serves reads, shares, the Coach and the
import door; the retired write paths answer `410 client-update-required`. Drive data as the probe
account through its MCP key (above), read it back over REST, and use one `NOW` for every instant so
the workouts below never overlap.

```sh
C="Authorization: Bearer $SECRET"; J='content-type: application/json'
NOW=$(python3 -c "import time;print(int(time.time()*1000))")
curl -s localhost:8088/v1/gym/exercises -H "$C"                     # 64 seeded movements

# A live workout: start, log, finish.
mcp gym_start_session "{\"id\":\"ses_probe0001\",\"startedAt\":$((NOW-3600000))}"
mcp gym_log_sets "{\"sessionId\":\"ses_probe0001\",\"sets\":[{\"id\":\"set_probe0001\",
  \"exerciseId\":\"bench-press\",\"weightKg\":82.5,\"reps\":8,\"completedAt\":$((NOW-3000000))}]}"
mcp gym_finish_session "{\"sessionId\":\"ses_probe0001\",\"finishedAt\":$((NOW-60000))}"
curl -s "localhost:8088/v1/gym/last?exercise=bench-press" -H "$C"    # the prefill read

# Routines and the frozen plan. An entry takes `exerciseId`, `sets`, `restSeconds`; `sets` is the
# per-set scheme, each `{reps, weightKg}` with either OMITTED.
# No `sets` is an open line; an empty array is refused. Absences survive into the frozen `plan`; a
# zero would be a target the lifter never set.
mcp gym_create_routine '{"id":"rt_probe00001","name":"Push A","position":0,"entries":[
  {"exerciseId":"bench-press","sets":[{"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5}]},
  {"exerciseId":"chin-up","sets":[{"reps":8},{"reps":8},{"reps":8}]},
  {"exerciseId":"barbell-row"}]}'
curl -s localhost:8088/v1/gym/routines/rt_probe00001 -H "$C"   # `history` rides on this read only; the list omits it
mcp gym_start_session "{\"id\":\"ses_probe0002\",\"startedAt\":$NOW,\"routineId\":\"rt_probe00001\"}"   # freezes `plan`
curl -s localhost:8088/v1/gym/sessions/ses_probe0002/review -H "$C"
mcp gym_discard_session '{"sessionId":"ses_probe0002"}'       # refused session-open while it runs
mcp gym_finish_session "{\"sessionId\":\"ses_probe0002\",\"finishedAt\":$NOW}"
mcp gym_discard_session '{"sessionId":"ses_probe0002"}'

# A past workout lands whole through the import door: 201 {session, sets} as GET /v1/gym/sessions/{id};
# the same body again → 200; a span crossing a finished session → 409 session-overlap {sessionId,
# session}; the open session never blocks it. `gym_import_session` admits the same command over MCP.
S=$((NOW-10800000)); F=$((S+3600000))
curl -s -X POST localhost:8088/v1/gym/sessions/import -H "$C" -H "$J" -d "{\"id\":\"ses_probe0101\",
  \"startedAt\":$S,\"finishedAt\":$F,\"routineId\":\"rt_probe00001\",\"sets\":[
  {\"id\":\"set_probe0101\",\"exerciseId\":\"bench-press\",\"weightKg\":60,\"reps\":5,\"completedAt\":$((S+600000))}]}"
curl -s localhost:8088/v1/gym/sessions -H "$C"
```

### As a phone writes: `/v1/sync`

Every request carries `Sync-Schema` (hello answers the server's `schema` and `minSchema`). A push
names a replica (`rp_` + 32 hex), the account it binds to, and numbered intents; stamps are
`ms:counter:actor`, the actor `r_` + 12 `[a-z0-9]`. A weigh-in is the smallest record:

```sh
S5='Sync-Schema: 5'; DAY=$(date -u +%F); ST="$NOW:0:r_verifyprobe"
REPLICA=rp_$(openssl rand -hex 16)
curl -s localhost:8088/v1/sync/hello -H "$C" -H "$S5"
curl -s -X POST localhost:8088/v1/sync/push -H "$C" -H "$S5" -H "$J" -d "{\"replica\":\"$REPLICA\",
  \"account\":\"$PROBE_USER_ID\",\"ackThrough\":0,\"intents\":[{\"n\":1,\"scope\":\"self/gym\",\"d\":[
  {\"t\":\"weighin\",\"id\":\"$DAY\",\"life\":[\"alive\",\"$ST\"],\"f\":{\"kg\":[80.4,\"$ST\"],\"recordedAt\":[$NOW,\"$ST\"]}}]}]}"
curl -s -X POST localhost:8088/v1/sync/pull -H "$C" -H "$S5" -H "$J" \
  -d '{"scopes":[{"scope":"self/gym","cursor":null}]}'            # every row as the replica sees it
curl -s localhost:8088/v1/gym/bodyweight -H "$C"
```

A result is `ok` with its `seq`, or `refused` with a `code` (engine §9.6). The next push from the
same replica takes `n: 2`; resending an `n` with a different body is `409 replica-forked`. The
records, fields and commands are [engine Appendix A](../../../docs/foundation/engine.md); the
corpus under `packages/api-contract/sync/corpus/gym/` holds admitted examples of each.

Traps:

- **`gym_start_session` JOINS an already-open session** rather than failing, so the reply can
  carry a different id than you sent — always compare, or a script pours its sets into whatever was
  already open. Send `"joinOpenSession": false` for a backfill; with a workout open it is refused.
  `routineId` is read only on the path that actually creates a session.
- **One open session per user**; an idle one closes itself four hours after its last set, not
  after its start, so give a probe workout recent instants.
- Retries keep the same id and body and answer the stored result. A reused id with a changed body
  is refused by `gym_log_sets`, `gym_create_routine` and the import door, while `gym_log_set`
  answers the stored set whatever the body. A new set in a finished workout is refused, so log
  before finishing.
- Over REST and `/v1/sync`, tell refusals apart by the machine `code`, never the sentence. The
  import door answers `409` `session-id-taken`, `set-id-taken`, `session-overlap` or
  `session-deleted`, and `400` `unknown-exercise`; a refused intent carries an engine code
  (`session-finished`, `session-open`, `session-overlap`, `payload-conflict`, `id-taken`,
  `unknown-exercise`, `bad-instant`, engine §9.6). The retired write paths answer
  `410 client-update-required`.
- The review excludes its own session from its history window, so read it after the finish.

### Fixtures for the iOS gym integration tests

`apps/ios/App/UITests/GymIntegrationFlowTests.swift` reads the server origin from
`WM_GYM_E2E_SERVER`, three accounts from the JSON file at `WM_GYM_E2E_IDENTITIES` and the signed-in
account from the JSON file at `WM_GYM_E2E_SESSION`. `adopt` and `conflict` sign in with a pasted
link; `conflict` holds an open workout of one set. Mint them on a throwaway database:

```sh
python3 - "$DATABASE_URL" http://127.0.0.1:8088 /private/tmp/<yours> <<'PY'
import hashlib, json, secrets, subprocess, sys, time, urllib.request, uuid
db, origin, out = sys.argv[1:]
def call(token, path, body, session=None):
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    if session: headers['Mcp-Session-Id'] = session
    with urllib.request.urlopen(urllib.request.Request(origin + path, json.dumps(body).encode(), headers)) as reply:
        return reply.headers, json.load(reply)
now, identities = int(time.time() * 1000), {}
for kind in ('signed', 'adopt', 'conflict'):
    account, email, token = str(uuid.uuid4()), f'ios-gym-{kind}-{secrets.token_hex(4)}@example.com', secrets.token_hex(24)
    statements = [f"insert into users(id,email) values ('{account}','{email}')",
        f"insert into sessions(token_hash,user_id,expires_ms) values ('{hashlib.sha256(token.encode()).hexdigest()}','{account}',{now + 86400000})"]
    identities[kind] = {'account': account, 'email': email, 'token': token}
    if kind != 'signed':
        link = secrets.token_hex(24)
        statements.append(f"insert into magic_links(token_hash,email,created_ms,expires_ms) values ('{hashlib.sha256(link.encode()).hexdigest()}','{email}',{now},{now + 21600000})")
        identities[kind]['link'] = f'{origin}/auth?token={link}'
    subprocess.run(['psql', db, '-q', '-v', 'ON_ERROR_STOP=1', '-c', ';'.join(statements)], check=True)
conflict = identities['conflict']
_, minted = call(conflict['token'], '/v1/mcp-keys', {'name': 'ios-fixture'})
headers, _ = call(minted['token'], '/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
    'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'ios-fixture', 'version': '0'}}})
workout, lifted, started = 'ses_ios_conflict_' + secrets.token_hex(6), 'set_ios_conflict_' + secrets.token_hex(6), now - 60000
for tool, arguments in (('gym_start_session', {'id': workout, 'startedAt': started}),
        ('gym_log_set', {'sessionId': workout, 'id': lifted, 'exerciseId': 'barbell-row', 'weightKg': 35, 'reps': 11,
                         'kind': 'working', 'completedAt': started + 1000})):
    _, reply = call(minted['token'], '/mcp', {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
                                              'params': {'name': tool, 'arguments': arguments}}, headers['Mcp-Session-Id'])
    assert not reply['result'].get('isError'), reply
conflict.update(openSession=workout, openSet=lifted, openStartedAt=str(started), openCompletedAt=str(started + 1000))
for name, value in (('identities.json', identities), ('session.json', identities['signed'])):
    with open(f'{out}/{name}', 'w') as file: json.dump(value, file)
PY
```

Then run the UI tests with `WM_GYM_E2E_SERVER=http://127.0.0.1:8088`,
`WM_GYM_E2E_IDENTITIES=/private/tmp/<yours>/identities.json` and
`WM_GYM_E2E_SESSION=/private/tmp/<yours>/session.json`. Without them the tests run on the app's
in-process model server and the conflict case skips, which is never a pass. Mint fresh identities
for every run: each link signs in once.

## What the server saw

Every write logs one `write {…}` line with its `operation`, `product`, `door` (`mcp`, `sync`,
`rest`, …), `outcome` and `duration_ms`, and no content. Read them back from the server's output
(`grep 'write {'`). Product events land in the `events` table:
`psql windmill -c "select name, props from events order by id desc limit 20"`. The backend's Sentry
client posts only to an `https` DSN, so a local run has no Sentry sink: leave `SENTRY_DSN` unset.
