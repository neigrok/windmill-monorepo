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

`pauses.json` and `saves.json` are the kit's arrays of `{name, input, expect}`, compared by JCS
([kit forms](../../domain-kit/README.md)).

Words in every file are made up. A `callId` is one letter 22 times.

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
  text as stored by the write that wrote the mark; at the press, of the page's text as it stands.
- `sessions` are the take's sessions in the order they were opened, four at most. `bytesSaved` is the UTF-8
  length of the session's part as saved. `heardAt` is the time of the session's last message as of that write,
  and the time it was opened before any.

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

## What `check.py` holds

- `pauses.json`: every answer equals a reference of §5.2 written in `check.py`. The cases above are stated by
  hand, so two derivations agree on each.
- Every mark matches the registry's `talkTake` row. While `sync/journal.registry.json` holds no such row, a mark
  is held to the Talk contract's shape, stated once in `check.py`; the check prints which it ran against.
- Every mark has the digest of the page it was written with, and its lengths read that page.
- `saves.json`: a guarded save is `unchanged` exactly when the drawn page's digest differs; a save into another
  day or over 131,072 bytes is refused; every other decision writes the mark last among its device writes, and
  the mark alone writes nothing else.
- Every clause the files pin has a story, and every story is named by a clause: the table `PINS`.
