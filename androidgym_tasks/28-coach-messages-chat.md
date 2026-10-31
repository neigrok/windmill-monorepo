# Coach chat in the Google Messages style

**Figma:**
- 08.1 Coach, empty: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27790) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41136)
- 08.10 a Markdown answer, full width: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-30552) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41360)
- 08.11 an answer streaming into its bubble: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-30653) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41382)
- 08.32 copy a message: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-31101) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41499)
- 08.59 jump to latest: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-31296) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41540)
- 01.6 Coach is thinking: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-30742) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39416)
- Components (Design System library, Android page):
  - `Android / Chat bubble` `337:2761`: Coach left on the card fill, lifter right on the accent; First / Middle / Last corners; Width = Full for long Markdown
  - `Android / Chat timestamp` `337:2762` and `Android / Chat notice` `337:2764` (same section)
  - `Android / Top app bar` `342:2953`, `Android / Menu` `342:2725`, `Android / Keyboard` `337:2403`

**Delivery:** Shipped to main in `fac7e530`, with task 37's lifecycle foundation in `ba0360c0`. The human-approved fresh-entry/composer, Markdown, streaming, Copy and stable-navigation scopes carry **🚀 In production** in Figma. Shared drawings explicitly retain the postponed proposal/action visuals. [Coach](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27790) is the canonical entry.

**Implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `coach/AskScreen.kt` draws History and the account seat, a stable navigation rail and the canvas composer. Fresh entry preserves previous chats and their pending responses through task 37's archive.
- `CoachBubble.kt`, `CoachMarkdown.kt` and `CoachReveal.kt` own grouped native bubbles, phone-format timestamps, Markdown tables, typing, paced streaming and Stop. Copy uses the complete received message independently of reveal progress.
- `CoachComposer.kt` retains native selection/caret state and owner-scoped text/photo drafts. Existing proposal, diff, review and write-receipt appearance remains unchanged.
- Native acceptance and the simplification observations are in [the message implementation record](../docs/engineering/android-coach-messages.md). Root integration covers 1,320 gym cases (1,303 pass and 17 opt-in LiveWire skip), plus 134 platform, 48 app and 46 tool cases, with zero failures or errors. Public release acceptance remains pending.

**Change**
- Top app bar (the bar itself is 03): title *Coach*, then the icon button *History* (Material Symbol `history`; the kit draws `schedule`), then the account seat (03). No ⋮ More, as on iOS: delete the menu (`coach/AskScreen.kt:140-154`). *New chat* lives in History (37); Notes and Connected log are reached from You (46); the account is the seat.
- Every deliberate entry into Coach opens a fresh local chat identity using 37's lifecycle; returning from History, a sheet or recreation restores the selected chat instead. Opening a fresh chat must not clear drafts, cancel an older response or switch its destination. Implement this contract with 37 before declaring the Coach flow complete.
- Scrolling keeps the full native bottom navigation stable; it does not collapse to a single expandable element. The composer sits directly on the canvas, without a separate backing pad. With the IME open use the approved keyboard/inset behavior; do not mistake keyboard avoidance for scroll-driven navigation collapse.
- Bubbles, in a new `coach/CoachBubble.kt` (tasks 29–44 reuse it):
  - Lifter: right-aligned on the accent with on-accent text.
  - Coach: left-aligned on the card fill, ink text.
  - Corners follow the group: First, Middle, Last. 2 dp inside a group, 12 dp between groups, 16 dp gutters.
  - A Markdown answer with a heading, a list or a table uses Width Full (08.10).
- A centred `ChatTimestamp` starts each group: *Today 18:40*. Use the phone's 12- or 24-hour setting.
- Markdown (08.10): add a `CoachBlock.Table` to `coach/CoachMarkdown.kt` and draw it inside the bubble. Example copy: heading *Thursday · Push A*, bullets *Bench Press — 3 × 3 at 90 kg*, table *Movement / Sets / Load*.
- Thinking (01.6): a Coach typing bubble with three dots replaces *reading your log…*. Delete `Ask.waiting`.
- Streaming (08.11): the first revealed characters replace the typing bubble, and the text grows inside the same bubble. Find why the emulator shows the answer whole, and fix it (the running generation's partial text must reach `rememberRevealedText`).
- Copy (08.32): a long press on a bubble shows a 16 % state layer on it and an M3 `DropdownMenu` under it with one item: *Copy answer* on Coach's bubble, *Copy question* on the lifter's. A plain tap does nothing. The TalkBack action carries the same words.
- Jump to latest (08.59): an M3 `ElevatedButton` (small) *Jump to latest* with `keyboard_arrow_down`, centred 12 dp above the composer.
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
- Screenshots of 08.1, 08.10, 08.11, 08.32, 08.59 and 01.6 match in Dark and Daylight on the emulator; the rig (01) adds `08.1-coach-empty-dark` / `-light`, `08.10-coach-markdown-dark` / `-light`, `08.11-coach-streaming-dark` / `-light`, `08.32-coach-copy-dark` / `-light`, `08.59-coach-jump-latest-dark` / `-light`, `01.6-coach-thinking-dark` / `-light`.
- `gym_ask_started` and `gym_ask_outcome` still fire with the same properties; `gym_screen_viewed` `coach` still fires.
- *Copy answer* / *Copy question* emit `gym_action` `{screen: coach, action: copy, outcome: ok}` (05 introduces the event). No message text in any event.
- `coach/AskScreenTests.kt` asserts the bar holds History and the seat and no *More*. Verify fresh entry, return from History, response arrival in an older chat, draft/photo restoration, recreation and scroll with keyboard up/down; the navigation and composer follow the approved states.
- A stream failure still reports under `gym.ask`.
- Tests to update: `coach/AskScreenTests.kt`, `coach/CoachAnswerTests.kt`, `coach/CoachComposerTests.kt`, `coach/CoachMarkdownTests.kt` (a table block), `coach/CoachRevealTests.kt` (partial text inside the bubble).

**Depends on:** 03, 05.

**Ledger:** 11g, 12h, 9r; dogfood `android-gym-target-page`.
