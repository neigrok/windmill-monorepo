# This workout sheet

**Approved flow:** [Workout](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036) — ✅ Ready for dev, human-approved 2026-10-25.

**Figma:**
- 03.4 This workout: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29834) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34419)
- Components (Design System library, Android page): `Android / Swipe row` `337:2217`, `Android / Equipment icon` `337:2025`, `Android / Button` `210:181`.

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `ui/AssemblySheet.kt` opens **This workout** from the rack name. Its stock M3 ListItems use a 20 dp handle inside a 48 dp interaction target, equipment-aware performed/planned metadata, and the existing forward glyph.
- Empty unplanned movements use the shared end-to-start-only `DeleteSwipeRow`. Refusals restore the row and show a supporting sentence. A handle owns its gesture before the parent swipe; reorder previews stay local until release, and cancellation restores the original order without saving.
- Picker Cancel and Back return to This workout. Existing selection returns to the preserved rack. The current custom-create route is retained for task 19.
- Edited load/reps snapshots live with the workout's existing local controls, keyed by movement and set count. Switching away and back restores that movement's edits. A new set retires only that movement's snapshot; a different workout or owner does not inherit it. Raw editor buffers retain their existing UI saveable keys.
- Content-free workout actions cover remove, completed reorder, picker open/cancel/add. Local API 37 acceptance covers six canonical, removal-ground and 200% text captures in Dark/Daylight. Picker Cancel, switching and relaunch preserve edited movement loads; released removal and handle reorder match stored controls and each emit one result event.

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
