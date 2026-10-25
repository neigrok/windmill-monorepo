# The number stepper and the decimal keyboard replace the keypad sheet

**Approved flow:** [Workout](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036) — ✅ Ready for dev, human-approved 2026-10-25.

**Figma:**
- 03.2 Load tapped, decimal keyboard: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28178) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34080)
- 03.10 Rack, pressed: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28389) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34112)
- 03.11 Rack, changed, with 48 dp hit areas: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28534) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34166)
- Components (Design System library, Android page):
  - `Android / Number stepper` `337:2514`: Default, Pressed, Changed, Focused
  - `Android / Keyboard` `337:2403`: Decimal

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- Tapping the rack's load or reps opens `KeypadSheet` (`ui/KeypadSheet.kt:135`; opened at `ui/LoggerScreen.kt:466`, :470). Fix set opens the same sheet (`ui/FixSheet.kt:104`).
  - Title *Weight* / *Reps* (`ui/KeypadSheet.kt:148`), keys `1 2 3 / 4 5 6 / 7 8 9 / ± 0 .` (:58) and *⌫* (:60), commit *Set weight* / *Set reps*. No system keyboard.
  - Refusals: *One decimal point only.*, *That is not a number yet.*, *Over 500 kg — check the number.*, *Whole reps, 1 to {max}.* (:53-56), *Enter a number, or cancel to keep {w}* (:111).
- The rack's load is a readout with *Weight* above (`ui/LoggerScreen.kt:860`) and *kg* beside (:891), `WeightReadout` (:873). Reps is `RepsRow` (:931) with 56 dp − / + and an `AnimatedContent` fade (:945).
- Pressing scales to 0.96 (`Modifier.pressed`, :1009-1020). No haptic on any change.

**Change**
- Migrate load and reps to `NumberStepper` (04) on the rack and in Fix set. Remove `KeypadSheet` and its entry state only after the explicit signed-input replacement is drawn, approved and verified; preserve the existing working signed-input path until then. Nonvisual parser/validation tests and unsigned component work can proceed independently.
- 03.2: a tap on the load focuses the field.
  - The cursor sits after the value. The system keyboard opens with `KeyboardType.Decimal`.
  - The rack rides above the IME (`imePadding`); the compact headerless ledger from 09 can scroll away. The focused value, error and commit action remain reachable without a blank reserved band.
  - The IME Done key validates and commits the focused input buffer. Explicit form actions (**Add**, **Done**, **Save fix**, **Log set**) also validate/commit that buffer before staging/submitting; they cannot silently use the previous value. Plain blur without an explicit commit and Cancel keep the prior committed value. Invalid buffered input blocks submission and remains visible for correction.
  - Refusals show as the field's supporting text, with today's sentences (move them to the domain, next to `domain/Ladder.kt`, so the rack and Fix set share them).
  - Reps opens `KeyboardType.Number`.
- Preserve an explicit 48 dp **±** sign action for assisted bodyweight loads in the shared input: it flips the entered magnitude between positive and negative, exposes *Flip sign — band-assisted* to TalkBack, and works without an IME minus key. Reuse the existing target sign action in the rack, Fix set and combined editor; `KeyboardType.Decimal` is only an input hint. Never replace it with a phone keypad. Preserve domain acceptance of signed loads. The exact new sign-action placement is not drawn in the approved examples. Designer-owned gate `android-gym-signed-load-input-design` must supply and obtain approval for focused/error states on rack, Fix set and the combined editor before the visual replacement ships; retain the working existing path meanwhile.
- 03.10 pressed: a key shows the M3 state layer (on-surface 12 % over the tonal container), and an icon button takes its pressed shape. No scale.
- 03.11 changed:
  - An accepted change ticks the value (short slide, tabular digits), the field flashes `accentSoft` with an accent numeral for 300 ms, and one light haptic plays (`GymHaptics.ticked`, 04).
  - Every − / + is 48 × 48 dp; ladder keys are 56 dp tall.
  - With reduce motion on, colour only. **Log set** stays silent.
- Delete `Modifier.pressed`.

**Out of scope:** the rack's head, units and ladder layout (09); Fix set's other rows (10); the combined movement editor (18).

**Done when**
- Screenshots of 03.2, 03.10 and 03.11 match in Dark and Daylight; the rig (01) adds `03.2-load-keyboard-dark/light`, `03.10-rack-pressed-dark/light`, `03.11-rack-changed-dark/light`.
- TalkBack adjusts both steppers (custom actions *Increase* / *Decrease*) and reads the unit. Verify direct negative entry, sign flip, editing and commit in rack, Fix set and combined editor with an IME that lacks minus; invalid text never replaces the last committed value. Capture small-height and large-font focus/error states against 09/18.
- `gym_set_logged` is unchanged. A rack edit the store refuses still reports under `gym.editRack` only when unexpected.
- After the signed-input migration gate passes, replace keypad-specific tests with equivalent NumberStepper/sign-entry assertions and retain their refusal cases in domain tests; do not delete coverage before its replacement runs. Update Fix set, logger and haptic tests.

**Depends on:** 04.

**Ledger:** 11d; dogfood `android-gym-target-page`.
