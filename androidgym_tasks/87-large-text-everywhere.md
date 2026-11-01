# Every screen holds at 320 dp and 200 % text

**Status:** Not started. Conformance where a board draws the large-text state; undrawn states go to the designer (design brief QW4 and QW12) and wait.

**Context:** the native wave fixed large text where a board drew it: navigation labels (00.7), the rack (03.35) and the receipt (03.36). No sweep has covered every screen. Known gaps:
- the routine editor's Target summary overlaps at 320 dp / 200 %, postponed by the owner on 2026-10-29;
- a two-digit set count widens its column on the workout page (ledger 11u).

**Current implementation**
- Rig recipes set `"fontScale": 2` for some states: `compact-rack.json` (03.35), `finish.json` (03.36), `room-chrome.json` (00.7), and the Coach, edit-movement and native-parts recipes. These recipes set none: bodyweight, coach-history, coach-messages, colour-roles, connected-log, deletion-lifecycle, equipment-units, fix-set, hide-workout, log, notes, notification-clock, number-entry, on-this-phone, onboarding-gym, predictive-back, record, routine-targets, sign-in-fields, workout-detail and workout-tile.
- `android-routine-target-summary-responsive-design` keeps the Target summary layout unchanged by the owner's ruling.

**Change**
- Run every rig recipe at 320 dp width and 200 % font scale, in Dark and Daylight.
- Fix text that is clipped, overlapped or cut where the screen's board already settles the layout (wrap, scroll or unit-below, as 03.35 and 03.36 do).
- Anything that needs a new drawing goes to the designer as a QW12 entry, and that screen waits. The Target summary stays as it is until the owner reopens it.
- Add the 200 % variants to the recipes that lacked them, so the rig keeps checking them.

**Done when**
- The task report lists every screen at 320 dp / 200 %: holds, fixed, or waiting for a named brief item.
- Compose tests at 2.0 font scale cover each fixed screen.

**Depends on:** 54, 59, 60. Tree: `android-large-text-audit`.
