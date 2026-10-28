# Connected log follows iOS, names ChatGPT or Claude and says it saves notes; Notes signed out keeps one head line

**Figma:**
- 09.3 Connected log: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39148) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44042)
- 09.4 Connected log, How this works: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39190) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44074)
- 09.5 Connected log, nothing connected: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1334-17213) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1334-17366)
- 09.6 Notes, signed out: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39287) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44142)

**Approved states:** 09.3–09.6 above are ✅ Ready for dev, verified 2026-10-29. They remain Ready until shipment.

**Implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `domain/ConnectedLog.kt` names ChatGPT or Claude and includes saving notes at the Write level. Existing scope parsing, since-date semantics and account-wide static-key disclosure stay intact.
- `ui/ConnectedLogScreen.kt` leads a connected root with **Connected** and browser rows; an empty root keeps the permission levels and Apply caption. **How this works** is a separate page, with levels after its five paragraphs only when opened from a connected root. The browser rows reuse the drawn forward glyph; the How door reuses the existing Material chevron whose path matches the approved 20 dp icon. Header, row and footer typography/insets follow the linked drawings.
- Credential reads publish a complete pair for the current owner, replica and request generation. Both readers restart after cache invalidation, including a same-owner reconnect whose loading state settles in one turn. A stale answer cannot fill a later seat, a missing authenticated transport is unread, and a known offline read uses the approved internet sentence. Neither failure claims an empty connection list.
- Task 26 already supplies the single signed-out Notes head and sign-in door. Only the signed-out account sentence adopts the existing Nunito 16 sp/24 sp role to match 09.6; signed-in production is retained. Its test checks one head and the existing callback/read behavior.
- The composed focused gate passes 47 Kotlin cases with zero failures/errors/skips, and App Debug compiles. The 33 lightweight capture-tool checks pass. Native acceptance remains pending its lease. `connected-log.json` covers both appearances of all four states; its opt-in fixture creates both credential kinds and verifies the real list endpoints before capture. Default capture behavior and the sole-empty-account launcher constraint stay intact.

**Change**
- The layout follows iOS (owner ruling, ledger 9t):
  - Something connected (09.3): **Connected**, one row per tool or key (its name; its levels · since when), each opening Connected tools in the browser (the drawn forward arrow in the 20 dp slot); then the door row **How this works**; then **Connect a tool**. No level rows, caption or *Manage connections* on this screen. Rows read from the same connections source iOS uses (`CoachConnections`); on failure *Couldn’t read your connections.*, offline *Connect to the internet to read your connections.*
  - Nothing connected (09.5): the head, the level rows, the Apply caption, the door **How this works**, then **Sign in first** signed out (opens the sign-in sheet) or **Connect a tool** signed in.
  - How this works (09.4) is a pushed page: the five lines from iOS (`ConnectedLogScreen.swift`); opened from 09.3 they are followed by the levels and the Apply caption.
- 09.5’s head reads *Your log, read by ChatGPT or Claude.* The Write level on 09.4 and 09.5 reads *logs sets · saves notes · adds routines · shares workouts · proposes changes*. Read and Delete are unchanged (*sets, workouts, routines, records, notes, weigh-ins*; *discards a workout · ends a share*), as are the caption *A routine change waits for your Apply; the rest lands at once.* and **How this works**.
- 09.6: the head is the one line *Any agent you connect can read these too.* (26 deletes the subtitle for both states); then *Notes live with your account, so they need you signed in.* and **Sign in**, which opens the sign-in sheet.
- The words of each level stay a claim about `GymToolCatalog.cpp`: when a tool joins a level there, its words join here.

**Out of scope:** Notes signed in (26).

**Done when**
- Screenshots of 09.3, 09.4, 09.5 and 09.6 match in Dark and Daylight; the rig (01) adds `09.3-connected-log-dark/light`, `09.4-connected-how-dark/light`, `09.5-connected-log-empty-dark/light`, `09.6-notes-signed-out-dark/light`.
- No new events; `gym_screen_viewed` `connections` and `notes` still fire.
- Tests: `domain/ConnectedLogTests.kt` pins the new head and Write line byte for byte; `ui/ConnectedLogScreenTests.kt` and `ui/NotesScreenTests.kt` (signed out) pass.

**Depends on:** 26.

**Ledger:** connected-log write disclosure, 9s, 9t, 12h; dogfood `android-gym-target-page`.
