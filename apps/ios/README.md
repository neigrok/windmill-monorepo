# Windmill iOS

`apps/ios` holds one SwiftPM package, `WindmillSync` in `Sync/`: the client of the sync engine
([engine.md](../../docs/foundation/engine.md)). There is no iOS app target.

## Layout

| Path | Responsibility |
|---|---|
| `Sync/Sources/SyncCore/` | Pure primitives every role shares: JSON and its JCS bytes, stamps and the HLC, lattice joins, the registry, id making, fractional keys, the scope digest, constants, and the wire (§9): ids and scope references, rows, deltas, intents, cursors, and the push, pull and live messages. It imports CryptoKit in its digest file and nothing else. |
| `Sync/Sources/SyncAPI/` | What a product domain or the domain kit names: the values (`Change`, `Gesture`, `CommitOutcome`, `Record`, `Notice`, …) and the `Replica` port with its readers. It imports only `SyncCore`. |
| `Sync/Sources/SyncReplica/` | The client algorithms (§7, §8) as pure planners. An Action loads a working copy (`LoadedReplica`, `LoadedDevice`), a planner changes it, and every change is a recorded write, so the copy's writes are the whole batch the store commits. No SQLite, networking or UI. |
| `Sync/Sources/SyncStore/` | The local store (§2.5): SQLite through GRDB, WAL with `synchronous=FULL`. `StoreTransaction` loads only the rows a planner's read set names; `BatchWriter` applies a batch and keeps the ref index in step; `Transactions.swift` holds one Action per transaction, each one load → plan → batch. The only target that imports GRDB. |
| `Sync/Sources/SyncEngine/` | The runtime. `SyncEngine` is what products commit and read through (it conforms to the `Replica` port); it runs engine start and the hello, releases holds on its timer, sends through the `Sender` (§7.4), pulls through the `Puller` (§7.5: boot, staging, reset, epoch change, the digest check, live frames), and follows the subscribed scopes on the `LiveChannel` (§9.5: follow, heartbeat, reconnect). Each worker is one loop over a step function, single-flight, over the `SyncTransport` port, whose `HTTPTransport` speaks §9 over `URLSession`, the live socket over `URLSessionWebSocketTask`. UI modules observe `RecordsView`, `NoticesView`, `UndoOffers` and `SyncStatus`, refreshed from SQLite in commit order. Clocks, randomness, the session token, the fork guard's copy, connectivity and product bindings are ports. `Lifecycle.swift` holds engine start with the fork guard, and the replica lifecycle the app drives (§7.10): `signIn` answers a `SignInSession` holding the signed-out decisions due, which the app answers and `complete`s (an answer counts only for the work it was shown), and `resumeSignIn` picks up a sign-in left pending; `signOut` flushes for at most `SIGNOUT_FLUSH_MS`, holds the replica from the sender, and answers a `SignOutSession` counting what is unsent, which the app `finish`es once with Keep or Discard (Discard deletes only the entries it counted) or `cancel`s; `dormantReplicas` and `discardDormant` cover what Keep left behind. |
| `Sync/Sources/SyncModelServer/` | The server half of the engine over in-memory tables, from the spec: hello, push with §6.1 admission, faults and poison, server-origin calls, pull, the live channel, text merge, epoch and restore. One value is one server process, whose `physNow()` never steps back (§10.2). Product rules plug in through `ServerRules`; `ProbeServerRules` binds the corpus's probe product. It imports only `SyncCore`. |
| `Sync/Sources/SyncTesting/` | Test support: the golden-corpus reader, the client-step language that drives a device through the corpus, the transcript runner that drives real engines through `protocol/*.jsonl`, the seeded generator for property tests, doubles of the engine's ports (`SimClock`, a seeded random source, in-memory token and fork-guard stores, a connectivity switch, `CommitFaults` to fail the next commit), and the wire doubles: `ScriptedTransport`, `TranscriptTransport`, `FakeLiveConnection`, and `SimNetwork`, which routes engines to one in-memory `SyncModelServer`. |
| `Sync/Tests/SyncCoreTests/` | Unit and property tests, one file per `SyncCore` file they test, and the layering check over every target. |
| `Sync/Tests/SyncAPITests/` | The product-facing values: each is equal only when its identifiers and texts are, byte for byte. |
| `Sync/Tests/SyncReplicaTests/` | Planner properties: Undo restores, a commit over its read set decides as one over every row, partial loads trap on rows they did not load, and clock-skew recovery terminates against `SyncModelServer` (engine §11.2 property 8). |
| `Sync/Tests/SyncStoreTests/` | The whole client corpus through SQLite, schema constraints, the ref-index property, and kill-at-every-step crash tests. |
| `Sync/Tests/SyncEngineTests/` | The engine over an in-memory store and scripted doubles, its loops in step mode: commits and their contract, holds, Undo and retire on the release timer, the readers, observation order, every push outcome of the sender, every pull outcome of the puller with live frame admission, the live channel's socket, heartbeat and reconnects, two devices over one `SimNetwork` stepped and with their loops running, the replica lifecycle (every §8.2 row, the lineage vectors through the engine, two devices meeting at a sign-in, and a kill at every step of sign-in, sign-out and the fork guard), `HTTPTransport` against a stubbed URL loader, and its live socket against WebSocket and refusing servers on the loopback. |
| `Sync/Tests/SyncModelServerTests/` | Model-server properties the corpus pins only by example: admission's digest, counters and rollback, paging and live frames end to end, text merge, the push and pull envelopes over the body as received, push and call bookkeeping, and the clock. |
| `Sync/Tests/SyncConformanceTests/` | The corpus runner: one test case per vector, one handler per corpus file. Each `protocol/*.jsonl` transcript runs its client half through real engines and its server half through `SyncModelServer`. |

The package is written in the Swift 6 language mode with strict concurrency, for iOS 18 and macOS 15.
`SyncCore` and `SyncAPI`, which other packages compile against, enable `MemberImportVisibility` and
follow the domain kit's source rules: no import attributes, no access-modified imports, no `#if`.

## Build and test

Everything runs on a Mac without a simulator. `swift test` needs Xcode's toolchain, because the
Command Line Tools ship no Swift Testing. Every build runs the explicit import check, so a module
imports only what its target declares:

```sh
cd apps/ios/Sync
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --explicit-target-dependency-import-check error
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild build -scheme WindmillSync-Package -destination 'generic/platform=iOS Simulator'
```

Keep the full monorepo: the corpus runner finds `packages/api-contract/sync/corpus/` by walking up from
its own file. `WINDMILL_SYNC_CORPUS=<path>` points it elsewhere.

**Corpus.** Each vector of a corpus file with a handler in `SyncConformanceTests/Handlers.swift` is one
test case, compared with its `expect` by JCS bytes. Each corpus file without a handler is one `pending`
case, recorded as a known issue, so the run lists it by name. A corpus file the role table in
`SyncTesting/Corpus.swift` does not classify fails the run. The client-step files also run through
the SQLite store, in `SyncStoreTests`.

**Property tests** draw a fresh seed on every run and name it in any failure. Replay one with
`SYNC_SEED=<seed> swift test --filter <test>`.

[CI](../../.github/workflows/ios.yml) runs `swift test` on macOS and builds the package for the iOS
simulator.
