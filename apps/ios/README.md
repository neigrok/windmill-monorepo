# Windmill iOS

`apps/ios` holds one SwiftPM package, `WindmillSync` in `Sync/`: the client of the sync engine
([engine.md](../../docs/foundation/engine.md)). There is no iOS app target.

## Layout

| Path | Responsibility |
|---|---|
| `Sync/Sources/SyncCore/` | Pure primitives every role shares: JSON and its JCS bytes, stamps and the HLC, lattice joins, the registry, id making, fractional keys, the scope digest, constants. It imports nothing but CryptoKit. |
| `Sync/Sources/SyncTesting/` | Test support: the golden-corpus reader and the seeded generator for property tests. |
| `Sync/Tests/SyncCoreTests/` | Unit and property tests, one file per `SyncCore` file they test, and the layering check that keeps `SyncCore` pure. |
| `Sync/Tests/SyncConformanceTests/` | The corpus runner: one test case per vector, one handler per corpus file. |

The package is written in the Swift 6 language mode with strict concurrency, for iOS 18 and macOS 15.

## Build and test

Everything runs on a Mac without a simulator. `swift test` needs Xcode's toolchain, because the
Command Line Tools ship no Swift Testing:

```sh
cd apps/ios/Sync
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild build -scheme WindmillSync-Package -destination 'generic/platform=iOS Simulator'
```

Keep the full monorepo: the corpus runner finds `packages/api-contract/sync/corpus/` by walking up from
its own file. `WINDMILL_SYNC_CORPUS=<path>` points it elsewhere.

**Corpus.** Each vector of a corpus file with a handler in `SyncConformanceTests/Handlers.swift` is one
test case, compared with its `expect` by JCS bytes. Each corpus file without a handler is one `pending`
case, recorded as a known issue, so the run lists it by name. A corpus file the role table in
`SyncTesting/Corpus.swift` does not classify fails the run.

**Property tests** draw a fresh seed on every run and name it in any failure. Replay one with
`SYNC_SEED=<seed> swift test --filter <test>`.

[CI](../../.github/workflows/ios.yml) runs `swift test` on macOS and builds the package for the iOS
simulator.
