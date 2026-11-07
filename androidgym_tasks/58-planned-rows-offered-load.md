# Planned rows show the load the plan expects, never the word "last"

**Status:** 🚀 On main (`ef0f05fb`) on Android and iOS, in Android 0.14.0. By the owner's ruling of 2026-11-06 a row still to lift reads the plan, never a set logged today; 03.34 draws the rack's offer on those rows and is logged as drift in `docs/design/consistency.md`.

**Figma:** 03.34 Rack, planned rows: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-40960) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41112)

**Current implementation**
- **Shared read:** `Prefill.expectedLoads(lifted, planEntry, lastTime)` gives the load the plan expects at the set in hand and each planned set after it: the target's own, else last time's as `Prefill.at` resolves a "last" target with nothing logged today. Today's sets never enter it; a load that would come from a last time not read yet is null. The rack's own prefill, `Prefill.of`, keeps following today's last set. Both live in Kotlin `:gym:domain`, Swift `GymDomain` and web `trainingReads.js`; ten `ExpectedLoads` cases in `packages/api-contract/gym/domain/training-reads.json` pass on all three.
- **Android:** `LiveLines.slots(sets, sessionId, planEntry, lastTime, …)` (`gym/.../presentation/LiveSession.kt`) names each current and planned row's load by the shared `Prefill.expectedLoads`: "100 kg total × max", or "— × max" while the movement's last time is unread (TalkBack: "no load yet"). `WorkoutSession.lastTimeOf(movement)` answers the shared `LastTime` this workout has read, unread (`isComplete == false`) until its read answers. `Readout.setTarget` keeps `last × …` for plan targets: Coach review rows and proposal field moves.
- **iOS:** `MovementLedger` (`App/Sources/Gym/Workout/WorkoutState.swift`) takes the movement's `LastTime` (incomplete while the log is unread) and reads its current and planned rows as "100 × max" or "— × max"; `WorkoutLedgerRow` speaks the same load. `Readout.setTarget` keeps `last × …` for Edit sets, which edits plan targets.
- **Tests:** `LiveSessionTests.testARowStillToLiftNamesTheLoadThePlanExpectsAndNeverLast` (Android), `WorkoutRenderingTests.testRowsStillToLiftReadThePlansExpectedLoad` and `testLedgerRowsSpeakTheirPlaceAndNumbersInWords` (iOS), `WorkoutStateTests.aLoggedSetTakesOverTheCurrentRowAndTheNextPlannedRowMovesUp` (iOS), and the shared vectors.

**Change**
- In the rack's planned rows, show the load the plan expects of that set: "100 kg total × max". With nothing to name, show "— × max".
- The expected load is the plan's own, else last time's as the prefill resolves a "last" target with nothing logged today; a set logged today never changes it. Read it from the domain; don't re-derive it.
- Apply the same to the iOS rack's planned rows.
- Check every other caller of `setTarget`/`Readout` first, such as routine rows and the summary sheet. Where "last" is the right word for a target with no load, keep it there and change only the rack's planned rows. If one string serves both today, split it.

**Done when**
- 03.34's planned rows match on Android in Dark and Daylight; iOS shows the same words on the simulator.
- Tests on both: a planned row reads the plan's expected load, unchanged by the set logged before it; one with none reads "— × max"; no planned row contains "last".
- If the shared reads gain a field for the offer, add vector cases and pass them on Kotlin, Swift and web.

**Depends on:** 09.
