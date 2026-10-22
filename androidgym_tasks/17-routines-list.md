# Routines list and empty Routines with the FAB

**Figma:**
- 02.1 Routines: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27415) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44402)
- 02.7 No routines yet, FAB: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30574) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45142)
- Components (Gym Components page, section `🧩 Android · Material 3`):
  - `Android / FAB` `1247:2332`
  - `Android / Top app bar` `1260:2948`
  - `Android / Swipe row` `1247:2439`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `ui/RoutinesScreen.kt:91-105`: the bar holds the text action *New routine* (a `+` icon button above font scale 1.3), then the account seat.
- The list (:108-160), in order: refusal notices, unseen removal receipts, the newest pending `ProposalCard` (:128-138), the signed-out `SignInCard`, then routine rows.
  - `ProposalCard` (`ui/ReviewSheet.kt:498-507`) draws *Proposal · {routine}*, a summary, a count and *Review*, and opens the review sheet.
  - `SignInCard` (:249-270): *Your log is saved on this device.* / *Sign in to add it to your account — it opens on the web too.*
  - Empty: *No routines yet.* (:144).
- *Start logging* is a pinned accent box, 56 dp (:162-177).

**Change**
- Delete the bar's *New routine* and its large-type `+` (both branches at :93-103). The root bar is title + account seat (03).
- Add an M3 `FloatingActionButton` with `Icons.Rounded.Add`, content description *New routine*, bottom end, 16 dp above *Start logging*. It opens the editor as the bar action does today (`onBuild(RoutineDraft(position = …))`).
  - The list's bottom padding grows so the FAB never covers the last row's ⋮.
- Replace the in-list `ProposalCard` with one waiting-proposal row at the top of the list:
  - leading chat icon (`Icons.Outlined.ChatBubbleOutline`), title *Push A · 3 changes* (routine + the store's `changeCount`), supporting line *From Coach · 18:42* (the proposal's `createdAtMs`), trailing chevron
  - a tap opens the Coach conversation at that proposal's card (29), using `ProposalSource.conversation`
  - a proposal with no conversation (written by a connected agent over MCP) is not drawn on any board. Ask the designer for that row before building it; until then keep today's path for it.
  - Unseen removal receipts keep their place above it.
- Empty, signed out (02.7): the sign-in card as today, then *No routines yet.*, the FAB and *Start logging*. No bar action.
- Rows, the ⋮ menu and the swipe use the shared parts from 04 and the immediate delete from 05; nothing else on the row changes.
- An empty Gym that first opens on Coach is 39's work; this task draws the Routines empty state only.

**Out of scope:**
- The swipe ground and immediate delete (05), the ⋮ menu item colour (05).
- The proposal card in the conversation (29).
- The routine summary sheet units (08).

**Done when**
- Screenshots of 02.1 and 02.7 match in Dark and Daylight; the rig (01) adds `02.1-routines-dark/light` and `02.7-no-routines-fab-dark/light`.
- `gym_screen_viewed` still fires `routines`; tapping the FAB still leads to `routine_editor`.
- Tapping the proposal row fires `gym_screen_viewed` `coach` (or `thread`), never `proposal`.
- Tests: `ui/RoutinesScreenTests.kt` (FAB present at every font scale, no bar action, the proposal row's title and line), `ui/StanceReadsTheAccountTests.kt` (signed-out empty state).

**Depends on:** 03, 04, 05.

**Ledger:** 11f, 11b; dogfood `android-gym-target-page`.
