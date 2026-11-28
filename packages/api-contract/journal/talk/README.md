# Journal Talk stories

Shared expectations for Talk's pure logic, written from [Journal Talk](../../../../docs/foundation/journal-talk.md);
§n, D-n and INV-n below are its. The specification is the oracle. No implementation supplies an expected value,
and a disagreement changes the implementation, never an expectation to suit a surface. A surface that carries
Talk runs every file here, and its runner fails on a file it does not run.

`generate.py` states every case by hand and writes the files; `generate.py --check` fails when a file is not what
it writes. `reference.py` is a second derivation: the pause rule, a take and a recovery, written from the
specification and this file, reading nothing `generate.py` states. `check.py` requires the reference to give every
answer the files state by hand, and holds the scripts to the AI wire and the marks to the registry;
`check.py --self-test` also proves it refuses 82 wrong sets of files. The reference checks and writes nothing.

```sh
python3 packages/api-contract/journal/talk/generate.py --check
python3 packages/api-contract/journal/talk/check.py --self-test
```

## Files

| File | Cases | Runs |
|---|---|---|
| `pauses.json` | 6 frames and their energies, 22 sequences and their commits | `PauseRule` |
| `saves.json` | 14 scenes | `SaveSpoken` |
| `takes/<name>.json` | 92 stories, 616 steps | `Take`, `TakeRecovery` |

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

Each sequence, and why its commits are what they are. A block's energy is written `b1`, `b2`. Where a row names
no energy, speech is 1,000,000 and quiet is 0 after a first quiet block.

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
  text as the take, or after it its recovery, last saved it; before the first save, of the page's text as it stood
  at the press. It is written with every write of the mark.
- `sessions` are the take's sessions in the order they were opened, one to four. `bytesSaved` is the UTF-8
  length of the session's part as saved. `heardAt` is the time of the last `heard` input the session's take read
  from it, as of that write, and the time it was opened before any; nothing else moves it. The registry's row
  cannot state the least length, so it admits a mark with no session: nothing writes one, and a mark found so is
  no mark.

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
  `talkTake`, among its device writes in the order of their keys.
- `body` null leaves the page as it is: the decision writes the mark and nothing else.
- Otherwise the decision is `SavePage`'s for the document `{body, mood, energy, source}`, its ratings those the
  phone holds for the day as `SaveWords` takes them, with the mark's write added. A refusal of `SavePage`'s is the
  refusal, and then the mark is not written either.
- `whilePage` null writes whatever the page holds. Otherwise it is a digest in the mark's form, and the decision
  is `{unchanged: {result: null}}` unless the drawn page's text, empty where the day has no page, has that digest.
  A take's own saves pass null. A recovery's write of the page and Undo pass the digest of the page as last
  saved (§5.4 step 4, §5.6). A write of the mark alone passes null, so a mark is cleared whatever the page holds.

No scene draws a `journalState` record, so every save of a written page retires the first-run copy, as the
journal corpus's scenes do: a repeated retirement is a difference the corpus permits between surfaces.

## `takes/`

`{format, name, given, steps, end, recovered}`.

- `given`: `offsetSeconds`, the phone's zone as the journal corpus gives it; `page`, the day's page as stored at
  the first step, `{body, source}` or null; `mark`, the mark as stored then, or null; `callIds`, the ids the take
  mints, used in order, every one of them.
- `steps`: each `{at, in, out}`. `at` is the device's clock in ms. `in` is one input, an object with one key.
  `out` holds the seven outputs after it, all seven always.
- `end`: how the take ended, or null while it runs or where the story has none. A press that opened no take says
  why here too.
- `recovered`: how the recovery finished, or null while it runs or where the story has none.

A `press` begins a `Take`. A `recover` begins a `TakeRecovery` from the mark and the page as stored then. A story
has one take at most and one recovery at most, in either order.

### Inputs

| Input | Whose | Meaning |
|---|---|---|
| `{press: true}` | the person | Talk was pressed, §4's reads let a take open, and the room has saved the page. |
| `{end: true}` | the person | The person ends the take. |
| `{undo: true}` | the person | Undo of an ended take. |
| `{frames: [...]}` | the device | Captured frames, as energies in `pauses.json`'s list form. Each is its own input at its own instant: the i-th, from 0, at `at + 100·i`. The next step is no earlier than the last of them. |
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
| `{changed: page}` | the store | The day's page became `{body, source}`, or null, by another hand: another device, or the person typing after a take. No part reads it at that step: of the outputs only `saved` changes, and `page` stays as it was. |

### Outputs

| Output | Meaning |
|---|---|
| `phase` | Of the part acting, the take a press began or the recovery a `recover` began: `connecting`, `listening`, `bridging`, `ending` or `ended` for a take; `recovering` or `recovered` for a recovery. A press that opens no take leaves a recovery acting. |
| `do` | The driver's orders of this step: `{microphone: "open" \| "closed"}`, `{close: callId}`, `{open: callId}` (open the live door for it), `{read: callId}` (read its result). They are listed in that order of kinds. |
| `send` | The frames sent in this step on the current session's connection, in order: `{audio: [first, last]}`, captured frames by their number in the take from 1; `{type: "commit"}`; `{type: "end"}`. |
| `page` | What that part shows: `{text, unsettled}`. `unsettled` holds one half-open range of UTF-16 offsets into `text` for each turn whose words are shown and not saved, in order. |
| `saved` | The day's page as stored, `{body, source}`, or null where the day has none. |
| `mark` | The mark as stored, or null. |
| `wakeAt` | The earliest deadline standing for that part, or null. |

A step that changes `saved` or `mark`, other than a `changed` step, is one `SaveSpoken`.

`end` is `{cause, code, heard, turns, commits, bridges}`:

- `cause` is what first ended the take, always: `person`, `limit` (`TAKE_MAX`), `dayEnd`, `background`,
  `microphone`, `capture`, `pageFull`, `refused` (before the first `started`), `service` (an `ended` or a `failed`
  the take did not ask for, after `started`), `bridge` (a bridge that did not hold) or `defect`.
- `code` is the service's or the door's code where one arrived: with a refusal, and with the session's last
  message, also when that message comes after the take was already ending, so the cause stays and the code is
  kept. It is null where none came. For `bridge` it is the code of the refusal that answered the last opening of
  the new session's door, and null where that opening got no answer or the take ended on a loss.
- `heard` says whether the take's last session said `started` and the take then placed its last message.
- `turns` counts the turns, over all sessions, whose words as last heard hold text. `commits` counts the commits
  the take sent. `bridges` counts the sessions opened after the first. They are §10's counts.

`recovered` is `{cause, answered}`. `cause` is `recovered`; `dropped` for a mark that was none to recover, there
being none, its day passed or no session in it; `press` for a recovery a press ended; `undo` for one Undo ended.
`answered` is the number of sessions whose result gave their text before that.

### The clock

- Every input carries `at`. An input first lets each deadline due at or before `at` take effect, in the order of
  their instants, and is read after them. So an `ended` at the instant its wait ends comes too late.
- Deadlines of one instant take effect in this order: the day's end, `TAKE_MAX`, `OPEN_WAIT`, `BRIDGE_WAIT`,
  `END_WAIT`, `RECOVER_FOR`, then `BRIDGE_RETRY` and `RESULT_POLL`. Those that end a take or a session's reading
  come first, the day's end before the limit, each group in the order of §11's table; two of one kind, in the
  mark's order of sessions.
- Each frame of a `frames` input is an input at its own instant, so a deadline inside a run takes effect between
  two frames.
- `wakeAt` is the earliest of the deadlines standing:
  - `TAKE_MAX` after the press, and `END_WAIT` before the day's end, while the take is `connecting`, `listening`
    or `bridging`;
  - `OPEN_WAIT` after the press, while the take is `connecting`;
  - `BRIDGE_WAIT` after the loss that began a bridge, until a session says `started`;
  - `BRIDGE_RETRY` after a `concurrency_exhausted`, where that falls before the bridge's wait ends;
  - `END_WAIT` after `end` was sent, or the day's last millisecond when that comes first;
  - `RESULT_POLL` after a result answered `conflict`, a first `result_gone` or `unread`;
  - in a recovery, `RECOVER_FOR` after each session still being read was last heard.
- The day and its end are the phone's, by `offsetSeconds`.

### Holding text

A turn, a part and the passage hold text when they have a character that is not whitespace, by the whitespace of
[the mark](#the-mark): the journal's own `hasText`. What holds no text is left out, with the space that would
join it; what holds text is never trimmed or normalised.

### A take

- **Press.** Within `END_WAIT` of the day's end the take ends at once, `dayEnd`; otherwise, on a page with no
  room for the blank line and one byte, it ends at once, `pageFull`. Neither mints a `callId` or writes a mark,
  and neither changes anything else: a mark still standing stays, and its recovery goes on.
  Otherwise the take writes its mark over any mark still standing, orders the door opened and is `connecting`; a
  recovery under way ends, and writes nothing after. A take reads the page once, here: the words it finds, an
  earlier take's among them, are the page's text before it.
- **Before the first `started`.** A first message `failed`, an `unopened`, a `lost` and `OPEN_WAIT` with no
  `started` each end the take `refused` and clear the mark; the wait's end closes the connection. An end of any
  cause closes the connection and clears the mark: nothing was recorded.
- **`started`.** The microphone opens and the take is `listening`. A second `started`, and an `unreadable`, end
  the take `defect`: the connection is closed, the words shown are saved and the mark stays.
- **Frames.** A frame captured while `listening` is sent as it is captured, and a commit follows it where the
  session's `PauseRule` says. A frame captured while the microphone is closed is dropped and takes no number.
- **Words.** §5.3: a `text` delta appends to its turn; a `turn` settles it; a turn is known by its session and
  number, a number not seen begins a turn, and numbers need not follow one another. A message of a session that
  was lost or gave its last message is ignored.
- **Saving.** Each `turn`, each session's last message and each answer that settles a lost session is a save: the
  page with every settled turn in place, as `spoken`, and the mark. While no passage has been saved and the
  passage holds no text, the page is not saved and only the mark is written. A passage that holds no text after
  one was saved returns the page to its text and `source` before the take, byte for byte. A `started`, a `text`
  delta and a frame write nothing.
- **The page's size limit.** A save that would pass 131,072 bytes is not made, and nothing is written at that
  step. The take is `pageFull`: it shows the page as saved, closes the microphone, sends `end` and waits as any
  end does. The session's last text replaces its part only if the page then fits.
- **An end.** The microphone closes and `end` is sent; the take is `ending` and goes on placing words. The
  session's last message places its text and the take is `ended`. With none by the deadline, where the
  connection is then closed, or when the connection is lost after `end` was sent, every word shown is saved as it
  arrived and the take is `ended`.
- **The service ends a session.** An `ended` the take did not ask for, whatever its `stop`, and a `failed` while
  `listening`, place their text and end the take `service` with their code; a `provider_failed` while `listening`
  is bridged instead. A `failed` after `end` was sent, `provider_failed` among them, is the session's last
  message: its text is placed, the cause stays what it was, and `end.code` is the message's.
- **The mark at the end.** It is cleared when every session has given its last message or its result. Otherwise
  it is written with the take's last save and stays, every word shown is saved as it arrived, and the take orders
  no more reads: the driver sends `recover`.
- **Undo.** Once, after the take has ended, and only while the page's text is as the take or its recovery last
  saved it: the page is again the page the take found, text and source, a mark still standing is cleared, and a
  recovery under way ends. The step is given the stored page and the mark, as a recovery's is. A second Undo, and
  an Undo after the page changed, write nothing.
- **After the end** a take shows the page as it last wrote it, with nothing unsettled.

### A bridge

- A `lost` session that had said `started`, and a `failed` `provider_failed` while `listening`, are bridged,
  three times at most: the take mints the next `callId`, adds it to the mark in the same write, orders its door
  opened and is `bridging`. A fourth such loss ends the take `bridge`.
- Every lost session is read (below), whether or not it said `started`. One that `failed` gave its text with
  that message and is not.
- Frames captured while `bridging` are kept and sent, in order, when the new session says `started`; its
  `PauseRule` starts with the first of them.
- A take that ends meanwhile, by any cause, is `ending`, and `end` follows the kept frames when the new session
  says `started`. Leaving the foreground is the one exception: the kept frames are dropped, the new session's
  opening is closed, no `end` is sent, and the take is `ended` with the words it has; the mark keeps both
  sessions for the recovery (INV-3 as written; the owner may rule otherwise, and then `bridge-background` alone
  moves).
- A first message `failed` `concurrency_exhausted` is tried again `BRIDGE_RETRY` later under the same `callId`,
  while that falls before the wait's end. Any other first failure, an `unopened`, and the wait's end with no
  `started` end the take `bridge`.
- A bridge's session `lost` before its `started` is another bridge, under the wait already running, whether or
  not the take has ended meanwhile. Once `end` has been sent a lost connection ends the wait and nothing is
  bridged.

### Reading a result

One set of rules, `TakeRecovery`'s, which a `Take` uses for its lost sessions.

- A message replaces the session's part with its `text`, whole, if the page then fits.
- `conflict` and `unread` are read again `RESULT_POLL` later. A first `result_gone` is read once more
  `RESULT_POLL` later; a second stands.
- `call_unknown` and a `result_gone` that stands keep the part the session has, its unsettled words saved as they
  arrived.

### A recovery

- With no mark it does nothing. A mark whose day is no longer the phone's today, a day that is no date among
  them, and a mark that names no session are cleared and nothing is written: `dropped`. Every step of a recovery
  checks the day first, before its deadlines, so an answer after midnight finds the mark cleared.
- Otherwise each session of the mark heard from within `RECOVER_FOR` is read, whether or not it answered during
  the take. A session at or past `RECOVER_FOR` is not, and one that reaches it unanswered is given up.
- A recovery's step is given the page and the mark as stored at that instant. Its write of the page passes the
  mark's digest as `SaveSpoken`'s `whilePage`: an answer that finds the page without that digest writes nothing.
  The reads go on, and the mark is still cleared at the end: a write of the mark alone is not guarded.
- A write keeps the mark's `day`, `bytesBefore`, `callId`s and `heardAt`, and changes the session's length and the
  digest. A result that would leave the passage holding no text writes nothing: the page before the take is not
  known to a recovery byte for byte.
- The mark is cleared when every session read has answered or been given up, and the recovery is `recovered`.
- A recovery orders reads and nothing else. A press and an Undo end it.

### The stories

| Stories | Pin |
|---|---|
| `open-and-end`, `open-refused`, `open-provider-unavailable`, `open-unopened` | §5.1 steps 2 and 3 |
| `open-no-started` | §5.1 step 3: `OPEN_WAIT` |
| `press-with-mark-standing`, `press-during-recovery`, `press-refused-with-mark-standing` | §5.1 steps 2 and 5: a press over a standing mark, a result after it, and a press that opens no take |
| `open-near-day-end`, `open-near-day-end-full-page` | §5.1 step 5, and the day's end before a full page |
| `open-lost` | §5.5: a first session lost before `started` |
| `end-while-connecting` | §5.4: an end before the first `started` |
| `delta-after-settled`, `turn-unseen`, `multibyte`, `turn-combining` | §5.3: a turn, its number, bytes and UTF-16, nothing normalised |
| `turn-out-of-order` | §5.3: a part in turn order |
| `turn-empty`, `turn-whitespace-alone` | §5.3: a turn that holds no text |
| `turn-forced` | §5.2: the service commits a turn itself |
| `ended-text-replaces-part` | §5.3: the last text, whole |
| `open-empty-page`, `page-trailing-whitespace`, `page-crlf`, `page-astral`, `page-whitespace-alone` | §5.3: the passage and the page before it |
| `passage-empties` | §5.3: a passage that holds no text after a save |
| `page-full`, `open-page-full`, `page-full-failed` | §5.3: the page's size limit, and a `failed` after it |
| `other-device-meanwhile` | INV-2: the later save stands |
| `end-at-take-max`, `end-before-day-end`, `end-background`, `end-microphone-taken`, `end-capture-failed` | §5.4: the causes of an end, and the day's last millisecond |
| `end-limit-inside-frames`, `end-day-end-and-limit-together` | the clock: a deadline inside a run of frames, and two at one instant |
| `end-no-ended`, `end-lost`, `end-ended-at-deadline` | §5.4 step 3, and an `ended` at the instant its wait ends |
| `end-undo`, `end-undo-mark-standing`, `end-undo-after-typing`, `undo-after-recovery`, `undo-during-recovery`, `undo-after-press-over-recovery` | §5.4 step 4 |
| `cut-idle`; `cut-subject-exhausted`, `cut-funding-required`; `cut-paused`, `cut-restarting` | §5.4's table, rows 1 to 3 |
| `bridge-provider-failed`, `end-provider-failed` | §5.4's table, row 4, while listening and after `end` |
| `failed-accounting-unavailable`, `failed-invalid-request` | §5.4's table, row 5 |
| `cut-unnamed`, `cut-completed-unasked` | §5.4: an `ended` the table does not name |
| `defect-unreadable`, `defect-started-twice` | §4: a defect |
| `bridge-lost`, `bridge-lost-again` | §5.5 steps 1 and 3, and every lost session read |
| `bridge-pause-in-kept` | §5.2: the counts start again at a new session |
| `bridge-concurrency-retry`, `bridge-retry-past-wait`, `bridge-retry-unanswered` | §5.5 step 2, and the code a failed bridge ends with |
| `bridge-ended-meanwhile`, `bridge-ended-then-lost`, `bridge-microphone-taken` | §5.5 step 3: an end inside a bridge, and §5.4 step 2: reading goes on through a recovery |
| `bridge-background` | INV-3: the foreground left during a bridge |
| `bridge-no-started`, `bridge-refused` | §5.5 step 4 |
| `bridge-result-replaces`, `bridge-result-gone`, `bridge-result-unknown` | §5.5 step 5 |
| `bridge-max` | §5.5: `MAX_BRIDGES` |
| `recover-day-passed`, `recover-no-session`, `recover-no-mark`, `recover-result-after-midnight` | §5.6: a mark that is none to recover |
| `recover-result-replaces`, `recover-nothing-saved`, `recover-two-sessions`, `recover-after-unsettled-end`, `recover-result-empty` | §5.6: a result replaces its part |
| `recover-gone-keeps`, `recover-unknown-keeps` | §5.6: a result gone or unknown |
| `recover-page-changed`, `recover-same-length-edit`, `recover-changed-meanwhile` | §5.6: writes only while the page has the digest |
| `recover-still-open`, `recover-expired` | §5.6: reads repeat, and `RECOVER_FOR` |

Every frame sequence of a story begins its session with a quiet second and sets speech at 1,000,000 against a
quiet of 0, so a revised floor does not move a commit here.

`page-full`, `page-full-failed`, `open-page-full` and `open-near-day-end-full-page` hold their pages whole,
131 KB a copy, as the journal corpus holds its bodies at the limit: 1.4 MB, 1.2 MB, 0.4 MB and 0.4 MB. A result too large for the page has no
story for that cost; `page-full` pins the rule for a last message, and `SaveSpoken` refuses the page either way.

### Readings

Where the specification leaves a choice, this is the one the stories take, and the story that holds it.

| Reading | Story |
|---|---|
| A take shows, after its end, the page as it last wrote it; a `changed` step leaves `page` as it was. | `end-undo-after-typing`, `recover-changed-meanwhile` |
| Every lost session is read, whether or not it said `started`. | `bridge-lost-again` |
| `heardAt` moves only with a `heard` input the take reads; an unreadable message does not move it. | `defect-unreadable`, `bridge-lost` |
| A failed bridge's `end.code` is the refusal that answered the last opening of its door, null on the wait or a loss. | `bridge-retry-past-wait`, `bridge-retry-unanswered`, `bridge-no-started`, `bridge-max` |
| Text holds text by the journal's `hasText`. | `turn-whitespace-alone`, `passage-empties`, `page-whitespace-alone` |
| `end` counts turns that hold text, commits sent and bridges. | `turn-forced`, `page-full`, `bridge-provider-failed` |
| A clear of the mark is not guarded by the page. | `recover-page-changed`; the scene "the mark is cleared on a page that has changed" |
| A bridge's session lost before `started` is bridged again under the same wait, even after the take was ended; after `end` was sent a loss ends the wait. | `bridge-lost-again`, `bridge-ended-then-lost`, `end-lost` |
| Every cause of an end during a bridge is answered as the person's. | `bridge-ended-meanwhile`, `bridge-microphone-taken` |
| Leaving the foreground during a bridge drops the kept frames, closes the opening and ends the take. | `bridge-background`, the one story an owner's ruling may flip |
| A `failed` after the take was already ending is not bridged: its text is placed, the cause stays and `end.code` is the message's. | `end-provider-failed`, `page-full-failed` |
| A press over a standing mark replaces it, ends its recovery, and keeps the page's words. | `press-with-mark-standing`, `press-during-recovery` |
| A press that opens no take changes nothing: the mark stays and its recovery goes on. | `press-refused-with-mark-standing` |
| Undo's guard is the last save by the take or by the recovery that followed it; Undo ends a recovery under way. | `undo-after-recovery`, `undo-during-recovery`, `end-undo-after-typing` |
| A recovery that finished before the take's press is no part of Undo's guard. | `undo-after-press-over-recovery` |
| A deadline takes effect before an input of the same instant. | `end-ended-at-deadline` |
| A result after midnight finds the mark cleared. | `recover-result-after-midnight` |
| Each frame is its own input: a deadline falls between two frames. | `end-limit-inside-frames` |
| A door with no `started` within `OPEN_WAIT` ends the take `refused`; the service's own reason arrives inside that wait. | `open-no-started`, `open-provider-unavailable` |
| Of two deadlines at one instant, the day's end comes before the limit. | `end-day-end-and-limit-together` |
| The day's end is checked before the page's room at the press. | `open-near-day-end-full-page` |
| A recovery with no mark does nothing. | `recover-no-mark` |
| A result that would leave the passage holding no text writes nothing in a recovery. | `recover-result-empty` |
| A passage that empties after a save returns the page as it was. | `passage-empties` |
| An `ended` `completed` the take did not ask for ends it `service`, code null. | `cut-completed-unasked` |
| An end before the first `started` closes the connection and clears the mark. | `end-while-connecting` |
| A retry that would fall at or past the wait's end is not made. | `bridge-retry-past-wait` |
| A turn that does not fit writes nothing at that step, the mark included, and the take then shows the page as saved. | `page-full` |
| A defect closes the connection, saves the words shown and leaves the mark. | `defect-unreadable`, `defect-started-twice` |
| At a take's end every word shown is saved as it arrived, a lost session's too. | `end-no-ended`, `bridge-no-started` |
| A recovery reads every marked session within `RECOVER_FOR`, those that answered during the take too, and reads on when the page has lost the digest. | `bridge-ended-meanwhile`, `recover-page-changed` |
| `TAKE_MAX` counts from the press. | `end-at-take-max` |

### What has no story

| Behaviour | Why |
|---|---|
| §4: what Talk says for a state or a code | What a person is told, drawn on boards. `end.cause` and `end.code` are what it is chosen from. |
| §5.1 step 1: typing not yet saved at the press | The room's: it saves the page before the press reaches the take. |
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
| `takes/*.json` | lists the folder; for each story keeps a page and a mark, starting from `given`; plays each step, applying a `changed` input and each write to them; compares the seven outputs with `out` by JCS, naming the file and the step at the first that differs; then compares `end` and `recovered`. `reference.py`'s `Driver` is such a runner over the reference's own parts. |

A runner fails on a file under this folder that it does not run, on a `format` that is not `journal-take/v1`, on
an input it does not know and on an `op` or an action its switch does not name. A failure names the file and the
step, never a story's text.

No surface runs these files yet. Each surface's claim test names them as waiting for the work that will run them,
and fails on a file under this folder that it does not name: `JournalRulesTests.everySharedFileHasARunner` in
Swift, for the roadmap node `m2-build-the-domain-in-swift`, and the journal corpus test on the web, for the web's
Talk (R-6).

## What `check.py` holds

- `pauses.json`: every answer equals the reference's `PauseRule`. The cases above are stated by hand, so two
  derivations agree on each.
- `takes/`: every `out` of every step, `end` and `recovered` equal what the reference's take and recovery give
  for the story's `given` and inputs. A failure names the step and the outputs that differ.
- Each script against the AI wire: every `heard` message passes the wire's own check; a `started` equals
  `liveEvents`' but for its `callId`; a last message equals an entry of `liveTerminals` in every field but `text`,
  or of `liveFirstFailures` whole; a result's code is one the wire's `refusals` hold. The stories between them
  play every key of `liveTerminals` but those `NOT_PLAYED` names with its reason.
- A first failure the live fixtures do not hold yet is held to their shape and to the fixtures' `refusals`. The
  codes are listed once, `WAITING_FIRST_FAILURES`, and wait on the node `widen-live-first-failures` of the AI
  service's tree; the check refuses a code there once the fixtures hold it.
- Every mark a story or a scene writes matches the registry's `talkTake` row, names one to four sessions, has the
  digest of the page it was written with, and reads that page by its lengths. While
  `sync/journal.registry.json` holds no such row, a mark is held to the Talk contract's shape, stated once in
  `check.py`; the check prints which it ran against.
- `saves.json`: a guarded save is `unchanged` exactly when the drawn page's digest differs; a save into another
  day or over 131,072 bytes is refused; every other decision writes the mark last among its device writes, and
  the mark alone writes nothing else.
- Every clause the files pin has a story, and every story is named by a clause: the table `PINS`.
- The self-test changes the files 82 ways, each a mistake an implementation or an author could make, and requires
  every one refused: 39 of them are a reviewer's, written without reading this folder's generator or checker.
