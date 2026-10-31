# Real Material buttons, a real disabled Log set, and icons instead of text chevrons

**Status:** ✅ Conformance to approved boards and the native-idiom rule (`docs/design/guidelines/system-architecture.md`, ledger 11n). Not started.

**Figma:**
- Disabled state as drawn on 02.16 (Done at 38 %): [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1443-19406)
- You sheet rows with icons: Shell 16b [board](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-4408)
- The Coach proposal look stays as it is (ledger 11k keeps the proposal redesign deferred, tasks 29–35).

**Current implementation**
- Primary buttons are drawn as `Box.background(accent).clickable`:
  - Apply and Turn down (`coach/ReviewSheet.kt`)
  - share and revoke (`sharing/WorkoutShareCard.kt`)
  - **Log set** (`ui/LoggerScreen.kt`)
- Their disabled states:
  - Log set has no disabled visual when `enabled == false` and it isn't finishing: it stays accent-filled and looks tappable.
  - Apply fakes disabled with `alpha(0.4f)`.
- Ripples spill outside rounded shapes where `.background(shape)` comes before `.clickable` with no clip.
- `ui/NativeControls.kt` `GymExtendedFab` rebuilds `ExtendedFloatingActionButton` from `FloatingActionButton + Row` and loses collapse-on-scroll.
- The You sheet's rows end in a text "›", which TalkBack reads aloud.
- Icons come from four sources: drawables, `GymGlyph` (`ui/GymSkin.kt`), a `glyph()` builder in `LoggerScreen.kt`, and a hand-written path beside `Icons.Filled.DragHandle` in `GymScreen.kt`.

**Change**
- **Buttons:**
  - Log set, Apply, Turn down, share and revoke become M3 `Button`, `FilledTonalButton` or `TextButton`. Each keeps its current colours through `ButtonDefaults.buttonColors`, and gets the real disabled state.
  - Log set's disabled state matches 02.16's Done.
- **Ripples:** clip to the shape before `clickable` wherever a custom surface remains.
- **FAB:** `GymExtendedFab` becomes M3 `ExtendedFloatingActionButton` with `expanded` tied to scroll.
- **You sheet:** rows use icons, not "›".
- **Icons:** one source, drawables or `Icons`. Delete `GymGlyph`, the `glyph()` builder and the hand-written path.

**Done when**
- Recaptures of the rack (03.1), the review sheet, the share card, the routines FAB and the You sheet match their boards in Dark and Daylight.
- Tests:
  - Log set disabled is not clickable and reads as disabled to accessibility.
  - The extended FAB collapses on scroll.
  - The You rows' content descriptions contain no "›".

**Depends on:** 04.
