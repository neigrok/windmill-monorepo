# This workout sheet

**Figma:**
- 03.4 This workout: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29834) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34419)
- Components (Gym Components page, section `🧩 Android · Material 3`): `Android / Swipe row` `1247:2439`, `Android / Equipment icon` `1247:2247`, `Android / Button` `656:6699`.

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
- Keep the TalkBack actions and **Add movement**.

**Out of scope:** the rack (09); the pager *Movement 3 of 5* (09); the sheet's *Hide workout* item and the *Notification off* · *Show* row, both drawn on 03.4 (45).

**Done when**
- Screenshots of 03.4 match in Dark and Daylight, apart from the *Hide workout* and *Notification off* rows (45); the rig (01) adds `03.4-this-workout-dark/light`.
- New `gym_action` with `screen` `workout`, `action` `remove`, `outcome` `ok` / `refused`, content-free. `gym_screen_viewed` is unchanged.
- `TrainingStore.drop` (`store/TrainingStore.kt:722`) refuses with `false` and has no failure path, so a refusal is the event only.
- `ui/AssemblySwipeTests.kt` asserts one direction only and the new ground; `domain/LiveSessionTests.kt` asserts the new meta strings in full.

**Depends on:** 04, 05, 08.

**Ledger:** 11b, 9z; dogfood `android-gym-target-page`.
