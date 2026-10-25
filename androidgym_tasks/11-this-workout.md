# This workout sheet

**Approved flow:** [Workout](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036) — ✅ Ready for dev, human-approved 2026-10-25.

**Figma:**
- 03.4 This workout: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29834) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34419)
- Components (Design System library, Android page): `Android / Swipe row` `337:2217`, `Android / Equipment icon` `337:2025`, `Android / Button` `210:181`.

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `AssemblySheet` (`ui/AssemblySheet.kt:68`) opens from the movement name on the rack.
  - Title *This session* (:118). Subtitle *{N sets} logged · {routine}*, or *· Free session* (:119).
  - Rows: a reorder handle *Reorder {name}* (:145, always shown, long-press then drag), the name, a meta line, a forward chevron. Meta comes from `domain/LiveSession.kt`: *3 of 5 sets · 80 × 5*, *Up next · 3 × 5 · 80kg* (:197), *No sets yet* (:199), *just added* (:179).
  - A row with no sets swipes in **both** directions (:164-167) onto `DropGround` (:181-193): the word *Remove* twice in `alarmInk` on `raised`. It drops at once.
  - TalkBack actions *Move up*, *Move down*, *Remove* (:125-127).
  - **Add movement**, `raised`, 64 dp (:174).
- Dropping a movement emits no event.

**Change**
- Title *This workout*. Subtitle *{N sets} logged · {routine}*: *4 sets logged · Push A*. A workout with no routine (one a connected agent started) ends the subtitle with `Readout.noRoutine` (13).
- Rows are M3 `ListItem`s: `drag_handle` leading (always shown), name and meta, the forward arrow trailing.
- Meta units follow equipment (08): *24 kg each*, *25 kg total*.
- Only a movement with no sets swipes, **end-to-start only**, on `DeleteSwipeRow` (04) with the label *Remove movement*. The row is gone on release, with no Undo. A refused drop snaps the row back and the note line says why.
- Delete `DropGround`.
- Keep the TalkBack actions and **Add movement** in this management sheet; the main rack has no Add button. **Add movement** opens the existing picker for this live workout. Picker Cancel returns to **This workout**; cancelling custom creation returns to the picker. A successful selection or custom creation returns to the same preserved rack and selects the added movement.
- Keep the workout ID, logged sets, active movement and every existing movement’s uncommitted load/reps while switching sheets. Remove sheet stacking/transition paths that produce a grey screen. Live creation has its own commit contract (19), not the routine editor’s outer Save. The rack backdrop follows 09’s headerless ledger and visual marker.

**Out of scope:** the rack (09); the visual position marker and spoken count (09); the sheet's *Hide workout* item and the *Notification off* · *Show* row, both drawn on 03.4 (45).

**Done when**
- Screenshots of 03.4 match in Dark and Daylight, apart from the *Hide workout* and *Notification off* rows (45); the rig (01) adds `03.4-this-workout-dark/light`.
- New `gym_action` with `screen` `workout`, `action` `remove`, `outcome` `ok` / `refused`, content-free. `gym_screen_viewed` is unchanged.
- `TrainingStore.drop` (`store/TrainingStore.kt:722`) refuses with `false` and has no failure path, so a refusal is the event only.
- `ui/AssemblySwipeTests.kt` asserts one direction only and the new ground; `domain/LiveSessionTests.kt` asserts full meta strings. This task verifies name → This workout → picker → existing selection and picker Cancel with preserved workout/rack state. Task 19 owns final custom-create success/refusal/Cancel/recreation integration; retain its existing working path until 19 lands. The combined acceptance then covers all return paths without a blank/grey surface.
- Record picker open/cancel/add outcomes with content-free `gym_action` labels under `screen=workout`; unexpected create/add boundary failures use static existing operations. No exercise names, values, search text or IDs in telemetry.

**Depends on:** 04, 05, 08, 09.

**Ledger:** 11b, 9z; dogfood `android-gym-target-page`.
