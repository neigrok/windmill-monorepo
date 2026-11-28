# Running the Windmill backend locally

One binary — `windmill_server` — serves every product: the REST API, the collab WebSocket and MCP,
all from one process against one Postgres. Every write is behind a session, so a signed-out caller
can read a public tree and nothing else. `CLAUDE.md` in this directory is the map of the tree;
`deploy/README.md` is the production runbook.

## 1. Dependencies

```sh
brew install cmake postgresql@14 openssl@3 jsoncpp c-ares brotli libpqxx
```

Drogon is not among them: the build makes its own, from the pinned release and the patches in
`third_party/drogon` (its `README.md`).

## 2. Database

```sh
brew services start postgresql@14        # or: pg_ctl -D /opt/homebrew/var/postgresql@14 start
createdb windmill
psql windmill -f db/schema.sql
```

`db/schema.sql` builds every product and the sync engine and is idempotent — re-run it after
pulling. It also removes retired gym and journal cutover copies; current user rows and engine
tables remain. The server-file purge and backup retention are in [the production runbook](deploy/README.md#day-to-day).

The subscription service (`services/subscriptions`) keeps its ledger in a database of its own, owned by
a role of the same name. Locally the role needs no password, since Homebrew's cluster trusts every
connection over its socket, and the service migrates the empty database itself when it starts:

```sh
createuser -h /tmp windmill_subscriptions
createdb -h /tmp -O windmill_subscriptions windmill_subscriptions
```

Its URL is `postgresql:///windmill_subscriptions?host=/tmp&user=windmill_subscriptions`;
[§4](#the-subscription-service) runs the service. The production rules that keep the backend's role out
of this database are not part of the local cluster.

The AI service (`services/ai`) uses a third database, `windmill_ai`, owned by its own role:

```sh
createuser -h /tmp windmill_ai
createdb -h /tmp -O windmill_ai windmill_ai
```

Run it from `services/ai` with the pinned Rust toolchain and `AI_DATABASE_URL` set to
`postgresql:///windmill_ai?host=/tmp&user=windmill_ai`; its [architecture](../services/ai/ARCHITECTURE.md)
names the remaining required configuration. It listens on 8084/8085. Keep `AI_PASS_KEYS={}` and
provider keys absent for a dark local process. `AI_TEST_DATABASE_URL` names a disposable maintenance
database for the Rust tests, which create isolated databases. Production HBA isolation is exercised
with `python3 backend/test/deploy/ai_db_test.py -v` from the repository root, using Docker Postgres 16.

The backend mounts `POST /v1/ai/passes` only with `AI_PASS_PRIVATE_SEED` set. Configure the 32-byte
Ed25519 seed as unpadded base64url, `AI_PASS_KID`, `AI_PASS_ENVIRONMENT=development` and
`AI_PASS_MIN_VERSIONS` as an object of profile names to positive integer minimum versions. Pin its
public key under the same kid in the service's `AI_PASS_KEYS`. The published test seed in the pass
vectors is accepted only in development under a `test-` kid. A production backend rejects that
public key under every kid, and rejects every `test-` kid.

The pass lasts 600,000 ms. Account claims come from `Entitlements::aiPrincipalFor` without grant
funding. An account pass names a presented installation only when it is bound to that account.

With the seed set, `AI_SERVICE_URL` (the service's public listener, `http://127.0.0.1:8084` locally) arms journal
echoes: their two model calls go to the service as the writer's background work, under a server pass the backend
signs for itself. Without either, echoes stay dark.
An installation alone must be unbound and anonymous admission enabled. Its pass consumes the same
durable address bucket as legacy generations, 30/hour by default; installation issuance remains
10/day. A separate principal token bucket allows 30 passes/minute, with burst 30. The route strictly
checks header occurrences and JSON keys; cookie sessions require an allowlisted Origin and JSON.
Every response is `no-store`. Existing installation and Coach routes keep their contracts.

## 3. Build

```sh
cmake -S . -B build
cmake --build build --target windmill_server
```

The first configure builds the patched Drogon into `~/.cache/windmill/drogon-<version>-<key>` (about
20 seconds on an M-series Mac) and every later one, in any checkout, reuses it; `-DWM_DROGON_PREFIX`
puts it elsewhere. A missing dependency fails the configure.

## 4. Run

```sh
DATABASE_URL="postgresql:///windmill?host=/tmp" PORT=8088 ./build/windmill_server
```

`:8088` is what `web/src/shell/apiBase.js` falls back to outside a production build, so the web app
finds it with no configuration. The default is `:8080`, which Docker Desktop usually holds.

Everything else is optional and each feature stays dark without its key — copy `.env.example` to
`.env` and `set -a; source .env; set +a` before the binary.

`ROADMAP_ENGINE_ENABLED=1`, which production's host sets (`deploy/README.md`, "Roadmap's cutover onto the sync
engine"), serves roadmap's scopes through the sync engine (`products/roadmap/sync/`), on the
`roadmap_*` tables `db/schema.sql` builds, and feeds roadmap's read models from them: the activity feed, the owner's
progress, the share page with its card and video, the gallery and reminders' readiness (`application/EngineReadModels`).
It also retires the rooms' socket and routes (`products/roadmap/routes.cpp`): `/v1/socket`, `GET`/`POST /v1/trees`,
`GET`/`PATCH`/`DELETE /v1/trees/{id}`, its `/guides` and `/diagnostics` and `PUT …/subtree` answer 410
`client-update-required` before authentication. Without it the server
composes and binds roadmap but withholds its scopes: hello says roadmap
holds nothing, `self/roadmap` pulls empty, its trees are not found, every roadmap intent is refused, and the read
models read the rooms and roadmap's own tables.

### The subscription service

Run from `services/subscriptions/`, once its database exists (§2); it migrates the ledger before it
listens. `SUBSCRIPTIONS_APP_STORE_TEST_ROOT` makes its App Store notification door trust the test chain
beside Apple's root, so a notification `app_store_test_signer` signs is believed. The service refuses that
variable at start unless `SENTRY_ENVIRONMENT` is `local`, `development`, `test` or `ci`; without it the
door trusts Apple's root alone, as production does.

```sh
TOKEN=$(openssl rand -hex 32)
SUBSCRIPTIONS_PUBLIC_ADDRESS=127.0.0.1:8082 SUBSCRIPTIONS_INTERNAL_ADDRESS=127.0.0.1:8083 \
  SUBSCRIPTIONS_DATABASE_URL="postgresql:///windmill_subscriptions?host=/tmp&user=windmill_subscriptions" \
  SUBSCRIPTIONS_APP_STORE_TEST_ROOT=tests/fixtures/app_store/test-chain/root.cer \
  SUBSCRIPTIONS_INTERNAL_TOKEN="$TOKEN" SENTRY_ENVIRONMENT=local cargo run --bin subscriptions
```

`SUBSCRIPTIONS_INTERNAL_TOKEN` is the bearer secret of the backend's reads on the internal port; without it
they answer 401. The backend follows the feed with the same secret in its `.env` beside
`SUBSCRIPTIONS_INTERNAL_URL=http://127.0.0.1:8083`.

In a second terminal, from the same directory and with the same `TOKEN`, sign one of the example
notifications (`tests/fixtures/app_store/test-payloads/`) and post it as Apple does:

```sh
SIGNED=$(cargo run -q -p app_store_test_signer < tests/fixtures/app_store/test-payloads/started.json)
curl -s -w '%{http_code}\n' localhost:8082/v1/stores/app-store/notifications \
  -H 'content-type: application/json' -d "{\"signedPayload\":\"$SIGNED\"}"              # 200
psql -h /tmp -U windmill_subscriptions windmill_subscriptions \
  -c 'select environment, outcome from inbox' -c 'select seq, type from events order by seq'
```

The inbox holds the notification `applied`, and the events are `started`, `bound` and `period_recorded`,
which the feed serves to the bearer, and the public port does not:

```sh
curl -s "localhost:8083/internal/v1/feed?after=0&limit=500" -H "authorization: Bearer $TOKEN"
curl -s -o /dev/null -w '%{http_code}\n' "localhost:8082/internal/v1/feed?after=0&limit=500"   # 404
```

The same `SIGNED` posted again answers 200 and adds nothing; a service started without
`SUBSCRIPTIONS_APP_STORE_TEST_ROOT` answers it `400 {"error":"refused"}` and keeps nothing, and its
`store.notification` line says `untrusted_chain`. Each delivery writes one such line to the service's
stdout, and the sweep one `sweep.inbox` line a minute
([ARCHITECTURE.md](../services/subscriptions/ARCHITECTURE.md#the-app-store-notification-door)). Locally
the service is reached directly; in production Caddy lets only Apple's subnet reach the door. Stop the
service by its ports.

#### A claim and a refresh

The claim door and the refresh take the subscription's state from the App Store Server API, so they need
an in-app purchase key and an Apple to call; without the key they answer `503
{"code":"store_api_unavailable"}`. Locally the run serves Apple itself: a directory holding the status
Get All Subscription Statuses answers, signed under the test chain, which `SUBSCRIPTIONS_APP_STORE_API_TEST_URL`
names (refused outside `local`, `development`, `test` and `ci`), and any P-256 key, since that Apple checks
no token. Sign the status first, so the notification posted after it is the newer statement. In a third
terminal, from `services/subscriptions/`:

```sh
APPLE=$(mktemp -d) && mkdir -p "$APPLE/inApps/v1/subscriptions"
jq 'del(.statusResponse.data[0].lastTransactions[0][].appAccountToken?)' \
  tests/fixtures/app_store/test-payloads/subscription-status.json \
  | cargo run -q -p app_store_test_signer > "$APPLE/inApps/v1/subscriptions/2000000000000001"
python3 -m http.server 8084 --bind 127.0.0.1 --directory "$APPLE"
```

Start the service as above with the key and that Apple beside the other variables:

```sh
SUBSCRIPTIONS_PUBLIC_ADDRESS=127.0.0.1:8082 SUBSCRIPTIONS_INTERNAL_ADDRESS=127.0.0.1:8083 \
  SUBSCRIPTIONS_DATABASE_URL="postgresql:///windmill_subscriptions?host=/tmp&user=windmill_subscriptions" \
  SUBSCRIPTIONS_APP_STORE_TEST_ROOT=tests/fixtures/app_store/test-chain/root.cer \
  SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID=local SUBSCRIPTIONS_APP_STORE_API_KEY_ID=local \
  SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY="$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256)" \
  SUBSCRIPTIONS_APP_STORE_API_TEST_URL=http://127.0.0.1:8084 \
  SUBSCRIPTIONS_INTERNAL_TOKEN="$TOKEN" SENTRY_ENVIRONMENT=local cargo run --bin subscriptions
```

Post the purchase without its hint, then claim it for an account, as the backend does for the phone that
bought it:

```sh
SIGNED=$(jq 'del(.notification.data[].appAccountToken?)' tests/fixtures/app_store/test-payloads/started.json \
  | cargo run -q -p app_store_test_signer)
curl -s localhost:8082/v1/stores/app-store/notifications -H 'content-type: application/json' \
  -d "{\"signedPayload\":\"$SIGNED\"}"
TRANSACTION=$(jq 'del(.transaction.appAccountToken)' tests/fixtures/app_store/test-payloads/purchase-transaction.json \
  | cargo run -q -p app_store_test_signer)
ACCOUNT=$(uuidgen | tr A-Z a-z)
curl -s localhost:8083/internal/v1/app-store/claims -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d "{\"accountId\":\"$ACCOUNT\",\"signedTransaction\":\"$TRANSACTION\"}"
```

It answers `{"seq":4,"entitlement":…}`: the feed holds `started` and `period_recorded` under no account, then
`bound` and `period_recorded` under `ACCOUNT`, and `store_hints` the account owed to Apple. The same claim
again answers the same `seq` and records nothing; another account's answers `409
{"code":"bound_to_another_account"}`. The sweep tries the owed hint each minute; this Apple answers its
`PUT` with 501, so the hint stays owed and each try logs `store.hint` `write_failed` `api_server_error`. A refresh
of the subscription, its id the feed's `subscriptionId`, pulls the same status again and answers its newest
`seq`:

```sh
curl -s -X POST "localhost:8083/internal/v1/subscriptions/$SUBSCRIPTION_ID/refresh" -H "authorization: Bearer $TOKEN"
```

Each claim and refresh writes one `store.claim` or `store.refresh` line
([ARCHITECTURE.md](../services/subscriptions/ARCHITECTURE.md#the-claim-and-refresh-doors)).

#### A claim through the backend

A phone claims through the backend, never the internal port: the backend forwards the signed transaction
under the account its session names and answers from its copy once the follower has brought it there
([subscriptions.md](../docs/foundation/subscriptions.md) §5.3). With the service running with its key and
Apple as above and the purchase posted without its hint, start the backend beside it in place of the
internal claim. The follower needs the AI ledger, whose alerts need an owner and a mail key, and the test
signer signs in sandbox, so the account that claims is a sandbox tester. From `backend/`, on a database
`db/schema.sql` built (§2):

```sh
SUBSCRIPTIONS_INTERNAL_URL=http://127.0.0.1:8083 SUBSCRIPTIONS_INTERNAL_TOKEN="$TOKEN" \
  AI_ALLOWANCES_ENABLED=true WINDMILL_OWNER_EMAILS=owner@example.com AI_ALLOWANCE_ALERT_EMAIL=owner@example.com \
  RESEND_API_KEY=local RESEND_BASE_URL=http://127.0.0.1:8100 WINDMILL_SANDBOX_EMAILS=ios-dev@example.com \
  WINDMILL_HOST=127.0.0.1 PORT=8088 ./build/windmill_server
```

Sign `ios-dev@example.com` in with a code as [the engine server](#engine-server-for-the-ios-simulator) does,
its `session` being `SESSION`, and claim the same `TRANSACTION`:

```sh
curl -s localhost:8088/v1/subscription/app-store/claims -H "authorization: Bearer $SESSION" \
  -H 'content-type: application/json' -d "{\"signedTransaction\":\"$TRANSACTION\"}"
curl -s localhost:8088/v1/subscription -H "authorization: Bearer $SESSION"
```

The claim answers 200 with the account's `SubscriptionResponse`, `windmillOne` true in `sandbox`, and
`GET /v1/subscription` answers the same; it answers 202 instead when the follower has not brought the copy to the
claim within 5 s. The same claim again answers alike; another account's answers
`409 {"code":"bound_to_another_account"}`, a caller with no session 401, a body that holds no compact JWS
`400 {"code":"invalid_transaction"}`, and a service without its key, a service that is down or a backend with the
follower off `503 {"code":"subscriptions_unavailable"}`. Each claim writes one `subscription.claim` line
([OBSERVABILITY.md](OBSERVABILITY.md)).

#### An erasure

The backend's erasure of a finally closed account owes the service the unbind of everything the account held
([subscriptions.md](../docs/foundation/subscriptions.md) §6.4). The service's door takes it directly too, and
answers 204 the first time and every time after:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "localhost:8083/internal/v1/accounts/$ACCOUNT" \
  -H "authorization: Bearer $TOKEN"                                                                   # 204
psql -h /tmp -U windmill_subscriptions windmill_subscriptions \
  -c 'select account_id is null as unbound from subscriptions' -c 'select left_with_no_one from periods'
```

The feed ends with `unbound` under the account, its entitlement holding nothing, and the periods it paid for stay
with no one. Each call writes one `account.unbind` line. A backend that erases the account while the service is down
keeps the unbind in `owed_subscription_unbinds` and its sweep tries it again, a minute or two later at first
(`subscription.unbind`, [OBSERVABILITY.md](OBSERVABILITY.md)).

### Engine server for the iOS simulator

Run from `backend/`. This serves `windmill_server` on an isolated local database, and the simulator
reaches it at `http://127.0.0.1:<port>`; choose the port with `WM_ENGINE_PORT`. The probe product and
its dev endpoints are absent from this server.

```sh
WM_ENGINE_DB=wm_ios_engine
WM_ENGINE_PORT=8088
createdb -h /tmp "$WM_ENGINE_DB"
export DATABASE_URL="postgresql:///$WM_ENGINE_DB?host=/tmp"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
RESEND_API_KEY= ANTHROPIC_API_KEY= OPENAI_API_KEY= JOURNAL_EMBEDDER_URL= \
  WINDMILL_HOST=127.0.0.1 WINDMILL_APP_URL="http://127.0.0.1:$WM_ENGINE_PORT" \
  PORT="$WM_ENGINE_PORT" ./build/windmill_server
```

In a second terminal, seed a development code using the direct-database path, then verify through
the normal app door. No Resend request or mail is needed. Repeat the SQL to issue a fresh code after
the single-use credential expires or is consumed. Set the same database and port as above.

```sh
WM_ENGINE_DB=wm_ios_engine
WM_ENGINE_PORT=8088
export DATABASE_URL="postgresql:///$WM_ENGINE_DB?host=/tmp"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
insert into magic_links(token_hash,code_hash,email,created_ms,expires_ms)
  select encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),
    encode(sha256(convert_to('483201','UTF8')),'hex'),'ios-dev@example.com',
    (extract(epoch from clock_timestamp())*1000)::bigint,
    (extract(epoch from clock_timestamp())*1000)::bigint+900000;
SQL
curl -sS "http://127.0.0.1:$WM_ENGINE_PORT/v1/auth/verify-code" \
  -H 'Content-Type: application/json' \
  -d '{"email":"ios-dev@example.com","code":"483201","sessionTransport":"bearer"}'
```

The code sign-in creates the account on first use. The response's `session` is the bearer secret and
`user.id` is the engine account. The app stores the secret in its Keychain and sends
`Authorization: Bearer <session>` with `Sync-Schema: <version>`, its registry's version, on hello, push
and pull; live uses `/v1/sync/live?schema=<version>`. Existing web and Android callers omit `sessionTransport` and
receive their existing bodies. Read [AUTH.md](AUTH.md) for native Apple configuration and its
identity-token/nonce exchange.

#### A server that requires an update (426)

Hello, push, pull and the live upgrade answer `426 upgrade-required` to a registry version below the
server's minimum. `SyncApi` takes that minimum from the `minVersion` of the composed
registries embedded at build time; no environment variable changes it. To drive the app's update
path, build a second binary from a copy of the contract whose composed registries all stand one version
ahead, with `minVersion` equal to `version`:

```sh
WM_426_CONTRACT=$(mktemp -d)/api-contract
cp -R ../packages/api-contract "$WM_426_CONTRACT"
python3 - "$WM_426_CONTRACT/sync" <<'PY'
import json, sys
for name in json.load(open(sys.argv[1] + "/composition.json"))["registries"]:
    path = f"{sys.argv[1]}/{name}"
    with open(path) as file:
        registry = json.load(file)
    registry["version"] = registry["minVersion"] = registry["version"] + 1
    with open(path, "w") as file:
        json.dump(registry, file, indent=2)
PY
cmake -S . -B build-426 -DWM_API_CONTRACT_DIR="$WM_426_CONTRACT"
cmake --build build-426 --target windmill_server
```

Stop the engine server by its port and serve `./build-426/windmill_server` with the same command and
database. The copied registries now require version 16; the app's version 15 is refused:

```sh
curl -si "http://127.0.0.1:$WM_ENGINE_PORT/v1/sync/hello" -H 'Sync-Schema: 15'
# HTTP/1.1 426 Upgrade Required … {"epoch":"…","error":"upgrade-required","serverTime":…}
```

Serving `./build/windmill_server` again lowers the minimum. An engine that has seen the 426 stops
syncing for the rest of its process, so the app syncs again once it relaunches.

After the simulator run, stop the listener by its chosen port and remove the local database:

```sh
WM_ENGINE_PID=$(lsof -tiTCP:"$WM_ENGINE_PORT" -sTCP:LISTEN)
if [ -n "$WM_ENGINE_PID" ]; then kill $WM_ENGINE_PID; fi
dropdb -h /tmp "$WM_ENGINE_DB"
```

## 5. Exercise it

You need a session first. Signing in through the web app needs a working `RESEND_API_KEY`: without
it `POST /v1/auth/magic-link` answers `502`. On a bare machine, mint the session by hand —
`sessions.token_hash` is the hex SHA-256 of the cookie value:

```sh
psql windmill -c "insert into users (id, email, name) values (gen_random_uuid(), 'you@example.com', 'You') on conflict (email) do nothing"
HASH=$(printf %s localdev | shasum -a 256 | cut -d' ' -f1)
psql windmill -c "insert into sessions (token_hash, user_id, expires_ms) select '$HASH', id, 99999999999999 from users where email='you@example.com'"
```

Then every call carries `-b wm_session=localdev`:

```sh
# plant a tree — the server mints the id
curl -b wm_session=localdev -X POST localhost:8088/v1/trees \
  -H 'content-type: application/json' -d '{
  "title": "Demo",
  "nodes": [
    { "id": "product", "label": "Windmill", "icon": "sprout", "color": "gold", "prerequisites": [] },
    { "id": "renderer", "label": "WebGL2 renderer", "icon": "zap", "color": "sky", "prerequisites": ["product"] }
  ]
}'                                                        # -> { "treeId": "t_…", "existed": false }

TREE=t_…                                                  # the id it just answered with
curl -b wm_session=localdev localhost:8088/v1/me           # -> { "user": { … } }
curl -b wm_session=localdev localhost:8088/v1/trees        # -> { "trees": [ … ] }
curl -b wm_session=localdev localhost:8088/v1/trees/$TREE  # -> { "seq", "data", "state", … }
```

A new tree is `private`, so the same reads without the cookie answer `404 no such tree` — byte-
identical to a tree that does not exist, deliberately.

### Manual live Coach verification

The Backend CI/CD dispatch input `verify_live_coach=true` runs the checked-out commit against
disposable Postgres accounts with the GitHub `ANTHROPIC_API_KEY` secret. It does not publish images
or deploy. The manually gated job sends at most four Coach generations: a free account's setup
question and routine creation, plus synthetic program photos for a separate fresh free account
and an owner. It verifies image
contents against the saved routines, exact USD settlement, replay, owner isolation and first-party
telemetry. Coach offers up to 2,000 output tokens; locked allowance admission may reduce each
round's cap to its 1,024-token policy floor. Individual/free-pool limits keep their normal defaults.

```sh
gh workflow run backend.yml --ref <reviewed-branch> -f verify_live_coach=true
```

This is paid provider verification, not part of ordinary CI. The driver targets less than $1 in
actual provider cost, checks cost between generations and requests Stop at $0.90 while waiting;
an in-flight round can still finish, so this is not a hard cost ceiling. It never retries a failed
generation. Email and telemetry go to isolated TLS collectors; no production account or mailbox
is used. The retained `coach-live-results` artifact contains bounded checks, per-round token/cost
counts, reservation/settlement amounts, numeric input/output offers and selected caps, plus sanitized
provider diagnostics, including on failure. The bounded telemetry wait requires every admission log.
Credentials, raw responses and private collector records are removed with the runner.

## 6. Point the frontend at it

Nothing to swap. `HttpTreeRepository` takes its base URL from `web/src/shell/apiBase.js`, which
resolves to `http://localhost:8088` outside a production build. Run the server on `:8088`, then
`cd ../web && npm run dev`. `VITE_API_BASE_URL` overrides.

## 7. Tests

```sh
cmake --build build -j8
ctest --test-dir build --output-on-failure       # four C++ suites and fourteen script checks
ctest --test-dir build -V                        # …and their summary lines
```

`domain`, `mcp`, `sync` and `adapters` are the C++ suites. `one_definition` checks that no two files of
`platform/` and `products/` define a class or struct under one qualified name: every binary links them all, and the
linker would keep one copy of the inline code the two share. `log_sources` checks that every file of them that writes a
`LOG_` line is one `privacySafeLogBody` keeps the lines of, and that it names no other: a line from a file it does not
name reaches the log and Sentry Logs as `framework diagnostic suppressed`. `sync_composition` checks that the manifest
and explicit server bindings name the same registries without duplicates. `deploy` checks that the production
Caddyfile forwards every credential line as received, `deploy_stop_grace` that the time the compose
file gives the server to stop covers the server's own deadline and exit flush, `deploy_production` runs
`deploy/deploy-production.sh` against a modeled Docker host, `auth_differential` tests the
authentication differential's comparator (`test/e2e/README.md`), `anonymous_coach` runs the unit
tests of the Coach end-to-end helpers (`anonymous_coach_test.py`, `gym_http_test.py`), and
`log_lifecycle` drives `windmill_mcp`'s log shutdown at stdin EOF, on a fatal signal and with stalled
stderr. `sync_epoch` checks the restore tool's refusals and bounded logging; under `WM_PG_TEST` it also
checks committed rotation, concurrent retries, rollback and lock timeouts using `psql`.
`server_stop` runs only under `WM_PG_TEST`: it starts `windmill_server` on a free port over
`DATABASE_URL` and tells it to stop — with a room it cannot save, with a request still running, in
the middle of a burst of socket frames, with a second request read behind one being served and with
a sync pull a worker answers late — and checks its exit code, the deadline it exits by, what landed
after the signal and its log. `roadmap_routes` runs only under `WM_PG_TEST`: it starts `windmill_server` over
`DATABASE_URL` with `ROADMAP_ENGINE_ENABLED` unset and set, and asks every route of roadmap's rooms, `/v1/socket`'s upgrade
and a plain GET of it, and the routes the move keeps, signed out and signed in, with a body none can parse: unset, each
answers through its handler, as roadmap's rooms serve it; set, each of the rooms' answers 410 `client-update-required`
with the CORS headers an allow-listed origin reads, logged once under its static operation in a line that names no tree, session
or body, and the kept routes answer as they do unset. `subtree_inventory` checks the subtree inventory tool's refusals; under `WM_PG_TEST` it builds
databases of its own beside `DATABASE_URL`'s, which the role must be allowed to create, and checks the
counts the tool prints, that they name no tree, account or title, that the tool writes nothing, and that
it counts a chain of 200,001 trees to its end. `roadmap_adopt` checks the roadmap adoption tool's refusals; under `WM_PG_TEST`
it builds databases of its own beside `DATABASE_URL`'s from `db/schema.sql` and `test/platform/infra/roadmap_adopt_fixture.sql`
and runs every stage on them: their counts, a second run that writes nothing, a run killed between stages and in the middle
of its adoption, a stage refused beside another client, which it watches for from `DATABASE_URL`'s database, the rows
that stop it, and that nothing it prints names a record
(`products/roadmap/adoption/README.md`).

Each binary ends with one line — `N/M cases passed, X stopped before the end, Y skipped, Z
assertion(s) failed`. *Stopped before the end* counts cases a failing `REQUIRE` cut short; *skipped*
counts cases the environment could not run, never folded into the passed count. A case that takes
the process down is named (`*** CRASHED mid-case … ***`) and re-raised, so the exit status is honest.

The Postgres integration cases run only under `WM_PG_TEST` and require two fresh throwaway databases,
each built by `db/schema.sql`. `DATABASE_URL` holds it alone. `WM_SYNC_DATABASE_URL` also holds
`db/probe.sql`: the `sync` suite runs there, and so does every gym case in `mcp` and `adapters` that
writes through `GymDoor` (`test/products/gym/sync/GymDoorFixture.h`). The gym HTTP
and MCP cases that only read run over a read-only fake store (`test/products/gym/Fakes.h`). The sync
suite wipes sync, probe, gym and journal data as it replays the corpus, store and concurrency cases;
run these binaries serially. Create the test databases explicitly as UTF-8; the Unicode contract
cases must not inherit a SQL_ASCII maintenance database.

```sh
createdb -h /tmp --template=template0 --encoding=UTF8 wm_rest_test
createdb -h /tmp --template=template0 --encoding=UTF8 wm_sync_test
psql -h /tmp -d wm_rest_test -v ON_ERROR_STOP=1 -f db/schema.sql
psql -h /tmp -d wm_sync_test -v ON_ERROR_STOP=1 -f db/schema.sql -f db/probe.sql
WM_PG_TEST=1 DATABASE_URL="postgresql:///wm_rest_test?host=/tmp" \
  WM_SYNC_DATABASE_URL="postgresql:///wm_sync_test?host=/tmp" \
  ctest --test-dir build -R '^(domain|sync|adapters|mcp|sync_epoch|subtree_inventory|roadmap_adopt|server_stop|roadmap_routes)$' -V
```

`windmill_server_probe` is `windmill_server` with the sync engine mounted over the probe product
instead of the product composition, for the throwaway sync database only; it refuses to start where
`WINDMILL_APP_URL` is https. It also mounts the dev stack's endpoints
(`products/probe/adapters/http/DevApi.h`), which native end-to-end runs drive:

- `POST /v1/dev/sign-in` `{"email"}` → `{"account", "token"}`: finds or creates the account and mints a
  new session with no mail. The token works as `Authorization: Bearer` wherever the `wm_session` cookie
  does, the `/v1/sync/live` upgrade included, and `POST /v1/auth/logout` with it revokes it.
- `POST /v1/dev/sync/epoch` → `{"epoch"}`: regenerates `sync_meta.epoch` as a restore would. Hello, push,
  pull and live frames carry the new one at once; the schema refusals (400, 426) and every 503
  keep the epoch read at boot until the process restarts.

`test/e2e/sync_probe.sh` drives it over HTTP, with the session cookie scoped to `Domain=sync-probe.test` so
a sign-in shows both of the cookie's scopes. The server refuses a `Domain` with no registrable domain, such
as `localhost` (`AUTH.md`), so the script reaches it as that dotted host through `curl --resolve`; every
other local run keeps the cookie host-only:

```sh
DATABASE_URL="postgresql:///wm_sync_test?host=/tmp" PORT=8089 WINDMILL_COOKIE_DOMAIN=sync-probe.test ./build/windmill_server_probe &
WM_E2E_DB=wm_sync_test PORT=8089 bash test/e2e/sync_probe.sh
```

`test/e2e/deployment_conformance.mjs` checks what engine.md asks of a deployment against the same server:
over raw HTTP/1.1 to it directly, then through the production edge, `deploy/Caddyfile` in Caddy's own
image with only its upstream pointed at the server. It rewrites the corpus's sessions in the database,
needs Docker and curl, and checks the Caddyfile first (the `deploy` test).

- **§9.1 Credentials.** It replays `envelope/credentials.json` on hello, pull, push and the live socket,
  through the edge over HTTP/1.1 and HTTP/2. Over HTTP/1.1 each runs on a connection of its own, then
  hello, pull and push all on one keep-alive connection, then all pipelined at once. A live socket is
  judged by the `as` of the frame a `sub` for a missing tree answers. A request that is not valid HTTP
  may be refused before the origin reads it, never served: the vector that spells `Cookie` with a Kelvin
  sign, and over HTTP/2 one whose value ends in space or tab (RFC 9113 §8.2.1); only a bare `400` or a
  reset stream counts as that refusal. The run says so when the edge offers no HTTP/2 extended CONNECT
  (RFC 8441), so that the live socket goes over HTTP/1.1 alone.
- **§6.8 The idle live socket.** A socket to the server and one through the edge say nothing for
  `LIVE_PING_MS + LIVE_PONG_MS` (35 s) and a second more, and must still be open and answer a `ping`
  with `pong` within a second. The server's idle limit (60 s, `kIdleConnectionLimit` in
  `platform/adapters/http/ReplyWait.h`) is longer, and the production Caddyfile sets no `stream_timeout`, so
  neither needs a setting for it.

```sh
WM_E2E_DB=wm_sync_test PORT=8089 EDGE_PORT=8443 node test/e2e/deployment_conformance.mjs
```

After stopping the probe server and finishing verification, remove the throwaway databases:

```sh
dropdb -h /tmp wm_rest_test
dropdb -h /tmp wm_sync_test
```

The Docker build runs `ctest` with no database beside it, so its Postgres cases skip. Backend CI's
`postgres` job runs them: it loads the builder stage the `test` job built and runs the `domain`,
`mcp`, `sync`, `adapters`, `sync_epoch`, `subtree_inventory`, `roadmap_adopt`, `roadmap_routes` and `server_stop` tests
in one `ctest` run
under `WM_PG_TEST` against a Postgres 16 service
with the same two-database setup above (`windmill_test` for `DATABASE_URL`, `windmill_sync_test` for
`WM_SYNC_DATABASE_URL`). It then serves the stage's own `windmill_server_probe` on the sync database
and runs `test/e2e/deployment_conformance.mjs` against it, and serves `windmill_server` on a third
database holding `db/schema.sql` alone, where `WM_E2E_CATALOG=products` runs the same direct and edge
suite over the product composition's catalog, roadmap's scopes withheld there with `ROADMAP_ENGINE_ENABLED` unset, and
its three product scopes. On the runner
itself, `test/deploy/schema_reapplication_test.py` checks that re-applying `db/schema.sql`, as every
deploy does, changes nothing, and that repeated application removes retired cutover storage and the
retired tree columns while preserving live rows.

The domain suite's pattern fuzz matches the sync registry's `Pattern` against the JS reference
(`packages/api-contract/sync/reference/core/registry.js`) on patterns and values the reference
generates and answers. It runs only when `WM_PATTERN_CASES` names a case file; the `postgres` job
generates one for a fresh seed on every run, and `--seed <n>` replays one:

```sh
node test/platform/domain/sync/reference_pattern_cases.mjs > /tmp/pattern-cases.json
WM_PATTERN_CASES=/tmp/pattern-cases.json ctest --test-dir build -R domain -V
```

## Coach verification

Tests and automation must not call a real LLM. Coach's committed adapter and service tests use
deterministic model replies, SSE bytes and repository fixtures. They cover request construction,
stream parsing, cancellation, receipts, owner isolation and retry persistence without provider
credentials. From the repository root:

```sh
cmake --build backend/build -j4
ctest --test-dir backend/build -R adapters --output-on-failure
```

Postgres cases additionally require `WM_PG_TEST=1`, an isolated `DATABASE_URL` and an isolated
`WM_SYNC_DATABASE_URL` initialized with the probe schema, as described in §7. Run the suites serially.
A local protocol fixture can exercise HTTP and proxy transport without calling a model;
its replies do not establish actual-model quality or vision understanding.

Actual-model exploration is manual and local only, when the user provides a local key. Use the
normal local application and isolated account/data; do not turn that interaction into a test,
scripted acceptance harness, CI job or deployment gate. Keep the key outside tracked files and
record only the observations needed for review.

Deployment verification checks image/endpoint/asset behavior without model calls. The deploy
workflow retains normal production `ANTHROPIC_API_KEY` rendering so customer Coach requests keep
their configured provider. Runtime stream diagnostics contain only HTTP status, numeric libcurl
result, message-state flags, fixed parser/provider error categories and cancellation/callback flags.
They do not retain raw bodies, prompts, thinking or credentials. An HTTP 200 can carry an SSE error;
zero observed tokens on an interrupted call do not prove that the provider billed nothing.

## API contracts

[The roadmap spec](SPEC.md) documents the tree HTTP and WebSocket surfaces. Journal and gym keep
contracts in their [journal](products/journal/ARCHITECTURE.md) and
[gym](products/gym/ARCHITECTURE.md) architecture documents; each product's `routes.cpp` registers its
current endpoints.
