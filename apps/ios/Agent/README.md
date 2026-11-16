# Coach turn engine

`Agent` runs product-neutral Coach turns and depends only on `SyncCore`. Its profile, seat, pictures,
marks and outcomes are plain values. It imports no Foundation, catalog, domain kit, platform or UI.
The application still uses its existing Gym turn implementation; this package is a library.

`Turn` sequences `ToolHost`, `AiClient` and `Telemetry` over injected time, cryptographic IDs and a
work lease. `run` opens records and the initial mark, uploads pictures, writes each round's mark,
streams visible text and dispatches final tool calls sequentially. The working request, carry and
full tool results exist only inside the invocation. `recover` reads a marked result without PUT or
ability execution. Its prefix uses UTF-8 bytes. Duplicate call IDs fail before any dispatch.

Stop lets an in-flight completed round finish, discards tool calls after Stop, and cancels only
retry waits. Await `seatWillChange()` before changing credentials, the host generation or active
replica: it waits for pending host mutations, writes interruption and drops the pass. Each invocation
holds its own state and work lease; after the barrier, a new seat can run while an old response drains. A host must
check its lease and record existence inside every commit; `WindmillPlatform.CoachCommitGuard`
provides that boundary for sync records. Record deletion ends silently. `TurnFreshness` requires a
live sync connection and corrected server time; it never consults a wall clock itself.

`Profile` validates before host admission. Every gate runs offered, seat, shape, successful group
limits, execution/write volume, product and Stop in that order. Only admitted executions consume
volume; successful executions consume group slots. Product refusal sentences are carried as JSON
error content. Telemetry contains bounded ability names, refusal labels and turn counts, never
questions, results, credentials, seat keys or call identifiers.

The package boundary test rejects product nouns and every import except SyncCore.

Run `swift test --package-path apps/ios/Agent --explicit-target-dependency-import-check error`. The complete shared story replay belongs to
`WindmillKit/Tests/WindmillPlatformTests`: it runs this engine and the actual AI retry policy over
scripted transport and guarded storage, comparing every expected trace field.
