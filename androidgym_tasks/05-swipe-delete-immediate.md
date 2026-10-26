# Resource-specific deletion: immediate confirmed deletes and nine-second weigh-in Undo

**Approved flow:** [Log / Weigh-in](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-31991) — ✅ Ready for dev, human-approved 2026-10-25. The weight recovery contract below is part of the approved revision; unrelated transient specimens are not newly approved by it.

**Figma:**
- 00.3 Transient band: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38296) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46470)
- 02.8 Routine editor, remove a movement by swipe: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30621) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45193)
- 02.10 Routine deleted by swipe: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29196) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45437)
- 02.12 Routine menu, Delete: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29480) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45706)
- 05.4 Workout detail, delete a set by swipe: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27713) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31027)
- Components (Design System library, Android page): `Android / Swipe row` `337:2217`, `Android / Menu` `342:2725`.

**Implementation status**
- Routine, set and note actions use immediate engine receipts. The application store owns each settled action, so disposing its row cannot cancel the write or its result event. Replica and anonymous-owner checks run inside the write transaction, including refused-import set correction.
- Weigh-ins use durable nine-second engine holds. The application retains receipt projections across navigation and activity recreation. Actual process backgrounding releases holds; restart and account transitions do not renew Undo. Successful same-day rewrites retire their hold; refused or failed writes retain it.
- Shared `DeleteSwipeRow` is wired to routine, editor-movement and detail-set rows. The routine menu uses the shared native destructive menu item. The editor changes only its draft. `RowDeleteGround` remains for the separate bidirectional target and Coach consumers.
- A failed immediate release restores the row only when its exact receipt can be undone. An uncertain release uses the existing error line without claiming restoration. Late Undo says “The Undo window closed.”, which makes no server-acknowledgement claim.
- The merged Debug gate passed: 1,222 gym cases (17 opt-in live-wire cases skipped), all three application cases and six telemetry cases. The final projection checks passed 84 cases; the native band checks passed three and focused Release checks passed 13. Dark/Daylight evidence covers the five linked deletion surfaces; the final native candidate also verifies immediate set/note deletion, weight Undo and background release before expiry. Full-screen geometry owned by later tasks is outside this evidence.

**Change**
- Immediate deletion is resource-specific. Routine (swipe and ⋮ **Delete**), set (swipe and Fix set) and note call the store delete on the settled action. Workout discard and conversation deletion become immediate only after their single confirmations exist (14, 37).
- Weigh-ins retain `Deletion.Bodyweight`, `WithheldDelete` and `Withheld.windowMs = 9_000L`. Hide the row while the delete is held; show **Undo** while held and send no delete before expiry or an explicit lifecycle release. Undo restores the row. The engine hold lifecycle in `docs/foundation/engine.md` §7.3 owns the durable nine-second hold: actual app backgrounding releases it to the queue, and activity recreation redraws the remaining Undo time. Screen navigation does not settle it. A successful same-day rewrite retires the hold; a failed rewrite keeps its existing Undo window. Process restart/sign-in/sign-out release held entries and do not offer Undo again; an explicit discarded room follows the engine’s discard policy.
- Routine-editor movement removal changes only its draft. It persists when the outer routine Save commits (18); leaving the outer draft without saving must not delete a catalogue movement.
- An immediate delete refusal restores the row and explains it in the note line. Keep the recovery/error presentation used by held weigh-ins; do not remove the snackbar host or its lifecycle handling globally.
- Use `DeleteSwipeRow` (04) on the routine row, editor movement row (label *Remove movement*) and workout detail set row. Remove SessionScreen's private `DeleteGround`; retain `RowDeleteGround` until its separate bidirectional target and Coach callers migrate.
- Routine ⋮ menu: one item, **Delete**, with delete icon and label in the error role (02), on the card surface.
- The transient band continues to carry one-off notices and the approved weight **Undo** action. A notice-only specimen does not override the weight flow.

**Out of scope:** the log row swipe and its dialog (22); Fix set's button (10); This workout's rows (11); the discard dialog (14); weigh-in and notes screens (24, 26); conversation delete (37).

**Done when**
- Deletion roles on 00.3, 02.8, 02.10, 02.12 and 05.4 match in Dark and Daylight; the rig (01) adds `00.3-band-dark/light`, `02.8-editor-swipe-dark/light`, `02.10-routine-deleted-dark/light`, `02.12-routine-menu-dark/light`, `05.4-set-swipe-dark/light`. Root chrome/FAB, editor geometry and Session copy remain with 03/17, 18 and 23. The weight Undo band uses the approved native one-line form; the general two-line specimen is not forced onto this shorter message.
- Use content-free `gym_action` events for immediate settled deletes (`screen=routines|session|notes`, `action=delete`, `outcome=ok|refused|failed`). For weights, distinguish the held request, Undo/cancellation and eventual delete outcome (24); a hidden row is not a committed delete. Pin the bounded labels in `TelemetryPolicy` and `docs/ANDROID_OBSERVABILITY.md`. Never include names, dates, values or record IDs.
- Unexpected failures still report under `gym.dropRoutine`, `gym.deleteSet`, `gym.deleteNote` and `gym.deleteWeighIn`; a refusal is the event only.
- Retain held-weight tests in `store/WithheldWindowTests.kt` and `store/WithheldSendTests.kt`: Undo before expiry sends nothing; expiry sends once; late Undo cannot pretend success; activity recreation keeps remaining time; actual backgrounding releases to the queue with no Undo on return; restart releases a surviving hold; a successful same-day rewrite retires its hold; a failed rewrite does not. Add resource-specific immediate-delete and refusal tests without converting these weight cases. Update swipe, row-return, transient and telemetry tests for the two contracts.

**Depends on:** 02, 04.

**Ledger:** 11b, 7a; dogfood `android-gym-target-page`.
