# The Finish receipt opens full height at large text and never hides Performed

**Status:** 🚀 On main (`ef0f05fb`), in Android 0.14.0. Boards 03.36 and 03.15 are 🚀 In production.

**Figma:**
- 03.36 Receipt at 200 %: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41620) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41702)
- 03.15 First workout, signed out: [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-42292)

**Current implementation** (`FinishScreen`, hosted in `GymRoom`'s `WindmillSheet`)
- **Height:** at large text (font scale above 1.3) the receipt takes the sheet's whole height; otherwise it stands at its board height (815 dp, 465 dp for a slight workout) and grows to hold every fact, up to the sheet's height.
- **Body:** the body scrolls under the pinned *Share with Coach* and *Done*. Signed out, every fact, the *Only on this phone · Keep it* line and *Performed* stand above them, or scroll into view whole.
- **Facts:** the three facts share one row, and wrap two to a row at large text or on a sheet narrower than 270 dp. A value keeps one line, shrinking from 32 sp to a 16 sp floor. A value too wide even at the floor stays at 16 sp and wraps at the space before its unit, so the number keeps one line wherever one line can hold it.
- **Actions:** *Share with Coach* and *Done* are Material `FilledTonalButton` and `Button` (`ReceiptAction`) at the 16 sp label, 24 dp side padding and 16 dp corners. The label keeps one line and, at 320 dp / 200 %, runs into the side padding as 03.36 draws it.
- **Tests:** `FinishLayoutTests.atLargeTextTheReceiptOpensFullHeightWrapsTheFactsTwoToARowAndScrollsToPerformed`, `signedOutAtNormalTextEveryFactAndPerformedStandAboveThePinnedActions`, `atLargeTextAVolumeNoSizeFitsWholeKeepsItsNumberOnOneLineAndDropsOnlyItsUnit` and `atTheLargestTextBothReceiptActionsAreMaterialButtonsWithOneLineLabelsInsideThem`. The rig's `finish.json` 03.15 recipe adds the three board movements through the movement sheet (02.22) and logs 3, 1 and 1 sets.

**Change**
- **Large text (03.36):** at large text the sheet opens full height. The body scrolls under the pinned *Share with Coach* and *Done*, and the facts wrap two per row.
- **03.15:** at normal text, signed out, every fact, Performed included, is visible above the pinned buttons, or reachable by scrolling, which reveals the whole row.

**Done when**
- 03.36 and 03.15 match in Dark and Daylight. Recapture the rig's `03.15` recipe: its picker step is stale, because picking a movement now opens 02.22.
- Tests: at 200 % the sheet is fully expanded and Performed can be scrolled to; signed out at 1×, Performed is not covered by the pinned buttons.

**Depends on:** 14.
