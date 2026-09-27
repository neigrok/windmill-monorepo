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
| `Sync/Sources/SyncEngine/` | The runtime. `SyncEngine` is what products commit and read through (it conforms to the `Replica` port); it runs engine start, releases holds on its timer, and sends through the `Sender` (§7.4), one push in flight, over the `SyncTransport` port, whose `HTTPTransport` speaks §9 over `URLSession`. UI modules observe `RecordsView`, `NoticesView`, `UndoOffers` and `SyncStatus`, refreshed from SQLite in commit order. Clocks, randomness, the session token, the fork guard's copy, connectivity and product bindings are ports. The puller, the live channel and sign-in are not built yet. |
| `Sync/Sources/SyncTesting/` | Test support: the golden-corpus reader, the client-step language that drives a device through the corpus, the seeded generator for property tests, doubles of the engine's ports (`SimClock`, a seeded random source, in-memory token and fork-guard stores, a connectivity switch, `CommitFaults` to fail the next commit) and `ScriptedTransport`. |
| `Sync/Tests/SyncCoreTests/` | Unit and property tests, one file per `SyncCore` file they test, and the layering check over every target. |
| `Sync/Tests/SyncReplicaTests/` | Planner properties: coalescing never changes what is drawn, Undo restores, a commit over its read set decides as one over every row, and partial loads trap on rows they did not load. |
| `Sync/Tests/SyncStoreTests/` | The whole client corpus through SQLite, schema constraints, the ref-index property, and kill-at-every-step crash tests. |
| `Sync/Tests/SyncEngineTests/` | The engine over an in-memory store and scripted doubles, its loops in step mode: commits and their contract, holds, Undo and retire on the release timer, the readers, observation order, every push outcome of the sender, and `HTTPTransport` against a stubbed URL loader. |
| `Sync/Tests/SyncConformanceTests/` | The corpus runner: one test case per vector, one handler per corpus file. |

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
case, recorded as a known issue, so the run lists it by name. A vector listed in `Corpus.defects`
breaks a rule of engine.md and runs as a known issue naming the rule. A corpus file the role table in
`SyncTesting/Corpus.swift` does not classify fails the run. The client-step files also run through
the SQLite store, in `SyncStoreTests`.

**Property tests** draw a fresh seed on every run and name it in any failure. Replay one with
`SYNC_SEED=<seed> swift test --filter <test>`.

[CI](../../.github/workflows/ios.yml) runs `swift test` on macOS and builds the package for the iOS
simulator.
