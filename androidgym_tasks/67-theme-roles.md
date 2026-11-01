# Type and colour come from the theme's roles

**Status:** Refactor; nothing visual changes. Done on `wave-67`, not yet on main. Robolectric captures (native graphics) of 61 states in Dark and Daylight — every screen preview, a tour of the room from Routines to the hidden workout bar, the onboarding's four pages and the shell's You, sign-in and delete-account screens — are pixel-identical to `main` outside the live clocks; every role also equals, field for field, the style its screen drew before. The emulator rig recipes have not been recaptured.

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- **Colour:** screens read the standard roles from `MaterialTheme.colorScheme` and the four the scheme has no slot for — faint ink, record ink, record wash and refusal ink — from `GymExtendedColors`, which `GymMaterial` provides beside the scheme and screens read as `MaterialTheme.gymColors` (`ui/GymMaterial.kt`).
  - `ui/GymSkin.kt` holds the two palettes from the colour-roles board. Each skin colour sits in exactly one scheme slot: canvas → `surface`, surface → `surfaceContainer`, raised → `surfaceContainerHighest`, line → `outlineVariant`, line strong → `outline`, accent → `primary`, on accent → `onPrimary`, accent soft → `primaryContainer`, ink → `onSurface`, ink dim → `onSurfaceVariant`, set done → `tertiary`, and error, on error and scrim by name.
  - `inkFaint` is the skin's own board value (#727771 Dark, #625C58 Daylight). The shell palette's `inkFaint` was `inkDim` under another name in the gym room; it is gone, and You's drag handle reads `inkDim`.
  - Delete account's confirm ink is the scheme's `onError`; the brand scheme carries the same dark `onError`.
  - The onboarding glimpses keep the roadmap and journal rooms' colours and the brand hues in one `GlimpsePalette` (`ui/onboarding/OnboardingGlimpses.kt`); gym's glimpse and the pager draw from the theme.
- **Type:** three sources of roles, and screens read only these.
  - `MaterialTheme.typography` (`gymTypography`, `ui/GymType.kt`): the 15 slots Material's own parts read — Text's default, buttons, fields, dialogs, the date picker, list items. Their values are unchanged. `withStockFields` and `withStockSnackbar` give the outlined fields and the snackbar the platform's own type.
  - `WindmillType` (`platform/design/Tokens.kt`): the brand's reading ramp in the system sans — body, paragraph, label, supporting, detail, caption, kicker and their line-height forms — and the shell's titles. The sign-in door, You and delete account read it, and so does gym prose.
  - `GymType` (`ui/GymType.kt`): every other style a gym screen draws, grouped by part of the room — chrome, native controls and the number stepper in Nunito, readouts in the system mono, the workout, Finish, the log, routines, confirmations, Coach in Nunito, onboarding. `GymChrome`, `GymNativeType`, `CoachType` and the screen-local style objects are gone, and so are the unused weight, reps and readout numerals.
  - Each role holds the size, weight, line height and figures its screen drew. No screen maps onto a Material slot: the slots carry tabular figures and no line height, the screens' sans styles neither, so mapping would move pixels (`docs/design/consistency.md` 11x).
- **Fonts:** `GymFonts` (`ui/GymType.kt`) builds the bundled faces once from `res/font/`: `nunito_*`, `jetbrains_mono_*`, `inter_*` (the glimpses' specimens) and `baloo2_bold` (the brand word).
- **Guard:** `app/src/test/kotlin/works/windmill/app/ThemeRolesTests.kt` reads every `app`, `platform` and `gym` source, debug included: a literal `.sp` or a `WindmillFont.` call appears only in `Tokens.kt` and `GymType.kt`, and a hex colour only in `Tokens.kt`, `WindmillMaterial.kt`, `GymSkin.kt` and the glimpse palette.
- **Dynamic colour** stays off: the brand palette is fixed (`docs/design/consistency.md` 11x).

**Observations**
- `WindmillType` holds 19 roles and `GymType` 114 styles where 00.2 draws ten; 11x lists the drift. Once the designer rules, a role's value changes in one place and every screen that reads it follows, and screen-specific roles fold into shared ones.
- `GymType`'s sections follow the room's parts, so a screen's styles sit next to each other. Some roles share a value under two names (a native row title and the button, Finish's action and the onboarding's), because their screens may part when the ramp converges.

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
