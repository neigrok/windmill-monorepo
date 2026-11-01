# Undo rises above a Weigh-in button that never moves, and lasts the system's accessibility timeout

**Status:** 🚀 On main (`ef0f05fb`), not yet in a published release. Board 05.17 is 🚀 In production; 05.16 is deleted.

**Figma:** 05.17 Log, weigh-in Undo: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41789) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41887). Superseded once this ships: 05.16 [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1447-20658).

**Current implementation**
- The Log and Routines screens host the room's transient in their own `GymScreen` Scaffold (`snackbarHost` and `floatingActionButton` slots), so the snackbar sits above *Weigh in* and *New routine* and neither button moves. Other frames keep the transient in the room's bottom bar.
- `GymRoom` reads `accessibleUndoWindowMs`, which is `AccessibilityManager.getRecommendedTimeoutMillis(9_000, FLAG_CONTENT_CONTROLS | FLAG_CONTENT_TEXT)` floored at `Withheld.windowMs = 9_000L`, on every resume and sets it as `DeletionsStore.undoWindowMs`.
- `DeletionsStore.withhold` passes that window to `EngineTraining.holdBodyweight`, whose engine gesture carries it as `Gesture.holdMs`; the engine stamps `releaseAt` from its own clock. The store keeps its injected clock.
- A log read from its top stays at its top when Undo brings a newer day back above the first row drawn, so the restored row is in view (`LogScreen`).
- The capture rig's `log.json` weight-undo recipe sets a 30 s accessibility timeout (`accessibility_timeout_ms`), so its Undo tap lands after the screenshot.
- Tests: `LogTransientTests` (the FAB's bounds with and without the snackbar in Dark and Daylight at 200% text; a 20 s timeout keeps Undo past nine seconds and restores the weigh-in), `LogWeightRowsTests` (a restored newest day returns into view), `HarnessTests` (a gesture's own hold length).

**Change**
- **Placement:** the snackbar rises above the FAB, which never moves. This is the standard Scaffold layout: the snackbar host sits above the FAB slot.
- **Hold time:**
  - The hold is the system accessibility timeout, `AccessibilityManager.getRecommendedTimeoutMillis(9_000, FLAG_CONTENT_CONTROLS | FLAG_CONTENT_TEXT)`, and never less than 9 s.
  - Compute the duration where it is shown, then pass it into the store's withheld window as an injected value. The store still stamps instants from its injected clock, and nothing reads an ambient clock.
- **Docs:** `docs/design/guidelines/system-architecture.md` §3 law 2 already states the Android rule.

**Done when**
- 05.17 matches in Dark and Daylight, and `log.json`'s weight-undo recipe passes: its Undo tap lands.
- Tests:
  - The FAB's bounds are identical with and without the snackbar.
  - The hold equals the accessibility timeout when that is longer than 9 s.
  - Undo inside the window restores the weigh-in.

**Depends on:** 05, 24.
