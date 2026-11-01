# A saved copy that partly reached the server keeps the sets that did not

**Status:** Waits for its board: design brief item QW5. Domain work can start; the screen change cannot.

**Figma:** none yet. The new *On this phone* state is drawn under brief item QW5 ([design brief](design-brief-quality-wave.md)). The existing recovery boards are in the [On this phone section](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=56-2) (task 25).

**Context:** when a held workout's restart is refused because one of its set ids is already on the server (`id-taken`, `session-id-taken` or `id-spent`), both phones offer only Discard. Discard would throw away the sets that never landed. A lifter can lose real training this way.

**Current implementation**
- The shared domain marks an identity refusal unfixable (Kotlin `apps/android/gym/domain/…/WorkoutRecovery.kt:23,41`: `canFix = reason != identityTaken`).
- Android's *On this phone* leaves these refusals out of Fix and gives them no main action, so only Discard remains (`apps/android/gym/src/main/kotlin/works/windmill/gym/ui/OnThisPhoneScreen.kt:118-127,247-250`).
- iOS gates the same way (`apps/ios/App/Sources/Gym/Recovery/WorkoutInspectScreen.swift:36`, `GymWorkoutAdoption.swift:92`).

**Change**
- Domain: a "keep the rest" action. It imports the sets whose ids are not on the server into a workout under new identities, keeps the original source until the account confirms, and leaves the landed sets alone. Add vectors to `recovery-actions.json` on Kotlin and Swift.
- Screen: once QW5 is ✅ Ready for dev, *On this phone* offers the action on these refusals, as drawn. Each step emits a `gym_import_recovery` event.

**Done when**
- The vectors pass on Kotlin and Swift.
- The board matches in Dark and Daylight.
- On the local stack, a copy with one set already on the server keeps its other sets after the action, and its source stays until the account confirms.

**Depends on:** 25, 79, design brief QW5. Tree: `gym-recovery-copy-partly-landed`.
