# The last three destructive actions use the error role

**Status:** Waits for the designer to confirm that 00.2 and 00.4 are ✅ Ready for dev: design brief item QW11. Conformance to the owner's ruling of 2026-10-22 (ledger 11c).

**Figma:** 00.2 [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-43776) and 00.4 [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38403).

**Context:** destructive actions use the M3 error role. Three Android controls still draw in ink or in an off-role red, so the one action that cannot be undone looks like any other.

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- The log row menu's *Discard workout* is a default (ink) menu item (`ui/LogScreen.kt:354`).
- The receipt overflow's *Discard* is ink (`ui/FinishScreen.kt:287`).
- History's *Delete* confirm uses `MaterialTheme.gymColors.alarmInk` (`coach/ThreadsScreen.kt:182`), which differs from the scheme's `error` (`ui/GymSkin.kt:40,49`).
- `GymMenuItem(destructive = true)` already uses `colorScheme.error` (`ui/NativeControls.kt:107`).

**Change**
- The two menu items use `GymMenuItem(destructive = true)`. History's confirm uses the error-role button that the other delete confirms use.
- Update ledger 11c so it no longer lists them.

**Done when**
- Each control matches 00.2 / 00.4 in Dark and Daylight on the rig (`colour-roles.json`).
- Tests assert the error colour on all three.

**Depends on:** 02, design brief QW11. Tree: `android-destructive-error-role`.
