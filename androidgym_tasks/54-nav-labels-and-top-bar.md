# Navigation labels stay whole at large text; the top app bar tints on scroll

**Status:** 🚀 On main (`ef0f05fb`), in Android 0.14.0. Board 00.7 is 🚀 In production; the top bar's scroll tint conforms to 00.1, which draws no scrolled state (ledger 11v).

**Figma:**
- 00.7 Navigation bar at 320 dp / 200 %: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1745-27419) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1745-27475)
- 00.1 Room chrome, top app bar: [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38215)

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `RoomChrome.kt`'s `TabRail` draws the M3 `NavigationBar`, at least 80 dp tall and growing with its labels. `RailLabels` measures each label: it keeps one line while it clears each neighbouring label by 8 dp and stays inside the bar, and otherwise wraps at its spaces. A label is never shrunk or ellipsized and may spill past its own item into the width a neighbour leaves. At 320 dp with 200 % text: *Routines*, *The / log*, *Coach*.
- `ui/GymScreen.kt`'s `TopAppBar` carries `TopAppBarDefaults.pinnedScrollBehavior()` over the screen's content, so every screen drawn through `GymScreen` tints its bar from the canvas to the card ground (`skin.surface`) once content scrolls under it, and back at the top.
- Tests: `RoomChromeTests` (whole labels at 320 dp / 200 % and 100 %, the wrapping rule), `ui/GymScreenTests` (the bar's ground at rest, scrolled and back). The rig captures `00.7-nav-large` and `00.1-bars-log-scrolled` (`tools/capture-recipes/room-chrome.json`) and recaptures `02.1-routines-large` (`routines-list.json`).

**Change**
- **Labels (00.7):**
  - Labels stay whole. A label may use its neighbours' spare width, and wraps only at a space: "Routines", "The / log", "Coach".
  - Text is never shrunk or ellipsized.
  - Keep the bar's height rule from 00.1 at 1× text.
- **Top bar:** attach `TopAppBarDefaults.pinnedScrollBehavior()` (or the behaviour 00.1 names) to each root's scrolling content, so the container tints once content scrolls under it.

**Done when**
- 00.7 matches in Dark and Daylight at 320 dp / 200 %. The rig recaptures `02.1-routines-large-*` and adds `00.7-*`.
- 00.1 matches at rest and scrolled.
- Tests:
  - At 200 % font and 320 dp, each label's text is the full word.
  - The top bar's container colour changes once its content scrolls.

**Depends on:** 03.
