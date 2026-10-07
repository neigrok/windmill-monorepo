# Browser sync engine

`BrowserSyncEngine.open()` opens IndexedDB and returns stable local snapshots without a network
request. `start()` installs tab coordination and lifecycle hooks, releases holds on the first tab,
requests persistent storage and starts synchronization. No product or UI imports this engine.

The registry composes the shared gym and journal registries at version 5, minimum 4. The deterministic
core and replica rules are browser ports of `packages/api-contract/sync/reference`.
UTF-8 uses `TextEncoder`, canonical cursor encoding uses browser base64 APIs and synchronous SHA-256
uses `@noble/hashes`. Test oracles stay outside the shipping dependency graph.

```js
const engine = await BrowserSyncEngine.open({ appVersion, telemetry, credentials });
const records = engine.observe('self/gym');
// React: useSyncExternalStore(records.subscribe, records.getSnapshot).
await engine.start();
```

`commit` accepts either changes/options or the reference's synchronous read-and-commit callback.
Its Promise resolves after the IndexedDB transaction commits; publication failures report separately and do not reject a durable save. The callback runs inside the
transaction and must not return a Promise; its views carry `drawn`, `stored`, `now`, `replica`, the
product's `devices` rows and the scope's `firstPullComplete`. A rejection is one of §7.1's three failures, a
`CommitError` of kind `not-writable`, `malformed` or `store`, or the callback's own throw, passed
through unchanged. `newGestureId()` mints the id a caller passes as `opts.gestureId` when it must know it
before the commit; the domain kit's runner (`src/platform/domain-kit/runner.js`) does. `observe` exposes
drawn/stored records, notices, `undoOffers` (the scope's held gestures, each with its `id`, `releaseAt` and
the records it changes) and `firstPullComplete`, retaining confirmed `seq`, `rc` and `ru` envelope metadata. `observeEngine` exposes replica/auth/upgrade state; `onEvent` delivers active
replica changes after durable commits and persisted-page suspension, restoration and restore failure.
Persisted restores reopen IndexedDB and coordination with the same observations and listeners;
the shell refreshes account state after restoration. Views and transport are injectable and product-neutral.

HTTP goes to the `base` origin the engine's owner passes (same-origin when none) and uses the session
cookie; anonymous pulls explicitly omit credentials. The `credentials` port
belongs to the session owner: `clear(account)` removes the credential after a completed sign-out.
The engine stores no tokens. The shell owns the cookie session and pinned account decisions. Finished sign-out durably records cookie cleanup until the credentials port succeeds. Sign-in uses a fresh
hello and pins Add/Discard decisions. Same-account refreshes preserve held work until its deadline
or a lifecycle transition. `beginSignOut`, `finishSignOut` and `cancelSignOut` expose the
bounded flush and Keep/Discard session. `cancelSignOut()` resolves after the shared pause is durably
released. The leader flushes; every numbering transaction checks the shared session, and a Web Lock
identifies its live owner. Cancel, finish and owner death release the pause. Pending product device
work uses `pendingDeviceWork`.

Each store mutation uses one strict-durability IndexedDB transaction. Indexed reads precede the
synchronous read-and-commit callback inside that same transaction; it cannot await. Writes hydrate
only their requested scopes or row keys and the governing record type. Control records, outboxes
and durable device work are separate from cached rows. Replica handles stay fixed across wire-ID
changes. Each cache has a generation pointer; completed boots transfer the staging pointer, and
forget/sign-out invalidate pointers atomically. Old generations are deleted in batches of 128.

IndexedDB store versions are independent of the wire registry version:

| Store version | Layout | Release evidence |
|---|---|---|
| 1 | Control and cache rows together in `records` | Legacy upgrade input; its shipping date is not recorded in the retained Git history. |
| 2 | Control records plus generation-indexed `rows` | The browser sync release, `082e971d`, dated 2026-10-05; the earliest retained implementation, `76b82e9c` on 2026-10-04, already opens version 2. |

A version-one database upgrades in one atomic IndexedDB version-change transaction. Every replica's
confirmed, spent and staged rows move to their cache generations; controls, outboxes, notices and device
work survive unchanged. An aborted upgrade closes its connection and retains the complete version-one
store for retry. A blocked open rejects and abandons its request: a later upgrade aborts before migration,
and a late successful connection closes. Open stores close on `versionchange`. Native Chromium
regressions verify every row after upgrade, abort, blocked-open retry and reopen, and exercise real
version changes. Fixture reads wait for transaction completion before closing their connections.

Offline open hydrates the active replica's cache once. Subsequent observation reads hydrate observed
scopes; unobserved cache generations are invalidated, and a later observation reloads them locally.
The default beacon adapter maps spec event labels to the intake's snake_case names.
Writer telemetry measures transaction enqueue to durable completion, with bounded numeric timings.
The 25 ms writer slice is a latency target, not a hardware-independent correctness assertion.
Push results use separate transactions; pull pages use 64-row chunks and 64-entry settling slices.
Web Locks serialize sender ownership and first-tab registration; BroadcastChannel delivers
invalidations, opened scopes, upgrade stops and replica changes. The leader reconciles durable control
state and outbox every second and on refresh; notifications are hints. Server retry floors survive
leader handoff. Auth generations and build/schema upgrade stops are durable; every HTTP request
checks the stop before using the network. CI uses `VITE_RELEASE` as the build identity. Live queues
bound active plus pending work to 64 frames and 1 MiB; overflow closes the socket and recovers through
pulls. A hidden leader yields to a visible peer. Unsupported coordination fails explicitly.

`npm run test:sync` claims all 52 client/all corpus files (847 vectors/transcript steps) and runs the
persisted runtime, fake IndexedDB and real Chromium tests. Playwright is dev-only. Test/build scripts
install Chromium automatically; Linux CI also installs its system dependencies. No browser test is
skipped when Chromium is unavailable. `npm run test:sync:fuzz` runs 500×300 core replay, 20×80 random
persisted replay and a 20-seed persisted fault campaign. Every campaign seed exercises the 34-event
§11.3 fault inventory, with active-event, principal-isolation, restart, guard, terminal death,
convergence, counters/caps, digest, existence and outbox checks.

`npm run test:sync:server -- /absolute/backend/build` runs an isolated port-8090 server, creates a
unique database, applies `schema.sql`, mints a local session, and replays gym/journal writes with a
lost push reply. It requires `windmill_server` and Postgres client tools from `backend/RUNNING.md`
(set `PGHOST` outside macOS). It stops its listener by port and drops its database. The repository's nightly workflow is outside web
territory; scheduling this script there remains an integration task. `npm run build` also bundles
the browser engine separately and rejects Node builtins. The app shell caches the built room assets for offline reload; product adapters own their projections and migration.

`react.js` exports `useSyncEngine()` (the open bound engine, or null during boot/sign-out) and
`useSyncRecords(scope)` (stable drawn/stored records, notices and first-pull state through
`useSyncExternalStore`). Records can observe the anonymous replica; only the session owner opens
and starts the engine. Each product's route table carries a `sync` group — `prepare(engine)`,
`onPushResult`, `pendingDeviceWork`, `liveHint(engine, replica)` and `signedOutWork`, the record type a
sign-in question counts — and the session owner composes every group into the engine options;
`prepare` runs before the first network request.

Command predictions may include local deaths and serial values; only the command arguments go on
the wire.
