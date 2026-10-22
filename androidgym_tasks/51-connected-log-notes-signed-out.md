# Connected log names ChatGPT or Claude and says it saves notes; Notes signed out keeps one head line

**Figma:**
- 09.3 Connected log: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39148) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44042)
- 09.4 Connected log, How this works: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39190) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44074)
- 09.6 Notes, signed out: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39287) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44142)

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- Connected log's head is *Your log, read by Claude, Cursor or Codex.* (`ConnectedLog.head`, `domain/ConnectedLog.kt:10`, drawn at `ui/ConnectedLogScreen.kt:96`).
- The Write level reads *logs sets · adds routines · shares workouts · proposes changes* (`LogLevel.Write`, `domain/ConnectedLog.kt:61`). The server grants `save_note` at the write level (`backend/products/gym/adapters/mcp/GymToolCatalog.cpp:289`), so the row leaves out a write a connected tool can make.
- Notes signed out draws the subtitle *what you write for Coach* above *Any agent you connect can read these too.* (`ui/NotesScreen.kt:89-90`), then *Notes live with your account, so they need you signed in.* (`Notes.signedOut`, `domain/Notes.kt:48`) and **Sign in**.

**Change**
- 09.3 and 09.4: the head reads *Your log, read by ChatGPT or Claude.* The Write level reads *logs sets · saves notes · adds routines · shares workouts · proposes changes*. Read and Delete are unchanged (*sets, workouts, routines, records, notes, weigh-ins*; *discards a workout · ends a share*), as are the caption *A routine change waits for your Apply; the rest lands at once.* and **How this works**.
- 09.6: the head is the one line *Any agent you connect can read these too.* (26 deletes the subtitle for both states); then *Notes live with your account, so they need you signed in.* and **Sign in**, which opens the sign-in sheet.
- The words of each level stay a claim about `GymToolCatalog.cpp`: when a tool joins a level there, its words join here.

**Out of scope:** the connected state and *Manage connections* (ledger 9t, not ruled); Notes signed in (26).

**Done when**
- Screenshots of 09.3, 09.4 and 09.6 match in Dark and Daylight; the rig (01) adds `09.3-connected-log-dark/light`, `09.4-connected-how-dark/light`, `09.6-notes-signed-out-dark/light`.
- No new events; `gym_screen_viewed` `connections` and `notes` still fire.
- Tests: `domain/ConnectedLogTests.kt` pins the new head and Write line byte for byte; `ui/ConnectedLogScreenTests.kt` and `ui/NotesScreenTests.kt` (signed out) pass.

**Depends on:** 26.

**Ledger:** connected-log write disclosure, 9s, 12h; dogfood `android-gym-target-page`.
