# Windmill iOS

`apps/ios` holds the SwiftPM package `WindmillSync` in `Sync/`, the client of the sync engine
([engine.md](../../docs/foundation/engine.md)); `WindmillDomain` in `Domain/`, the domain kit every feature's
logic is declared on ([domain-kit.md](../../docs/foundation/domain-kit.md)); and `SyncTestingSurface/`, a package of
tests only, which proves from outside `WindmillSync` that its test harness is enough for the domain kit. The one
product domains so far are gym Notes and Bodyweight (`Domain/Sources/GymDomain`); the `domain-feature` skill
(`.claude/skills/domain-feature/`) teaches building the next one from it. The one app is `SyncProbe/`, the engine's dev
and test host over the probe product, which never ships; there is no product app target yet.

## Layout

| Path | Responsibility |
|---|---|
| `Sync/Sources/SyncCore/` | Pure primitives every role shares: JSON and its JCS bytes, stamps and the HLC, lattice joins, the registry, id making, fractional keys, the scope digest, constants, and the wire (§9): ids and scope references, rows, deltas, intents, cursors, and the push, pull and live messages. It imports CryptoKit in its digest file and nothing else. |
| `Sync/Sources/SyncAPI/` | What a product domain or the domain kit names: the values (`Change`, `Gesture`, `CommitOutcome`, `Record`, `Notice`, …) and the `Replica` port with its readers. It imports only `SyncCore`. |
| `Sync/Sources/SyncReplica/` | The client algorithms (§7, §8) as pure planners. An Action loads a working copy (`LoadedReplica`, `LoadedDevice`), a planner changes it, and every change is a recorded write, so the copy's writes are the whole batch the store commits. No SQLite, networking or UI. |
| `Sync/Sources/SyncStore/` | The local store (§2.5): SQLite through GRDB, WAL with `synchronous=FULL`. `StoreTransaction` loads only the rows a planner's read set names; `BatchWriter` applies a batch and keeps the ref index in step; `Transactions.swift` holds one Action per transaction, each one load → plan → batch. The only target that imports GRDB. |
| `Sync/Sources/SyncEngine/` | The runtime. `SyncEngine` is what products commit and read through (it conforms to the `Replica` port); it runs engine start and the hello, releases holds on its timer, sends through the `Sender` (§7.4), pulls through the `Puller` (§7.5: boot, staging, reset, epoch change, the digest check, live frames), and follows the subscribed scopes on the `LiveChannel` (§9.5: follow, heartbeat, reconnect). Each worker is one loop over a step function, single-flight, over the `SyncTransport` port, whose `HTTPTransport` speaks §9 over `URLSession`, the live socket over `URLSessionWebSocketTask`. UI modules observe `RecordsView`, `NoticesView`, `UndoOffers` and `SyncStatus`, refreshed from SQLite in commit order. Clocks, randomness, the session token, the fork guard's copy, connectivity and product bindings are ports. `Lifecycle.swift` holds engine start with the fork guard, and the replica lifecycle the app drives (§7.10): `signIn` answers a `SignInSession` holding the signed-out decisions due, which the app answers and `complete`s (an answer counts only for the work it was shown), and `resumeSignIn` picks up a sign-in left pending; `signOut` flushes for at most `SIGNOUT_FLUSH_MS`, holds the replica from the sender, and answers a `SignOutSession` counting what is unsent, which the app `finish`es once with Keep or Discard (Discard deletes only the entries it counted) or `cancel`s; `dormantReplicas` and `discardDormant` cover what Keep left behind. |
| `Sync/Sources/SyncIOS/` | The iOS adapters. `AppLifecycle` turns leaving the app (the last foreground scene going to the background) into `leave()` and a flush inside the background time `BackgroundActivity` borrows, handed back exactly once, and coming back into `foreground()`; `KeychainTokenStore` keeps each account's session token in the Keychain, readable after the first unlock and never leaving the device; `ProtectedStorage` holds the database in a directory protected until the first unlock, beside the fork guard's copy in a file excluded from backup. The Keychain and UIKit halves compile on iOS only. |
| `Sync/Sources/SyncModelServer/` | The server half of the engine over in-memory tables, from the spec: hello, push with §6.1 admission, faults and poison, server-origin calls, pull, the live channel, text merge, epoch and restore. One value is one server process, whose `physNow()` never steps back (§10.2). Product rules plug in through `ServerRules`, which a product with no rules of its own conforms to with an empty body; `ProbeServerRules` binds the corpus's probe product. It imports only `SyncCore`. |
| `Sync/Sources/SyncTesting/` | Test support. `SteppedEngine` is the step-mode harness the domain kit's `Harness` wraps (kit §14.2, ER-9): a real `SyncEngine` whose loops never start, over an in-memory store, on a `SimClock` and a seeded random source, into one model server its devices share; each public call runs the engine's step functions on the calling thread to their end (`sync()`, `advance(ms:)`, `leave()`, `device()`, `failNextCommit()`, and the reads of `drawn`, `stored`, notices and Undo offers). `ModelServerHandle` is that server process, with its sessions, whose revocation closes the sockets opened under them, and its scripted refusals; `SimNetwork` carries each device's calls to it, with the faults a simulation arms: requests dropped, delayed or served twice, replies lost, credentials lost on the way, answers a proxy makes, poisoned intents. `Simulator` is §11.3's replay simulator: phones on clocks of their own under a seeded schedule of gestures, holds, Undo, process death, sign-in and sign-out, revoked sessions and another account's session held as the phone's own, going offline, clock skew and jumps, epoch changes and restores, restored and cloned stores, with a check at every answer and frame served as anyone but the replica's account that nothing it pulled changed; then quiescence and the invariant checks, and §11.2 property 3. Beside them: the golden-corpus reader, the client-step language that drives a device through the corpus, the transcript runner that drives real engines through `protocol/*.jsonl`, the seeded generators for property tests and simulation gestures, doubles of the engine's ports (`SimClock`, a seeded random source, in-memory token and fork-guard stores, a connectivity switch, `CommitFaults` to fail the next commit, `Killer` to kill at a crash point), and the wire doubles `ScriptedTransport`, `TranscriptTransport` and `FakeLiveConnection`. |
| `Sync/Tests/SyncCoreTests/` | Unit and property tests, one file per `SyncCore` file they test, and the layering check over every target. |
| `Sync/Tests/SyncAPITests/` | The product-facing values: each is equal only when its identifiers and texts are, byte for byte. |
| `Sync/Tests/SyncReplicaTests/` | Planner properties: Undo restores, a commit over its read set decides as one over every row, partial loads trap on rows they did not load, and clock-skew recovery terminates against `SyncModelServer` (engine §11.2 property 8). |
| `Sync/Tests/SyncStoreTests/` | The whole client corpus through SQLite, schema constraints, the ref-index property, and kill-at-every-step crash tests. |
| `Sync/Tests/SyncEngineTests/` | The engine over an in-memory store and scripted doubles, its loops in step mode: commits and their contract, holds, Undo and retire on the release timer, the readers, observation order, every push outcome of the sender, every pull outcome of the puller with live frame admission, the live channel's socket, heartbeat and reconnects, two devices over one `SimNetwork` stepped and with their loops running, the replica lifecycle (every §8.2 row, the lineage vectors through the engine, two devices meeting at a sign-in, and a kill at every step of sign-in, sign-out and the fork guard), `HTTPTransport` against a stubbed URL loader, and its live socket against WebSocket and refusing servers on the loopback. |
| `Sync/Tests/SyncIOSTests/` | Leaving the app through the lifecycle's notifications on a real engine (the flush inside lent background time, handed back once, cancelled when the time runs out), and the storage directory over real files: the fork guard's copy is excluded from backup, so a store restored from a backup re-identifies and the original keeps its replica. |
| `Sync/Tests/SyncModelServerTests/` | Model-server properties the corpus pins only by example: admission's digest, counters and rollback, paging and live frames end to end, text merge, the push and pull envelopes over the body as received, push and call bookkeeping, and the clock. |
| `Sync/Tests/SyncConformanceTests/` | The corpus runner: one test case per vector, one handler per corpus file. Each `protocol/*.jsonl` transcript runs its client half through real engines and its server half through `SyncModelServer`. |
| `Sync/Tests/SyncTestingTests/` | The step-mode harness's surface; the replay fuzz over many seeds, with the paths every run of 64 seeds must take, and a run's determinism by its seed; property 3; that the checks see what they check (a phone the server disagrees with, a record alive again, a notice that lost what it held, rows of a tree the phone may not read) and that a finished run frees its server; and a kill at every step of scenarios that between them reach every transaction of design §3.5 on both sides of its commit. |
| `SyncProbe/` | The probe host app (XcodeGen, `project.yml`): the real engine and every `SyncIOS` adapter over the probe product alone, the registry `windmill_server_probe` serves, through `FaultInjectingTransport` (offline, forced 401 and 503) and a skewable device clock, with a log of every exchange, live frame and lease of background time. With `-scenario <name> -report <path>` it runs one scenario of `Scenarios.swift` headless and writes a JSON report; otherwise it shows its screens, one file each under `Sources/Screens/`. `e2e.sh` builds it, boots two simulators of its own, runs every scenario against the local probe server and checks the server's side. |
| `SyncTestingSurface/` | A package that depends only on `WindmillSync`'s `SyncTesting` product. Its tests drive two devices through `SteppedEngine`'s public surface and declare their own server-rules double, as the domain kit's `Harness` does. |
| `Domain/Sources/DomainKitNFC/` | One function, `nfc(_:)`, the only Foundation the kit reaches; `LayeringTests` pins its text (kit §2.3). |
| `Domain/Sources/DomainKit/` | The kit (kit §3–§12), pure logic over `SyncCore` and `SyncAPI`: the entity protocols, typed ids and `Fields`; value objects and the text, number, choice and count specs; `Valid` and checks; local days and zones; the rule book; the reader, repositories and capacity; plans and their translation to one gesture; actions and `ActionRunner`, the only holder of the `Replica` port; drafts and their save; the standard `SaveDraft`, `Remove` and `Move`; refusals and notices. It names no product. |
| `Domain/Sources/DomainKitTesting/` | What a product's tests use (kit §14): `Harness` over `SyncTesting`'s `SteppedEngine`; `RegistryCheck`, `RuleBookCheck` and `RuleBookParity`; `ProductCorpus`, which runs a product's value and action vectors from `packages/api-contract/<product>/domain/`; and `Contract`, which reads `packages/api-contract/` and gives the kit's values their vector JSON forms. |
| `Domain/Sources/GymDomain/` | Gym's feature domains on the kit: Notes (the `Note` entity and its specs, positions, the Coach's `save_note` call) and Bodyweight (a weigh-in per local day, saved whole, with its day rules and derived reads); the gym refusal type and rule book. Their vectors live in `packages/api-contract/gym/domain/` and `packages/api-contract/gym/rules/`. |
| `Domain/Tests/DomainKitTests/` | The kit's traps, each in a process of its own; `Valid`'s refusal of a U+0000 no check caught; and the compile attacks: every file under `Attacks/` compiles to SIL against this build's modules, as product-domain code or as UI code (main actor by default, warnings as errors), and a `fail` attack must fail with the error its first line names. |
| `Domain/Tests/DomainKitTestingTests/` | The runner of the kit's shared vectors, `packages/api-contract/domain-kit/`, over the probe declarations its README lists (a trap a vector expects runs in a process of its own); the harness over the real engine and model server; and the three checks against a registry built for them. |
| `Domain/Tests/LayeringTests/` | Kit §2.4: the closed world of the four packages read from `swift package dump-package`, their constant-data manifests and settings, §2.2's edges and closures, §2.3's source rules over swift-syntax's parser, the CI workflows, and the app project when `project.yml` exists; with one fixture per rule under `Fixtures/`. |

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

**Simulation.** The replay fuzz runs 64 seeds from 1 in every `swift test`, each 300 actions before quiescence.
`SYNC_SIM_SEEDS=<n>` runs more, `SYNC_SEED=<s>` starts elsewhere, and `SYNC_SIM_ACTIONS=<n>` lengthens each run. A
failure names its seed and the last actions; `SYNC_SEED=<s> SYNC_SIM_SEEDS=1` runs that seed alone:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer SYNC_SIM_SEEDS=1000 \
  swift test --explicit-target-dependency-import-check error --filter SimulatorTests/everySeed
```

**The domain kit.** `WindmillDomain` builds `WindmillSync` as a dependency. Its compile attacks run the Xcode
toolchain's `swiftc` against the modules the build made; its layering tests run `swift package dump-package` on every
package, and `xcodegen` and `xcodebuild` on the app's fixtures when `xcodegen` is installed:

```sh
cd apps/ios/Domain
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --explicit-target-dependency-import-check error
```

**The harness from outside.** `SyncTestingSurface` builds `WindmillSync` as a dependency:

```sh
cd apps/ios/SyncTestingSurface
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --explicit-target-dependency-import-check error
```

**The probe app end to end.** `e2e.sh` needs XcodeGen, a free simulator runtime, and `windmill_server_probe` on a
throwaway database with its dev endpoints (`backend/RUNNING.md`, the probe server); dev sign-in, a revoked session and a
regenerated epoch come from there. It builds the app, makes and boots two simulators, runs each scenario (the probe's
launch arguments, leave flush, relaunch release, live convergence, fork guard, 401 and re-authentication, a pull under a
revoked session, a live socket under a revoked session, another account's credential held as the account's, clock skew,
a clock jump across a kill, epoch change, sign-in lineage) and deletes the simulators; `SIM_A`, `SIM_B` and `PROBE_APP`
reuse booted simulators and a built app:

```sh
cd backend && DATABASE_URL="postgresql:///wm_sync_test?host=/tmp" PORT=8089 ./build/windmill_server_probe &
WM_E2E_DB=wm_sync_test bash apps/ios/SyncProbe/e2e.sh           # or name scenarios: e2e.sh live fork-guard
```

**Corpus.** Each vector of a corpus file with a handler in `SyncConformanceTests/Handlers.swift` is one
test case, compared with its `expect` by JCS bytes. Each corpus file without a handler is one `pending`
case, recorded as a known issue, so the run lists it by name. A corpus file the role table in
`SyncTesting/Corpus.swift` does not classify fails the run. The client-step files also run through
the SQLite store, in `SyncStoreTests`.

**Property tests** draw a fresh seed on every run and name it in any failure. Replay one with
`SYNC_SEED=<seed> swift test --filter <test>`.

[CI](../../.github/workflows/ios.yml) checks the generated registry, runs `WindmillSync`'s `swift test` on macOS, builds
that package for the iOS simulator, and runs the tests of `WindmillDomain` and `SyncTestingSurface`. It neither builds
`SyncProbe` nor runs `e2e.sh`, which needs the local backend.
