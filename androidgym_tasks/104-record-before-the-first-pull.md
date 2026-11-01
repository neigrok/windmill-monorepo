# The record page's Recent sets before the first pull

**Status:** Waits for the designer's ruling: design brief item QW3.

**Figma:** 05.18 draws the log before the first pull ([Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1767-27118)). The record page's state comes from QW3 ([design brief](design-brief-quality-wave.md)).

**Context:** before an account's first pull, a movement's record page leaves out what partial history cannot prove (task 72), and lists the days this phone holds under *Recent sets*. That heading claims the sets are the recent ones when the phone may hold only some of them (ledger 11u).

**Current implementation**
- `ui/RecordScreen.kt`, under `Record.page`'s completeness flag: no tiles, no *Estimated strength* card, no *Nothing logged for this movement yet*, and the phone's days under *Recent sets*.

**Change**
- Follow QW3. If the heading changes before the pull, it changes back when the pull lands, with no flash.
- Mark the board 🚀 In production when it ships.

**Done when**
- The unread record page matches QW3 in Dark and Daylight, and the read page is unchanged.
- A test flips the completeness flag and checks both headings.

**Depends on:** 72, design brief QW3. Tree: `android-record-recent-sets-before-pull`.
