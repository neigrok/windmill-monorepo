# Roadmap scale measurements

These opt-in harnesses measure the size cases in
[roadmap-on-the-engine.md §10](../../../../docs/foundation/roadmap-on-the-engine.md).
They use the synthetic probe registry. They do not register roadmap or ship probe in a production app.

`fixtures.mjs` is the common input definition for every surface. Generate it into a private scratch directory:

```sh
node packages/api-contract/sync/benchmarks/fixtures.mjs /tmp/windmill-scale/fixtures
```

The three inputs are a tree with 10,000 tags and 20,000 links, 500 boards with one child tree each, and
a signed-out copy with the same 30,000 tree records represented by 10,001 pending entries. The pending
queue includes the governing board create; a tag and two links share each remaining entry. The manifest
records the expected counts. Fixtures and generated reports stay outside the repository.

Each client measures initial pull, reopening the disk copy, the first drawn read, one tag update, and
sign-in API completion. Reopen uses a new engine over the same database in the same process; operating
system pages may remain warm. These are engine measurements without screen rendering. The pending
case signs in to an empty account, then pulls the product scope while its governing create and tree
records remain queued. That first pull measures adoption's empty-account synchronization, not upload
of the 10,001-entry queue. Assertions preserve the records and queue through that pull.

Run one harness at a time. Apply a process-group timeout to every command; use a private build/cache
directory and at most two build workers. Record `git rev-parse HEAD`, tool versions, build mode and host
with the report. Measurements are evidence, not CI wall-time assertions.

## Browser

Install the web workspace's existing dependencies and its Playwright Chromium browser, then run:

```sh
node packages/api-contract/sync/benchmarks/browser.mjs \
  --fixtures /tmp/windmill-scale/fixtures --output /tmp/windmill-scale/browser.json --port 5347
```

The runner serves an isolated Vite page, uses Chromium's real IndexedDB, and sends HTTP requests to
the JavaScript model server. Timers are disabled so explicit engine pull rounds cannot race a sender.
`--scenario large|many|pending` selects one case. Each case has a fresh browser profile and database.
`--storage disk`, the default, keeps that profile in a temporary directory, so IndexedDB writes to
disk as a person's browser does. `--storage memory` uses an ephemeral context instead, whose in-memory
IndexedDB costs more per row as the database grows. `--profile DIRECTORY` writes one V8 CPU profile per
measured phase, `<scenario>-<phase>.cpuprofile`, which DevTools opens; profiled timings include the
sampler's overhead. The report includes the source commit, dirty-tree flag, storage, browser/host
versions, client timings, every write transaction's writer hold by phase (`transactions`: from its
first request to its durable completion, queue excluded), the writer telemetry the engine delivered
(`writer`, at most 100 events a minute), and individual model-server request times. The server,
browser and profile directory close on completion or failure.

## Browser budgets

The browser engine's budgets at roadmap's size, which the engine meets before roadmap's registry is
pinned ([roadmap-on-the-engine.md §10](../../../../docs/foundation/roadmap-on-the-engine.md), "Size").
The reference machine is an Apple M3 Pro Mac running the harness's Chromium (HeadlessChrome 145)
with `--storage disk`. A figure is the median of three runs on an otherwise quiet machine; the
model server's time in the report is the load check. Every write transaction other than a commit
holds the writer at most `WRITER_SLICE_MS` (25 ms, [engine.md §2.5](../../../../docs/foundation/engine.md)),
as `transactions` reports it; adopting a signed-out queue at sign-in is one §7.10 transaction and the
exception.

| Case | Phase | Budget | a4670ed74 |
|---|---|---|---|
| large | one gesture | 50 ms | 22.8 ms |
| large | open and first read | 250 ms | 202 ms |
| large | sign-in (returning) | 50 ms | 10.5 ms |
| large | first pull | 2.5 s | 2.20 s |
| many | one gesture | 25 ms | 9.5 ms |
| many | open and first read | 50 ms | 39.5 ms |
| many | sign-in (returning) | 50 ms | 15.9 ms |
| many | first pull | 1 s | 369 ms |
| pending | one gesture | 100 ms | 37.1 ms |
| pending | open and first read | 250 ms | 203 ms |
| pending | sign-in (adoption of 10,002 entries) | 1 s | 503 ms |
| pending | first pull | 250 ms | 54.5 ms |

At a4670ed74 the largest writer hold of a transaction other than a commit was 25.7 ms in the large
first pull (one chunk of 473 over the three runs; each run's p99 at most 18.7 ms), 12.6 ms in the
many first pull and 21.4 ms in the pending case, whose adoption held the writer 412–461 ms.

## Swift

From `apps/ios/Sync`, with the installed Xcode selected:

```sh
SYNC_BENCH=1 SYNC_ROADMAP_SCALE_FIXTURES=/tmp/windmill-scale/fixtures \
SYNC_BENCH_REPORT=/tmp/windmill-scale/swift.jsonl SYNC_BENCH_SOURCE_HEAD="$(git rev-parse HEAD)" \
xcrun swift test -c release -Xswiftc -enable-testing --disable-sandbox \
  --scratch-path /tmp/windmill-scale/swift --jobs 2 \
  --explicit-target-dependency-import-check error --filter RoadmapScale
```

This uses the real SQLite store in WAL/FULL mode and `SyncEngine` step mode, with an in-process model
server on system clocks. No sender drains the queue. The report has separate open/read measurements.
`pendingAdoptionPlan` also measures the pure lifecycle plan over the common queue, with exact adopted
entry and batch-write assertions; database persistence is excluded from that separate diagnostic.

## Android kernel

From `apps/android`, with the configured JDK and Android SDK available:

```sh
SYNC_ROADMAP_SCALE_FIXTURES=/tmp/windmill-scale/fixtures \
SYNC_BENCH_REPORT=/tmp/windmill-scale/kotlin.jsonl SYNC_BENCH_SOURCE_HEAD="$(git rev-parse HEAD)" \
./gradlew --no-daemon --max-workers=2 --project-cache-dir /tmp/windmill-scale/gradle \
  :sync-engine:testDebugUnitTest --tests works.windmill.sync.engine.RoadmapScaleBenchmarks
```

The harness uses disk `AndroidSqlite` in WAL/FULL mode with Robolectric's NATIVE SQLite implementation
at SDK 35. It measures actual `SyncRuntime.signIn`, and steps the engine's pull request/application
paths against the Kotlin model server. It does not measure a physical Android device or ART. Returning
account sign-in completes before its asynchronous hello; the report distinguishes this from anonymous
adoption, which waits for hello. `SYNC_ROADMAP_SCALE_SCENARIO` selects one case.

## C++ server over Postgres

Configure a private optimized backend build (`Release` or `RelWithDebInfo`) and build the opt-in target
`windmill_sync_scale` with two workers. Apply `backend/db/schema.sql` and `backend/db/probe.sql` to an
isolated database whose name contains `_scale_`. The runner resets sync and probe data in that database.
It requires a separate URL and an explicit reset switch; it never uses the application's database URL.

```sh
WM_PG_TEST=1 WM_SCALE_ALLOW_RESET=1 WM_SCALE_DATABASE_URL=postgresql://localhost/wm_roadmap_scale_local \
SYNC_BENCH_SOURCE_HEAD="$(git rev-parse HEAD)" \
/tmp/windmill-scale/build/windmill_sync_scale /tmp/windmill-scale/fixtures /tmp/windmill-scale/cpp.jsonl
```

The server report times real `SyncService.hello`, paged `pull`, and `push` calls through Postgres.
Fixture loading is excluded. Large/many cases pull all seeded product/tree/overlay scopes and admit
one tag update. The pending case pulls the empty product, then admits its governing create and first
three-row tree intent. The remaining pending queue is not uploaded. HTTP/TLS, client reopen, client
read and client adoption are not server equivalents and are not included in those numbers.
