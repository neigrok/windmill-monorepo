# Resource-specific deletion: immediate confirmed deletes and nine-second weigh-in Undo

**Approved flow:** [Log / Weigh-in](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-31991) — ✅ Ready for dev, human-approved 2026-10-25. The weight recovery contract below is part of the approved revision; unrelated transient specimens are not newly approved by it.

**Figma:**
- 00.3 Transient band: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38296) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46470)
- 02.8 Routine editor, remove a movement by swipe: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30621) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45193)
- 02.10 Routine deleted by swipe: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29196) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45437)
- 02.12 Routine menu, Delete: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29480) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45706)
- 05.4 Workout detail, delete a set by swipe: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27713) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31027)
- Components (Design System library, Android page): `Android / Swipe row` `337:2217`, `Android / Menu` `342:2725`.

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- Deletes are held for `Withheld.windowMs = 9_000L` (`store/WithheldDelete.kt:108`) behind an *Undo* snackbar (`GymRoom.kt:507-530`). Callers of `store.withhold(…)`:
  - routine: `destroy()` (`GymRoom.kt:766-774`), from the swipe (`ui/RoutinesScreen.kt:184-206`) and the ⋮ menu's *Delete* (`ui/RoutinesScreen.kt:241-242`, ink on `raised`);
  - set: workout detail swipe and Fix set (`ui/SessionScreen.kt:280`, :378; `ui/LoggerScreen.kt:537`);
  - note (`ui/NotesScreen.kt:276`), weigh-in (`ui/BodyweightScreen.kt:344`);
  - workout (`GymRoom.kt:645`) and conversation (`GymRoom.kt:1122`).
- Snackbar lines: *{name} deleted.*, *{w} kg × {r} is out of the log.*, *Note deleted.*, *Weigh-in deleted.*, *Session deleted.*, *Conversation deleted.* (`store/WithheldDelete.kt:41-80`), *{n} deleted.* (:119) and *The window closed — that delete already went.* (:114).
- A refusal after the window is a Long snackbar (`GymRoom.kt:534-546`). Leaving the app lets the holds go (`GymRoom.kt:548-563`).
- Grounds: the editor movement row uses `RowDeleteGround` (`ui/RoutineBuilder.kt:392-397`); the workout detail set uses its own `DeleteGround` (`ui/SessionScreen.kt:464`, :474-488), which bleeds red at the row's top-right corner.
- The note line (mono 12, `inkDim`, two lines) sits under the snackbar host in the room's bottom bar (`GymRoom.kt:962-978`).

**Change**
- Immediate deletion is resource-specific. Routine (swipe and ⋮ **Delete**), set (swipe and Fix set) and note call the store delete on the settled action. Workout discard and conversation deletion become immediate only after their single confirmations exist (14, 37).
- Weigh-ins retain `Deletion.Bodyweight`, `WithheldDelete` and `Withheld.windowMs = 9_000L`. Hide the row while the delete is held; show **Undo** while held and send no delete before expiry or an explicit lifecycle release. Undo restores the row. Use the existing engine hold lifecycle from `docs/foundation/engine.md` §7.3: the nine-second hold is durable; actual app backgrounding releases it to the queue, and activity recreation redraws the remaining Undo time. Screen navigation does not settle it. Keep the sent/expiry guard and successful same-day rewrite cancellation. A failed rewrite keeps the existing Undo window. Do not remove `WithheldDelete.kt` or shared recovery globally; keep the working weight path until it is wired to the engine-owned hold. Replace its current in-memory background-abandon behavior with the canonical durable release, rather than preserving that build drift. Process restart/sign-in/sign-out release held entries and do not offer Undo again; an explicit discarded room follows the engine’s discard policy.
- Routine-editor movement removal changes only its draft. It persists when the outer routine Save commits (18); leaving the outer draft without saving must not delete a catalogue movement.
- An immediate delete refusal restores the row and explains it in the note line. Keep the recovery/error presentation used by held weigh-ins; do not remove the snackbar host or its lifecycle handling globally.
- Use `DeleteSwipeRow` (04) on the routine row, editor movement row (label *Remove movement*) and workout detail set row. Delete `RowDeleteGround` and SessionScreen's `DeleteGround` after migrating their callers.
- Routine ⋮ menu: one item, **Delete**, with delete icon and label in the error role (02), on the card surface.
- The transient band continues to carry one-off notices and the approved weight **Undo** action. A notice-only specimen does not override the weight flow.

**Out of scope:** the log row swipe and its dialog (22); Fix set's button (10); This workout's rows (11); the discard dialog (14); weigh-in and notes screens (24, 26); conversation delete (37).

**Done when**
- Screenshots of 00.3, 02.8, 02.10, 02.12 and 05.4 match in Dark and Daylight; the rig (01) adds `00.3-band-dark/light`, `02.8-editor-swipe-dark/light`, `02.10-routine-deleted-dark/light`, `02.12-routine-menu-dark/light`, `05.4-set-swipe-dark/light`.
- Use content-free `gym_action` events for immediate settled deletes (`screen=routines|session|notes`, `action=delete`, `outcome=ok|refused|failed`). For weights, distinguish the held request, Undo/cancellation and eventual delete outcome (24); a hidden row is not a committed delete. Pin the bounded labels in `TelemetryPolicy` and `docs/ANDROID_OBSERVABILITY.md`. Never include names, dates, values or record IDs.
- Unexpected failures still report under `gym.dropRoutine`, `gym.deleteSet`, `gym.deleteNote` and `gym.deleteWeighIn`; a refusal is the event only.
- Retain held-weight tests in `store/WithheldWindowTests.kt` and `store/WithheldSendTests.kt`: Undo before expiry sends nothing; expiry sends once; late Undo cannot pretend success; activity recreation keeps remaining time; actual backgrounding releases to the queue with no Undo on return; restart releases a surviving hold; a successful same-day rewrite retires its hold; a failed rewrite does not. Add resource-specific immediate-delete and refusal tests without converting these weight cases. Update swipe, row-return, transient and telemetry tests for the two contracts.

**Depends on:** 02, 04.

**Ledger:** 11b, 7a; dogfood `android-gym-target-page`.
