# A phone back from a long time offline drains its outbox in linear time

**Status:** Not started. Shared engine, every implementation; nothing visual changes.

**Context:** a phone that comes back with a large outbox restamps and reloads it at a cost that grows with the square of its size. 218 records took about 43 s of CPU in the iOS returning fixture. Android's own read overlay was made linear in ff16d667; the restamp was not.

**Current implementation**
- Restamp walks every later entry per field or register:
  - Kotlin `apps/android/sync-engine/…/Recovery.kt:48`;
  - Swift `apps/ios/Sync/Sources/SyncReplica/Outcomes.swift:681-683`;
  - the JS reference, `refusal.js:17,130`.
- Swift reads are still K×E: `shaped()` filters `entriesTouchingReads` once per record (`apps/ios/Sync/Sources/SyncEngine/Readers.swift:260`), though the view itself is built in one pass (`Views.swift:50`).
- No benchmark covers restamping.

**Change**
- Restamp in one pass over the outbox, indexed by record and field, on Kotlin, Swift and the JS reference. The spec's ordering and outcomes do not change.
- Swift's `shaped()` indexes outbox entries by record once per read, as Android does.
- Add a benchmark vector (a 1,000-entry outbox restamped after a refusal) with a budget every engine meets, and keep the conformance corpus byte-stable.

**Done when**
- The benchmark meets its budget on all three engines.
- The iOS returning fixture drains 218 records in well under a second of CPU.
- The full Android build, Swift `SyncCore` / engine tests and the JS corpus pass.

**Depends on:** none. Tree: `engine-outbox-restamp-quadratic`, `sync-outbox-overlay-cost`.
