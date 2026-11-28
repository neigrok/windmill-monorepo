# Coach turn engine

`Agent` runs product-neutral Coach turns and depends only on `SyncCore`. Its profile, seat, pictures,
marks and outcomes are plain values. It imports no Foundation, catalog, domain kit, platform or UI.
The App's Roadmap Coach runs its turns on it, behind its switch; the App's gym Coach still uses its own turn implementation.

`Turn` sequences `ToolHost`, `AiClient` and `Telemetry` over injected time, cryptographic IDs and a
work lease. `run` opens records and the initial mark, uploads pictures, writes each round's mark,
streams visible text and dispatches final tool calls sequentially. Before anything of round 1, it
asks `AiClient.connected` once and withdraws a turn begun while the device reports no connection: no
mark, no upload, no request. The working request, carry and
full tool results exist only inside the invocation. `recover` reads a marked result without PUT or
ability execution. Its prefix uses UTF-8 bytes. Duplicate call IDs fail before any dispatch.

Stop lets an in-flight completed round finish, discards tool calls after Stop, and cancels retry
waits and pending retry preparation or response headers. Successful event streams and host commits
finish normally. Await `seatWillChange()` before changing credentials, the host generation or active
replica: it waits for pending host mutations, writes interruption and drops the pass. Each invocation
holds its own state and work lease; after the barrier, a new seat can run while an old response drains. A host must
check its lease and record existence inside every commit; `WindmillPlatform.CoachCommitGuard`
provides that boundary for sync records. Record deletion ends silently. `TurnFreshness` requires a
live sync connection and corrected server time; it never consults a wall clock itself.

`Profile` validates before host admission. Every gate runs offered, seat, shape, successful group
limits, execution/write volume, product and Stop in that order. Only admitted executions consume
volume; successful executions consume group slots. Product refusal sentences are carried as JSON
error content. Unknown host refusal codes use the profile's `product-refused` code and sentence in
model results and telemetry. Telemetry contains bounded ability names, refusal labels and turn counts, never
questions, results, credentials, seat keys or call identifiers. `Telemetry.hostFailure()` has no
payload: the integration routes it to static failure operation `agent-host` for unexpected host,
storage and runtime failures. Expected record deletion, stale seats and host refusals stay quiet.

The package boundary test rejects product nouns and every import except SyncCore.

Run `swift test --package-path apps/ios/Agent --explicit-target-dependency-import-check error`. The complete shared story replay belongs to
`WindmillKit/Tests/WindmillPlatformTests`: it runs this engine and the actual AI retry policy over
scripted transport and guarded storage, comparing every expected trace field.
