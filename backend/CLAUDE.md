# backend — the C++ surface

One C++20 modular-monolith binary serving every product. Brand-wide rules live in the root
`CLAUDE.md` and the monorepo map in `STRUCTURE.md`; this file is only what is true inside
this tree.

## Layering

`platform/` is the product-neutral half — auth, oauth, billing, the MCP engine, email,
telemetry, access, the HTTP host. `products/<p>/` is one product each (roadmap, journal,
gym), and every product repeats the same four layers: `domain/` (pure), `application/`
(services over ports), `ports/` (the abstractions), `adapters/` (one subfolder per messy
edge it actually has — `http` and `postgres` everywhere, plus `ws`/`mcp`/`llm`/`email`
where a product needs them).

The composition roots are `platform/infra/main.cpp` — REST, the collab socket and MCP in
one process — plus `mcp_main.cpp` (stdio transport) and `mcp_http_main.cpp` (standalone
HTTP transport, kept for local/standalone runs).

## How a product plugs in

Each product owns a `routes.h` that declares one `…Deps` struct and
`registerRoutes(drogon::HttpAppFramework&, const Deps&)`. `main.cpp` builds the
collaborators and calls each in its own namespace — `registerRoutes` (roadmap),
`journal::registerRoutes`, `gym::registerRoutes`.

MCP tools are the second seam: a product implements `platform/ports/ToolHost.h` (declaring
each tool's product and access level beside its description) and `main.cpp` registers it as
a `ToolModule` on the `CompositeToolHost` that `McpServer` binds. The composite is the grant
gate — it filters `tools/list` by the caller's scope, refuses an out-of-scope call, and
refuses a duplicate tool name at boot. Roadmap and gym are registered today. Tending is wired to
roadmap's host **directly**, never the composite, so a prompt-injection-exposed agent cannot
reach another product's tools.

`db/schema.sql` is one file for every product, applied in order and idempotent
(`create … if not exists`), so the deploy re-applies it every time.

## Build and test

```sh
cmake -S . -B build                             # RelWithDebInfo by default (see CMakeLists.txt:7)
cmake --build build -j8
ctest --test-dir build --output-on-failure      # three binaries: domain · mcp · adapters
```

Drogon and libpqxx are the two vendor dependencies (`brew install drogon libpqxx`).
Without them CMake still builds the core libraries and the domain tests and *skips the
server* — read the configure status line rather than assuming. Never build `-O0`: an
un-inlined call chain overflows Drogon's worker-thread stack and corrupts return values
with no crash, which is why the default build type is forced.

Every test file is named by hand in one of three `add_executable` lists in
`CMakeLists.txt`. A new test file that is not in a list is a test that never runs.

`RUNNING.md` is the local walkthrough (deps, database, run, exercise). `deploy/README.md`
is the production runbook. `SPEC.md` is the founding design document, superseded in
places — check its banner before building from it.

## A green local build is not a green CI

macOS/Homebrew and the CI's Linux image disagree on two things that each compile green on
one side and fail on the other:

- **libpqxx** names a result row `pqxx::row_ref` on macOS and `pqxx::row` on Linux. Read
  rows through `pqxx::result`, or take the row as a template parameter — never bind a
  `pqxx::row` (`PgTreeRepository.cpp:179`, `PgTendRunRepository.cpp:129`).
- **jsoncpp** writes a non-finite double as a token no parser reads back, and older builds
  throw on it instead, so the two toolchains can disagree on the same value
  (`ToolArgs.cpp:69` names such a value rather than rendering it).

So: watch `gh run list` after every backend push. And a push is not a deploy — CI builds
and publishes the image (`.github/workflows/backend.yml`); the VPS deploy
(`.github/workflows/deploy.yml`) is manual.
