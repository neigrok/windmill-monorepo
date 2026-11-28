# Journal Talk

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
definitions (`D-n`), invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and
roadmap nodes can cite them.

## §0 Status and scope

**Status:** Specified, and approved by the owner on 2026-11-17; nothing is built. Talk exists on the web only, as a
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

**Depends on:**

- the pass door and the device AI clients of the Coach engine, merged and linked into the app, with
  the backend's signing key and the AI service's matching key set in production;
- `journal.talk` among the uses the backend signs for;
- the live door open in production, which needs the AI service's own provider key and its audio
  billing check (AI service §8.2);
- a paid period funding a grant in the AI service (AI service I-7), without which only an owner's
  account can talk.

## §1 Principles

- **P-1 Words appear as they are spoken.** The page fills while the person talks. Nothing waits for
  the end of a recording. (R-1)
- **P-2 The device runs Talk.** Capture, pause detection, the session and the placing of words are
  the device's. The backend signs a pass and does nothing else; the AI service transcribes and
  meters. No server of Windmill's holds a recording or a transcript (AI service INV-13).
- **P-3 Windmill keeps no audio.** A device holds audio in memory only, and only what §5.5 names.
  It writes none to a file, a store, a log or a backup.
- **P-4 The page is the record.** Words Talk settles are journal text like typed words, saved as
  typing is saved. Talk adds no synced record of its own.
- **P-5 One behaviour, two languages.** Swift and JavaScript answer the same script with the same
  frames, the same page text and the same end. Shared stories hold them to it (§9).
- **P-6 Talk holds no money rule and shows no count of money or allowance.** The AI service decides
  whether a session is admitted and when the allowance ends it.

## §2 Vocabulary

*Pass*, *use* and `callId` mean what the [Coach engine](coach-engine.md) §2 and §4 define; *turn*,
`started`, `text`, `turn`, `ended` and `failed` are the live door's (AI service §6.6).

- **D-1 Take.** One use of Talk, from the person's press until it ends. It lasts at most `TAKE_MAX`.
- **D-2 Session.** One call to the live door, named by its `callId`. A take is one session, or
  several in order when a connection is bridged (§5.5).
- **D-3 Settled, unsettled.** A turn's words are *unsettled* while they arrive as `text` deltas and
  *settled* once its `turn` message has given its final text.
- **D-4 Passage.** The span of today's page a take writes: every session's part, in order.
- **D-5 Mark.** The device row `talkTake` of `device/journal`, which does not sync. It names the
  take in progress: its day, the UTF-8 byte length of the page's text before the passage, and for
  each session in order its `callId`, the byte length of its part as last saved, and the device's
  time when it was last heard from.

## §3 Where things live

| Part | iPhone | Web |
|---|---|---|
| The pause rule, the passage and the take's states: pure, no I/O | `JournalDomain` | `web/src/products/journal/domain/` |
| The save that writes spoken words and the mark together, `SaveSpoken` | `JournalDomain` | the same folder |
| Their stories | `packages/api-contract/journal/talk/` | the same files |
| A pass for a use, and the live connection | `WindmillPlatform`, beside the AI client | `web/src/platform/ai/` |
| Microphone capture and conversion | the app's journal room | `web/src/products/journal/talk/` |

- The journal's registry gains the device row `talkTake`, kept on the device only. The registry's
  version rises with it and its minimum does not.
- The AI client MUST offer a pass for a named use without a Coach profile, and the live connection
  MUST obey the client's rules for a pass: memory only, dropped when the seat changes
  (Coach engine INV-1).
- Talk's use is `journal.talk`, version 1.
- The live connection sends the pass as `Authorization: Bearer` on the iPhone and as the second
  offered subprotocol in a browser, beside `wm-live.v1`. It sends no cookie and no installation
  credential.

## §4 Who may talk

Talk is part of Windmill One. When the button is pressed the device reads the backend's
`GET /v1/subscription` and the AI service's `GET /v1/allowance`, before the microphone opens, so a
person is told why before they speak. It stops at the first row that holds:

| State | Read from | Talk does |
|---|---|---|
| Signed out | the shell | The button is shown and opens the sign-in door. (R-4) |
| Offline | no connection | Says Talk needs a connection, and typing goes on. |
| Microphone refused | the system | Points to Settings. |
| This build is retired | the pass door's `client-update-required` | Asks for an update. |
| No Windmill One | the subscription's `windmillOne` false | Opens the store door [subscriptions](subscriptions.md) designs. |
| Windmill One with no funded period | `windmillOne` true and the allowance's `capabilities.transcription` false; the live door's `funding_required` | Says Talk returns when the period is paid. |
| Allowance used | `subject_exhausted` | Says when it returns. |
| Another request running | `concurrency_exhausted` | Says so; nothing is recorded. |
| Busy | `busy`, `rate_limited`, `accounting_unavailable`, from either door | Says to try again in a moment. |
| Talk is off | the pass door's 404 or `unavailable`; the live door's `provider_unavailable` or `paused` | Says Talk is not available now. |
| A defect | `invalid_request`, `conflict`, `too_large`, `untrusted-origin`, every `pass_` code but one `pass_expired`, an answer that cannot be read | Says Talk is not available now, and is reported. |

- On the iPhone a refused upgrade yields its status and no reason: a 401 fetches a new pass and
  tries once more, a second 401 is a defect, and no other status is tried again. A browser cannot
  read even that, so it fetches a new pass and tries once more for any failed upgrade.
- Wherever Talk is offered, the product says that Windmill keeps no audio and that the service that
  writes it down keeps it for 30 days. The microphone permission text says the same. Neither names a
  provider; the privacy page does. (R-3; AI service R-11) The AI service calls one provider and has
  no fallback, so the sentence has one provider to be true of.

## §5 The take

### §5.1 Open

1. The device checks §4's states.
2. It mints a `callId`, writes the mark, and opens the live door,
   `GET /v1/calls/{callId}/transcription?label=talk`.
3. Until `started` arrives Talk shows that it is connecting, and the microphone is closed, so
   nothing is recorded that cannot be written down. A first message `failed` ends the take with its
   code as §4 maps it, and clears the mark.
4. Talk sends no `context` frame and names no language.
5. A take is not opened within `END_WAIT` of the end of the day.

### §5.2 Audio and pauses

- The device captures with the system's voice processing, automatic gain, noise suppression and
  echo cancellation all off, and sends 16-bit little-endian PCM, mono, 24 kHz, in frames of `FRAME`
  (2,400 samples), as they are captured.
- **The pause rule** works in whole numbers, so two implementations agree to the frame.
  - A frame's *energy* is the sum of its samples' squares divided by 2,400, rounded down.
  - Frames are counted from a session's first. Each ten in a row are a *block*, whose energy is the
    sum of its frames' energies divided by ten, rounded down.
  - The *floor* is the lowest energy among the last ten whole blocks. Before one whole block exists
    it is zero.
  - A frame is *speech* when its energy is at least ten times the floor and at least `SPEECH_MIN`.
  - The device sends `commit` after the frame that makes `PAUSE` of frames in a row that are not
    speech, once the speech frames since the last commit number at least `MIN_TURN`. The counts
    start again at a commit and at a new session.
- The service commits a turn itself at its `MAX_TURN`. A pause the rule misses delays when words
  settle and loses none of them.

### §5.3 Words

- A `text` delta appends to its turn's unsettled words. A `turn` message replaces that turn's words
  with its final text and settles them; a later delta for that turn is ignored.
- **A session's part** is its turns that hold text, in turn order whatever order they settle in,
  joined by one space, until the session's `ended` or `failed` arrives; then it is that message's
  `text`, whole.
- **The passage** is the sessions' parts joined by one space. It follows the page's text, with its
  trailing whitespace removed, after a blank line; on an empty page it stands alone.
- **Showing.** The device shows the whole passage as it changes. Unsettled words are shown only:
  they are never in the editor's document or its draft.
- **Saving.** At each `turn`, and at each session's end, `SaveSpoken` saves the page with every
  settled turn in place, and writes the mark's lengths in the same local write. It replaces the
  page's text whole, as typing does, and never carries a page into another day.
- A page Talk has written into has `source` `spoken`, and typing keeps it.
- While a take runs, the page takes no typing on that device, and in a browser no other tab types
  on it.
- A take stops at the last whole turn that fits the page's size limit, and says the page is full.

### §5.4 End

A take ends when the person ends it; at `TAKE_MAX`, whose last minute is counted down; `END_WAIT`
before the day ends; when the app leaves the foreground (R-5); when the system takes the microphone
for a call, an alarm or its assistant, or the microphone's device goes; and when capture fails.

1. The microphone closes at once. The device sends `end`.
2. It waits `END_WAIT` for `ended`, places its `text`, saves, and clears the mark. On the iPhone it
   asks the system for that long when it has left the foreground.
3. With no `ended` in that time it saves the unsettled words as they arrived, and the mark stays
   for §5.6.
4. An ended take offers Undo once, which removes its passage in one save.

A session the service ends is read the same way: its `text` is placed and saved.

| The service says | The take |
|---|---|
| `ended` `cut` with `idle` | ends; the words stay. Talk says it stopped listening. |
| `ended` `cut` with a refusal of the next slice | ends; the words stay; §4 says why. |
| `ended` `cut` with `paused` or `restarting` | ends; the words stay; Talk says it is not available now. |
| `failed` `provider_failed` after `started` | is bridged (§5.5). |
| any other `failed` after `started` | ends; the words stay; §4 says why. |

### §5.5 A connection lost

A connection is lost when it closes or errors without `ended` or `failed`, and when the device's
own check says it is dead: audio waiting to be sent passes `LIVENESS`, or on the iPhone a ping goes
unanswered that long. A lost session, and one the table above names, is *bridged*:

1. The microphone stays open. The device keeps what it captures in memory, at most `BRIDGE_WAIT` of
   it, and opens a new session under a new `callId`, added to the mark.
2. A new session refused `concurrency_exhausted` is tried again within `BRIDGE_WAIT`: the lost
   session can hold its place for some tens of seconds.
3. When the new session answers `started`, the device sends what it kept, then the live audio. A
   person who ends the take meanwhile is answered the same way: the kept audio is sent, then `end`.
4. With no `started` within `BRIDGE_WAIT`, or on any other refusal, the take ends with its words.
5. The lost session's `text` is read from `GET /v1/calls/{callId}/result`, every `RESULT_POLL`
   while the service answers that the session is still open, and replaces that session's part of
   the passage. A session whose result is gone or unknown keeps the part it has.

- Audio sent into a failing connection and never transcribed is not sent again, so nothing is
  written twice. Words spoken in that moment can be missing.
- A take is bridged at most `MAX_BRIDGES` times.
- This is the only audio a device holds: at most `BRIDGE_WAIT` of it, in memory, during a bridge.

### §5.6 Recovery

When the journal room opens or returns to the foreground and a mark exists, the device recovers
it, once it has pulled the journal's scope whole.

- A mark whose day is no longer today, or whose seat is no longer the device's, is cleared and
  nothing is written.
- Otherwise the device reads the result of each marked session heard from within `RECOVER_FOR`. A
  session that answers with its text has its part replaced by it; one whose result is gone or
  unknown keeps its part.
- It writes only while the page's text after the mark's first length is exactly the parts the mark
  recorded. Otherwise it changes nothing.
- It clears the mark once every session has answered or `RECOVER_FOR` has passed for it.
- It never opens a session and never records.

- **INV-1.** A device writes no audio to storage and holds none in memory beyond §5.5.
- **INV-2.** On the device that runs a take, nothing but the take changes the page's text while it
  runs, and only settled words are saved, but for the end §5.4 step 3 names. A change another
  device makes to the same page meanwhile meets the take's saves as it would meet typing: the later
  save stands.
- **INV-3.** A device sends audio only while a take is running and the app is in the foreground.
- **INV-4.** Nothing of a take is logged or reported: no audio, no level, no word, no `callId` and
  no pass.

## §6 What a person sees

What a person sees is built only from boards marked ✅ Ready for dev. The boards approved on
2026-11-08 draw a finished recording written down at the end (Journal · iOS 03.3P to 03.6P, and
03.8P at the largest text); R-1 replaces that interaction, so Talk is drawn again and approved
before it is built. The first microphone request (03.1P), a refused microphone (03.2P) and offline
(03.7P) keep their place, with their words checked against live Talk and §4's sentence.

The design MUST draw, for the iPhone and the web: connecting; listening with words arriving;
unsettled words told apart from settled ones; ending; the last minute; Undo of a take; a take that
ended by itself, for each cause §5.4 names; a bridge, which SHOULD be quiet; every state of §4; and
each at the largest text.

## §7 The web

The web's Talk moves to the same behaviour after the iPhone's (R-6).

- It captures with an audio worklet, converts to the door's format in the browser, and runs the same
  domain code against the same stories.
- A take runs in one tab. The tab takes a browser lock named for the day's page before it writes
  the mark, and another tab shows Talk as running elsewhere and takes no typing on that page.
- Once the web's bundle has moved, `POST /v1/journal/transcribe` answers `410`
  `client-update-required`, as gym's retired routes do, and a bundle that still calls it reloads.
  The backend's transcriber, its voice ration, its provider key and their configuration are then
  deleted (AI service I-8).
- The web's held recording, its Download and its retry of a refused take retire with the route.
- Should the web's move not land before the backend's transcription model shuts down on
  2027-02-26, Talk on the web is off from that day until it does.

## §8 What the backend does

It signs a pass for `journal.talk` at the pass door, under the rules of every other use. It logs
one line for each, as the Coach engine §10 says. It holds no route of Talk's own.

## §9 Testing

- **Stories.** `packages/api-contract/journal/talk/pauses.json` gives sequences of frame energies
  and the frames after which a commit is sent: made-up ones for each clause of the rule, and
  recorded ones from a quiet room, a car, a café, earbuds and a whisper. `takes/` gives scripts:
  the person's acts, the service's messages and the connection's faults in, and out the frames
  sent, the page's text and the saved text after each step, the mark, and how the take ends. They
  cover every row of §5.4's table, each step of §5.5 and §5.6, a turn that settles out of order, an
  empty turn, a take across the page's size limit, and typing that keeps `spoken`. Each language
  runs every file, and a story lands before the rule it pins.
- **The service played.** No test in CI calls the AI service or a provider. Tests play the live
  door from `packages/api-contract/ai`.
- **Through the real door.** Before a product screen depends on it, each surface drives a take
  through the pass door and the AI service on a local stack with a played provider: a take that
  ends, one cut by the allowance, one bridged, one whose connection dies silently, and one recovered
  after the process is killed. Each checks one settled charge a session and that no log holds a
  word.
- **On a device.** A take against the real provider on a physical iPhone is part of the AI
  service's billing check, with spending the owner authorises.

## §10 Observability

- Events, with no word of the person's:
  - `journal_talk_refused`, with the code and whether it came before or during a take;
  - `journal_talk_started`;
  - `journal_talk_ended`, with how it ended, its code, its length in seconds as a bucket, its turns,
    the turns the service had to commit itself, and its bridges as counts;
  - `journal_talk_undone` and `journal_talk_recovered`, the second with how many sessions answered.
- The web's present `journal_talk_take` and `journal_talk_retry` retire with its held recording.
- Sentry, under static names: `ai-pass`, `ai-call` and, for the live door, `ai-live`, as the AI
  client reports them;
  `journal-talk-capture` for a microphone or conversion failure; `journal-talk-recover` for a
  recovery that could not read a result it should have. A refusal a person can act on is an event
  and never an Issue.
- Each surface lists these in its observability document, and the iPhone's telemetry allowlist
  gains the AI service's routes.

## §11 Values

| Name | Value | Whose |
|---|---|---|
| `TAKE_MAX` | 10 min (R-2) | Talk's |
| `FRAME` | 100 ms: 2,400 samples, 4,800 bytes | Talk's |
| `PAUSE` | 7 frames | the pause rule's |
| `MIN_TURN` | 10 speech frames, the service's 1 s | the pause rule's |
| `SPEECH_MIN` | an energy of 10,737, which is −50 dBFS | the pause rule's |
| `LIVENESS` | 2 s | Talk's |
| `BRIDGE_WAIT` | 10 s, the service's `LIVE_BURST` | Talk's |
| `MAX_BRIDGES` | 3 | Talk's |
| `END_WAIT` | 15 s, over the service's `LIVE_CLOSE_WAIT` | Talk's |
| `RESULT_POLL` | 5 s | Talk's |
| `RECOVER_FOR` | 10 min from when a session was last heard, the service's `RESULT_LINGER` | Talk's |

## §12 Gaps this build closes, and what it asks of others

- The iPhone app reads nothing about Windmill One or an allowance, has no microphone code and no
  microphone permission text.
- The web never marks a page `spoken`, though the journal's architecture says it does.
- The web's copy says no audio is kept anywhere, which the provider's 30 days makes untrue.
- The live door refuses every session in production until its audio billing is verified, and a paid
  period funds no grant in the AI service yet.

Asked of the AI service, for its own tree:

- A session's result can answer that it is gone in the instant between its settling and its last
  message; Talk reads once more after `RESULT_POLL`, and the service should not answer so.
- A session whose connection has died holds one of the account's calls for some tens of seconds; a
  shorter rule for a dead socket would let a bridge through sooner.

The build makes false, and corrects in the same change, the sync engine's line that transcription
stays a backend route and the journal architecture's account of Talk.

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
