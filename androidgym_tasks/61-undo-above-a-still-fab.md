# Undo rises above a Weigh-in button that never moves, and lasts the system's accessibility timeout

**Status:** ✅ Ready for dev. The owner approved 05.17 on 2026-10-31. Once shipped, it replaces 05.16. Not started.

**Figma:** 05.17 Log, weigh-in Undo: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41789) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41887). Superseded once this ships: 05.16 [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1447-20658).

**Current implementation**
- `store/WithheldDelete.kt` holds a deleted weigh-in for a fixed `windowMs = 9_000L`, and `TrainingStore` takes it as `undoWindowMs`.
- When the snackbar closes, the *Weigh in* extended FAB drops into the space it left, under the lifter's finger. The capture rig's `log.json` weight-undo step taps Undo and opens the Weigh-in sheet instead.

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
- Delete Figma 05.16 after merge: superseded boards are deleted, not archived.

**Depends on:** 05, 24.
