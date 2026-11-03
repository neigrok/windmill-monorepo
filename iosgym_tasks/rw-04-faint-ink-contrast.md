# Gym faint ink passes 4.5:1 in Dark

**Status:** Designed (🚧, awaiting owner approval); not built.

**Figma:** the Design System library's `dark/ios/gym/ink-faint` is raised to `#898E88` (2026-11-03; it reaches the Gym file once published and accepted). Android's twin is approved and built (Gym Android 05.21, [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1847-29462)).

**Context:** Dark `gym/ink-faint` `#727771` reads 3.77:1 on `gym/card` `#161C1D` and 4.17:1 on `gym/canvas` `#0B1111`, yet iOS uses it for text: planned ledger rows and their marker (`Gym/Workout/WorkoutScreen.swift:381`, `:383`) and Edit sets' row numbers (`Gym/Workout/EditSets.swift:182`). `#898E88` reads 5.16:1 on card, 5.70:1 on canvas, 4.60:1 on raised; ink-dim `#B6B5AF` stays 8.39:1, so faint stays the quietest text.

**Current implementation**
- `apps/ios/App/Sources/Theme/Theme.xcassets/gym/ink-faint.colorset`: Dark `#727771`, Light `#625C58` (Light passes).
- `docs/design/ios/ios-redesign.md` gym role table and its *never* list ("ink-faint on an essential label — below 4.5:1 on both night canvases"); `apps/ios/App/Tools/tests/test_theme_assets.py` checks the table against the assets; `apps/ios/App/Tests/Theme/PalettesTests.swift`.

**Change:** Dark `gym/ink-faint` → `#898E88` in the asset and the role table; the *never* line names journal and shell only. Light unchanged.

**Done when:** `test_theme_assets.py` and `PalettesTests` pass with the new value; planned rows and Edit sets numbers render `#898E88` in Dark.

**Depends on:** nothing. Tree: `ios-rw-04-faint-ink`, under `ios-review-wave-parity`.
