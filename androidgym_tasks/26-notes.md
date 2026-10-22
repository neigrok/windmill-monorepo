# Notes and the note editor

**Figma:**
- 09.1 Notes, swipe delete: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39045) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-43995)
- 09.2 Note editor: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39104) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44029)
- Components (Design System library, Android page):
  - `Android / Swipe row` `337:2217`
  - `Android / Button` `210:181` (Text · Tone=Error)
  - `Android / Top app bar` `342:2953` (Pushed, with the optional text action *Save*)

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- Notes (`ui/NotesScreen.kt:42-132`): *what you write for Coach* / *Any agent you connect can read these too.* (`domain/Notes.kt:36-37`); rows with a reorder handle (long-press drag, two or more notes), the title, the first line or *empty · tap to write*, a chevron (:173-217); *Top note wins.* (`domain/Notes.kt:40`); a bottom *Add a note* on `raised`.
  - Rows do not swipe. A note is deleted only from its editor.
- Note editor (`NoteEditorScreen`, `ui/NotesScreen.kt:224-282`):
  - Title *New note* or *Note*; the bar's *Save* / *Saving…* is a `TextButton` in the accent (:253-260).
  - Fields are a label above a borderless `raised` `OutlinedTextField` (`NoteField`, :285-300): *Title* and *Body* (new) or *Note* (existing), placeholders *How I want to be talked to* and *Write a note for Coach*.
  - *Delete note* in alarm ink (:276-279). It is held: the editor closes and *Note deleted.* shows with *Undo* for nine seconds (`store/WithheldDelete.kt:67`).

**Change**
- Head: one line, *Any agent you connect can read these too.* Delete the subtitle *what you write for Coach* (`Notes.sub`) and the footer *Top note wins.* (`Notes.topWins`, `ui/NotesScreen.kt:116`). The reorder handle stays.
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
- A note delete emits nothing today. Add `gym_action` with `screen=notes` (swipe) or `note_editor` (button), `action=delete`, `outcome=ok` / `refused` / `failed`; no title or text.
- Failures still report as `gym.deleteNote`, `gym.saveNote`, `gym.reorderNotes`.
- Tests: `ui/NotesScreenTests.kt`, `ui/NotesStateTests.kt`, `ui/NotesLayoutTests.kt`, `ui/EngineNotesScreenTests.kt`, `store/WithheldWindowTests.kt` (the note case goes).

**Depends on:** 02, 03, 04, 05.

**Ledger:** 11b, 11c, 9s, 12h; dogfood `android-gym-target-page`.
