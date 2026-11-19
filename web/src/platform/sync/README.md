# Browser sync engine

`BrowserSyncEngine.open()` opens IndexedDB and returns stable local snapshots without a network
request. `start()` installs tab coordination and lifecycle hooks, releases holds on the first tab,
requests persistent storage and starts synchronization. Products and UI reach the engine through `session.js`;
from this module they import only `ReplicaChanged`.

The registry composes the shared gym, journal and roadmap registries at version 13, minimum 11. The deterministic
core and replica rules import `packages/api-contract/sync/reference/core` and `client` directly.
The shared modules use `TextEncoder`, canonical base64url and vendored synchronous SHA-256, with no
dependencies. `core/encoding.js` exposes the shared encoding helpers to web consumers;
`core/content.js` holds the web content clock. IndexedDB, transport, leadership, session, telemetry
and React bindings stay here. Reference server models and test oracles stay outside the shipping
dependency graph.

```js
const engine = await BrowserSyncEngine.open({ appVersion, telemetry, credentials });
const records = engine.observe('self/gym');
// React: useSyncExternalStore(records.subscribe, records.getSnapshot).
await engine.start();
records.release(); // when the holder leaves the scope
```

`commit` accepts either changes/options or the reference's synchronous read-and-commit callback.
Its Promise resolves after the IndexedDB transaction commits; publication failures report separately and do not reject a durable save. The callback runs inside the
transaction and must not return a Promise; its views carry `drawn`, `stored`, `now`, `replica`, the
product's `devices` rows and the scope's `firstPullComplete`. A rejection is one of §7.1's three failures, a
`CommitError` of kind `not-writable`, `malformed` or `store`, or the callback's own throw, passed
through unchanged. `newGestureId()` mints the id a caller passes as `opts.gestureId` when it must know it
before the commit; the domain kit's runner (`src/platform/domain-kit/runner.js`) does.

`observe(scope)` answers a hold on the scope's observation, with `getSnapshot`, `subscribe` and `release`.
Every hold of a scope reads one observation; every publication refreshes it while any hold is unreleased,
and the last `release()` drops it, so a later `observe` folds the scope afresh from the published replica. A
released hold calls no listener again; `release` is idempotent, and a hold never released lasts the document. The
snapshot carries:

- `drawn` and `stored`: the scope's records, retaining confirmed `seq`, `rc` and `ru` envelope metadata;
- `pending`: the drawn records some queued outbox entry (held, ready, sent or acked) still changes, each
  the same object as in `drawn`, so `new Set(snapshot.pending).has(record)` asks it of a drawn record; a
  record leaves it once no queued entry changes it (the pull that covers its entries settled them, or they
  were undone, refused or discarded);
- `outbox`: `{held, ready, sent, acked}`, the counts of the queued entries that belong to the scope or draw
  in it;
- `loaded`: whether the device's stored rows of the scope are in the snapshot. Every publication reads every
  scope (below), so an engine snapshot is always loaded; only `useSyncRecords`' placeholder before the engine
  opens is not;
- `notices`, `undoOffers` (the scope's held gestures, each with its `id`, `releaseAt` and the records it
  changes) and `firstPullComplete`.

`observeNotices(product)` answers a hold of the same kind on one product's notices in every scope (engine.md §7.6):
its snapshot is `{replica, notices}`, each notice whole and none dismissed, a scope known gone's among them. The
engine publishes it again only when the product's notices change. `dismissNotice(id)` hides a notice (engine.md
D-17) and resolves to true; one the active replica does not hold is left alone, and its dismissal resolves to false
and reports nothing.

`observeEngine` and `getSnapshot` expose replica/auth/upgrade state and `connection`: `offline` while the
browser reports no network, `unreachable` after a request to the server got no answer or a 5xx answer
and before one answers again, else `online`. The tab that makes a request tells the other tabs whether it
was answered. `onEvent` delivers active replica changes after durable commits and persisted-page
suspension, restoration and restore failure.
`activeBinding()` answers an opaque string that a sign-in or a sign-out changes, the sign-in that binds the anon
replica in place included, and a re-identify does not (engine.md §7.12). `commitAct(prepare, segment, {binding})` commits
an act only while the binding its caller planned it under stands: otherwise it throws `ReplicaChanged` in the write
transaction, before its prepare callback runs, writes nothing and reports nothing (engine.md §7.1 Ordered local acts).
A pull's answer and its pages land the same way, only under the binding the pull was sent under, and a live frame only
under the binding its socket opened under: a change of binding, another tab's included, closes the socket. One that a
sign-in, a sign-out or a re-identify overtook applies nothing, pauses nothing and leaves the puller's backoff as it was
(engine.md §7.12).
`commitAct(segments, {undo})` journals an act opted into Undo after its hold (engine.md §7.3 Undo of an act);
`requestInverse(actId, slots?)` asks for its inverse in one transaction and answers an `InverseResult`,
`readInverseResult(requestId)` reads it from the published replica, and `releaseReversibleAct(actId)` drops a
journal record the product's stack no longer needs. The journal, inverse requests and cancellation receipts
are control records of the replica's store, beside its outbox. The first tab's engine start releases every
act no unsettled request reads, and reports how many requests are `waiting` and the oldest one's age; each
request that settles reports its applied and skipped counts.
Persisted restores reopen IndexedDB and coordination with the same observations and listeners;
the shell refreshes account state after restoration. Views and transport are injectable and product-neutral.

HTTP goes to the `base` origin the engine's owner passes (same-origin when none) and uses the session
cookie; anonymous pulls explicitly omit credentials. The `credentials` port
belongs to the session owner: `clear(account)` removes the credential after a completed sign-out or a cancelled
sign-in, and answers `true` when the browser then holds none. The anon replica, which a live socket carrying a cookie
can have paused, comes out of a finished sign-out unpaused, and a `clear` that answers `true` unpauses it again
(engine.md §9.1).
The engine stores no tokens. The shell owns the cookie session and pinned account decisions. Finished sign-out durably records cookie cleanup until the credentials port succeeds. Sign-in uses a fresh
hello and pins Add/Discard decisions. Same-account refreshes preserve held work until its deadline
or a lifecycle transition. `beginSignOut`, `finishSignOut` and `cancelSignOut` expose the
bounded flush and Keep/Discard session. `cancelSignOut()` resolves after the shared pause is durably
released. Before the sender numbers a push it asks a fresh hello and sends only when the account, schema floor and device still match; otherwise it backs off. The leader flushes; every numbering transaction checks the shared session, and a Web Lock
identifies its live owner. Cancel, finish and owner death release the pause. Pending product device
work uses `pendingDeviceWork`.
The shell passes `deviceCleanup: true` to `finishSignOut` when product residue must be erased. A completed
transition records the departing account and transition generation in `device.meta.deviceCleanup` in the
same transaction. The optional synchronous `beforeSignOutCommit` callback runs after the pure lifecycle
accepts completion on an isolated transaction device, before persistence or publication. It is a commit-attempt
boundary for fencing document data; counted mismatches and earlier failures never invoke it. A throwing or
asynchronous callback aborts the transaction. A later persistence failure does not reverse the caller's fence.
The callback cannot await or call the engine again. The shell clears that exact marker after product cleanup succeeds and replays it after reload.

Each store mutation uses one strict-durability IndexedDB transaction. Indexed reads precede the
synchronous read-and-commit callback inside that same transaction; it cannot await. Writes hydrate
only their requested scopes or row keys and the governing record type. Control records, outboxes
and durable device work are separate from cached rows. Replica handles stay fixed across wire-ID
changes. Each cache has a generation pointer; completed boots transfer the staging pointer, and
forget/sign-out invalidate pointers atomically. Old generations are deleted in batches of 128.

A store keeps the control records it last committed or read, as JSON text, and uses them while the
head record's revision is unchanged; any other tab's write moves the revision and the next transaction
reads them again. It keeps each cache generation's rows it has read, frozen, while the generation's
version is unchanged, and reads a whole generation along the `[generation, id]` primary key, so
`open` takes the `IDBKeyRange` of the same IndexedDB implementation (`keyRange`, the global by
default). A write edits one working copy of each control record, kept while the record's text is
unchanged, so it parses only the records that changed since the last write; a record a write
changes, a value a caller handed in and an aborted write's edits never reach the next write. It
shares the rows and compares only rows whose identity changed; a read shares frozen values, so
unchanged state keeps its identity from one publication to the next. A row is a value: a change
replaces it and never edits it. The push request a write numbers leaves it as a copy.

IndexedDB store versions are independent of the wire registry version:

| Store version | Layout | Release evidence |
|---|---|---|
| 1 | Control and cache rows together in `records` | Legacy upgrade input; its shipping date is not recorded in the retained Git history. |
| 2 | Control records plus generation-indexed `rows` | The browser sync release, `082e971d`, dated 2026-10-05; the earliest retained implementation, `76b82e9c` on 2026-10-04, already opens version 2. |
| 3 | Version 2's layout, holding Undo of an act's `journal`, `inverse` and `cancellation` control records | Introduced with Undo of an act (engine.md §7.3, K-3). |

Version 3 changes no object store. It shuts out every bundle older than Undo of an act, whose writes
would drop the journal's control records and number its waiting inverse slots unbound: such a tab
closes at the upgrade's `versionchange`, and such a bundle's later open fails with `VersionError`. A
version-two database upgrades with every record unchanged. A version-one database upgrades in one atomic
IndexedDB version-change transaction. Every replica's
confirmed, spent and staged rows move to their cache generations; controls, outboxes, notices and device
work survive unchanged. An aborted upgrade closes its connection and retains the complete version-one
store for retry. A blocked open rejects and abandons its request: a later upgrade aborts before migration,
and a late successful connection closes. Open stores close on `versionchange`. Native Chromium
regressions verify every row after upgrade, abort, blocked-open retry and reopen, and exercise real
version changes. Fixture reads wait for transaction completion before closing their connections.

Every publication, at open, after each write and whenever another tab's write moves the store, reads every
scope the active replica holds rows of. So a view or a kit read of any scope, held or not, answers the device's
rows, a scope another tab brought to the device after this tab opened included (engine.md §7.8). The store keeps
the rows of each generation it has read, and this tab's writes update them in place, so a publication reads rows
from IndexedDB only for a generation it does not hold whole, such as one another tab's write changed.
An observation (`observation.js`) keeps its scope's records between publications and folds again only
the records whose confirmed row changed identity or whose queued entries changed; a record no held
entry touches is one frozen object in both `drawn` and `stored`.
The default beacon adapter maps spec event labels to the intake's snake_case names.
Writer telemetry measures transaction enqueue to durable completion, with bounded numeric timings,
for the first ten writes of each minute that change the store, under an allowance failures and step
events never share.
The 25 ms writer slice is a latency target, not a hardware-independent correctness assertion.
Push results use separate transactions. A pull response applies in chunks sized by how long the last
one held the writer, from 64 rows and never fewer, aiming at half of the 25 ms writer slice; one chunk may
carry several of the response's pages, each checked in the chunk that applies it. Settling slices take
64 entries.
Web Locks serialize sender ownership and first-tab registration; BroadcastChannel delivers
invalidations, opened scopes, upgrade stops and replica changes. The leader reconciles durable control
state and outbox every second and on refresh; notifications are hints. Server retry floors survive
leader handoff. Auth generations and build/schema upgrade stops are durable; every HTTP request
checks the stop before using the network. CI uses `VITE_RELEASE` as the build identity. Live queues
bound active plus pending work to 64 frames and 1 MiB; overflow closes the socket and recovers through
pulls. A hidden leader yields to a visible peer. Unsupported coordination fails explicitly.

`npm run test:sync` claims all 63 client/all corpus files (1204 vectors/transcript steps) and runs the
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

`react.js` exports `useSyncEngine()` (the open bound engine, or null during boot/sign-out),
`useSyncRecords(scope)` (the scope's snapshot through `useSyncExternalStore`, holding the scope for the
document) and `useSyncNotices(product)` (the product's notices the same way). Records can observe the anonymous replica; only the session owner opens
and starts the engine. Each product's route table carries a `sync` group — `prepare(engine)`,
`onPushResult`, `pendingDeviceWork`, `adoptDeviceRows`, `liveHint(engine, replica)`, `signedOutWork` — the record type a
sign-in question counts, with the product's own words for it (`counted(n)`, `many`) —, `adoptionAnswer(engine, due)` and
`adoptionCount(engine)` for a sign-in decision, and `signInWords(engine, due)` and `signOutWords(engine, question)` for a
question the product words itself — and the session owner composes every group into the engine options;
`prepare` runs before the first network request.

`pendingDeviceWork(product, rows)` identifies durable work for both sign-in and sign-out decisions.
Sign-in adopts that work even without outbox entries, exposes its count as `due.pending`, and pins
each row's full bytes with its key so a stale Add or Discard is asked again.
`adoptDeviceRows(product, incomingRows, keptRows)` returns the merged product rows, or `undefined`
when unhandled. A differing pending-work collision without a merge fails the transaction and keeps
both replicas intact; ordinary device settings retain the destination value on a shared key.

Command predictions may include local deaths and serial values; only the command arguments go on
the wire.
## Server freshness

`freshness(scope)` returns `{syncLive,serverNow}`. It requires a live socket following that scope,
a completed pull, a clock sample from this boot without a later clock jump, and no auth or seat
transition. Disconnected or unsampled clocks return null time. The same value is available inside
transaction `readMetadata`, whose confirmed records carry both `rc` and server update time `ru`.
Consumers recheck freshness inside the commit that depends on server age.
