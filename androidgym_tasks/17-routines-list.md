# Routines list and empty Routines with the FAB

**Approved flow:** [Routine editor](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30392) — ✅ Ready for dev, human-approved 2026-10-25. The combined editor opens from this flow; the unshown MCP proposal row remains a separate design follow-up.

**Figma:**
- 02.1 Routines: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27415) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44402)
- 02.7 No routines yet, FAB: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30574) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45142)
- Components (Design System library, Android page):
  - `Android / FAB` `337:2110`
  - `Android / Top app bar` `342:2953`
  - `Android / Swipe row` `337:2217`

**Implementation status**
- Routines retains the shared root title/account bar from 03. The shipped shared `GymFab` is the single **New routine** action, at bottom end with 16 dp spacing above navigation. It opens the same routine draft and keeps its accessibility label at every text scale.
- The list uses 16 dp horizontal content padding and reserves 88 dp below for the 56 dp FAB and its margins. The empty title is Nunito ExtraBold 24 sp / 32 sp, at the approved 8 dp content inset. The signed-out sign-in card and its unused callback are removed.
- The current Coach proposal card, unseen removal receipts, proposal chips and functioning **Review** destination remain unchanged. The user postponed action appearance changes; the illustrated waiting-proposal row is outside this release. No conversation-backed route or unapproved MCP row is introduced.
- Shared swipe/menu and immediate deletion from 05 remain intact. The combined Debug gate passes 1,225 gym cases (17 opt-in live-wire skips) and all 48 application cases, including the 11 onboarding cases and tile/draft/recreation checks. All 19 final row/swipe checks pass. Installed API 37 acceptance covers full/empty Dark and Daylight at standard size and 320 dp/200% text, FAB creation, existing proposal Review and the account seat. Tasks 03 and 17 ship together.
- Native evidence is `/private/tmp/windmill-android-task17/native2`, APK SHA-256 `4419120c0d431303d6ccde76d64626833c7e4a3c9175f7ced5738f6cd05a1d7e`. All eight automated captures retain the 56 dp FAB and 48 dp account target. The same-APK settled `02.7-empty-dark-inset-repeat.png` supplies standard Dark anatomy; the first Dark image retains an unexplained 58 px vertical inset difference. One native routine save reaches the backend and emits one `gym_routine_saved(action=create)` event; the pending proposal and original routine revisions remain unchanged. Account-sheet open has no separate event yet; task 46 owns that shell gap.

**Change**
- Use the approved shared native FAB (04) with its exact add asset, brand-soft/card fill and **New routine** content description. Keep the root bar title/account-only (03).
- Remove the Routines sign-in suggestion. The first-workout receipt suggestion belongs to 14.
- Preserve current proposal appearance, content and review behavior while 29–35 wait. Their future integration must retain a working review fallback for connected-agent proposals until an approved destination exists.
- Routine rows use the approved 12 dp leading / 0 trailing inset, 8 dp icon gap, 2 dp copy gap, Nunito Bold 16/22 title and Nunito 13/18 supporting text. The 68 dp minimum grows with content. Keep ordering, proposal chips, the shared menu and settled deletion behavior. Scrolling must expose the last row's More target above the FAB at large text.

**Out of scope:**
- The swipe ground and immediate delete (05), the ⋮ menu item colour (05).
- Proposal/change-card appearance and destination redesign (29–35), deferred at user request.
- The routine summary sheet units (08).

**Done when**
- Screenshots of the in-scope 02.1 and 02.7 chrome, empty state and FAB match in Dark and Daylight; the existing proposal card remains by user instruction; the rig (01) adds `02.1-routines-dark/light` and `02.7-no-routines-fab-dark/light`.
- `gym_screen_viewed` still fires `routines`; tapping the FAB still leads to `routine_editor`.
- The existing proposal card's **Review** and secondary routine chip still open their current review destinations with existing events.
- Tests cover one accessible FAB at default, enlarged and maximum text; no bar action, *Start logging* or sign-in card; last-row menu clearance; proposal review identity; onboarding; and tile navigation with draft/recreation preservation.

**Depends on:** 03, 04, 05, 13.

**Ledger:** 11f, 11b, 12b, 12f; dogfood `android-gym-target-page`.
