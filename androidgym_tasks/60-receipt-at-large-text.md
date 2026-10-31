# The Finish receipt opens full height at large text and never hides Performed

**Status:** ✅ Ready for dev. The owner approved 03.36 on 2026-10-31; 03.15 is approved already. Not started.

**Figma:**
- 03.36 Receipt at 200 %: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41620) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41702)
- 03.15 First workout, signed out: [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-42292)

**Current implementation** (`FinishSheet`/`FinishScreen`)
- **Signed out:** the line *Only on this phone · Keep it* pushes *Performed* under the pinned buttons. The movement name is clipped and the sheet does not open far enough (finish a first workout while signed out).
- **At 320 dp / 200 %:**
  - The stats stack vertically, so Volume and Performed fall off-screen.
  - "Share with Coach" wraps.
  - The sheet will not grow (finish any workout at 320 dp / 200 %).

**Change**
- **Large text (03.36):** at large text the sheet opens full height. The body scrolls under the pinned *Share with Coach* and *Done*, and the facts wrap two per row.
- **03.15:** at normal text, signed out, every fact, Performed included, is visible above the pinned buttons, or reachable by scrolling, which reveals the whole row.

**Done when**
- 03.36 and 03.15 match in Dark and Daylight. Recapture the rig's `03.15` recipe: its picker step is stale, because picking a movement now opens 02.22.
- Tests: at 200 % the sheet is fully expanded and Performed can be scrolled to; signed out at 1×, Performed is not covered by the pinned buttons.

**Depends on:** 14.
