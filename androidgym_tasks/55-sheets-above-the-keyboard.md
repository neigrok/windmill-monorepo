# Sheets stay below the status bar when the keyboard opens

**Status:** Implemented, awaiting merge.

**Figma** (each draws a sheet with the keyboard up and its handle clear of the status bar):
- 02.24 Movement editor, Load keyboard: [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1452-22388). Its caption reads "Native IME insets resize the sheet".
- 02.16 Movement editor: [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1443-19406)
- 03.2 Rack with the keyboard: [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28178)

**Current implementation**
- `WindmillSheet` (`apps/android/platform/.../design/WindmillSheet.kt`) pads every sheet by the status bar read in the sheet's own window, so a sheet taller than the room above the keyboard stops at the status bar and its content resizes above the keyboard. `WindmillSheetTests.withTheKeyboardUpATallSheetStopsBelowTheStatusBar` pins it with the IME showing.
- Fix set (`gym/.../ui/FixSheet.kt`) keeps Save fix below its scrolling fields, so the keyboard never covers it; while the keyboard is up, Delete set and the routine line scroll with the fields, and the focused field is brought into view. `FixSheetLayoutTests.withTheKeyboardUpSaveFixStandsBelowTheScrollingFieldsAndDeleteScrollsWithThem` pins it.
- The boards stop the movement editor at the top app bar's line; the build stops every sheet at the status bar, as this task asks.

**Change**
- Fix this once, at the shared sheet layer (`:platform` design, where the room's sheets are built), not per sheet. A sheet with the keyboard up stops below the status bar.
- Its content resizes above the keyboard, and its focused field stays visible.

**Done when**
- Fix set, the movement editor, Add movement and the routine name field, keyboard up: captures match the boards in Dark and Daylight. The rig recipes for 02.24 and 03.3 show the handle below the status band.
- A test pins it: with the IME showing, the sheet's top is at or below the status-bar inset.

**Depends on:** 04.
