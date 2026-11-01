# Update required always arrives, and delivery state comes from the engine alone

**Status:** Not started. Nothing visual changes; *Update required* already exists.

**Context:** when every scope on a phone is stopped at this version's digest, the phone makes no pull and has nothing to push. It never hears the server's `426 upgrade-required`, so *Update required* never shows. The task also closes PR #22's loose ends.

**Current implementation** (paths under `apps/android/`)
- `SyncRuntime.publishPullable` marks `Pulls.blocked` when every scope is digest-stopped (`sync-engine/…/SyncRuntime.kt:541-550`), and the puller skips stopped scopes (`:561`). Only the log foot reads `pulls` (`gym/…/store/HistoryReads.kt:69`).
- Gym keeps its own delivery copy, `reportedTransport` (`app/…/WindmillApplication.kt:127-136`) and `training.reportDelivery` (`:212`), beside the engine's `failedPushes`, `unansweredPushes` and `holdsBack` (`sync-engine/…/Observation.kt:101-106`).
- Android applies `minSchema` from any hello status (`SyncRuntime.kt:312`). iOS reads it only from a 200 (`apps/ios/Sync/Sources/SyncEngine/SyncEngine.swift:522-523`).
- `GymEngineSessionTests.kt:338-344` sends `426 {minSchema}` without `error: upgrade-required`, a shape the server never sends.
- Comments say an unanswered push "never reached the server" (`Observation.kt:99`; iOS `Observation.swift:507`, `SyncEngine.swift:308`). engine.md states the rule correctly (`:1546-1549`).
- iOS files the server's 1008 close as a transport Issue (`apps/ios/Sync/Sources/SyncEngine/Transport.swift:247-256`). Android counts it as a refusal.

**Change**
- When every scope is stopped, the engine still makes a bounded hello on foreground and on its backoff, so a `426 upgrade-required` reaches the update surface. Record the rule in engine.md, and give iOS the same behaviour.
- Delete gym's `reportedTransport` / `reportDelivery` copy. The workout's delivery state reads the engine's observation.
- Read `minSchema` only from a 200 hello, as iOS does.
- The test sends the real 426 body through `GymEngineSession`.
- Comments say "got no answer the engine could read", as engine.md does.
- iOS counts a 1008 close as a refusal metric, not an Issue.

**Done when**
- A test drives a digest-stopped replica against a server that answers `426 upgrade-required`, and *Update required* shows without a write.
- On the local stack, raising the server minimum above the build shows *Update required* on an idle phone that has pulled everything.
- Neither phone files a Sentry Issue for a 1008 close.

**Depends on:** none. Tree: `android-engine-426-followups`.
