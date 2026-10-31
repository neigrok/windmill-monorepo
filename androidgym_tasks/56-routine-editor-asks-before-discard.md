# The routine editor asks before Back discards unsaved changes; Keep editing on both discard questions

**Status:** ✅ Ready for dev. The owner approved 02.20 and the revision of 02.17 on 2026-10-31. Not started.

**Figma:**
- 02.20 Routine editor, unsaved changes: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-39519) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-39682)
- 02.17 Movement editor, unsaved changes, revised to *Keep editing*: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1443-19730) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1443-20852)
- iOS model: `apps/ios/App/Sources/Gym/Routines/RoutineBuilder.swift` asks the same question and blocks swipe-dismiss.

**Current implementation**
- `ui/RoutineBuilder.kt` swallows Back only while saving (`BackHandler(enabled = saving) {}`).
- A back gesture on a new routine with a name and two movements discards it silently: no question, no Undo. To reproduce: New routine, type a name, add two movements, swipe back.
- The movement editor already asks (02.17), but its dismiss button reads *Cancel*.
- The routine Name is a label-above outlined field. The movement form uses floating-label fields, so the one editor mixes two field idioms.

**Change**
- **Dirty draft (02.20):** Back, Cancel or the back gesture asks:
  - title: **Discard routine changes?**
  - text: **{name} won't be saved.**
  - buttons: **Keep editing** · **Discard**

  Discard leaves; Keep editing stays.
- **Clean draft:** leaves at once.
- **Gesture preview:** a dirty draft shows no predictive-back preview. Register with task 53's back guard. If 53 hasn't landed, intercept with a `BackHandler` enabled only while dirty.
- **02.17:** the dismiss button reads **Keep editing**.
- **Name field:** the outlined field with its label inside, as in the movement form (02.20 draws it).
- "Dirty" means the draft differs from what was opened, by the editor's existing equality, so reorder-and-back counts.

**Done when**
- 02.20 and 02.17 match in Dark and Daylight. Fix `routine-targets.json`'s mislabelled `02.14 movement-unsaved`: it is 02.17.
- Tests:
  - Back on a dirty new routine asks, and Discard leaves.
  - Keep editing keeps every field.
  - Back on a clean draft leaves without asking.
  - Activity recreation while asking keeps the dialog and the draft.
- Events: the existing `routine_editor` actions keep firing. If a discard event is added, list it in `docs/ANDROID_OBSERVABILITY.md`; no routine name is ever an event property.

**Depends on:** 18; uses 53 if present.

**Ledger:** 4k.
