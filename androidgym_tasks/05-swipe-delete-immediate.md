# Swipe delete is immediate everywhere: no hold, no Undo snackbar

**Figma:**
- 00.3 Transient band: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38296) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46470)
- 02.8 Routine editor, remove a movement by swipe: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30621) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45193)
- 02.10 Routine deleted by swipe: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29196) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45437)
- 02.12 Routine menu, Delete: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29480) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45706)
- 05.4 Workout detail, delete a set by swipe: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27713) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31027)
- Components (Gym Components page, section `🧩 Android · Material 3`): `Android / Swipe row` `1247:2439`, `Android / Menu` `1260:2608`.

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
- A delete lands on release past the threshold, or on the menu tap. No hold, no snackbar, no Undo.
  - Routine (swipe and ⋮ **Delete**), set (swipe and Fix set), note, weigh-in: call the store's delete at once.
  - Workout discard and conversation delete keep their hold until their one confirmation exists (14, 37). Those tasks make them immediate; the last of them deletes `store/WithheldDelete.kt`.
- On a refusal the row comes back, and the note line says why (e.g. *the log didn’t answer — Push A is still in your program*). Delete the refusal snackbar and the ON_STOP release.
- Use `DeleteSwipeRow` (04) on the routine row, the editor movement row (label *Remove movement*) and the workout detail set row. Delete `RowDeleteGround` and SessionScreen's `DeleteGround`.
- Routine ⋮ menu: one item, **Delete**, with the `delete` icon and label in the error role (02), on the card surface.
- 00.3: the band is the M3 `Snackbar` for one-off notices (two lines, e.g. *Link copied — anyone who has it can read this workout*) above the note line, above the navigation bar. No Undo action anywhere in gym.

**Out of scope:** the log row swipe and its dialog (22); Fix set's button (10); This workout's rows (11); the discard dialog (14); weigh-in and notes screens (24, 26); conversation delete (37).

**Done when**
- Screenshots of 00.3, 02.8, 02.10, 02.12 and 05.4 match in Dark and Daylight; the rig (01) adds `00.3-band-dark/light`, `02.8-editor-swipe-dark/light`, `02.10-routine-deleted-dark/light`, `02.12-routine-menu-dark/light`, `05.4-set-swipe-dark/light`.
- New event `gym_action` (content-free, keys from `TelemetryPolicy.keys` in `platform/telemetry/Telemetry.kt`): `screen` (`routines`, `session`, `notes`, `bodyweight`), `action` `delete`, `outcome` `ok` / `refused` / `failed`. One event per settled delete. Add it to the product events table in `docs/ANDROID_OBSERVABILITY.md`.
- Unexpected failures still report under `gym.dropRoutine`, `gym.deleteSet`, `gym.deleteNote` and `gym.deleteWeighIn`; a refusal is the event only.
- Tests: rewrite `store/WithheldWindowTests.kt` and `store/WithheldSendTests.kt` as immediate-delete tests; update `ui/SetRowSwipeTests.kt`, `ui/RowSwipeAccessibilityTests.kt`, `ui/RoutinesScreenTests.kt`, `ui/PlanningSwipePaintTests.kt`, `ui/RowReturnReplayTests.kt`, `LogTransientTests.kt` and `store/TelemetryTests.kt`.

**Depends on:** 02, 04.

**Ledger:** 11b, 7a; dogfood `android-gym-target-page`.
