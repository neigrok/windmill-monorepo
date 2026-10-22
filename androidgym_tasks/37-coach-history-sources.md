# History, deleting a conversation, What Coach read

**Figma:**
- 08.4 History: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28552) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41230)
- 08.5 What Coach read: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28654) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41250)
- 08.34 History, delete a conversation: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-31663) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41570)
- Components (Gym Components page, section `🧩 Android · Material 3`):
  - `Android / Swipe row` `1247:2439` (Rest, Swiping, Past threshold)
  - `Android / FAB` `1247:2332` (Extended)
  - `Android / Button` `656:6699` (Quiet · Tone=Error for the dialog's *Delete*)
  - `Android / Top app bar` `1260:2948`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `ThreadsScreen` (`coach/ThreadsScreen.kt:61`): title *History* (`coach/Thread.kt:156`), pull to refresh (`coach/ThreadsScreen.kt:104`).
- Rows (`ThreadRow`, `coach/ThreadsScreen.kt:190-205`): the first question, then *{day} · {outcome}* and a chevron. Outcomes: *2 changes → Push*, *1 change turned down*, *created Push*, *2 changes waiting*, *2 changes superseded* (`coach/Thread.kt:83-92`).
- A pinned accent button *Ask something new* (`coach/ThreadsScreen.kt:143-154`, `coach/Thread.kt:157`). Empty, it reads *Nothing here yet. Every conversation you have with Coach is kept until you delete it.* (`coach/Thread.kt:168`).
- Swipe end-to-start (`SwipeableThreadRow`, `coach/ThreadsScreen.kt:164-187`) on `RowDeleteGround` (`:180`). The delete is held 9 s: *Conversation deleted.* / *your routine keeps what you applied* + Undo (`store/WithheldDelete.kt:51-57`).
- What Coach read is the tally line under the answer (`coach/CoachAnswer.kt:167-202`):
  - *Read 18 sets · 6 weeks · 3 sessions* (`coach/Ask.kt:265-272`), with a *+* / *−* toggle (`coach/CoachAnswer.kt:184`).
  - Expanded, raw lines such as *Push A · 26 Sep* / *Workout summary · 15 working · 2435kg* (`:187-196`), with no space before *kg* and no rounding (the emulator printed *5050.25kg*), then tool phrases (`:197-199`).

**Change**
- History (08.4):
  - Rows are two-line M3 `ListItem`s: the first question as the headline, the outcome or the answer's first words as the supporting line, and the date trailing (*Today*, *Yesterday*, *Sep 27*).
  - Outcome lines: *Push A · 5 changes*, *Changed a movement*, *Created 3 routines*. A settled proposal uses 30's words (*Applied*, *Rejected*, *Out of date*).
  - Board copy: *Is Push A still doing anything?* / *Push A · 5 changes* / *Today*; *Pull-ups are bodyweight for me. I add a 10 kg belt.* / *Changed a movement* / *Yesterday*; *How heavy should I start squats?* / *Choose a weight you can lift 8 times with good form.* / *Sep 27*; *My program, 3 days a week* / *Created 3 routines* / *Sep 26*.
  - *Ask something new* becomes an `ExtendedFloatingActionButton` *New chat* (`add` icon), bottom end. *New chat* is the one way to start a conversation; *Ask something new* goes from every screen.
  - Empty: *No conversations* (replaces `Threads.none`).
- Delete a conversation (08.34):
  - The row swipes on `DeleteSwipeRow` (04), a11y label *Delete conversation*.
  - Past the threshold, an M3 `AlertDialog`: *Delete this conversation?* / *You can’t undo this.* / **Cancel** · **Delete** (error role, 02). Cancel puts the row back. Both phones use these words (ledger 12g).
  - On Delete the conversation goes at once: no hold, no Undo snackbar. A refusal brings the row back and the note line explains.
  - Delete `Deletion.Thread`'s *Conversation deleted.* and *your routine keeps what you applied*. The last of 14 and 37 to land deletes `store/WithheldDelete.kt`.
- What Coach read (08.5), a bottom sheet:
  - The tally line under the bubble reads *Read 1 workout · 1 week ›* (`chevron_forward`). Use *workouts* (9z). A tap opens an M3 `ModalBottomSheet` over a 32 % scrim; the thread lifts so the tally stays visible above it.
  - The sheet: handle, title *What Coach read*, the line *1 workout · 1 week*, then one row card per workout, *Push A* over *Sat, Sep 26 · 1 working set · 400 kg*, with a chevron. Each row opens that workout (23).
  - **Close** (`Android / Button` Quiet, 56 dp) at the foot.
  - Volume is rounded like the rest of the app, with a space before *kg*.
  - *Also read your notes.* under the rows when Coach read them.
  - Tool phrases leave this card; Coach's writes have their own receipts (35).

**Out of scope:** the swipe row itself (04), the chat (28), the write receipts (35).

**Done when**
- Screenshots of 08.4, 08.5 and 08.34 match in Dark and Daylight on the emulator; the rig (01) adds `08.4-coach-history-dark` / `-light`, `08.5-coach-what-read-dark` / `-light`, `08.34-history-delete-dark` / `-light`.
- `gym_screen_viewed` `threads` and `thread` still fire; a read row opens `session`.
- Delete emits `gym_action` `{screen: threads, action: delete, state: shown}` when the dialog shows, then `{…, outcome: ok | refused | failed | cancelled}`. No title or question text in any event.
- Delete failures still report under `gym.deleteThread`; a refusal is an event, not an Issue.
- Tests to update: `coach/ThreadScreenTests.kt`, `coach/ThreadTests.kt`, `coach/AnswerReceiptTests.kt`, `store/WithheldWindowTests.kt` (the thread case goes).

**Depends on:** 04, 05, 28, 30.

**Ledger:** 11k, 10v, 11b, 12g, 12h; dogfood `android-gym-target-page`.
