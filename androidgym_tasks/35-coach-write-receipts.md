# Coach write receipts: changed a movement, saved a note

**Figma:**
- 08.9 Coach changes a movement's equipment: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28915) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41334)
- 08.25 save a note: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-37720) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41795)
- 08.26 a movement's details: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-37761) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41805)
- Components: `Android / Change row` `1247:2908` (Changed, Note), `Android / Diff field` `1247:2753`.

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- A note save and a movement update show only as tally phrases in the expanded read line: *saved a note*, *updated a movement* (`coach/Ask.kt:232`, `:235`; drawn at `coach/CoachAnswer.kt:197-199`).
- The answer carries tool names only (`AskStep`, `coach/Ask.kt:15`). `results` carries created routines only (`CoachResult`, `coach/Ask.kt:50`); the server fills it only for routines (`backend/products/gym/application/AskService.cpp:129`, `:488`).

**Change**
- Both are small cards under Coach's bubble, in the proposal card's diff language (29), with no buttons.
- *Changed a movement* (08.9, 08.26): a header *Changed a movement*, then a *Changed* block with the movement name and its fields:
  - 08.9: *Pull-up · Equipment ~~Machine~~ → Bodyweight*. Coach copy: *Done. Pull-up is now a bodyweight movement. Log the belt as 10 kg added. Volume counts only the added weight.*
  - 08.26: *Incline Press · Name ~~Incline DB~~ → Incline Press · Equipment ~~Barbell~~ → Dumbbells · Weight is ~~Total~~ → Each dumbbell* (the iOS board 08.26 draws the same row). Coach copy: *Done. Enter the weight of one dumbbell from now on.* The *Weight is* row reads *Each dumbbell* for two dumbbells and *Total* otherwise.
  - Tapping the card opens the movement's Record.
- *Saved a note* (08.25): a header *Saved a note*, then a *Note* block with the note's text in body type: *Left shoulder hurts on wide-grip bench. Use a close grip.* Tapping it opens Notes. Coach copy: *I saved this as a note. I will use it when I plan.*
- If a write is not confirmed: *Could not confirm a note save* / *Could not confirm a movement update*, still opening Notes or the movement.
- Coach only appends notes; no other note receipt exists.
- Backend first: add `save_note` and `update_exercise` results (the note's id and text; the movement's id, with its fields before and after) to the generation's `results`, so the card draws what the log did, not what the model said.
- Drop *saved a note* and *updated a movement* from the tally phrases once the cards show.

**Out of scope:** the Edit movement sheet (20), What Coach read (37).

**Done when**
- Screenshots of 08.9, 08.25 and 08.26 match in Dark and Daylight on the emulator; the rig (01) adds `08.9-coach-changed-movement-dark` / `-light`, `08.25-coach-saved-note-dark` / `-light`, `08.26-coach-movement-details-dark` / `-light`.
- `gym_ask_outcome` still fires; a read failure of a receipt reports under `gym.ask`.
- No note text, movement name or field value in any event or log.
- Tests to update: `coach/AnswerReceiptTests.kt`, `coach/CoachAnswerTests.kt`, `coach/AskTests.kt` (tally phrases).

**Depends on:** 29.

**Ledger:** 11k, 10v, 12h; dogfood `android-gym-target-page`.
