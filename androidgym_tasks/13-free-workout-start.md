# Remove the free workout

**Figma:** none. Board 03.9 is deleted: app workouts start from a routine (02.2's **Start workout**). Routines (02.1, 02.7) draw no *Start logging*, and the receipt has no *Save a routine* (03.7, 03.8). The Quick Settings tile entry is task 16.

**Implementation status**
- Routines opens saved routines and the routine editor. `TrainingStore.start` requires a routine ID. Its action decision refuses a missing routine or intervening open workout before creating another workout or intent.
- Receipts contain no routine-save form, draft, save callback or implicit routine write. Receipt restoration uses the completed workout's session ID.
- A workout started elsewhere without a routine still arrives through the engine, opens on the existing **What are you lifting?** picker, and can log and reopen. Its shared title is `Readout.noRoutine`: **Free workout**.
- All 233 targeted tests pass; the integrated gym Debug suite passes 1,167 tests with 17 opt-in live-wire cases skipped. Native acceptance verifies no free-start or receipt routine-save control, an external no-routine workout restored through the existing picker, and no additional start event. See [implementation status](../docs/engineering/android-implementation.md).

**Contract**
- App starts require a saved routine. No app screen offers a free-workout start.
- A receipt never offers to create a routine, including receipts for external or legacy workouts without a routine.
- The picker has no first-workout title or sign-in card. Existing movement creation, Add movement and external-workout entry remain available.
- Nullable engine `SessionStart` and saved-workout import formats remain supported. Connected agents can still start a workout without a routine.
- No-routine workout titles use **Free workout** in the logger, assembly, receipt, Coach readback and notifications.
- `gym_session_started` fires once for a successful app start. A missing routine, duplicate start or received workout emits no additional start event; `gym_screen_viewed` `workout` is unchanged.

Any replacement external/no-routine entry state requires human-approved design through
`android-gym-no-routine-picker-design`. This task preserves the existing picker.

**Out of scope:** the rest of Routines (17); the rest of the receipt (14); the tile (16); the picker's rows (02.4).

**Done when**
- Routines and receipt tests find no free-start or routine-save action.
- A missing-routine start leaves engine state and event count unchanged, including deletion after the initial selection. An intervening external workout is resumed with an expected refusal and no new start event or intent.
- External no-routine workouts can choose a movement, log and reopen.
- Picker, logger, receipt, readout and start-event checks pass, followed by native/telemetry batch acceptance.

**Depends on:** none.

**Ledger:** 12b, 9z; dogfood `android-gym-target-page`.
