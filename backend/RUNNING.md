# Running the Windmill backend locally

One binary — `windmill_server` — serves every product: the REST API, the collab WebSocket and MCP,
all from one process against one Postgres. Every write is behind a session, so a signed-out caller
can read a public tree and nothing else. `CLAUDE.md` in this directory is the map of the tree;
`deploy/README.md` is the production runbook.

## 1. Dependencies

```sh
brew install postgresql@14 openssl@3 drogon libpqxx
```

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

CMake prints `windmill_server enabled` once Drogon + libpqxx are found. Without them it builds only
the core libraries and tests and skips the server.

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
ctest --test-dir build --output-on-failure       # three binaries: domain · mcp · adapters
ctest --test-dir build -V                        # …and their summary lines
```

Each binary ends with one line — `N/M cases passed, X stopped before the end, Y skipped, Z
assertion(s) failed`. *Stopped before the end* counts cases a failing `REQUIRE` cut short; *skipped*
counts cases the environment could not run, never folded into the passed count. A case that takes
the process down is named (`*** CRASHED mid-case … ***`) and re-raised, so the exit status is honest.

The Postgres integration cases need a live database with `db/schema.sql` applied and run only under
`WM_PG_TEST`. They seed and clean their own rows.

```sh
WM_PG_TEST=1 DATABASE_URL="postgresql:///windmill?host=/tmp" \
  ctest --test-dir build -R adapters -V
```

Nothing in `.github/workflows/backend.yml` sets `WM_PG_TEST`: CI runs `ctest` inside the Docker
builder stage with no database beside it, so those cases are proven on a developer's machine and
nowhere else. Run them before pushing a change to a Pg repository or the tables it reads.

## Coach provider acceptance in CI

The Backend CI/CD workflow has a manual `verify_coach_provider` input, defaulting to false. Set it
to true on the reviewed candidate ref to build/test that exact checkout and run Coach against
`https://api.anthropic.com`. This mode skips image publication and cannot trigger production deploy.
It uses the existing `ANTHROPIC_API_KEY` Actions secret only in the candidate container environment;
it reads no production database, deployment configuration, SSH credentials or developer `.env`.

`test/e2e/coach_provider_ci.py` creates a separate runner Docker network, a tmpfs Postgres instance,
and a candidate exposed only on loopback. The database has no published port and uses trust auth
only inside that disposable network. A synthetic account/session and the schema's exercise catalog
are the entire initial data set. Mail, telemetry forwarding and background integrations are disabled.
The harness makes at most three new Coach requests and one identical completed replay, with 180-second
request and 600-second harness limits; the ordinary backend iteration and spend limits still apply.
The launcher removes its containers, network and private session file on exit. No host deployment or
registry publication is part of verification.

The artifact contains only `coach-provider-acceptance.json` and `coach-provider-run.json`: allowlisted
synthetic visible answers/receipts/results, check outcomes, source SHA, GitHub run identity, image ID,
provider model and observed token/cache/cost usage. Credentials, headers, image bytes, internal
reasoning and raw provider payloads are excluded. An interrupted call can have incomplete observed
usage. Inspect both the checks and the synthetic answers before treating a run as acceptance.

The run JSON also includes bounded stream diagnostics: HTTP status, numeric libcurl result,
message-start/completion flags, parser failure category, known provider error type and
cancellation/callback-failure flags. The runner extracts only that fixed record from the candidate's
in-memory logs before removing it; other log text is discarded. Provider error messages, unknown
error-type values and response bodies are never retained. An HTTP 200 can still carry an SSE error;
zero observed tokens on an interrupted call do not prove that the provider billed nothing.

Run the bootstrap and harness tests without a provider key from the repository root:

```sh
python3 -m unittest discover -s backend/test/e2e -p 'test_coach_provider_*.py' -v
```

## Deployed Coach smoke check

The Deploy workflow's manual `verify_coach_only=true` mode verifies the running release without
deploying. `image_tag` must be its full 40-character published commit SHA; `latest` is refused.
The mode shares the `deploy-vps` concurrency guard with normal deployments and never changes
images, services, routes or configuration. Its verifier checkout SHA is recorded separately.

`test/e2e/coach_provider_deployed.py` uses the existing Actions SSH credentials on a hosted runner
to inspect the server's exact image tag, image ID, registry digest and container health before any
database write, then checks them again after the smoke test. It creates one fresh random account
and hashed session through `~/windmill`'s compose Postgres service, with no email delivery. The
existing bounded acceptance harness uses that session against `https://windmill.works`, so its
incremental-delivery evidence includes the public proxy. The provider key stays on the server.

Cleanup first proves the account UUID, synthetic email and per-run marker, stops its unfinished
generations, and checks quiescence. A transaction locks the owner and its conversation leases,
refuses unexpected sessions or active generations, and removes only that newly created fixture.
Provider usage rows remain intact. If creation, ownership or quiescence cannot be proved, the
runner revokes only its new session and reports the retained fixture for review. A runner killed
before cleanup can leave the fixture; its session expires after 30 minutes.

Artifacts are limited to `coach-provider-deployed.json` and `coach-provider-acceptance.json`:
release/run identity, synthetic visible responses and receipts, observed usage, check outcomes and
cleanup status. SSH details, credentials, headers, image bytes and raw provider payloads are
excluded. Exit 3 means streaming timing was inconclusive; it is not a passing acceptance result.
The same offline script-test command above covers deployment gating and cleanup guards.

## Roadmap tree endpoints

The roadmap tree surface only — the server also serves auth, oauth, billing, MCP keys, reminders, the
share/gallery pages, and all of journal's and gym's routes, each in its product's `routes.cpp`.

| Method | Path | Body / result |
| --- | --- | --- |
| POST | `/v1/trees` | `{ title?, nodes?, kinds?, id? }` → `{ treeId, existed }`. The body is the starting `TreeData`; send none for a blank tree with the default legend. A supplied `id` must be `t_` + 16 lowercase hex. `409 id-taken` names somebody else's tree; `409 id-retired` names one you deleted — let that one go, never re-plant it under a fresh id |
| GET | `/v1/trees` | → `{ trees[] }` — the caller's roadmaps, newest first: `{ id, title, total, done, createdAt, updatedAt, dominantKind? }`, times in epoch ms |
| DELETE | `/v1/trees/:id` | → `204`. Owner-only soft-delete |
| GET | `/v1/trees/:id` | → `{ seq, data, state, createdAt, visibility, mine }`. `data.kinds` is the legend, `state` the full CRDT state, `createdAt` the planting time in epoch ms — the week-N card counts from it, never the calendar week |
| PUT | `/v1/trees/:id` | `TreeData` → `{ seq, data }`. Whole-document write; seeds the default legend on a new tree |
| POST | `/v1/trees/:id/fork` | `{ id?, title? }` → `{ seq, data }`. Copies nodes, edges and kinds verbatim, progress cleared |
| GET | `/v1/trees/:id/progress` | → `{ marks: [{ node, status, at, markedAt, outOfOrder? }] }` — the **owner's** progress, not the caller's |
| GET | `/v1/trees/:id/diagnostics` | → `{ cycles[], dangling[], selfEdges[], smells[], maskedWork[] }` |
| GET | `/v1/trees/:id/activity` | `?since=&limit=` → `{ events[] }`, a human feed from `tree_ops` |

Every row is gated by `canRead`/`canWrite` (`platform/domain/Access.h`): a private tree is owner-only
and answers `404` to everyone else; unlisted and public read alike. Planting, listing, writing,
deleting and forking need a session — an anonymous caller gets `401`.
