# One movement editor for name, equipment and targets; one outer routine Save

**Approved flow:** [Routine editor](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30392) — ✅ Ready for dev, human-approved 2026-10-25.

**Figma:**
- 02.6 Combined movement editor: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30392) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44962)
- 02.11 Combined movement editor, Vary by set expanded on the same route: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29263) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45508)
- Components (Design System library, Android page):
  - `Android / Number stepper` `337:2514`
  - `Android / Keyboard` `337:2403` (Number and Decimal)
  - `Android / Swipe row` `337:2217`
  - `Android / Button` `210:181`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `ui/RoutineBuilder.kt` still opens a target-only sheet; `ui/TargetBlock.kt` owns uniform/per-set targets and the existing bodyweight sign action. Name and equipment are outside that edit.
- Routine-picker creation calls `store.create` before adding to its local draft (`ui/RoutineBuilder.kt`, `ui/MovementPicker.kt`). Cancelling the outer routine can therefore leave a created movement behind.
- The sync domain already provides `RoutineMovementChange` and `SaveRoutinePlan` in `apps/android/gym/domain/src/main/kotlin/works/windmill/gym/domain/sync/Routines.kt`. It combines routine entries, new/custom movement metadata and overrides in one Plan, with stale guards and aliases. `TrainingStore.saveRoutine` still uses the older create/replace-routine adapter; wire the existing action rather than rebuilding it.

**Change**
- Replace the target-only destination with the approved combined movement form: **Name**, **Equipment**, dumbbell count when relevant, then **Targets**. Opening an existing routine movement edits all of these on one route. There is no separate Targets route, navigation hop or target-only commit.
- Implement the shared Name/Equipment/count fields here using the approved combined form and 04’s native primitives;19 reuses this form for its creation contexts and is not a prerequisite of 18. **Sets** and **Reps** use Number input; **Load** uses Decimal, with equipment-aware units from 08. Preserve blank/open/varies semantics and the domain’s validation; zero is not a substitute for an unset target.
- Assisted bodyweight load entry retains the explicit sign action from 07 and works without an IME minus key. Preserve cable/kettlebell metadata and supported-record semantics; new visuals for those options remain gated as described in 08.
- **Vary by set** expands within this same form. Name and Equipment remain in its editable scroll hierarchy. Use the approved per-set rows, Fill actions, Add set and removal. Never recreate a target-only sheet behind the expansion. Drawn chips may be 32 dp but their touch bounds, steppers and row actions are at least 48 dp.
- **Add** for a new selected/custom movement and **Done** for an existing movement validate and stage name, equipment, load count and target edits in the owning routine draft. They first validate the focused input buffer, then stage it; invalid input blocks the action. They perform no catalogue or routine write. Cancelling this form discards only its uncommitted movement edit; preserve previously staged outer-draft entries. Use the approved unsaved confirmation for a dirty form.
- The outer routine **Save** is the single write boundary. Carry base/current routine plus each movement’s base/current metadata into the existing `SaveRoutinePlan`. Stable draft IDs must survive retry. Reuse its stale/visibility guards and single Plan; do not call `CreateExercise`, `RenameExercise` or a standalone Edit action before it. Removing a staged new movement prevents that creation from joining the save.
- Cancelling/discarding the outer routine draft leaves the routine, catalogue, aliases and targets unchanged. A failed/stale Save keeps the draft available with an honest refusal; it must not leave partial metadata or a routine-only write behind. Preserve restore/recreation of the draft without submitting it.
- Keyboard layout: compact scroll content and pinned **Add**/**Done**, not a tall padded sheet. Scroll the focused field and full error above the IME and pinned action, including the bottom Load and per-set fields. Unfocused content may scroll under the viewport boundary, but focus cannot leave a field/error clipped. Status/navigation insets remain correct after recreation.
- Keep a shared target-editor component where useful for Coach drafts. Reusing its controls must not import routine-only staging or atomic-save claims into Coach/live-workout flows, whose owners are 19/38/41.

**Out of scope:** standalone Record editing (20); live-workout custom creation’s distinct write boundary (19); implementing missing Cable/Kettlebell or new sign-action placements without their design follow-up (07/08).

**Done when**
- Capture the combined uniform/per-set, keyboard, Load-focus/error and unsaved states in Dark and Daylight against the approved flow. Verify compact phones, large text and 48 dp hit bounds; there is no separate Targets destination.
- Add/Done followed by outer Cancel causes zero routine/catalogue/alias writes. Outer Save publishes new movement metadata and routine entries together through one existing `SaveRoutinePlan`; retry is idempotent. Removed staged creations never persist.
- Exercise stale routine/metadata/equipment/target edits, unseen/deleted movement refusal, failed Save, repeated Save and recreation. Assert unchanged replica state on refusal and full retained draft content, not just a success label.
- Preserve the existing SaveRoutinePlan/shared vectors; add adapter/draft UI tests for the new wiring. Update the relevant `RoutineEditor`, target/per-set, create-movement, planning-write and sign-entry tests to the combined route.
- `gym_routine_saved` fires only at successful outer Save. Content-free `gym_action` tracks movement-form open/stage/cancel and outer-save refusal/failure with bounded labels; staging must not emit a created/saved event. Unexpected adapter/write failures report under static `gym.saveRoutine`; draft persistence retains `gym.saveRoutineDraft`. Record labels in `docs/ANDROID_OBSERVABILITY.md`, without names, targets, IDs or field text.

**Depends on:** 04, 07, 08.

**Ledger:** 11d, F38; dogfood `android-gym-target-page`.
