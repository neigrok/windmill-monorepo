# The number stepper and the decimal keyboard replace the keypad sheet

**Approved flow:** [Workout](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036) — ✅ Ready for dev, human-approved 2026-10-25.

**Figma:**
- 03.2 Load tapped, decimal keyboard: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28178) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34080)
- 03.10 Rack, pressed: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28389) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34112)
- 03.11 Rack, changed, with 48 dp hit areas: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28534) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34166)
- Components (Design System library, Android page):
  - `Android / Number stepper` `337:2514`: Default, Pressed, Changed, Focused
  - `Android / Keyboard` `337:2403`: Decimal

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- The rack and Fix set use the shared `ui/NumberStepper.kt`: an editable Display load, regular reps, 48 dp icon buttons and the existing 56 dp ladder. Load requests signed decimal input; reps requests whole-number input. There is no app keypad or extra sign control.
- `domain/NumberEntry.kt` reads signed and comma-decimal input, checks the ±500 kg bound before half-away hundredth rounding, and retains the existing refusal sentences. Performed reps are whole numbers from 1 to 99; future planned-target consumers keep their own rules.
- `ui/NumberDraft.kt` retains the raw buffer separately from its committed value. IME Done and explicit Log set / Save fix validate the buffer. Plain blur or Cancel restores the committed value. Invalid input stays visible and blocks submission. A Fix draft survives the temporary empty workout read during activity recreation, and a successful Finish discards that workout's saved UI state. Storage failure retains the existing recovery sentence after the keyboard closes.
- A new focus places the caret after the current value. Further edits and the approved 04 overflow expansion preserve selection. The field exposes Increase / Decrease accessibility actions; its unit remains in its accessible name.
- Accepted step or IME changes share one feedback path: a 300 ms accent flash, a clipped 150 ms motion of the existing editor layer, and one light haptic. Unchanged or refused edits do not tick. Explicit Log set stays silent.

**Change**
- Migrate load and reps to `NumberStepper` (04) on the rack and in Fix set. Replace `KeypadSheet` and its entry state with the approved native-keyboard flow, preserving signed decimal input and its refusal cases.
- 03.2: a tap on the load focuses the field.
  - The cursor sits after the value. The system keyboard opens with `KeyboardType.Decimal`.
  - The rack rides above the IME (`imePadding`); the compact headerless ledger from 09 can scroll away. The focused value, error and commit action remain reachable without a blank reserved band.
  - The IME Done key validates and commits the focused input buffer. Explicit form actions (**Add**, **Done**, **Save fix**, **Log set**) also validate/commit that buffer before staging/submitting; they cannot silently use the previous value. Plain blur without an explicit commit and Cancel keep the prior committed value. Invalid buffered input blocks submission and remains visible for correction.
  - Refusals show as the field's supporting text, with today's sentences (move them to the domain, next to `domain/Ladder.kt`, so the rack and Fix set share them).
  - Reps opens `KeyboardType.Number`.
- Assisted bodyweight loads use the native keyboard’s minus key. Human clarification on 2026-10-25 establishes this as the intended sign interaction in the approved rack, Fix set and combined-editor boards; the mock keyboard does not depict every native key. Configure and verify signed decimal input on the target Android emulator. Preserve the approved control sizing and domain acceptance of signed loads; do not add an app-level ± control or carry over the withdrawn proposal’s smaller display type.
- 03.10 pressed: a key shows the M3 state layer (on-surface 12 % over the tonal container), and an icon button takes its pressed shape. No scale.
- 03.11 changed:
  - An accepted change ticks the value (short slide, tabular digits), the field flashes `accentSoft` with an accent numeral for 300 ms, and one light haptic plays (`GymHaptics.ticked`, 04).
  - Every − / + is 48 × 48 dp; ladder keys are 56 dp tall.
  - With reduce motion on, colour only. **Log set** stays silent.
- Delete `Modifier.pressed`.

**Out of scope:** the rack's head, units and ladder layout (09); Fix set's other rows (10); the combined movement editor (18).

**Done when**
- Screenshots of 03.2, 03.10 and 03.11 match in Dark and Daylight; the rig (01) adds `03.2-load-keyboard-dark/light`, `03.10-rack-pressed-dark/light`, `03.11-rack-changed-dark/light`.
- TalkBack adjusts both steppers (custom actions *Increase* / *Decrease*) and reads the unit. On the target emulator, verify the native minus key, negative decimal entry, editing and commit in the rack and Fix set; invalid text never replaces the last committed value. Capture small-height and large-font focus/error states with the approved 04 overflow behavior. Task 18 owns the combined editor integration and its native acceptance; reusable signed/comma/refusal and stepper contracts are covered here.
- `gym_set_logged` is unchanged. A rack edit the store refuses still reports under `gym.editRack` only when unexpected.
- Replace keypad-specific tests with equivalent NumberStepper/native sign-entry assertions and retain their refusal cases in domain tests; do not delete coverage before its replacement runs. Update Fix set, logger and haptic tests.

**Depends on:** 04.

**Ledger:** 11d; dogfood `android-gym-target-page`.

**Verified:** API 37 `final3` captures cover all six Dark/Daylight boards. Native accessibility
Increase/Decrease actions adjust both fields; spoken TalkBack is unverified. Fix draft/error/note
restoration, 320 × 640 dp at 200% text, action reachability, correction readback and storage recovery
are verified. Detailed native minus/decimal, reps refusal and Cancel evidence is retained in the
unchanged `pilot3` entry paths. The [phase log](../docs/engineering/android-implementation.md)
records exact APK/test provenance, local event/Issue delivery and evidence limits.
