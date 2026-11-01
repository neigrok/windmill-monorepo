# Real Material buttons, a real disabled Log set, and icons instead of text chevrons

**Status:** 🔨 Built, awaiting merge. Conformance to approved boards and the native-idiom rule (`docs/design/guidelines/system-architecture.md`, ledger 11n).

**Figma:**
- Disabled state as drawn on 02.16 (Done at 38 %): [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1443-19406)
- You sheet rows with icons: Shell 16b [board](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-4408)
- The Coach proposal look stays as it is (ledger 11k keeps the proposal redesign deferred, tasks 29–35).

**Current implementation**
- Primary buttons are Material 3 buttons that keep their colours through `ButtonDefaults`:
  - **Log set** (`ui/LoggerScreen.kt`) is a `Button`. Disabled, it draws 02.16's Done: accent and on-accent at 38 %. While Finish is in flight, it draws the raised wait.
  - Apply (`ui/ReviewSheet.kt`) is a `Button` whose disabled colours keep the 40 % look; Turn this down is a `TextButton`.
  - Share and revoke (`sharing/WorkoutShareCard.kt`) are a `Button` (38 % while the link is being made) and a `TextButton`.
- The custom surfaces that remain clip to their shape before `clickable` (log workout rows, the workout detail's Share this workout, On this phone rows), so ripples stay inside.
- `ui/NativeControls.kt` `GymExtendedFab` is M3 `ExtendedFloatingActionButton`. On the Log, *Weigh in* collapses to its icon while the list is scrolled and keeps "Weigh in" as its accessible name.
- The You sheet's rows end in the `you_chevron` drawable with no content description; a row reads its label alone.
- Icons come from drawables and the core `Icons` set. `GymGlyph`, the `glyph()` builder and the hand-written drag-handle path are gone; the logger's cloud-off mark is the `gym_cloud_off` drawable.
- Tests: `LoggerScreenTests` (a disabled Log set is a disabled button and a tap logs nothing), `LogWeightRowsTests` (*Weigh in* collapses on scroll and expands at the top), `YouSheetTests` (each row's merged text is its label and it has no content description).

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
