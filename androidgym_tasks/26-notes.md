# Notes and the note editor

**Figma:**
- 09.1 Notes, swipe delete: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39045) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-43995)
- 09.2 Note editor: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39104) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44029)
- Components (Design System library, Android page):
  - `Android / Swipe row` `337:2217`
  - `Android / Button` `210:181` (Text · Tone=Error)
  - `Android / Top app bar` `342:2953` (Pushed, with the optional text action *Save*)

**Implementation status**
- Notes has the single approved honesty line, 20 dp gutter, card rows and the existing reorder handle. The subtitle and *Top note wins.* are removed. Rows use the shared immediate error-ground swipe without Undo; the 48 dp handle consumes its own gesture before the row swipe can start.
- The editor uses the shared pushed bar with *Note*, a disabled clean-state *Save*, outlined *Title* and *Note* fields at 56/240 dp minima, and the shared error text button. Save and Delete retain the existing storage/failure boundaries.
- A cancelled drag rolls back its temporary order and emits no reorder event. A failed swipe restores its row and shows the existing refusal sentence inline; editor delete failures keep the editor open. Both retry paths retain one result per attempt.
- Save and delete emit bounded `gym_action` results with `screen=note_editor`; list deletion uses `screen=notes`. Successful reorder keeps `gym_note_moved` and unchanged drops emit nothing.
- The final relevant gate passes 51 gym and six telemetry cases with no failures or skips; all 38 Android tool tests pass. API 37 native evidence covers both appearances, real handle reorder, Save and editor/list deletion, plus Save above the real IME and scrolled Delete at 320 dp/200% text. Evidence and qualifications are recorded in `docs/engineering/android-implementation.md`.

**Change**
- Head: one line, *Any agent you connect can read these too.* Delete the subtitle *what you write for Coach* (`Notes.sub`) and the footer *Top note wins.* (`Notes.topWins`, `ui/NotesScreen.kt:114`). The reorder handle stays.
- Note rows swipe end-to-start on `DeleteSwipeRow` (04), a11y label *Delete note*. Past the threshold the note is deleted at once: no hold, no Undo.
  - The reorder handle and *Add a note* stay as they are.
  - A swipe and a long-press drag must not fight: the drag starts only from the handle, the swipe only from the row body.
- Note editor (09.2):
  - Bar: `Android / Top app bar` Pushed, back + *Note* + the text action *Save* (tertiary text while there is nothing to save).
  - Fields: M3 `OutlinedTextField`s with the label inside the outline, *Title* and *Note*. A new note's second field is also *Note* (today *Body*).
  - **Delete note** as `Android / Button` Text · Tone=Error (error role, 02). It deletes at once and closes the editor.
- A refused or failed delete brings the note back and the note line says why (today's *that note is still here* line).
- 05 already makes the store's note delete immediate; this task adds the swipe and the button.

**Out of scope:**
- Signed-out Notes (09.6) and Connected log (09.3, 09.4): 51.

**Done when**
- Screenshots of 09.1 (one row mid-swipe) and 09.2 match in Dark and Daylight, signed in; the rig (01) adds `09.1-notes-swipe-delete-dark/light` and `09.2-note-editor-dark/light`.
- `gym_note_moved` still fires after a reorder; `gym_screen_viewed` `notes` / `note_editor` still fire.
- Note deletion emits `gym_action` with `screen=notes` (swipe) or `note_editor` (button), `action=delete`, `outcome=ok` / `refused` / `failed`. Editor saves emit the same bounded outcomes with `screen=note_editor`, `action=save`; no title, text or record identity.
- Failures still report as `gym.deleteNote`, `gym.saveNote`, `gym.reorderNotes`.
- Tests: `ui/NotesScreenTests.kt`, `ui/NotesStateTests.kt`, `ui/NotesLayoutTests.kt`, `ui/EngineNotesScreenTests.kt`, `store/WithheldWindowTests.kt` (the weigh-in Undo contract remains intact).

**Depends on:** 02, 03, 04, 05.

**Ledger:** 11b, 11c, 9s, 12h; dogfood `android-gym-target-page`.
