# The routine editor asks before Back discards unsaved changes; Keep editing on both discard questions

**Status:** 🚀 On main (`ef0f05fb`), not yet in a published release. Boards 02.20 and 02.17 are 🚀 In production.

**Figma:**
- 02.20 Routine editor, unsaved changes: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-39519) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-39682)
- 02.17 Movement editor, unsaved changes, revised to *Keep editing*: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1443-19730) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1443-20852)
- iOS model: `apps/ios/App/Sources/Gym/Routines/RoutineBuilder.swift` asks the same question and blocks swipe-dismiss.

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `RoutineDraft.unsaved` (`domain/Program.kt`) says what Back would lose: a new draft holding a name or a movement, or an edit that differs from its routine by the editor's `changed` equality, so a reorder counts.
- `ui/RoutineBuilder.kt` registers `BackGuard(enabled = saving || draft.unsaved)`. A Back, the back gesture or the top bar's back arrow on an unsaved draft asks *Discard routine changes?* with *{name} won't be saved.* (*This routine won't be saved.* while the name is blank), **Keep editing** · **Discard**; a clean draft leaves at once. While a save is in flight Back does nothing. The question is saved with the draft, so a recreation keeps both.
- `GymStage` counts only the standing frame's guard (`LocalFrameStands`), so an editor sliding away after a save or a discard asks nothing.
- The movement editor's question (02.17) and the draft's share one `DiscardQuestion`: **Keep editing** in the accent, **Discard** in the error colour.
- The routine Name is an outlined field with its label inside, typed in `NativeFieldType` like the movement form.
- Events: `gym_action` `routine_editor` `discard` sends `state: shown` when the question opens, then `ok` or `cancelled`. No routine name is a property.
- Tests: `ui/RoutineEditorTests` (Back on a dirty new routine asks and Discard leaves; Keep editing keeps the name and the order, and the back arrow asks the same; a clean new or edited draft leaves at once; recreation keeps the question and the draft), `domain/ProgramTests`. The rig captures 02.17 as `movement-unsaved` and 02.20 as `routine-unsaved` (`tools/capture-recipes/routine-targets.json`).

**Change**
- **Dirty draft (02.20):** Back, Cancel or the back gesture asks:
  - title: **Discard routine changes?**
  - text: **{name} won't be saved.**
  - buttons: **Keep editing** · **Discard**

  Discard leaves; Keep editing stays.
- **Clean draft:** leaves at once.
- **Gesture preview:** a dirty draft shows no predictive-back preview. Register task 53's back guard, `BackGuard(enabled = dirty) { … }` in `GymNavigator.kt`: while it is enabled, Back previews nothing and calls it instead of leaving.
- **02.17:** the dismiss button reads **Keep editing**.
- **Name field:** the outlined field with its label inside, as in the movement form (02.20 draws it).
- "Dirty" means the draft differs from what was opened, by the editor's existing equality, so reorder-and-back counts.

**Done when**
- 02.20 and 02.17 match in Dark and Daylight; `routine-targets.json` captures 02.17 as `movement-unsaved`.
- Tests:
  - Back on a dirty new routine asks, and Discard leaves.
  - Keep editing keeps every field.
  - Back on a clean draft leaves without asking.
  - Activity recreation while asking keeps the dialog and the draft.
- Events: the existing `routine_editor` actions keep firing. If a discard event is added, list it in `docs/ANDROID_OBSERVABILITY.md`; no routine name is ever an event property.

**Depends on:** 18; uses 53 if present.

**Ledger:** 4k.
