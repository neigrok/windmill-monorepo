# Planned rows show the load the rack will offer, never the word "last"

**Status:** 🚀 On main (`ef0f05fb`) on Android and iOS, not yet in a published release. 03.34 is 🚀 In production.

**Figma:** 03.34 Rack, planned rows: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-40960) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41112)

**Current implementation**
- **Shared read:** `Prefill.offeredLoads(todaySets, planEntry, lastTime)` gives the load the rack offers at the set in hand and each planned set after it, each set offered as though the one before were logged as offered. A load that would come from a last time not read yet is null. It is built on `Prefill.at`, which `Prefill.of` also uses, in Kotlin `:gym:domain`, Swift `GymDomain` and web `trainingReads.js`. Nine `OfferedLoads` cases in `packages/api-contract/gym/domain/training-reads.json` pass on all three.
- **Android:** `LiveLines.slots(sets, sessionId, planEntry, lastTime, …)` (`gym/.../domain/LiveSession.kt`) names each current and planned row's offer by the shared `Prefill.offeredLoads`: "22.5 kg total × max", or "— × max" while the movement's last time is unread (TalkBack: "no load yet"). `TrainingStore.lastTimeOf(movement)` answers the shared `LastTime` this workout has read, unread (`isComplete == false`) until its read answers. `Readout.setTarget` keeps `last × …` for plan targets: Coach review rows and proposal field moves.
- **iOS:** `MovementLedger` (`App/Sources/Gym/Workout/WorkoutState.swift`) takes the movement's `LastTime` (incomplete while the log is unread) and reads its current and planned rows as "22.5 × max" or "— × max"; `WorkoutLedgerRow` speaks the same offer. `Readout.setTarget` keeps `last × …` for Edit sets, which edits plan targets.
- **Tests:** `LiveSessionTests.testARowStillToLiftNamesTheLoadItsRackWillOfferAndNeverLast` (Android), `WorkoutRenderingTests.testRowsStillToLiftReadTheOfferedLoad` and `testLedgerRowsSpeakTheirPlaceAndNumbersInWords` (iOS), and the shared vectors.

**Change**
- In the rack's planned rows, show the load the rack will offer for that set: "22.5 kg total × max". With nothing to offer, show "— × max".
- The offered load is the one the rack's prefill would put in the stepper: the shared `LastTime`/prefill read, or the plan's load. Read it from the domain; don't re-derive it.
- Apply the same to the iOS rack's planned rows.
- Check every other caller of `setTarget`/`Readout` first, such as routine rows and the summary sheet. Where "last" is the right word for a target with no load, keep it there and change only the rack's planned rows. If one string serves both today, split it.

**Done when**
- 03.34's planned rows match on Android in Dark and Daylight; iOS shows the same words on the simulator.
- Tests on both: a planned row with an offer reads the load; one without reads "— × max"; no planned row contains "last".
- If the shared reads gain a field for the offer, add vector cases and pass them on Kotlin, Swift and web.

**Depends on:** 09.
