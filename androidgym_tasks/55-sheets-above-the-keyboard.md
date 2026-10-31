# Sheets stay below the status bar when the keyboard opens

**Status:** Implemented, awaiting merge. `WindmillSheet` pads its sheet by the status bar read in the sheet's own window, so a sheet taller than the room above the keyboard resizes its content there instead of sliding under the status band; `WindmillSheetTests` pins it with the IME showing. The boards stop the movement editor at the top app bar's line; the build stops every sheet at the status bar, as this task asks.

**Figma** (each draws a sheet with the keyboard up and its handle clear of the status bar):
- 02.24 Movement editor, Load keyboard: [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1452-22388). Its caption reads "Native IME insets resize the sheet".
- 02.16 Movement editor: [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1443-19406)
- 03.2 Rack with the keyboard: [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28178)

**Current implementation**
- When the keyboard opens, Fix set, the movement editor and Add movement expand under the status bar. Their drag handle sits about 30 px into the 63 px status band.
- To reproduce: open Fix set from a logged row, or the movement editor's Load field, so the keyboard comes up; the handle sits in the status band. The rig's `03.3` and `routine-targets` keyboard captures show it.
- `adjustResize` and `imePadding` work for screens. The fault is in how `ModalBottomSheet` content and window insets combine.

**Change**
- Fix this once, at the shared sheet layer (`:platform` design, where the room's sheets are built), not per sheet. A sheet with the keyboard up stops below the status bar.
- Its content resizes above the keyboard, and its focused field stays visible.

**Done when**
- Fix set, the movement editor, Add movement and the routine name field, keyboard up: captures match the boards in Dark and Daylight. The rig recipes for 02.24 and 03.3 show the handle below the status band.
- A test pins it: with the IME showing, the sheet's top is at or below the status-bar inset.

**Depends on:** 04.
