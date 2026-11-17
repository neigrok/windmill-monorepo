# Journal Talk

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
definitions (`D-n`), invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and
roadmap nodes can cite them.

## §0 Status and scope

**Status:** Specified; not approved, and nothing is built. Talk exists on the web only, as a
finished recording sent to the backend's `POST /v1/journal/transcribe`
([journal architecture](../../backend/products/journal/ARCHITECTURE.md)). The iPhone has no Talk.
The build order lives in the Journal Talk roadmap tree, which the dogfood tree
(`t_9362d9bc883e0a1e`) opens from the node `journal-talk`.

**Scope:** Talk as live speech to text: a person speaks and the words appear on today's page while
they speak ([AI service](ai-service.md) I-5). The device's side of it on the iPhone and then on the
web: capture, pauses, the session with the AI service's live door, placing the words, and what a
person is told. Then the retirement of the backend's transcription route.

**Out of scope:** The live door itself and its metering (AI service §6.6, §5). The pass door
([Coach engine](coach-engine.md) §4.1). Buying Windmill One and the door a person without it meets
([subscriptions](subscriptions.md)). Echoes. Android, which has no journal.

**Depends on:** the AI service's live door open in production, which needs its provider key and its
audio billing check (AI service §8.2); a paid period funding a grant in the AI service (AI service
I-7); the pass door and the AI clients of the Coach engine.

## §1 Principles

- **P-1 Words appear as they are spoken.** The page fills while the person talks. Nothing waits for
  the end of a recording. (R-1)
- **P-2 The device runs Talk.** Capture, pause detection, the session and the placing of words are
  the device's. The backend signs a pass and does nothing else; the AI service transcribes and
  meters. No server of Windmill's holds a recording or a transcript (AI service INV-13).
- **P-3 Windmill keeps no audio.** A device holds audio in memory only, and only what §5.5 names.
  It writes none to a file, a store, a log or a backup.
- **P-4 The page is the record.** Words Talk settles are journal text like typed words, saved by
  the page's ordinary save. Talk adds no synced record of its own.
- **P-5 One behaviour, two languages.** Swift and JavaScript answer the same script with the same
  frames, the same page text and the same end. Shared stories hold them to it (§9).
- **P-6 Talk holds no money rule.** The AI service decides whether a session is admitted and what it
  costs. Talk carries its refusals to the person and decides nothing by an amount.

## §2 Vocabulary

*Pass*, *use* and `callId` mean what the [Coach engine](coach-engine.md) §2 and §4 define; *turn*,
`started`, `text`, `turn`, `ended` and `failed` are the live door's (AI service §6.6).

- **D-1 Take.** One use of Talk, from the person's press until it ends. It lasts at most `TAKE_MAX`.
- **D-2 Session.** One call to the live door, named by its `callId`. A take is one session, or
  several in order when a connection is bridged (§5.5).
- **D-3 Settled, unsettled.** A turn's words are *unsettled* while they arrive as `text` deltas and
  *settled* once its `turn` message has given its final text.
- **D-4 Passage.** The span of today's page a take writes: every session's text, in order.
- **D-5 Mark.** A device row, which does not sync, naming the take in progress: its day, its
  sessions' `callId`s in order, the UTF-8 byte length of the page's text before the passage, and the
  UTF-8 byte length of the passage as last saved.

## §3 Where things live

| Part | iPhone | Web |
|---|---|---|
| The pause rule, the passage and the take's states: pure, no I/O | `JournalDomain` | `web/src/products/journal/domain/` |
| Their stories | `packages/api-contract/journal/talk/` | the same files |
| A pass for a use, and the live connection | `WindmillPlatform`, beside the AI client | `web/src/platform/ai/` |
| Microphone capture and conversion | the app's journal room | `web/src/products/journal/talk/` |
| The mark | the device scope's row `talkTake` | the same |

- The AI client MUST offer a pass for a named use without a Coach profile, and the live connection
  MUST obey the client's rules for a pass: memory only, dropped when the seat changes
  (Coach engine INV-1).
- Talk's use is `journal.talk`, version 1. The backend lists it among the uses it signs for.
- The live connection sends the pass as `Authorization: Bearer` on the iPhone and as the second
  offered subprotocol in a browser, beside `wm-live.v1`. It sends no cookie and no installation
  credential.

## §4 Who may talk

Talk is part of Windmill One. What the button does, by the person's state:

| State | Read from | Talk does |
|---|---|---|
| Signed out | the shell | The button is shown and opens the sign-in door. (R-4) |
| No Windmill One | `GET /v1/allowance`: `capabilities.transcription` false with plan none | Opens the store door [subscriptions](subscriptions.md) designs. |
| Windmill One with no funded period | `funding_required` | Says Talk returns when the period is paid. |
| Allowance used | `subject_exhausted` | Says when it returns. |
| Another request running | `concurrency_exhausted` | Says so; nothing is recorded. |
| This build is retired | the pass door's `client-update-required` | Asks for an update. |
| Talk is off | the pass door's 404 or `anonymous_ai_unavailable`; the live door's `provider_unavailable` or `paused` | Says Talk is not available now. |
| Offline | no connection | Says Talk needs a connection, and typing goes on. |
| Microphone refused | the system | Points to Settings. |

- The device reads `GET /v1/allowance` when the button is pressed, before the microphone opens, so
  a person is told why before they speak.
- No screen states an amount of money.
- Wherever Talk is offered, the product says that Windmill keeps no audio and that the service that
  writes it down keeps it for 30 days. The microphone permission text says the same. Neither names a
  provider; the privacy page does. (R-3; AI service R-11)

## §5 The take

### §5.1 Open

1. The device checks §4's states in the table's order and stops at the first that holds.
2. It mints a `callId`, writes the mark, and opens the live door,
   `GET /v1/calls/{callId}/transcription`.
3. The microphone opens when `started` arrives, so nothing is recorded that cannot be written down.
   A first message `failed` ends the take with its code as §4 maps it, and clears the mark.
4. Talk sends no `context` frame and names no language.

### §5.2 Audio and pauses

- The device sends 16-bit little-endian PCM, mono, 24 kHz, in frames of `FRAME`, as they are
  captured.
- **The pause rule.** A frame's level is the RMS of its samples in dBFS. The floor is the lowest
  one-second mean level of the last 10 s. A frame is speech when its level is at least
  `SPEECH_OVER_FLOOR` above the floor and at least `SPEECH_MIN`. The device sends `commit` when
  speech since the last commit has lasted `MIN_TURN` and `PAUSE` of frames that are not speech has
  followed it.
- The service commits a turn itself at its `MAX_TURN`. A pause the rule misses delays when words
  settle and loses none of them.

### §5.3 Words

- A `text` delta appends to its turn's unsettled words. A `turn` message replaces that turn's words
  with its final text and settles them. Turns are placed in turn order whatever order they settle
  in.
- The passage starts as a new paragraph after the page's text. A session's part of it is its
  settled and unsettled turns in order, joined by one space, until the session's `ended` or `failed`
  arrives; then it is that message's `text`, whole.
- The device shows the whole passage as it changes. It saves settled words only: at each `turn`, and
  at each session's end, the page is saved through the page's ordinary save with the page's text and
  the passage's settled part, and the mark's lengths are written in the same local write.
- A page Talk has written into has `source` `spoken`, and typing does not change it back.
- While a take runs, the page takes no typing. One writer changes a page's text at a time.

### §5.4 End

A take ends when the person ends it, at `TAKE_MAX`, at the last second the allowance covers
(`started.remainingSeconds`), when the day changes, or when the app leaves the foreground (R-5).
The last minute before a limit is counted down.

1. The microphone closes at once. The device sends `end`.
2. It waits `END_WAIT` for `ended`, places its `text`, saves, and clears the mark.
3. With no `ended` in that time the take ends with the words it has, and the mark stays for §5.6.

A session the service ends is read the same way: its `text` is placed and saved.

| The service says | The take |
|---|---|
| `ended` `cut` with `idle` | ends; the words stay. Talk says it stopped listening. |
| `ended` `cut` with a refusal of the next slice | ends; the words stay; §4 says why. |
| `ended` `cut` with `restarting` or `paused`; `failed` after `started` | is bridged (§5.5). |

### §5.5 A connection lost

A session whose connection closes or errors without `ended` or `failed`, and one the table above
names, is *bridged*:

1. The microphone stays open. The device keeps what it captures in memory, at most `BRIDGE_WAIT` of
   it, and opens a new session under a new `callId`, added to the mark.
2. When the new session answers `started`, the device sends what it kept, then the live audio.
3. With no `started` within `BRIDGE_WAIT`, or on any refusal, the take ends with the words it has.
4. The lost session's text is read from `GET /v1/calls/{callId}/result` once the service has closed
   it, and replaces that session's part of the passage.

- Audio sent into a failing connection and never transcribed is not sent again, so nothing is
  written twice. Words spoken in that moment can be missing.
- A take is bridged at most `MAX_BRIDGES` times.
- This is the only audio a device holds: at most `BRIDGE_WAIT` of it, in memory, during a bridge.

### §5.6 After the process ends

When the journal room opens and a mark exists, the device reads each marked session's result while
the service still holds it (`RECOVER_FOR` from the session's start by the device's clock).

- It replaces the passage with the sessions' texts only while the page's text after the mark's first
  length is exactly the passage the mark recorded. Otherwise it changes nothing.
- Either way it clears the mark once every session has answered, or `RECOVER_FOR` has passed.
- It never opens a session and never records.

- **INV-1.** A device writes no audio to storage and holds none in memory beyond §5.5.
- **INV-2.** Only settled words are saved to a page, and a take changes no text but its own passage.
- **INV-3.** A device sends audio only while a take is running and the app is in the foreground.
- **INV-4.** Nothing of a take is logged or reported: no audio, no level, no word, no `callId` and
  no pass.

## §6 What a person sees

What a person sees is built only from boards marked ✅ Ready for dev. The boards approved on
2026-11-08 draw a finished recording written down at the end (Journal · iOS 03.3P to 03.6P); R-1
replaces that interaction, so Talk's live states are drawn again and approved before they are built.
The boards for the first microphone request (03.1P), a refused microphone (03.2P), offline (03.7P)
and the largest text (03.8P) keep their place, with §4's sentence in the permission text.

The design MUST draw: listening with words arriving; unsettled words told apart from settled ones;
ending; the last minute; a take that ended by itself, for each cause §5.4 names; a bridge, which
SHOULD be quiet; every state of §4; and the web's twins of each.

## §7 The web

The web's Talk moves to the same behaviour after the iPhone's (R-6).

- It captures with an audio worklet, converts to the door's format in the browser, and runs the same
  domain code against the same stories.
- A take runs in one tab. The tab takes a browser lock named for the day's page before it writes
  the mark, and another tab shows Talk as running elsewhere.
- Once the web's bundle has moved, `POST /v1/journal/transcribe` answers `410`
  `client-update-required`, and a bundle that still calls it reloads. The route, the backend's
  transcriber, its voice ration and its provider key for transcription are then deleted
  (AI service I-8).
- The web's held recording, its Download and its retry of a refused take retire with the route.

## §8 What the backend does

It signs a pass for `journal.talk` at the pass door, under the rules of every other use. It logs
one line for each, as the Coach engine §10 says. It holds no route of Talk's own.

## §9 Testing

- **Stories.** `packages/api-contract/journal/talk/pauses.json` gives sequences of frame levels and
  the frames at which a commit is sent. `takes/` gives scripts: the person's acts, the service's
  messages and the connection's faults in, and out the frames sent, the page's text and the saved
  text after each step, the mark, and how the take ends. Each language runs every file, and a story
  lands before the rule it pins.
- **The service played.** No test in CI calls the AI service or a provider. Tests play the live
  door from `packages/api-contract/ai`.
- **Through the real door.** Before a product screen depends on it, each surface drives a take
  through the pass door and the AI service on a local stack with a played provider: a take that
  ends, one cut by the allowance, one bridged, and one recovered after the process is killed. Each
  checks one settled charge a session and that no log holds a word.
- **On a device.** A take against the real provider on a physical iPhone is part of the AI
  service's billing check, with spending the owner authorises.

## §10 Observability

- Events, with no word of the person's: `journal_talk_refused` with the code and whether it came
  before or during a take; `journal_talk_take` when a take ends, with how it ended, its code, its
  length in seconds as a bucket, its turns and its bridges as counts.
- Sentry, under static names: `ai-pass` and `ai-call` as the AI client reports them;
  `journal-talk-capture` for a microphone or conversion failure; `journal-talk-recover` for a
  recovery that could not read a result it should have. A refusal a person can act on is an event
  and never an Issue.
- Each surface lists these in its observability document, and the iPhone's telemetry allowlist
  gains the AI service's routes.

## §11 Values

| Name | Value | Whose |
|---|---|---|
| `TAKE_MAX` | 10 min (R-2) | Talk's |
| `FRAME` | 100 ms, 4,800 bytes | Talk's |
| `PAUSE` | 700 ms | the pause rule's |
| `SPEECH_OVER_FLOOR`, `SPEECH_MIN` | 10 dB, −50 dBFS | the pause rule's |
| `MIN_TURN` | 1 s, the service's | the live door's |
| `BRIDGE_WAIT` | 10 s, the service's `LIVE_BURST` | Talk's |
| `MAX_BRIDGES` | 3 | Talk's |
| `END_WAIT` | 15 s, over the service's `LIVE_CLOSE_WAIT` | Talk's |
| `RECOVER_FOR` | 10 min, the service's `RESULT_LINGER` | Talk's |

## §12 Gaps this build closes

- The iPhone app reads nothing about Windmill One or an allowance, has no microphone code and no
  microphone permission text.
- The iPhone's AI client fetches a pass only for a Coach profile and speaks no WebSocket.
- The web never marks a page `spoken`, though the journal's architecture says it does.
- The web's copy says no audio is kept anywhere, which the provider's 30 days makes untrue.
- The live door refuses every session in production until its audio billing is verified, and a paid
  period funds no grant in the AI service yet.

## §13 Rulings

| | Question | Ruling |
|---|---|---|
| R-1 | Whether words appear while a person speaks | They do. The approved boards for a finished recording are replaced. (2026-11-17) |
| R-2 | How long one take may run | 10 minutes. (2026-11-17) |
| R-3 | What Talk says about the audio | "Windmill keeps no audio. The service that writes it down keeps it for 30 days." No provider is named where Talk is offered. (2026-11-17) |
| R-4 | Talk signed out | The button is shown and opens sign-in. Brand canon's rule that Windmill One is never shown signed out takes this exception. (2026-11-17) |
| R-5 | The app leaves the foreground during a take | The take ends and its words stay. Talk never records in the background. (2026-11-17) |
| R-6 | The web's Talk | The same behaviour through the AI service, built after the iPhone's and before the backend's transcription model shuts down on 2027-02-26. (2026-11-17) |
| R-7 | Which path the iPhone takes to the model | The AI service's live door, not the backend's route. (2026-11-17) |
