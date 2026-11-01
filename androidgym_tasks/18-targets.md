# One movement editor for name, equipment and targets; one outer routine Save

**Status:** On main at `95b83e80` in batch `b40dd5e0`; the shipped canonical states are 🚀 In production. Android 0.14.0 carries it.

**Approved flow:** [Routine editor](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30392) — human-approved 2026-10-25.

**Figma:**
- 02.6 Combined movement editor: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30392) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44962)
- 02.11 Combined movement editor, Vary by set expanded on the same route: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29263) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45508)
- 02.25 Regular Load unit below at 320dp/200%: [Approved frame](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1661-33960), 🚀 In production, human-approved 2026-10-28. Keep 20sp value and 16sp unit bases, side controls, native minus and pinned Done. Expansion stays while focused through valid zero; longer text retains native horizontal editing. The older full-width/buttons-below proposal is unapproved.
- Components (Design System library, Android page):
  - `Android / Number stepper` `337:2514`
  - `Android / Keyboard` `337:2403` (Number and Decimal)
  - `Android / Swipe row` `337:2217`
  - `Android / Button` `210:181`

**Shared equipment control:** [Canonical Android section](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1548-7642), 🚀 In production, human-approved 2026-10-26. The combined uniform/per-set, add, keyboard, invalid, unsaved and Load-focus drawings on the canonical Android page use this approved shared control. The existing Name/Equipment/Targets composition and staged Add/Done routes remain unchanged.

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `ui/RoutineBuilder.kt` opens `MovementForm` for uniform/per-set targets, name and equipment. Routine creation stages stable movement identities in the owning draft.
- `RoutinesStore.saveRoutine` admits one store-owned save and calls the existing domain `SaveRoutinePlan` through `EngineTraining`. It writes routine entries, new movement metadata, overrides and aliases together with the domain stale/visibility guards.
- `GymRoom` pins the caller owner, identity revision, replica and exact save attempt. An invalidated result cannot close a newer form or leave its own busy flag stuck. The admitted store-owned save survives caller disposal.

**Contract**
- Replace the target-only destination with the approved combined movement form: **Name**, **Equipment**, then **Targets**. Opening an existing routine movement edits all of these on one route. There is no separate Targets route, navigation hop or target-only commit.
- Implement the shared Name/Equipment fields here using the approved combined form and 04’s native primitives;19 reuses this form for its creation contexts and is not a prerequisite of 18. **Sets** and **Reps** use Number input; **Load** uses Decimal, with equipment-aware units from 08. Preserve blank/open/varies semantics and the domain’s validation; zero is not a substitute for an unset target.
- Signed Other and legacy bodyweight load entry uses the native keyboard’s minus key as specified in 07. Verify negative decimal entry and commit on the target emulator and retain the approved sizing. Preserve raw legacy equipment/count on unchanged or name-only edits; selecting a different category writes its explicit value. No legacy data migration is part of this form.
- Equipment offers exactly **Barbell**, **Dumbbells**, **Other**, with implicit multipliers 1/2/1. There is no One/Two selector, multiplier label, or Name/Equipment help/warning. Existing barbell maps to Barbell, paired dumbbells to Dumbbells, and all other stored combinations to Other; selecting the original displayed choice preserves its raw metadata.
- **Vary by set** expands within this same form. Name and Equipment remain in its editable scroll hierarchy. Use the approved per-set rows, Fill actions, Add set and removal. Never recreate a target-only sheet behind the expansion. Drawn chips may be 32 dp but their touch bounds, steppers and row actions are at least 48 dp.
- **Add** for a new selected/custom movement and **Done** for an existing movement validate and stage name, equipment, load count and target edits in the owning routine draft. They first validate the focused input buffer, then stage it; invalid input blocks the action. They perform no catalogue or routine write. Cancelling this form discards only its uncommitted movement edit; preserve previously staged outer-draft entries. Use the approved unsaved confirmation for a dirty form.
- The outer routine **Save** is the single write boundary. Carry base/current routine plus each movement’s base/current metadata into the existing `SaveRoutinePlan`. Stable draft IDs must survive retry. Reuse its stale/visibility guards and single Plan; do not call `CreateExercise`, `RenameExercise` or a standalone Edit action before it. Removing a staged new movement prevents that creation from joining the save.
- Cancelling/discarding the outer routine draft leaves the routine, catalogue, aliases and targets unchanged. A failed/stale Save keeps the draft available with an honest refusal; it must not leave partial metadata or a routine-only write behind. Preserve restore/recreation of the draft without submitting it.
- Keyboard layout: compact scroll content and pinned **Add**/**Done**, not a tall padded sheet. Scroll the focused field and full error above the IME and pinned action, including the bottom Load and per-set fields. Unfocused content may scroll under the viewport boundary, but focus cannot leave a field/error clipped. Status/navigation insets remain correct after recreation.
- Keep a shared target-editor component where useful, but retain the current Coach draft controls and presentation in this release. Routine-only staging and atomic-save claims must not enter Coach/live-workout flows, whose owners are 19/38/41.

**Out of scope:** standalone Record editing (20); live-workout custom creation’s distinct write boundary (19); new Cable/Kettlebell chooser variants.

**Done when**
- Capture the combined uniform/per-set, keyboard, Load-focus/error and unsaved states in Dark and Daylight against the approved flow. Verify compact phones, large text and 48 dp hit bounds; there is no separate Targets destination.
- Add/Done followed by outer Cancel causes zero routine/catalogue/alias writes. Outer Save publishes new movement metadata and routine entries together through one existing `SaveRoutinePlan`; retry is idempotent. Removed staged creations never persist.
- Exercise stale routine/metadata/equipment/target edits, unseen/deleted movement refusal, failed Save, repeated Save and recreation. Assert unchanged replica state on refusal and full retained draft content, not just a success label.
- Preserve the existing SaveRoutinePlan/shared vectors; add adapter/draft UI tests for the new wiring. Update the relevant `RoutineEditor`, target/per-set, create-movement, planning-write and sign-entry tests to the combined route.
- `gym_routine_saved` fires only at successful outer Save. Content-free `gym_action` tracks movement-form open/stage/cancel and outer-save refusal/failure with bounded labels; staging must not emit a created/saved event. Unexpected adapter/write failures report under static `gym.saveRoutine`; draft persistence retains `gym.saveRoutineDraft`. Record labels in `docs/ANDROID_OBSERVABILITY.md`, without names, targets, IDs or field text.

**Verification**
- The composed Android gate passes gym Debug and Release separately: each has 1,429 cases, 1,412 passes and 17 explicit opt-in LiveWire skips, with no failures or errors. Platform Debug passes 140 cases, App Debug passes 48, and Debug assembles.
- Accepted native captures cover the normal, per-set, keyboard and unsaved forms in Dark and Daylight. The approved 02.25 scope proves readable `−12.5` and valid `0` with unchanged focused bounds at 320dp/200%, whole-buffer comma-decimal replacement and duplicate-separator rejection. Native partial selection remains unestablished. The broader Target-summary overlap is postponed and excluded; no whole-form 200% acceptance is claimed.
- Local schema-10 acceptance proves all six routine/catalogue SQL tables unchanged before outer Save, then one new sync result with exact 501/zero target arrays, rest, metadata and the former-name alias through SQL and authenticated GET. Dumbbells retains raw SQL `NULL` and reads as the effective count 2. A separate staged-creation Cancel preserves the full baseline.
- The final Save run delivers 22 bounded intake events, including five form/Save steps and one `gym_routine_saved`. Accepted partial capture runs, Cancel and final Save have separate receipts on the same frozen source/APK. Setup and observer failures are qualified rather than counted as whole-run passes. Technical save-failure reporting is covered at the deterministic adapter/store boundary; no native failure Issue was injected or claimed.

**Depends on:** 04, 07, 08.

**Ledger:** 11d, F38; dogfood `android-gym-target-page`.
