# A movement with no plan has a heading that leaves no gap

**Status:** Waits for its board: design brief item QW1.

**Figma:** none yet. 05.3b draws the planned heading ([Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1782-26943) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1782-27019)); the planless heading comes from QW1 ([design brief](design-brief-quality-wave.md)).

**Context:** on a free workout (one with no plan, received from another surface) each movement heading keeps its 48 dp touch target with no line under the name. A blank gap sits where 05.3b draws *Plan 3 × 8 · 75 kg total* (ledger 11u).

**Current implementation**
- `ui/SessionScreen.kt`, `Performed.Against.Silent`: the heading holds `GymTap.minimum` with no second line.

**Change**
- Once QW1 is ✅ Ready for dev, the planless heading follows it. Keep the 48 dp target if the board keeps the heading tappable.
- Mark the board 🚀 In production when it ships.

**Done when**
- The free-workout heading matches QW1 in Dark and Daylight, at default and 200 % text.

**Depends on:** 23, design brief QW1. Tree: `android-planless-movement-heading`.
