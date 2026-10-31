# Barbell and dumbbell loads are 0 or more on every surface; the field shows a real minus sign

**Status:** 🚀 On main (`70ec2dbe`), not yet in a published release. Boards 02.21 and 03.33 are 🚀 In production.

**Figma:**
- 02.21 Movement editor, load below zero: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-39774) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-40098)
- 03.33 Fix set, load below zero: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-40425) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-40717)

**Current implementation**
- **Rule:** `ExerciseRules.loadFloor` gives Barbell and a pair of Dumbbells a floor of 0; Bodyweight, Other and a single dumbbell keep their sign, so an assisted machine still takes a negative load. Kotlin `:gym:domain`, Swift `GymDomain` and web `web/src/products/gym/domain` pass the shared vectors in `packages/api-contract/gym/domain/` (`training-actions.json`, `routines-actions.json`, `recovery-actions.json`).
- **Scope:** the floor guards a load a person enters now, on every surface: Barbell and Dumbbells refuse below 0 when a set is logged, fixed, entered as a past workout, corrected as a session, edited in a recovery fix, or saved as a routine target. Facts already recorded (signed-out workouts adopted, owed sets and fixes replayed after an upgrade, stranded sets recovered, untouched loads in a correction) replay through each action's `recorded` door and are never refused by it.
- **Android:** the movement editor shows **Load, 0 or more.** inline and Done waits; the hint shows only while Load is empty. Fix set shows **Enter 0 or more, or cancel to keep {kept}** and Save fix waits. The rack and Fix set steps stop at 0, and a kept legacy load under 0 cannot be stepped down. Every load field and readout draws the minus sign U+2212.
- **iOS and web** surface the refusal through their existing inline refusal lines. No server validates a load bound, so the backend is unchanged.

**Change**
- **Shared rule:**
  - Barbell and Dumbbells refuse a load below 0. Bodyweight and Other keep their sign.
  - Add the cases to the right file in `packages/api-contract/gym/domain/` (targets and set corrections) and make every implementation pass them: Kotlin `:gym:domain`, Swift `GymDomain` and web `web/src/products/gym/domain`.
  - Use the `domain-feature` skill.
- **Server:** check whether the backend or either model server validates loads on write (`GymRules.cpp`, `GymServerRules.swift`, `GymServerRules.kt`). If one does, apply the same bound there, so no phone accepts a value the server refuses, or the reverse.
- **Android editor (02.21):**
  - A barbell or dumbbell load below 0 shows **Load, 0 or more.** inline, and Done waits.
  - The hint shows only while Load is empty.
- **Android Fix set (03.33):** shows **Enter 0 or more, or cancel to keep {kept}** (e.g. 75), and Save fix waits.
- **Minus sign:** every load field and readout shows the minus sign U+2212, never a hyphen.
- **iOS and web:** surface the refusal through their existing inline-refusal idiom. No new layout.

**Done when**
- 02.21 and 03.33 match in Dark and Daylight.
- The shared vectors pass on Kotlin, Swift and web; the backend's ctest passes if the backend changed.
- Tests:
  - Negative barbell and dumbbell loads are refused in the editor and in Fix set.
  - Negative Bodyweight and Other loads are accepted.
  - The field shows U+2212.
  - The hint hides once a load is typed.
- Refusals are events, never Sentry Issues; list any new label in `docs/ANDROID_OBSERVABILITY.md`.

**Depends on:** 07, 10, 18.
