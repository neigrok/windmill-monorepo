# backend — the C++ surface

One C++20 modular-monolith binary serving every product. Brand-wide rules live in the root
`CLAUDE.md`, the monorepo map in `STRUCTURE.md`. This file is only what is true inside this tree.

## Layering

`platform/` is the product-neutral half — auth, oauth, billing, the MCP engine, email, telemetry,
access, the HTTP host, and the AI spend meter (`domain/AiUsage`, `domain/AiFuse`,
`ports/AiUsageRepository`: every vendor call is priced and recorded, and the ceilings read the same
rows the owner page does).

`products/<p>/` is one product each (roadmap, journal, gym), and every product repeats the same four
layers: `domain/` (pure), `application/` (services over ports), `ports/` (the abstractions),
`adapters/` (one subfolder per messy edge — `http` and `postgres` everywhere, plus
`ws`/`mcp`/`llm`/`email` where a product needs them).

Composition roots: `platform/infra/main.cpp` (REST, the collab socket and MCP in one process),
`mcp_main.cpp` (stdio transport), `mcp_http_main.cpp` (standalone HTTP transport, for local runs).

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

`db/schema.sql` is one file for every product, applied in order and idempotent
(`create … if not exists`); the deploy re-applies it every time.

## Build and test

```sh
cmake -S . -B build                             # RelWithDebInfo by default (CMakeLists.txt:12)
cmake --build build -j8
ctest --test-dir build --output-on-failure      # three binaries: domain · mcp · adapters
```

Drogon and libpqxx are the two vendor dependencies (`brew install drogon libpqxx`). Without them
CMake builds the core libraries and the domain tests and skips the server — read the configure
status line rather than assuming.

Never build `-O0`: an un-inlined call chain overflows Drogon's worker-thread stack and corrupts
return values with no crash. That is why the default build type is forced.

Every test file is named by hand in one of three `add_executable` lists in `CMakeLists.txt`. A test
file not in a list never runs.

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
