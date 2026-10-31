# Barbell and dumbbell loads are 0 or more on every surface; the field shows a real minus sign

**Status:** 🔨 Implemented on its branch, not merged. Kotlin, Swift and web pass the shared vectors; no server validates a load bound, so the backend is unchanged. The boards flip to 🚀 after merge.

**Figma:**
- 02.21 Movement editor, load below zero: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-39774) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-40098)
- 03.33 Fix set, load below zero: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-40425) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-40717)

**Current implementation**
- Signed load fields (number | signed | decimal, IME `0x3002`) exist on purpose: assisted machines take a negative load.
- A barbell *total* of −12.5 kg is accepted in routine targets and in Fix set. To reproduce: type −12.5 into a barbell movement's Load in the editor, or in Fix set, and press Done.
- The field types a hyphen while the summary shows a minus sign.
- The "kg blank: pick it at the rack…" hint stays visible after a load is entered.
- No shared vector pins a lower bound per equipment, so iOS, web and Android can disagree.

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
