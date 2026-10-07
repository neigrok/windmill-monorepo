# backend — the C++ surface

One C++20 modular-monolith binary serving every product. Brand-wide rules live in the root
`CLAUDE.md`, the monorepo map in `STRUCTURE.md`. This file is only what is true inside this tree.

## Layering

`platform/` is the product-neutral half — auth, oauth, billing, the MCP engine, the sync engine, email,
telemetry, access, the HTTP host, and the AI spend meter (`domain/AiUsage`, `domain/AiFuse`,
`ports/AiUsageRepository`: every vendor call is priced and recorded, and the ceilings read the same
rows the owner page does).

`products/<p>/` is one product each (roadmap, journal, gym, and the sync engine's test-only probe),
with four shared layers: `domain/` (pure), `application/` (services over
ports), `ports/` (the abstractions), `adapters/` (one subfolder per messy edge — `http` and `postgres`
everywhere, plus `ws`/`mcp`/`llm`/`email` where a product needs them). Gym and journal each keep their
small engine binding together in `sync/`: rules, state port, product registry/binding and Postgres
stores, plus gym's server write door and journal's change feed. Each builds into its product library.

Composition roots: `platform/infra/main.cpp` (REST, the collab socket, MCP and the sync engine in one
process; it builds `windmill_server`, the harness-clocked `windmill_server_test_clock` and the probe's
`windmill_server_probe`), `mcp_main.cpp` (stdio transport) and `mcp_http_main.cpp` (standalone HTTP
transport, for local runs).

## How a product plugs in

Each product owns a `routes.h` declaring one `…Deps` struct and
`registerRoutes(drogon::HttpAppFramework&, const Deps&)`. `main.cpp` builds the collaborators and
calls each in its own namespace — `registerRoutes` (roadmap), `journal::registerRoutes`,
`gym::registerRoutes`.

MCP tools are the second seam: a product implements `platform/ports/ToolHost.h` (declaring each
tool's product and access level beside its description) and `main.cpp` registers it as a
`ToolModule` on the `CompositeToolHost` that `McpServer` binds. The composite is the grant gate — it
filters `tools/list` by the caller's scope, refuses an out-of-scope call, and refuses a duplicate
tool name at boot. Roadmap and gym are registered. Tending is wired to roadmap's host directly,
never the composite, so a prompt-injection-exposed agent cannot reach another product's tools.

`db/schema.sql` is one file for every product and builds the whole database, the sync engine's tables
and envelope columns included. It is applied in order and idempotent (`create … if not exists`); the
deploy re-applies it every time. It removes cutover snapshots and their guards; engine registers,
receipts and retained journal revisions stay in place.

## Build and test

```sh
cmake -S . -B build                             # RelWithDebInfo by default (CMakeLists.txt:12)
cmake --build build -j8
ctest --test-dir build --output-on-failure      # four C++ suites and four script checks (RUNNING.md §7)
```

Drogon and libpqxx are the two vendor dependencies, and the configure fails without either. libpqxx
comes from the system (`RUNNING.md` §1). Drogon is its pinned release with the patches in
`third_party/drogon`, which the configure builds once into a cache and the image builds in a layer of
its own: a request keeps every header line it was received with (`headerOccurrences()`), a response
keeps a cookie per name, domain and path, and a request whose field lines or framing RFC 9112 calls
invalid is refused. Its headers come first on every include path, so an unpatched Drogon installed
beside the others never shadows them.

Never build `-O0`: an un-inlined call chain overflows Drogon's worker-thread stack and corrupts
return values with no crash. That is why the default build type is forced.

Every C++ test file is named by hand in one of four `add_executable` lists in `CMakeLists.txt`. A test
file not in a list never runs.

The sync engine (`docs/foundation/engine.md`) is a platform feature: `domain/sync/` (pure: records,
shape, identity, the join, text merge), `ports/SyncStore.h` (the engine's own tables),
`ports/SyncType.h` (what a product binds per type and command), `application/sync/` (the catalog,
admission, push, pull, hello and the live channel, all run on `application/WorkerPool`), and the
adapters `postgres/PgSyncStore`, `postgres/PgTableType` (the common one-table product store),
`http/SyncApi` (`/v1/sync/hello`, `push`, `pull`) and `ws/SyncSocket` (`/v1/sync/live`), which read every
request's credentials from the header lines it was received with (§9.1, `domain/sync/Credentials.h`). It is built
against the sync contract in `../packages/api-contract/sync`, which CMake finds through
`WM_API_CONTRACT_DIR` and the image build receives as the named context `contract` (`Dockerfile`,
`.github/workflows/backend.yml`). The domain tests replay its golden corpus over in-memory fakes, one
case per vector (`test/platform/domain/sync/CorpusTest.cpp`); a corpus file with no runner is a named
skipped case, and a file nobody claims fails. They also load every product registry the contract ships
(`RegistryTest.cpp`), and run the gym and journal bindings against registry v6/minimum 4 and composition.json. `windmill_sync_tests` replays the server's files again
over Postgres under `WM_PG_TEST` (`RUNNING.md` §7).

`products/gym/sync/` binds gym's ten types and seven commands, and `products/journal/sync/` binds
journal's `page` and `journalState` and its two commands, `journal.savePage` and `journal.claimPage`.
`platform/infra/SyncProducts` seals the two into the gym + journal v6/minimum-4 catalog. `windmill_server`
always serves it at `/v1/sync/hello`, `push`, `pull` and `/v1/sync/live`, and the engine is the only
writer of gym and journal client data. Every gym write the server makes for a lifter — the MCP gym
tools, Coach, `POST /v1/gym/sessions/import`, the lazy close of a workout walked away from, and the
proposal unlink a Coach conversation's delete makes — goes through `GymDoor`, the one `GymWriteDoor`,
as a server-origin intent; it builds its own admission stack and four-thread worker pool beside the
engine's. `GymTools` and the import handler take the door directly; `TrainingService` uses it for
stale closes and `ThreadService` for proposal unlinking. Catalog, program, notes, settings and
weigh-in reads use repository ports directly. The gym repositories only read, but for shares and
Coach threads. No server door writes a journal page: `JournalRepository` only reads, and `JournalFeed` hands each committed page to the
`PageWatcher` (echo derivation) after the live feed, reporting a failure of either after the commit.

The admission corpus of both products runs over fakes and over Postgres, and so do journal's revision
retention vectors. Postgres cases run under `WM_PG_TEST` against two databases that `db/schema.sql`
builds: `DATABASE_URL`, and `WM_SYNC_DATABASE_URL` with `db/probe.sql` beside it, which the `sync` suite
and every gym case that writes through `GymDoor` use (`RUNNING.md` §7).

`windmill_server_test_clock` is the production composition with a clock the harness sets through
`WM_TEST_CLOCK_FILE`; `test/e2e/auth_differential.py` runs it beside `origin/main`'s server
(`test/e2e/README.md`). `windmill_server` compiles no test clock, and the runtime image does not carry
`windmill_server_test_clock`.

`products/probe/` is the engine's test and dev product (`probe.registry.json`, `db/probe.sql`) and the
worked example of a product on the engine. Only the test binaries and `windmill_server_probe` link it:
that server mounts the engine over the probe instead of gym and journal and refuses to start where
`WINDMILL_APP_URL` is https, and the Dockerfile fails the image if a probe symbol reaches
`windmill_server` or `windmill_mcp_http`.

`RUNNING.md` is the local walkthrough, `deploy/README.md` the production runbook. `SPEC.md` is the
roadmap tree engine: the loose-graph model, the sync contract, the socket frames and the tables.

## Every Postgres connection comes from the pool

`platform/adapters/postgres/PgPool.h` is the only place this process opens a connection, and it
holds at most 20. A repository stores a `std::shared_ptr<PgPool>`, never a connection string, and
borrows for exactly one transaction:

```cpp
PgLease conn{*pool_};      // the borrow, returned when it goes out of scope
pqxx::work txn{*conn};     // declared second so it destructs FIRST and can still roll back
```

That order and that ceiling are both load-bearing: a closed loopback connection holds one of macOS's
16,384 TCP ephemeral ports for 30 seconds, and the whole machine shares that pool.

- Tests borrow from `test/PgTestPool.h`, one pool per binary — never a connection per case.
- Local `DATABASE_URL` is the unix socket (`postgresql:///windmill?host=/tmp`), which costs no
  ephemeral port. Production keeps TCP.
- Never load-test with one `curl` per request. Pass every URL to one `curl` so it reuses the
  connection.

## A green local build is not a green CI

macOS/Homebrew and the CI Linux image disagree on two things that compile green on one side and fail
on the other:

- **libpqxx** names a result row `pqxx::row_ref` on macOS and `pqxx::row` on Linux. Read rows through
  `pqxx::result`, or take the row as a template parameter — never bind a `pqxx::row`
  (`PgTreeRepository.cpp`, `PgTendRunRepository.cpp`).
- **jsoncpp** writes a non-finite double as a token no parser reads back, and older builds throw
  instead, so the two toolchains can disagree on the same value (`ToolArgs.cpp` names such a value
  rather than rendering it).

Watch `gh run list` after every backend push, because **a push to `main` IS a deploy**.
`.github/workflows/backend.yml` builds, tests and publishes the image, and a green run triggers
`deploy.yml` on that exact sha with nobody in the loop. Red `ctest` ships nothing; a hand-dispatched
`deploy.yml` with an older sha is the rollback.
