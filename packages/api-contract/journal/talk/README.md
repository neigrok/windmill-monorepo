# Journal Talk stories

Shared expectations for Talk's pure logic, written from [Journal Talk](../../../../docs/foundation/journal-talk.md);
§n, D-n and INV-n below are its. The specification is the oracle. No implementation supplies an expected value,
and a disagreement changes the implementation, never an expectation to suit a surface. A surface that carries
Talk runs every file here, and its runner fails on a file it does not run.

`generate.py` states every case by hand and writes the files; `generate.py --check` fails when a file is not what
it writes. `check.py` derives what it can a second time, without reading `generate.py`, and refuses a file that
differs; `check.py --self-test` also proves it refuses a set of wrong files.

```sh
python3 packages/api-contract/journal/talk/generate.py --check
python3 packages/api-contract/journal/talk/check.py --self-test
```

## Files

| File | Cases | Runs |
|---|---|---|
| `pauses.json` | 6 frames and their energies, 22 sequences and their commits | `PauseRule` |
| `saves.json` | 13 scenes | `SaveSpoken` |
| `takes/<name>.json` | 19 stories, 92 steps | `Take`, `TakeRecovery` |

`pauses.json` and `saves.json` are the kit's arrays of `{name, input, expect}`, compared by JCS
([kit forms](../../domain-kit/README.md)). A file of `takes/` is one story in the form `journal-take/v1`, a
sibling of the [Coach's turn stories](../../agent/README.md).

Words in every file are made up. A `callId` is one letter 22 times.

## The parts

| Part | What it is |
|---|---|
| `PauseRule` | A session's counters: a frame's energy, and whether a commit follows a frame (§5.2). |
| `Passage` | The page's text before a take and each session's part: the page as shown and as saved (§5.3, D-4). |
| `TalkMark` | The value of the device row `talkTake` (D-5). |
| `Take` | A take's phases and its one step: an input and its time in, outputs out (§5.1, §5.3 to §5.5). |
| `TakeRecovery` | The same step for a mark with no take in memory, and the one home of the rules for reading a session's result (§5.5 step 5, §5.6). |
| `SaveSpoken` | The kit action that writes the page and the mark in one local write (§5.3). |

The driver holds what is not pure: the socket and its liveness check, the pass, the microphone and the bytes of
its frames, minting `callId`s, one timer at `wakeAt`, the background time asked of the system, running
`SaveSpoken`, the pull that precedes a recovery, the screen and the events.

## `pauses.json`

| `input` | `expect` |
|---|---|
| `{op: "PauseRule.energy", samples}` | `{energy}` |
| `{op: "PauseRule.commits", energies}` | `{commits}`: the numbers, from 1, of the frames after which a commit is sent |

`samples` and `energies` are lists. An item is one value, or `[value, count]` for that value `count` times in a
row. `samples` holds a frame's 2,400 samples; `energies` holds one session's frames from its first.

The rule is §5.2, in whole numbers:

- a frame's energy is the sum of its samples' squares divided by 2,400, rounded down;
- frames 1 to 10, 11 to 20 and so on are blocks, and a block's energy is the sum of its frames' energies divided
  by ten, rounded down;
- a frame's floor is the lowest energy among the last ten blocks complete before it, and zero before one is;
- a frame is speech when its energy is at least ten times its floor and at least `SPEECH_MIN`, 10,737;
- a commit follows the frame that makes seven in a row that are not speech, once ten speech frames, in a row or
  not, have come since the last commit; both counts then start again, and the blocks do not.

The floor is under revision (node `m2-revise-the-pause-floor`): the cases that pin a floor follow §5.2 as it
stands, and no sequence recorded from a microphone is here until the floor is settled.

Each sequence, and why its commits are what they are. S is 1,000,000 and a block's energy is written `b1`, `b2`.

| Case | Arithmetic |
|---|---|
| seven quiet frames after ten of speech send one commit | `b1` 0, so the floor is 0. Frames 11 to 20 are speech. Frame 27 is the seventh in a row that is not, with ten speech frames counted. |
| six quiet frames send nothing | The same, one frame short of seven. |
| nine speech frames and a pause send nothing | Frame 26 is the seventh quiet one, with nine speech frames counted. |
| before one whole block the floor is zero | Frames 1 to 9 at 20,000 are speech against a floor of 0. `b1` is 18,000, so frame 11 at 200,000 is the tenth speech frame, and frame 18 the seventh quiet one after it. |
| a frame is judged against the blocks complete before it | Frame 10 completes `b1` and is judged before it: floor 0, the tenth speech frame. Judged against `b1`, 20,000, it would not be speech and nothing would be sent. |
| an energy of 10,736 is not speech; an energy of 10,737 is speech | The floor is 0, so `SPEECH_MIN` alone decides. |
| ten times the floor is speech; one less than ten times the floor is not speech | `b1` 2,000: 20,000 is speech and 19,999 is not. |
| a block's energy rounds down | `b1` is 20,009 / 10 = 2,000, so 20,000 is speech. Rounded up it would be 2,001 and 20,000 would fall short of 20,010. |
| the floor is the lowest of the whole blocks | `b1` 5,000, `b2` 2,000, `b3` 9,000: the floor is 2,000 and frames 31 to 40 at 20,000 are speech. |
| ten blocks back a block still holds the floor | Frames 101 to 110 see blocks 1 to 10, so the floor is `b1`, 1,000, and 20,000 is speech. |
| an eleventh block pushes the first out of the floor | Frames 111 to 120 see blocks 2 to 11, all 5,000, so 20,000 falls short of 50,000. |
| speech frames need not be in a row | Five speech frames, three quiet, five speech: ten counted, and frame 30 is the seventh quiet one. |
| one speech frame starts a quiet run again | Six quiet frames, one of speech, then seven: the commit follows frame 34, not frame 28. |
| a pause before enough speech is not kept for later | Seven quiet frames after nine of speech send nothing. The tenth speech frame needs seven quiet frames of its own, to frame 34. |
| a long silence sends one commit | The counts start again at the commit after frame 27, and silence counts no speech. |
| after a commit nine speech frames send nothing; after a commit ten speech frames and a pause send the next | The second turn needs ten speech frames of its own: with ten, frame 44 is the seventh quiet one. |
| the floor does not start again at a commit | `b1` 2,000 still holds the floor after the commit at frame 27, so 15,000 is not speech. Were the blocks counted again from the commit, the floor would be 0 and frame 44 would send a second commit. |
| an empty sequence sends nothing; a sequence shorter than a block sends nothing | No frame makes seven quiet in a row. |

## The mark

The device row `talkTake` (D-5), null when there is none:

```json
{"day": "2026-10-01", "bytesBefore": 9, "pageDigest": "2b52e661f19e998f",
 "sessions": [{"callId": "AAAAAAAAAAAAAAAAAAAAAA", "bytesSaved": 20, "heardAt": 1790856003900}]}
```

- `day` is the take's local day.
- `bytesBefore` is the UTF-8 length of the page's text before the take with its trailing whitespace removed.
  Whitespace is ECMAScript's `WhiteSpace` and `LineTerminator`, as the journal corpus trims; U+0085 is content.
- `pageDigest` is the first 16 lowercase hexadecimal characters of the SHA-256 of the UTF-8 bytes of the page's
  text as the take last saved it; before its first save, of the page's text as it stood at the press. It is
  written with every write of the mark.
- `sessions` are the take's sessions in the order they were opened, one to four. `bytesSaved` is the UTF-8
  length of the session's part as saved. `heardAt` is the time of the session's last message as of that write,
  and the time it was opened before any. The registry's row cannot state the least length, so it admits a mark
  with no session: nothing writes one, and a mark found so is no mark.

A page that has the mark's digest is read by the mark's lengths: its first `bytesBefore` bytes; then, when no
part has bytes, nothing but whitespace; otherwise two line feeds when `bytesBefore` is above zero, and each part
that has bytes, of its length, one space between two.

## `saves.json`

The scene of the journal corpus's [`page-actions.json`](../domain/README.md#actions), unchanged:
`{action, input, records: {drawn}, devices?, ids, now, offsetSeconds, actor}` in, `{decision}` out.

| Action | Input | Result |
|---|---|---|
| `SaveSpoken` | `{day, body, source, mark, whilePage}` | as `SavePage`: the claim id of a day with a pending claim, null otherwise |

`SaveSpoken` is the one write of a take and of a recovery.

- `mark` is the mark to store, or null to clear it. Every write decision carries it as the device write
  `talkTake`, after the other device writes, which are in the order of their keys.
- `body` null leaves the page as it is: the decision writes the mark and nothing else.
- Otherwise the decision is `SavePage`'s for the document `{body, mood, energy, source}`, its ratings those the
  phone holds for the day as `SaveWords` takes them, with the mark's write added. A refusal of `SavePage`'s is the
  refusal, and then the mark is not written either.
- `whilePage` null writes whatever the page holds. Otherwise it is a digest in the mark's form, and the decision
  is `{unchanged: {result: null}}` unless the drawn page's text, empty where the day has no page, has that digest.
  A take's own saves pass null. Recovery and Undo pass the digest of the page as the take last saved it (§5.4
  step 4, §5.6).

No scene draws a `journalState` record, so every save of a written page retires the first-run copy, as the
journal corpus's scenes do: a repeated retirement is a difference the corpus permits between surfaces.

## `takes/`

`{format, name, given, steps, end, recovered}`.

- `given`: `offsetSeconds`, the phone's zone as the journal corpus gives it; `page`, the day's page as the phone
  draws it at the first step, `{body, source}` or null; `mark`, null for a take and the stored mark for a
  recovery; `callIds`, the ids the take mints, used in order, every one of them.
- `steps`: each `{at, in, out}`. `at` is the device's clock in ms. `in` is one input, an object with one key.
  `out` holds the seven outputs after it, all seven always.
- `end`: how the take ended, or null while it runs or where the story has none.
- `recovered`: how the recovery finished, or null.

A story whose first input is `press` runs a `Take`. A `recover` input runs a `TakeRecovery` from the mark and the
page as stored then: as the first input of a story, or after the story's take has ended.

### Inputs

| Input | Whose | Meaning |
|---|---|---|
| `{press: true}` | the person | Talk was pressed and §4's reads let a take open. The first input of a take. |
| `{end: true}` | the person | The person ends the take. |
| `{undo: true}` | the person | Undo of an ended take. |
| `{frames: [...]}` | the device | Captured frames, as energies in `pauses.json`'s list form. The i-th, from 0, is captured at `at + 100·i`, and the next step is no earlier than the last of them. |
| `{background: true}` | the device | The app left the foreground. |
| `{microphoneTaken: true}` | the device | The system took the microphone, or its device went. |
| `{captureFailed: true}` | the device | Capture failed. |
| `{heard: {callId, message}}` | the service | One message of that session, whole, in the shape of the [AI wire](../../ai/README.md)'s `liveEvents`. A take reads `type`, `turn`, `delta`, `text`, `stop` and `code` and nothing else of it. |
| `{lost: {callId}}` | the connection | The connection closed, errored or was judged dead, with no last message. |
| `{unopened: {callId, code}}` | the connection | The door never opened: the code a door gave, or `offline`. |
| `{unreadable: {callId}}` | the connection | A message that could not be read. |
| `{result: {callId, message}}` | a result read | The session's last message, as its result gives it. |
| `{result: {callId, code}}` | a result read | The result door's refusal: `conflict` while the session is open, `result_gone`, `call_unknown`. |
| `{result: {callId, unread: true}}` | a result read | The read failed any other way. |
| `{recover: true}` | the room | The journal room opened or came back to the foreground, or the take ended with its mark standing, and the journal's scope is pulled whole. |
| `{clock: true}` | the clock | A wake with nothing else. |
| `{changed: page}` | the store | The day's page became `{body, source}`, or null, by another hand: another device, or the person typing after a take. No part reads it at that step: of the outputs only `saved` changes. |

### Outputs

| Output | Meaning |
|---|---|
| `phase` | `connecting`, `listening`, `bridging`, `ending` or `ended` for a take; `recovering` or `recovered` for a recovery. |
| `do` | The driver's orders of this step: `{microphone: "open" \| "closed"}`, `{close: callId}`, `{open: callId}` (open the live door for it), `{read: callId}` (read its result). They are listed in that order of kinds. |
| `send` | The frames sent in this step on the current session's connection, in order: `{audio: [first, last]}`, captured frames by their number in the take from 1; `{type: "commit"}`; `{type: "end"}`. |
| `page` | What is shown: `{text, unsettled}`. `unsettled` holds one half-open range of UTF-16 offsets into `text` for each turn whose words are shown and not saved, in order. |
| `saved` | The day's page as stored, `{body, source}`, or null where the day has none. |
| `mark` | The mark as stored, or null. |
| `wakeAt` | The earliest deadline standing, or null. |

A step that changes `saved` or `mark`, other than a `changed` step, is one `SaveSpoken`.

`end` is `{cause, code, heard, turns, forcedTurns, bridges}`:

- `cause` is what first ended the take: `person`, `limit` (`TAKE_MAX`), `dayEnd`, `background`, `microphone`,
  `capture`, `pageFull`, `refused` (before the first `started`), `service` (an `ended` or a `failed` the take did
  not ask for, after `started`), `bridge` (a bridge that did not hold) or `defect`.
- `code` is the service's or the door's code for `refused`, `service` and `bridge`, where one came; otherwise
  null.
- `heard` says whether the take's last session said `started` and then gave its last message.
- `turns` counts the turns a message named. `forcedTurns` counts those the service committed itself: for each
  session, its highest turn number less one less the commits sent to it, where that is above zero. `bridges`
  counts the sessions opened after the first. They are §10's counts.

`recovered` is `{cause, answered}`: `dropped` for a mark that was none to recover, its day passed or no session
in it, and `recovered` otherwise; and the number of sessions whose result gave their text.

### The clock

- Every input carries `at`. An input first lets each deadline due at or before `at` take effect, in the order of
  their instants, and is read after them.
- `wakeAt` is the earliest of the deadlines standing:
  - `TAKE_MAX` after the press, and `END_WAIT` before the day's end, while the take is `connecting`, `listening`
    or `bridging`;
  - `BRIDGE_WAIT` after the loss that began a bridge, until a session says `started`;
  - `BRIDGE_RETRY` after a `concurrency_exhausted`, where that falls before the bridge's wait ends;
  - `END_WAIT` after `end` was sent, or the day's last millisecond when that comes first;
  - `RESULT_POLL` after a result answered `conflict`, a first `result_gone` or `unread`;
  - in a recovery, `RECOVER_FOR` after each session still being read was last heard.
- The day and its end are the phone's, by `offsetSeconds`.

### A take

- **Press.** Within `END_WAIT` of the day's end the take ends at once, `dayEnd`. On a page with no room for the
  blank line and one byte it ends at once, `pageFull`. Neither mints a `callId` or writes a mark. Otherwise the
  take writes the mark, orders the door opened and is `connecting`. A take reads the page once, here.
- **Before the first `started`.** A first message `failed`, an `unopened` and a `lost` each end the take
  `refused` and clear the mark. An end of any cause closes the connection and clears the mark: nothing was
  recorded.
- **`started`.** The microphone opens and the take is `listening`. A second `started`, and an `unreadable`, end
  the take `defect`: the connection is closed, the words shown are saved and the mark stays.
- **Frames.** A frame captured while `listening` is sent as it is captured, and a commit follows it where the
  session's `PauseRule` says. A frame captured while the microphone is closed is dropped and takes no number.
- **Words.** §5.3: a `text` delta appends to its turn; a `turn` settles it; a turn is known by its session and
  number, a number not seen begins a turn, and numbers need not follow one another. A message of a session that
  was lost or gave its last message is ignored.
- **Saving.** Each `turn`, each session's last message and each answer that settles a lost session is a save: the
  page with every settled turn in place, as `spoken`, and the mark. While the passage holds no text the page is
  not saved and only the mark is written. A `started`, a `text` delta and a frame write nothing.
- **The page's size limit.** A save that would pass 131,072 bytes is not made, and nothing is written at that
  step. The take is `pageFull`: it shows the page as saved, closes the microphone, sends `end` and waits as any
  end does. The session's last text replaces its part only if the page then fits.
- **An end.** The microphone closes and `end` is sent; the take is `ending` and goes on placing words. The
  session's last message places its text and the take is `ended`. With none by the deadline, where the
  connection is then closed, or when the connection is lost while `ending`, every word shown is saved as it
  arrived and the take is `ended`.
- **The service ends a session.** An `ended` the take did not ask for, and a `failed` other than
  `provider_failed`, place their text and end the take `service` with their code.
- **The mark at the end.** It is cleared when every session has given its last message or its result. Otherwise
  it is written with the take's last save and stays, every word shown is saved as it arrived, and the take orders
  no more reads: the driver sends `recover`.
- **Undo.** Once, after the take has ended, and only while the page's text is as the take last saved it: the page
  is again the page `given` held, text and source, and a mark still standing is cleared. A second Undo, and an
  Undo after the page changed, write nothing.
- **After the end** the take shows the page as stored and nothing is unsettled.

### A bridge

- A `lost` session that had said `started`, and a `failed` `provider_failed`, are bridged, three times at most:
  the take mints the next `callId`, adds it to the mark in the same write, orders its door opened and is
  `bridging`. A fourth such loss ends the take `bridge`.
- A lost session is read (below). One that `failed` gave its text with that message and is not.
- Frames captured while `bridging` are kept and sent, in order, when the new session says `started`; its
  `PauseRule` starts with the first of them. A person who ends the take meanwhile is `ending`, and `end` follows
  the kept frames.
- A first message `failed` `concurrency_exhausted` is tried again `BRIDGE_RETRY` later under the same `callId`,
  while that falls before the wait's end. Any other first failure, an `unopened`, and the wait's end with no
  `started` end the take `bridge`.
- A bridge's session `lost` before its `started` is another bridge, under the wait already running.

### Reading a result

One set of rules, `TakeRecovery`'s, which a `Take` uses for its lost sessions.

- A message replaces the session's part with its `text`, whole, if the page then fits.
- `conflict` and `unread` are read again `RESULT_POLL` later. A first `result_gone` is read once more
  `RESULT_POLL` later; a second stands.
- `call_unknown` and a `result_gone` that stands keep the part the session has, its unsettled words saved as they
  arrived.

### A recovery

- A mark whose day is no longer the phone's today, a day that is no date among them, and a mark that names no
  session are cleared and nothing is written: `dropped`.
- Otherwise each session of the mark heard from within `RECOVER_FOR` is read, whether or not it answered during
  the take. A session at or past `RECOVER_FOR` is not, and one that reaches it unanswered is given up.
- A recovery's step is given the page and the mark as stored at that instant, and its write passes the mark's
  digest as `SaveSpoken`'s `whilePage`: an answer that finds the page without that digest writes nothing. The
  reads go on.
- A write keeps the mark's `day`, `bytesBefore`, `callId`s and `heardAt`, and changes the session's length and the
  digest.
- The mark is cleared when every session read has answered or been given up, and the recovery is `recovered`.
- A recovery orders reads and nothing else.

### The stories

| Stories | Pin |
|---|---|
| `open-and-end`, `open-refused`, `open-provider-unavailable`, `open-unopened` | §5.1 steps 2 and 3 |
| `open-near-day-end` | §5.1 step 5 |
| `open-lost` | §5.5: a first session lost before `started` |
| `end-while-connecting` | §5.4: an end before the first `started` |
| `delta-after-settled`, `turn-unseen`, `multibyte` | §5.3: a turn, its number, bytes and UTF-16 |
| `turn-out-of-order` | §5.3: a part in turn order |
| `turn-empty` | §5.3: a turn that holds no text |
| `turn-forced` | §5.2: the service commits a turn itself |
| `ended-text-replaces-part` | §5.3: the last text, whole |
| `open-empty-page`, `page-trailing-whitespace` | §5.3: the passage and the page before it |
| `page-full`, `open-page-full` | §5.3: the page's size limit |
| `other-device-meanwhile` | INV-2: the later save stands |

Every frame sequence of a story begins its session with a quiet second and sets speech at 1,000,000 against a
quiet of 0, so a revised floor does not move a commit here.

`page-full` and `open-page-full` hold their pages whole, 131 KB a copy, as the journal corpus holds its bodies at
the limit: 1.4 MB and 0.4 MB. A result too large for the page has no story for that cost; `page-full` pins the
rule for a last message, and `SaveSpoken` refuses the page either way.

### What has no story

| Behaviour | Why |
|---|---|
| §4: what Talk says for a state or a code | What a person is told, drawn on boards. `end.cause` and `end.code` are what it is chosen from. |
| §5.2: the capture's settings and format | The microphone's. A device test. |
| §5.3: the page takes no typing while a take runs | The editor's. A UI test. |
| §5.5: `LIVENESS` | The connection's own check. A take sees `lost`. |
| §5.6: the pull that precedes a recovery; the mark and the seat | The driver's and the engine's: a mark is a row of its replica. |
| INV-1, INV-4 | Storage and logs: the tests through the real door (§9). |
| §9: sequences recorded from a microphone | They wait for the capture and for the floor. |
| Typing that keeps `spoken` | The journal corpus's `page-actions.json`. |

## Runners

| File | A runner |
|---|---|
| `pauses.json` | reads the kit's vectors, switches on `op`, and compares by JCS. |
| `saves.json` | builds `SaveSpoken` from `input.input` and decides it over the scene, as the journal corpus's action runner does. |
| `takes/*.json` | lists the folder; for each story keeps a page and a mark, starting from `given`; plays each step, applying a `changed` input and each write to them; compares the seven outputs with `out` by JCS, naming the file and the step at the first that differs; then compares `end` and `recovered`. |

A runner fails on a file under this folder that it does not run, on a `format` that is not `journal-take/v1`, on
an input it does not know and on an `op` or an action its switch does not name. A failure names the file and the
step, never a story's text.

## What `check.py` holds

- `pauses.json`: every answer equals a reference of §5.2 written in `check.py`. The cases above are stated by
  hand, so two derivations agree on each.
- Every mark matches the registry's `talkTake` row. While `sync/journal.registry.json` holds no such row, a mark
  is held to the Talk contract's shape, stated once in `check.py`; the check prints which it ran against.
- Every mark a story or a scene writes names one to four sessions, has the digest of the page it was written
  with, and reads that page by its lengths.
- `saves.json`: a guarded save is `unchanged` exactly when the drawn page's digest differs; a save into another
  day or over 131,072 bytes is refused; every other decision writes the mark last among its device writes, and
  the mark alone writes nothing else.
- `takes/`, from each script alone:
  - every `heard` message passes the AI wire's own check; a `started` equals `liveEvents`' but for its `callId`; a
    last message equals an entry of `liveTerminals` in every field but `text`, or of `liveFirstFailures` whole; a
    control frame equals an entry of `liveFrames`, and none is `context`; a result's code is one of `refusals`;
  - the commits sent to each session are where the reference of §5.2 puts them over the frames sent to it;
  - audio is sent once, in the order captured, to a session that said `started` and was not sent `end`; no more
    than 100 frames are ever kept; nothing captured while `listening` is held back;
  - a mark written by a take names the sessions opened, in order, each with the time of its last message or of
    its opening; a mark written by a recovery changes lengths and digest alone;
  - `wakeAt` is the earliest deadline standing; `end` and `recovered` are what the script makes them: the cause,
    the code and each count;
  - a frame, a `started` and a `text` delta write nothing; a `changed` step changes `saved` alone; a take saves
    as `spoken` and Undo as the page was; nothing is unsettled once a take has ended; a recovery orders reads
    only, of the sessions heard from within `RECOVER_FOR`, on the mark's day.
- A first failure the live fixtures do not hold yet is held to their shape and to the fixtures' `refusals`. The
  codes are listed once, `WAITING_FIRST_FAILURES`, and wait on the node `widen-live-first-failures` of the AI
  service's tree; the check refuses a code there once the fixtures hold it.
- Every clause the files pin has a story, and every story is named by a clause: the table `PINS`.
