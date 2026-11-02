# Dark faint ink clears small-text contrast; modal sheets stop at 560 dp

**Status:** On main. Checked on an API 36 emulator: in Dark, the workout page's set numbers and “Plan saved at start” render in `#898E88` (pixel sample of the screenshot); at 864 dp the Fix set sheet is 560 dp wide and centred, and at 411 dp it is full width. `:gym`, `:platform` and `:app` unit tests are green, and the contrast test pins the exact ratios in both modes. Not yet done: a comparison against boards 05.21 and 02.27 before they are marked 🚀. F2, the Target row on board 02.26, is not built; it waits for the board's spacing values.

**Context:** the Dark faint-ink role is used for small workout-page text, and Material's default sheet width exceeds the approved 560 dp bound. The orchestrator authorizes F1 and F3, including the shell's You sheet, with existing sheet radius, handle and vertical behavior retained.

**Figma:** 05.21 [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1847-29462) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1847-29519); 02.27 [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-31939) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-32056). Production prefixes are owned by the orchestrator.

**Current implementation** (paths under `apps/android/`)

- `gym/…/ui/GymSkin.kt` sets Dark `inkFaint` to `#898E88`; Daylight remains `#625C58`. Existing consumers retain type, layout and semantics.
- `gym/…/ui/GymMaterialTests.kt` checks the palette specimen and exact contrast ratios on canvas, surface and raised in both modes, using the shared `ui/Contrast.kt` helper also used by `RoomChromeTests`, with faint ink quieter than dim ink on surface.
- `platform/…/design/WindmillSheet.kt` supplies a local `sheetMaxWidth = 560.dp` to the sole production `ModalBottomSheet` call. Its cancelled Back gesture resets the preview and aborts the close; only a cancelled coroutine rethrows cancellation.
- `platform/…/design/WindmillSheetTests.kt` exercises that shared sheet at 840 dp and 412 dp, asserting width and both horizontal edges. Existing gesture tests retain cancellation coverage.
- No new user-facing sentences, user steps, failure boundaries or telemetry.

**Done when**

- F1's regression passes on all three grounds in both modes, preserving the quietest text role.
- F3's regression proves a centred 560 dp sheet at 840 dp and full-width sheets at 412 dp; native rendering retains the existing radius, handle and vertical behavior.
- The orchestrator reviews and runs the gym/platform tests plus `ThemeRolesTests` and completes native verification.

**Open**

- F2: the Target row remains unchanged. Board 02.26's spacing, stacked alignment, type/roles and reading order must be read before implementation.
- S1: preserve “Sets”, “Check Sets”, “Vary by set”, “N sets · varies”, “Set”, “Set N reps”, “Set N load”, and the workout-page “5 sets · 3 movements” readout pending the owner's ruling.
- iOS `dark/ios/gym/ink-faint` remains `#727771` (`docs/design/ios/ios-redesign.md`, `PalettesTests.swift`). Web's gym-night `--neutral-500` remains `#727771`; the grandfathered row in `docs/design/guidelines/system-architecture.md` still describes web. The orchestrator carries these open differences into 11z's D4/D5/D7 when that ledger entry lands; this package does not edit the ledger.

**Observations**

- The shared sheet owns the bound without a host override or new token. A shared width token waits for 00.9.
- Sheet handles use different existing inks: Finish uses `inkFaint`, the builder `onSurfaceVariant`, and You `inkDim`. No board here changes those roles.

**Depends on:** 02, 67; approved 05.21 and the orchestrator's 02.27 width ruling. Tree: `android-115-faint-ink-sheet-width`.
