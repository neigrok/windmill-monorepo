# Navigation labels stay whole at large text; the top app bar tints on scroll

**Status:** ✅ Ready for dev. The owner approved 00.7 on 2026-10-31. The top bar's scroll tint conforms to 00.1, which is already approved. Not started.

**Figma:**
- 00.7 Navigation bar at 320 dp / 200 %: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1745-27419) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1745-27475)
- 00.1 Room chrome, top app bar: [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38215)

**Current implementation**
- `GymRoom.kt` draws the M3 `NavigationBar`. At 320 dp width with 200 % font, the labels clip to "Routine" and "The".
- `GymScreen.kt`'s `TopAppBar` has no `scrollBehavior`, so the scrolled-container colour never applies.

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
