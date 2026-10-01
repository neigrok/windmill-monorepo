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

`db/schema.sql` is one file for every product and idempotent — re-run it after pulling.

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

## 6. Point the frontend at it

Nothing to swap. `HttpTreeRepository` takes its base URL from `web/src/shell/apiBase.js`, which
resolves to `http://localhost:8088` outside a production build. Run the server on `:8088`, then
`cd ../web && npm run dev`. `VITE_API_BASE_URL` overrides.

## 7. Tests

```sh
cmake --build build -j8
ctest --test-dir build --output-on-failure       # four binaries (domain · mcp · adapters · sync) and the deploy check
ctest --test-dir build -V                        # …and their summary lines
```

Each binary ends with one line — `N/M cases passed, X stopped before the end, Y skipped, Z
assertion(s) failed`. *Stopped before the end* counts cases a failing `REQUIRE` cut short; *skipped*
counts cases the environment could not run, never folded into the passed count. A case that takes
the process down is named (`*** CRASHED mid-case … ***`) and re-raised, so the exit status is honest.

The Postgres integration cases run only under `WM_PG_TEST` and require two fresh throwaway databases.
The REST `adapters` suite reads `DATABASE_URL`, holding plain `db/schema.sql`. The engine `sync` suite
reads `WM_SYNC_DATABASE_URL`, holding `db/schema.sql`, `db/probe.sql` and `db/gym_sync.sql`.
The gym adoption and backfill rehearsal is documented in [deploy/gym-migration/README.md](deploy/gym-migration/README.md).
Both URLs must be set when running those suites under `WM_PG_TEST`. Never apply `gym_sync.sql` to the
legacy repository database: it removes the `ON DELETE` actions those repository tests require.
The admitted gym door cases in `adapters` use `WM_SYNC_DATABASE_URL`, with real repositories and
the gym catalog. The existing HTTP/MCP contract fixtures use fakes. The sync suite wipes sync,
probe and gym data as it replays the corpus, store and concurrency cases; run these binaries serially.

```sh
createdb -h /tmp wm_rest_test
createdb -h /tmp wm_sync_test
psql -h /tmp -d wm_rest_test -v ON_ERROR_STOP=1 -f db/schema.sql
psql -h /tmp -d wm_sync_test -v ON_ERROR_STOP=1 -f db/schema.sql -f db/probe.sql -f db/gym_sync.sql
WM_PG_TEST=1 DATABASE_URL="postgresql:///wm_rest_test?host=/tmp" \
  WM_SYNC_DATABASE_URL="postgresql:///wm_sync_test?host=/tmp" \
  ctest --test-dir build -R '^(domain|sync|adapters)$' -V
```

`GYM_ENGINE_WRITES` and `GYM_WRITE_FREEZE` accept `1`, `true` or `on`, and default off. Engine writes
require the adopted gym schema and metadata. The freeze refuses REST writes with `503 gym-frozen`,
MCP and Coach abilities with error results, and leaves staleness unchanged on reads. Conversations
and workout shares retain their existing tables; conversation deletion admits proposal unlinking.

```sh
WM_PG_TEST=1 DATABASE_URL="postgresql:///wm_rest_test?host=/tmp" \
  WM_SYNC_DATABASE_URL="postgresql:///wm_sync_test?host=/tmp" GYM_ENGINE_WRITES=1 \
  ctest --test-dir build -R '^(mcp|adapters)$' -V
```

`windmill_server_probe` is `windmill_server` with the sync engine mounted over the probe product, for
that throwaway database only; it refuses to start where `WINDMILL_APP_URL` is https. It also mounts the
dev stack's endpoints
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
  with `pong` within a second. Drogon's idle timeout (60 s) does not reach an upgraded connection, and
  the production Caddyfile sets no `stream_timeout`, so neither needs a setting for it.

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
`sync` and `adapters` tests in one `ctest` run under `WM_PG_TEST` against a Postgres 16 service with
the same two-database setup above (`windmill_test` for REST, `windmill_sync_test` for sync), then
serves the stage's own `windmill_server_probe` on the sync database and runs
`test/e2e/deployment_conformance.mjs` against it.

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

Postgres cases additionally require `WM_PG_TEST=1` and an isolated `DATABASE_URL`, as described
above. A local protocol fixture can exercise HTTP and proxy transport without calling a model;
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
