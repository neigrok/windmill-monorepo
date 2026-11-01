# Update required always arrives, and delivery state comes from the engine alone

**Status:** Implemented, awaiting review and the local-stack check. Nothing visual changes; *Update required* already exists. The two local-stack checks under **Done when** have not been run.

**Context:** when every scope on a phone was stopped at this version's digest, the phone made no pull and had nothing to push. It never heard the server's `426 upgrade-required`, so *Update required* never showed. The task also closes PR #22's loose ends.

**Current implementation** (paths under `apps/android/`)
- A digest-stopped scope is pulled and followed like any other; only its digest check is skipped (engine.md §7.5 step 4). The puller and the live socket no longer pass over stopped scopes, and `Pulls.blocked` means offline, an upgrade required or no seat (`sync-engine/…/SyncRuntime.kt`). iOS and web already pulled stopped scopes, so no hello was added on any engine.
- The workout's delivery state reads the engine's observation: `EngineTraining.deliveryBlocker` maps `authPaused` to sign-in, no network or a gym scope in `unansweredPushes` to offline, and a gym scope in `failedPushes` to the log's failure (`gym/…/store/EngineTraining.kt`). The app passes `HTTPTransport` to `SyncRuntime` directly (`app/…/WindmillApplication.kt`).
- Android reads `minSchema` only from a 200 hello, as iOS does; web now does the same (`web/src/platform/sync/engine.js`). engine.md §9.2 records the rule.
- `GymEngineSessionTests.updateRequiredHelloKeepsAnonymousTrainingWritableWithoutSelectingTheProposedOwner` sends the server's real 426 body (`error: upgrade-required` in the sync envelope).
- Comments say an unanswered push "got no answer the engine could read" (`Observation.kt`; iOS `Observation.swift`, `SyncEngine.swift`).
- iOS reports the server's 1008 close as an `api_request_failed` metric with `failure_kind` `refused` and no Issue (`apps/ios/Sync/Sources/SyncEngine/Transport.swift`, `Telemetry.swift`). Android counts it as a refusal.
- Tests: `SyncRuntimeTests.aDigestStoppedScopeIsStillPulledAndHearsTheServersUpgrade`, `SyncRuntimeTests.onlyASuccessfulHellosMinimumRequiresAnUpgrade`, `SignInDecisionTests.anIdlePhoneWhoseEveryScopeStoppedStillShowsUpdateRequired` (the dialog shows with no push and an empty outbox), `EngineTrainingTests.deliveryCopyReadsHowTheEnginesLastPushEnded`, iOS `TransportTests.aSessionEndedCloseIsARefusalWithoutAnIssue`, web `only a 200 hello says the app is too old by its minSchema`. Gym tests push through the engine's own sender with `EngineRoomFixture.push`.

**Change**
- When every scope is stopped, the engine still pulls them, so a `426 upgrade-required` reaches the update surface. Record the rule in engine.md; iOS and web already behave so.
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
