# Shared native parts: FAB, extended FAB, error buttons, menus, the swipe row, the number stepper

**Figma:**
- 00.4 Native anatomy primitives: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38403) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46495)
- Components (Design System library, Android page):
  - `Android / FAB` `337:2110`: Default and Pressed, the (+) and the extended *Weigh in*
  - `Android / Button` `210:181`: Tone=Error, Filled and Text
  - `Android / Menu` `342:2725`
  - `Android / Swipe row` `337:2217`: Rest, Swiping, Past threshold
  - `Android / Number stepper` `337:2514`: Default, Pressed, Changed, Focused
  - `Android / Keyboard` `337:2403`: Decimal

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- No `FloatingActionButton` anywhere in gym.
- No error-toned button. Destructive controls are brick, ink or accent text (02 fixes the colour; the screens follow in their own tasks).
- Menus are `DropdownMenu` on `raised` with text-only items, e.g. the routine menu's *Delete* in ink (`ui/RoutinesScreen.kt:241-242`).
- Swipe rows: `rememberRowDismiss` (`ui/RowSwipe.kt:44-63`) with `SwipeToDismissBox` and the default positional threshold. The ground is `RowDeleteGround` (:68-81): the word *Delete* in mono 13 Bold, `alarmInk`, on `alarmInk` at 18 %, no icon.
- Number entry is a custom keypad sheet (`ui/KeypadSheet.kt`) or 56 dp `raised` ± keys. Pressing only scales to 0.96 (`Modifier.pressed`, `ui/LoggerScreen.kt:1009-1020`).
- `GymHaptics` (`ui/GymHaptics.kt:11-16`) has `revealed`, `saved` and `finished`. Nothing ticks on a value change.

**Change**
- Build these once, in `ui/`, matching 00.4 in both modes:
  - **FAB:** M3 `FloatingActionButton` (+), and `ExtendedFloatingActionButton` (icon + label). Bottom end, 16 dp from the edge. The list under it gets a bottom inset so the last row stays clear.
  - **Error buttons:**
    - Filled·Error (e.g. **Discard**): `Button` with `containerColor = colorScheme.error`, `contentColor = colorScheme.onError`.
    - Text·Error (e.g. **Delete weigh-in**, **Delete note**): `TextButton` with `contentColor = colorScheme.error`.
  - **Menu:** `DropdownMenu` on the card surface, `DropdownMenuItem` with a leading icon. A destructive item paints its icon and label in `colorScheme.error`.
  - **`DeleteSwipeRow`** in `ui/RowSwipe.kt`, replacing `RowDeleteGround`:
    - `SwipeToDismissBox`, end-to-start only, keeps `rememberRowDismiss`.
    - Ground: full-bleed `colorScheme.error` with `Icons.Outlined.Delete` in `onError`. No word.
    - The caller passes the accessibility label that names the act (*Delete routine*, *Remove movement*, *Delete set*, *Discard workout*, *Delete weigh-in*, *Delete note*, *Delete conversation*).
    - `revealed` haptic at the threshold, as today.
  - **`NumberStepper`** in a new `ui/NumberStepper.kt`:
    - 48 dp `FilledTonalIconButton` − and + around a filled `TextField` with a label and a `suffix` unit (*kg each*, *reps*, …).
    - Tapping the value focuses the field. `KeyboardType.Decimal` for loads, `KeyboardType.Number` for counts; `ImeAction.Done` commits.
    - Sizes: Regular, and Display for the rack's load numeral.
    - Pressed: the M3 state layer (on-surface 12 % over the tonal container), not a scale.
    - Changed: the value ticks (`AnimatedContent`, short slide, tabular digits), the field flashes `accentSoft` for 300 ms, and one light haptic plays. With reduce motion on, colour only.
    - Refusals show as the field's supporting text.
- Add a `GymHaptics.ticked()` for an accepted value change.
- Delete `Modifier.pressed` once 07 and 09 use the stepper.

**Out of scope:** using the parts on each screen (05, 07, 09, 10, 17, 18, 22); the top bar (03).

**Done when**
- Screenshots of 00.4 match in Dark and Daylight; the rig (01) adds `00.4-native-parts-dark` / `00.4-native-parts-light` from a debug-only specimen screen.
- No new events: these are parts. The screens that use them carry the events.
- New Compose tests cover the swipe row's label and one-direction settle, the stepper's IME commit and its refusal text. `ui/RowSwipeAccessibilityTests.kt` and `ui/HapticVocabularyTests.kt` are updated for the new ground and the new haptic.

**Depends on:** 02.

**Ledger:** 11c, 11d, 11f; dogfood `android-gym-target-page`.
