# Workout writes and recovery retain the whole saved source

**Status:** On main. Checked on the local stack: a signed-out finished workout, an open workout and their routine are adopted at sign-in with Add. Corrupting one queued set intent in the signed-out replica's SQLite store did not reach the per-item path: the whole anonymous replica became unreadable, each read reported a store failure to Sentry while signed out, sign-in still completed, the replica was retained whole with neither workout adopted, and exactly one `gym.prepareAdoption` report was sent. Per-item isolation is covered by unit tests only. Not driven: a full-disk fault during reorder and the F5 mutation check, because the debug build has no fault switch; the raw `Violation` gap below stands.

**Context:** package 108 covers controls-write failures escaping logger callbacks, unexpected import preparation failures recorded as correction refusals, partial decoding of retained starts, and incomplete migration assertions. Recovery's domain/store journal split remains task 79.

**Current implementation**
- `WorkoutSession` shares a controls-write boundary; movement choice, reorder and removal return `WorkoutChange`. Logger callbacks use the existing recovery sentence and bounded action outcomes.
- Controls failures after accepted engine writes return the existing recovery refusal. Discarding a device-shelf workout clears its retained history details.
- Recovery names the workout and replica whose durably accepted set awaits an engine commit. Successful recovery, discard, permanent refusal, account change and teardown end that state; start checks the remaining failure before writing a new workout.
- `WorkoutImports` classifies only expected refusals and decode errors as journal refusals. Direct preparation and recovery actions propagate unexpected exceptions without committing the prepared journal.
- `prepareAdoption` reports an unexpected item failure once under `gym.prepareAdoption`, retains that source locally without its outgoing writes, and continues adopting other work. Retry markers use registry-valid `rack:` keys. Reconciliation retries the deferred item; failures outside an item retain the whole anonymous replica while sign-in completes.
- In the whole-replica fallback, the account opens without the phone's signed-out training until the person signs out and back in. Automatic retry on connect and an approved disclosure line are tracked by dogfood node `android-retained-signed-out-replica-retry-disclosure`.
- A shared source reader decodes each retained workout as a whole. Unreadable sources retain their bytes and use the existing recovery state without a Sentry report. `EngineTraining` reads held starts through that reader.
- Reconciliation and command receipts skip unreadable sources unchanged; queued and submitted unreadable copies also show recovery instead of adding. Preview and persisted refusals use the same classifier.
- Controls migration assertions compare complete sessions, performed sets, entries and the parsed saved document before and after persistence and reopening.
- `GymEvents` and `docs/ANDROID_OBSERVABILITY.md` list failed reorder/removal outcomes and their static failure operations.
- Structure observation: boundary decoding now has one owner; the remaining legacy/domain recovery split requires task 79's migration and shared-vector work.
- Test observation: a domain violation converted to a named refusal retains that specific code; the classifier's generic correction branch requires a violation that propagates to the store boundary.
- Raw `Violation` coverage remains a gap: identity-source faults poison the engine transaction and must roll back even if the store catches them; standing-record decoding throws `DecodeError`, while correction numbering overflow returns a refusal rather than throwing. No production test hook is introduced.

**Done when**
- Disk-write fault tests prove unchanged controls and one report, including later latched attempts; logger tests prove failed removal and picker feedback.
- Import tests prove direct preparation failures leave snapshots unchanged, adoption isolates a failed item while other work adopts, malformed shared metadata cannot block sign-in, deferred sources keep their bytes and retry independently, and explicit recovery actions retire their retry state.
- Specific domain refusals retain their codes, values requiring normalization remain correction refusals, and corrupted starts never expose a readable subset or remain adding.
- Migration assertions pass and a dropped performed-set field fails the mutation check.
- The orchestrator runs gym tests, `:sync-engine:testDebugUnitTest` including `AnonymousRetentionTests`, `:app`'s `ObservabilityDocTests`, and native/local-stack acceptance.

**Depends on:** none for this package; recovery through domain actions is task 79. Tree: `android-108-workout-writes-recovery`.
