# Planned rows show the load the rack will offer, never the word "last"

**Status:** ✅ Ready for dev. The owner approved the rule on 03.34 on 2026-10-31, including iOS following it. Not started.

**Figma:** 03.34 Rack, planned rows: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-40960) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41112)

**Current implementation**
- Android:
  - `gym/.../domain/Readout.kt` writes a target with no load as `last × {reps}`.
  - `domain/LiveSession.kt` draws planned rows as `last {unit} × {reps}`.
- iOS: `apps/ios/Domain/Sources/GymDomain/TrainingReads.swift` `setTarget` writes the same `last × …`.
- With no history, the rack's planned rows read the template words "last kg total × max" (`manual/m15-rack-light.png`).

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
