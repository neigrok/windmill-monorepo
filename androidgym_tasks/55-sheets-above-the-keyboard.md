# Sheets stay below the status bar when the keyboard opens

**Status:** ✅ Conformance to approved boards. Not started.

**Figma** (each draws a sheet with the keyboard up and its handle clear of the status bar):
- 02.24 Movement editor, Load keyboard: [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1452-22388). Its caption reads "Native IME insets resize the sheet".
- 02.16 Movement editor: [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1443-19406)
- 03.2 Rack with the keyboard: [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28178)

**Current implementation**
- When the keyboard opens, Fix set, the movement editor and Add movement expand under the status bar. Their drag handle sits about 30 px into the 63 px status band.
- Evidence from the 2026-10-31 review: `runs/rack/03.3-fix-set-keyboard-light.png`, `runs/targets/02.12-combined-load-keyboard-dark.png`, `manual/m06-load-keyboard.png`.
- `adjustResize` and `imePadding` work for screens. The fault is in how `ModalBottomSheet` content and window insets combine.

**Change**
- Fix this once, at the shared sheet layer (`:platform` design, where the room's sheets are built), not per sheet. A sheet with the keyboard up stops below the status bar.
- Its content resizes above the keyboard, and its focused field stays visible.

**Done when**
- Fix set, the movement editor, Add movement and the routine name field, keyboard up: captures match the boards in Dark and Daylight. The rig recipes for 02.24 and 03.3 show the handle below the status band.
- A test pins it: with the IME showing, the sheet's top is at or below the status-bar inset.

**Depends on:** 04.
