# The rack: equipment icon, load and reps steppers, the ladder

**Figma:**
- 03.1 Rack, Dumbbells, kg each: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34026)
- 03.12 Rack, Bodyweight, kg added: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28687) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34230)
- 03.13 Rack, Barbell, kg total: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28829) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34284)
- Components (Gym Components page, section `🧩 Android · Material 3`):
  - `Android / Number stepper` `1247:2736` (the load field is the Display size)
  - `Android / Equipment icon` `1247:2247`
  - `Android / Button` `656:6699` (Log set)

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `MovementHead` (`ui/LoggerScreen.kt:571`): *‹* / *›* step keys (:588, :609), the name auto-sized 28 → 20 sp (:600-601), *Exercise {i} / {n}* (`domain/LiveSession.kt:134`). No equipment icon.
- `Rack` (`ui/LoggerScreen.kt:836-868`): a `surface` panel with an accent top edge.
  - *Weight* label (:860), `WeightReadout` (:873) auto-sized 40–96 sp (:887) with plain *kg* (:891). A tap opens the keypad.
  - `LadderRow` (:898): four 56 dp pills from `Ladder.labels` (`domain/Ladder.kt:52-56`): *−2.5 −1 +1 +2.5* under 20 kg, *−5 −2.5 +2.5 +5* from 20 to 50, *−10 −2.5 +2.5 +10* above.
  - `RepsRow` (:931): *Reps*, 56 dp − / +, the number.
  - **Log set**, 64 dp accent (:991).
- Ledger header *Set / kg / Reps* (:692-694). Warm-ups are indexed *W* (06 removes them).

**Change**
- Movement head: the equipment icon (08) left of the name. The name sizes 28 → 22 for long names. Step keys stay.
- Load: `NumberStepper` (04, Display size) with the label *Load*, the numeral, and the unit by equipment (08):
  - 03.1 Dumbbells: **16** *kg each*.
  - 03.13 Barbell: **60** *kg total*.
  - 03.12 Bodyweight: **10** *kg added*; a negative number is band help.
  - − / + nudge by the movement's step.
- The plate ladder stays under the load with the same bands. It edits the same draft.
- Reps: the same stepper, Regular size, labelled *Reps* with the unit *reps*.
- **Log set** stays the 64 dp primary and stays silent.
- Ledger: *Set / kg / Reps*, the ✓ for landed sets, the accent row for the current set. No *W*.
- Delete the *Weight* label and `WeightReadout`.

**Out of scope:** the stepper itself, keyboard, pressed and changed states (07); Fix set (10); This workout (11).

**Done when**
- Screenshots of 03.1, 03.12 and 03.13 match in Dark and Daylight; the rig (01) adds `03.1-rack-dumbbells-dark/light`, `03.12-rack-bodyweight-dark/light`, `03.13-rack-barbell-dark/light` (the fixture gains a bodyweight movement with added load).
- `gym_set_logged` fires once per **Log set**. A rack refusal still reports under `gym.editRack` / `gym.acceptSet` only when unexpected.
- `ui/LoggerScreenTests.kt`, `ui/LargestTypeTests.kt` and `domain/LadderTests.kt` pass with the new layout, including a 200 % font test that the load stepper and Log set stay on screen.

**Depends on:** 06, 07, 08.

**Ledger:** 11d, 11e, 9c; dogfood `android-gym-target-page`.
