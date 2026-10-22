# Coach chat in the Google Messages style

**Figma:**
- 08.1 Coach, empty: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27790) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41136)
- 08.10 a Markdown answer, full width: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-30552) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41360)
- 08.11 an answer streaming into its bubble: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-30653) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41382)
- 08.32 copy a message: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-31101) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41499)
- 08.33 jump to latest: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-31296) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41540)
- 08.35 more menu: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-31791) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41596)
- 01.6 Coach is thinking: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-30742) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39416)
- Components (Gym Components page, section `🧩 Android · Material 3`):
  - `Android / Chat bubble` `1247:2983`: Coach left on the card fill, lifter right on the accent; First / Middle / Last corners; Width = Full for long Markdown
  - `Android / Chat timestamp` `1247:2984` and `Android / Chat notice` `1247:2986` (same section)
  - `Android / Top app bar` `1260:2948`, `Android / Menu` `1260:2608`, `Android / Keyboard` `1247:2625`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- Top bar (`coach/AskScreen.kt:134-157`):
  - *History* is a text `TopAction` (:139).
  - ⋮ *More* opens a `DropdownMenu` on `skin.raised` (:144): *Notes*, *Connected log*, *New chat* (only with a conversation, disabled while asking), *Account* (:145-153).
  - No account seat: `seat` is passed in (`GymRoom.kt:1179`) and never drawn.
- The question is a right-aligned `raised` box at 90 % width, radius 20, body 17 (`coach/CoachAnswer.kt:58-65`).
- The answer is unbubbled prose: paragraph body 19/27, headings 22 / 20 / 19 Bold (`coach/CoachAnswer.kt:302-309`), lists, code and rules (`:258-283`). No tables: `CoachBlock` has Paragraph, Heading, ListItem, Code and Rule only (`coach/CoachMarkdown.kt:5-9`).
- No timestamps and no grouping. Exchanges sit `WindmillSpace.x4` apart (`coach/AskScreen.kt:166`).
- Waiting is the text *reading your log…* (`coach/Ask.kt:211`, drawn at `coach/AskScreen.kt:190-192`). The server is polled about once a second and `rememberRevealedText` paces the text (`coach/CoachReveal.kt:70`), but on the emulator the answer lands whole.
- A tap or long press on any message opens a menu with *Copy* on `raised` (`coach/CoachAnswer.kt:209-231`).
- *Jump to latest* is a `TextButton` on a `surface` pill (`coach/AskScreen.kt:229-235`).
- Composer (`coach/CoachComposer.kt:100-131`):
  - a `surface` pill, radius 28, with *Add photo* (`gym_photo`) inside it and placeholder *Ask about your training* (`coach/Ask.kt:172`)
  - a 48 dp `raised` circle that always shows *↑*, and *■* while Coach answers (`:115-130`)

**Change**
- Top app bar (the bar itself is 03): title *Coach*, then icon buttons *History* (Material Symbol `history`; the kit draws `schedule`) and *More* (`more_vert`), then the account seat (03).
- *More* is an M3 `DropdownMenu` on the card surface (08.35): *Notes*, *Connected log*, *New chat* (only with a conversation), *Account*.
- Bubbles, in a new `coach/CoachBubble.kt` (tasks 29–44 reuse it):
  - Lifter: right-aligned on the accent with on-accent text.
  - Coach: left-aligned on the card fill, ink text.
  - Corners follow the group: First, Middle, Last. 2 dp inside a group, 12 dp between groups, 16 dp gutters.
  - A Markdown answer with a heading, a list or a table uses Width Full (08.10).
- A centred `ChatTimestamp` starts each group: *Today 18:40*. Use the phone's 12- or 24-hour setting.
- Markdown (08.10): add a `CoachBlock.Table` to `coach/CoachMarkdown.kt` and draw it inside the bubble. Example copy: heading *Thursday · Push A*, bullets *Bench Press — 3 × 3 at 90 kg*, table *Movement / Sets / Load*.
- Thinking (01.6): a Coach typing bubble with three dots replaces *reading your log…*. Delete `Ask.waiting`.
- Streaming (08.11): the first revealed characters replace the typing bubble, and the text grows inside the same bubble. Find why the emulator shows the answer whole, and fix it (the running generation's partial text must reach `rememberRevealedText`).
- Copy (08.32): a long press on a bubble shows a 16 % state layer on it and an M3 `DropdownMenu` under it with one item, *Copy*. A plain tap does nothing. Keep the TalkBack *Copy* action.
- Jump to latest (08.33): an M3 `ElevatedButton` (small) *Jump to latest* with `keyboard_arrow_down`, centred 12 dp above the composer.
- Composer (08.1):
  - *Add photo* is an icon button (`image`) outside the field.
  - The field is an M3 filled `TextField` shaped as a 28 dp pill, placeholder *Ask about your training*, no label, no indicator line.
  - *Send* is a `FilledIconButton` (`send`) that shows only when there is text or a photo.
  - While Coach answers it becomes *Stop*: a filled 40 dp circle with the `stop` symbol. Keep the descriptions *Stop response* / *Cancel upload*.
- Empty Coach, signed in (08.1): the bar, an empty canvas and the composer. Nothing else here; the greeting is 39.
- Read tally line under Coach's last bubble: *Read 18 workouts · 6 weeks* with a chevron (its expanded form is 37).

**Out of scope:**
- The proposal card (29) and decided states (30).
- The day's cap notice (36), History and What Coach read (37).
- The greeting (39), the photo in the composer and its caption (40).

**Done when**
- Screenshots of 08.1, 08.10, 08.11, 08.32, 08.33, 08.35 and 01.6 match in Dark and Daylight on the emulator; the rig (01) adds `08.1-coach-empty-dark` / `-light`, `08.10-coach-markdown-dark` / `-light`, `08.11-coach-streaming-dark` / `-light`, `08.32-coach-copy-dark` / `-light`, `08.33-coach-jump-latest-dark` / `-light`, `08.35-coach-more-menu-dark` / `-light`, `01.6-coach-thinking-dark` / `-light`.
- `gym_ask_started` and `gym_ask_outcome` still fire with the same properties; `gym_screen_viewed` `coach` still fires.
- *Copy* emits `gym_action` `{screen: coach, action: copy, outcome: ok}` (05 introduces the event). No message text in any event.
- A stream failure still reports under `gym.ask`.
- Tests to update: `coach/AskScreenTests.kt`, `coach/CoachAnswerTests.kt`, `coach/CoachComposerTests.kt`, `coach/CoachMarkdownTests.kt` (a table block), `coach/CoachRevealTests.kt` (partial text inside the bubble).

**Depends on:** 03, 05.

**Ledger:** 11g; dogfood `android-gym-target-page`.
