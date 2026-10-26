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

**Implementation status**
The approved 00.4 Dark and Daylight boards supply the shared anatomy. Controls are implemented
in `ui/NativeControls.kt`, `ui/NumberStepper.kt` and `ui/RowSwipe.kt`. The human-approved
[O overflow addendum](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1523-6723)
(2026-10-26) supplies the Display overflow and focused expansion rules. Full gym Debug passes
1,196 checks with 17 opt-in wire skips; all 33 focused Release and 32 capture-tool checks pass.
API 37 Dark/Daylight specimens verify full signed loads, native minus input, caret ends, 320dp/200%
text, pressed controls, menus and settled swipe removal. Existing screen consumers keep their current
controls until their numbered migration tasks; `RowDeleteGround` remains for those consumers,
and bidirectional Assembly/Refusal rows retain their own semantics.

**Change**
- Build these once, in `ui/`, matching 00.4 in both modes:
  - **FAB:** M3 `FloatingActionButton` (+), and `ExtendedFloatingActionButton` (icon + label). Consumers place them bottom end, 16 dp from the edge, and inset the list so its last row stays clear.
  - **Error buttons:**
    - Filled·Error (e.g. **Discard**): `Button` with `containerColor = colorScheme.error`, `contentColor = colorScheme.onError`.
    - Text·Error (e.g. **Delete weigh-in**, **Delete note**): `TextButton` with `contentColor = colorScheme.error`.
  - **Menu:** `DropdownMenu` on the card surface, `DropdownMenuItem` with a leading icon. A destructive item paints its icon and label in `colorScheme.error`.
  - **`DeleteSwipeRow`** in `ui/RowSwipe.kt`, alongside the legacy ground until each consumer migrates:
    - `SwipeToDismissBox`, end-to-start only, keeps `rememberRowDismiss`.
    - Ground: full-bleed `colorScheme.error` with the approved 24 dp delete symbol in `onError`. No word.
    - The caller passes the accessibility label that names the act (*Delete routine*, *Remove movement*, *Delete set*, *Discard workout*, *Delete weigh-in*, *Delete note*, *Delete conversation*).
    - `revealed` haptic at the threshold, as today.
  - **`NumberStepper`** in a new `ui/NumberStepper.kt`:
    - 48 dp standard icon-button touch targets, with a transparent resting 40 dp container and 24 dp −/+ symbols, around a native editable filled field. Its label sits above a baseline-aligned value/unit row (*kg each*, *reps*, …).
    - Tapping the value focuses the field. Signed decimal input for loads uses the native keyboard's minus key; `KeyboardType.Number` is for counts and `ImeAction.Done` commits. The owner approved native minus entry on 2026-10-25: retain the approved field sizing, add no app-level sign control, and verify negative decimal entry on the target emulator in 07.
    - Sizes: Regular is 56 dp high with JetBrains Mono Medium 20 sp / 24 sp value and Nunito Regular 16 sp / 24 sp unit. Display starts at 120 dp high with Nunito ExtraBold 88 sp / 92 sp value and Nunito Regular 22 sp / 28 sp unit. Native paragraph metrics may increase the field height; never clip the real editor to force its minimum. The flexible field uses 16 dp horizontal padding; value/unit gaps are 6 dp and 8 dp respectively.
    - Display overflow: retain 88sp inline when the signed numeral, unit and 4dp caret reserve fit. Otherwise put the 22sp unit below with 4dp spacing and fit the numeral from 88sp down to a 32sp floor before system scaling. The overflow field starts at 156dp and grows with content. If the floor cannot fit beside the controls, use full field width and place the same 48dp controls below, trailing aligned with 4dp between and 8dp above. Remeasure each edit; retain the most expanded layout until blur without reflow animation, preserving native focus/caret/selection. [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1526-7097) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1526-7422).
    - Pressed: the standard icon button shows an 8% on-surface-variant layer and native ripple; its visible 40 dp container has an 8 dp corner radius. No whole-control scale.
    - Changed: the value ticks (`AnimatedContent`, short slide, tabular digits), the field flashes `accentSoft` for 300 ms, and one light haptic plays. With reduce motion on, colour only.
    - Refusals sit 8 dp below the stepper, align with its outer leading edge and wrap at full width: Nunito Regular 14 sp / 20 sp in the error role. This composition is approved in [02.16](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1443-19406); it does not replace the value or unit.
- Add a `GymHaptics.ticked()` for an accepted value change.
- Tasks 07 and 09 remove their legacy pressed-scale modifier when their consumers migrate.

**Controlled input contract**
`NumberStepper(value, onValueChange, label, unit, onStep, onCommit)` receives raw text from its
consumer. `NumberStepperSize` is `Regular` or `Display`; `NumberStepperInput` is `Count` or
`SignedDecimal`. `onStep(NumberStep.Decrease/Increase)` and `onCommit()` return
`NumberEditResult.Changed`, `.Unchanged` or `.Refused`. Only `Changed` flashes the field and ticks.
Changed and unchanged commits complete IME Done; refused commits retain focus. The component
never parses text, imposes bounds, writes data or emits product events. Consumers own those rules,
controlled text, `refusal`, `enabled`, `decreaseEnabled`, `increaseEnabled` and `commitEnabled`.
`hapticsEnabled` carries the app preference; platform touch feedback still controls haptic delivery.
`reducedMotion` disables the digit slide and defaults from Android's animator setting. Signed decimal
entry adds Android's signed and decimal flags to the native input connection; no app sign button exists.
Valid signed loads retain every sign and decimal at rest and either caret end. The complete value
remains in the editor's accessibility semantics. Arbitrary overlong raw text remains editable at
the 32sp floor and receives consumer validation; it is never truncated or changed to fit.
The decorative digit slide is limited to values that fit their available width. Task 07 verifies
consumer entry with the native signed keyboard, including `-12.5`, `-102.5` and `-499.99`.


`DeleteSwipeRow(actionLabel, onDelete)` calls the suspending deletion request after end-to-start
settle, or through its named accessibility action. Returning `false` resets a refused/deferred swipe;
returning `true` leaves the accepted row to its consumer. Confirmation, removal, persistence and Undo
policy stay with the screen. `GymFab`, `GymExtendedFab`, `GymErrorButton`, `GymErrorTextButton`,
`GymMenu` and `GymMenuItem` supply native presentation with consumer callbacks. Destructive menu
items tint both label and icon through the error role.

**Out of scope:** using the parts on each screen (05, 07, 09, 10, 17, 18, 22); the top bar (03).

**Done when**
- Screenshots of 00.4 match in Dark and Daylight; the rig (01) adds `00.4-native-parts-dark` / `00.4-native-parts-light` from a debug-only specimen screen.
- No new events: these are parts. The screens that use them carry the events.
- New Compose tests cover the swipe row's label and one-direction settle, the stepper's IME commit and its refusal text. `ui/RowSwipeAccessibilityTests.kt` and `ui/HapticVocabularyTests.kt` are updated for the new ground and the new haptic.

**Depends on:** 02.

**Ledger:** 11c, 11d, 11f; dogfood `android-gym-target-page`.
