# History, deleting a conversation, What Coach read

**Release scope:** History, chat lifecycle, retained drafts, deletion and sources remain in scope. Preserve existing proposal/change cards, Apply/Reject controls, diff blocks, action/save receipts, review routes and outcome wording. Task 30's outcome-word changes and task 35's new receipt presentation are postponed.

**Figma:**
- 08.4 History: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28552) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41230)
- 08.5 What Coach read: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28654) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41250)
- 08.34 History, delete a conversation: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-31663) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41570)
- Components (Design System library, Android page):
  - `Android / Swipe row` `337:2217` (Rest, Swiping, Past threshold)
  - `Android / FAB` `337:2110` (Extended)
  - `Android / Button` `210:181` (Text · Tone=Error for the dialog's *Delete*)
  - `Android / Top app bar` `342:2953`

**Approved revision:** Fresh Coach, History with local drafts, restored drafts and a reply pending in another chat are ✅ Ready for dev, approved 2026-10-25: [Coach](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27790), [History](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28552), [pending reply](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1442-18583), [restored draft](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1442-18668).

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
  - Keep the current proposal and write-outcome wording in the supporting line. Task 30's *Applied*, *Rejected* and *Out of date* wording changes are deferred; the History row layout and date remain in scope.
  - Board copy: *Is Push A still doing anything?* / *Push A · 5 changes* / *Today*; *Pull-ups are bodyweight for me. I add a 10 kg belt.* / *Changed a movement* / *Yesterday*; *How heavy should I start squats?* / *Choose a weight you can lift 8 times with good form.* / *Sep 27*; *My program, 3 days a week* / *Created 3 routines* / *Sep 26*.
  - *Ask something new* becomes an `ExtendedFloatingActionButton` *New chat* (`add` icon), bottom end. It is an additional explicit fresh-chat action. Every deliberate entry into the Coach tab also opens a fresh unsent chat; returning from a sheet/History or recreating the selected screen does not.
  - This task owns the durable owner/chat archive foundation used by 28, 38, 44 and 49, including anonymous owner identities; it does not require the anonymous network/import implementation in 38. Give each local chat a stable identity before its first send. Keep draft text, selected/prepared photo, local turns, request identity and confirmations under that chat and its account/anonymous owner. A completely empty unsent chat need not create a History row.
  - Persist a meaningful draft before switching chats. Merge server conversations and local-only drafts/pending chats in History without duplicate rows after a server thread id arrives. Signed-out History stays on this phone; it is not server history.
  - Opening a fresh chat must not call `CoachStore.abandon`/`LocalCoach.clear`, delete a draft or cancel another chat's request. An answering chat does not block navigation. Its eventual reply and receipt return to the originating chat, with a link from the approved pending-reply state. Account transitions must not leak one owner's draft or response to another.
  - Selecting History restores that exact chat, including unsent text/photo and scroll position. New chat starts an empty composer while retaining the old row. Task 44 carries the selected anonymous chat across explicit sign-in adoption without treating that return as a fresh tab entry.
  - Empty: *No conversations* (replaces `Threads.none`).
- Delete a conversation (08.34):
  - The row swipes on `DeleteSwipeRow` (04), a11y label *Delete conversation*.
  - Past the threshold, an M3 `AlertDialog`: *Delete this conversation?* / *You can’t undo this.* / **Cancel** · **Delete** (error role, 02). Cancel puts the row back. Both phones use these words (ledger 12g).
  - On Delete the conversation goes at once: no hold, no Undo snackbar. A refusal brings the row back and the note line explains.
  - Remove only the held conversation-deletion case and its *Conversation deleted.* / *your routine keeps what you applied* copy after the immediate confirmed deletion path passes. Preserve `store/WithheldDelete.kt` and its weight hold/Undo behavior required by 05/24. Deleting a local-only draft removes only that chat; deleting a server conversation reconciles its server receipt before dropping retained local metadata.
- What Coach read (08.5), a bottom sheet:
  - The tally line under the bubble reads *Read 1 workout · 1 week ›* (`chevron_forward`). Use *workouts* (9z). A tap opens an M3 `ModalBottomSheet` over a 32 % scrim; the thread lifts so the tally stays visible above it.
  - The sheet: handle, title *What Coach read*, the line *1 workout · 1 week*, then one row card per workout, *Push A* over *Sat, Sep 26 · 1 working set · 400 kg*, with a chevron. Each row opens that workout (23).
  - **Close** (`Android / Button` Text, 56 dp) at the foot.
  - Volume is rounded like the rest of the app, with a space before *kg*.
  - *Also read your notes.* under the rows when Coach read them.
  - Retain tool-write receipt content in its current presentation while task 35 waits. Do not move or restyle action outputs as part of the sources sheet.

**Out of scope:** the swipe row itself (04), the chat (28), postponed outcome-word changes (30) and new write-receipt presentation (35). Existing tool-write content remains available.

**Done when**
- Screenshots of the active History, sources and deletion layouts in 08.4, 08.5 and 08.34 match in Dark and Daylight on the emulator, retaining current action cards, receipt presentation and outcome wording wherever the drawings include postponed changes; the rig (01) adds `08.4-coach-history-dark` / `-light`, `08.5-coach-what-read-dark` / `-light`, `08.34-history-delete-dark` / `-light`.
- `gym_screen_viewed` `threads` and `thread` still fire; a read row opens `session`.
- Delete emits `gym_action` `{screen: threads, action: delete, state: shown}` when the dialog shows, then `{…, outcome: ok | refused | failed | cancelled}`. No title or question text in any event.
- Delete failures still report under `gym.deleteThread`; a refusal is an event, not an Issue. Draft/history persistence failures report under static operations and keep recoverable draft state.
- Verify tab switch away/back, New chat while another response is pending, restored text/photo, restart during a request, local/server History merge, signed-out local History and account-switch isolation. Keep request/photo contents out of logs.
- Record fresh-entry, history-open, draft-restored and reply-open steps as bounded `gym_action` actions in `docs/ANDROID_OBSERVABILITY.md`; do not emit chat ids, text, photo names or outcome previews.
- Tests to update: `coach/ThreadScreenTests.kt`, `coach/ThreadTests.kt`, `coach/AnswerReceiptTests.kt`, `store/WithheldWindowTests.kt` (the thread case goes).

**Depends on:** 04, 05, 28.

**Ledger:** 11k, 10v, 11b, 12g, 12h; dogfood `android-gym-target-page`.
