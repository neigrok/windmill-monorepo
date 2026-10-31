# Type and colour come from the theme's roles

**Status:** Refactor; nothing visual changes. Not started.

**Current implementation**
- **Typography:** there are three parallel type systems.
  - About 300 direct `WindmillFont.*` calls, plus `GymChrome`, `GymNativeType` and about 30 `GymType.*`.
  - Roughly 20 `MaterialTheme.typography` reads, though `gymTypography` is installed (`GymMaterial.kt`).
  - About 260 literal `.sp` sizes.
- **Colour:**
  - About 140 `LocalGymColors` reads against about 20 `MaterialTheme.colorScheme` reads.
  - `gymPalette` maps `inkFaint = skin.inkDim` (`GymMaterial.kt`). That is a silent alias, either a bug or an unrecorded decision.
  - The onboarding glimpses hard-code about 30 hex colours (`ui/onboarding/OnboardingGlimpses.kt`, `OnboardingPager.kt`).
- **Fonts:** the app-wide Nunito and mono faces ship as `onboarding_*` fonts in `res/font/` (2.3 MB).
- **Dynamic colour** is off, and no decision is recorded anywhere.

**Change**
- **Type:** map `GymChrome`, `GymNativeType` and `WindmillFont` sizes onto `gymTypography` roles, and read `MaterialTheme.typography` everywhere. Keep only the roles the boards use.
- **Colour:** read standard roles from `colorScheme`. Fold the extras (`prInk`, `setDone`, `alarmInk` and similar) into one small `GymExtendedColors` provided beside the scheme.
- **`inkFaint`:** resolve the alias. Either give it its own value from the colour-roles board (task 02's `colour-roles.json`), or delete `inkFaint` and use `inkDim`.
- **Glimpses:** move the hard-coded colours onto roles.
- **Fonts:** rename the `onboarding_*` fonts to what they are.
- **Dynamic colour:** record the decision in `docs/design/consistency.md`. The brand palette is fixed, so dynamic colour stays off; ask the designer if that is not settled.

**Done when**
- Every rig recipe recaptures pixel-identical, or within the rig's tolerance, in Dark and Daylight. This is the proof that nothing moved.
- `grep` finds no `WindmillFont.` and no literal `.sp` outside the theme files, and no hex colour outside the theme and the glimpse palette object.

**Depends on:** 02.
