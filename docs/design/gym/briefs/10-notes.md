# Notes — the context a lifter writes for Coach

A gym-only screen, reached from gym settings and from Coach's own room: **title-and-text pairs the
lifter writes and Coach reads, including useful user-provided insights Coach saves.** A note holds anything from *keep your tone blunt* to the exact
programme they are running and the goal they are chasing.

## What the screen says out loud — one line

**One.** Not four.

> **"Any agent you connect can read these too."**

That is the only genuinely surprising fact on the screen, and alone it lands. Coach's tool set can
only *narrow* the catalogue every connected agent already sees, and the MCP grant is a name prefix —
so a notes read is served to **every agent holding the gym read scope**. Unsaid, this feature ships
the most personal free text in the product readable by every agent the lifter ever connected. The
word *too* carries the rest: it says Coach reads them without a second sentence saying so.

**It heads the screen**, above the list. A rule you read after you have written is not a rule, and on
a screen that scrolls a footer is a promise below the fold.

Under the heading, one more line, and its wording is load-bearing:

> **what you write for Coach**

Notes contains deliberate user instructions and useful insights explicitly supplied during Coach
conversations. Coach may append one new insight in the user's wording; it cannot edit, delete or
reorder existing notes. The user retains those controls on the Notes screen.

## The shape

A note is **a title and a body**. Nothing else. No tags, no folders, no colours. Both stored
**verbatim** on save. Coach uses the user's own wording for constraints and does not invent facts.

**Bounded, and the bounds are one number in three places.** Ten notes per account; a title of at
most 60 characters (Unicode code points, non-empty after trim); a body of at most 500 UTF-8 bytes
after trim, which may be empty. The same numbers sit in the schema CHECK, the domain constructor and
the `list_notes` tool's description, and the server refuses in three sentences every surface shows
verbatim: *a note needs a title*, *a title runs to 60 characters*, *a note runs to 500 bytes*.
Everything around this is bounded by name, and an unbounded free-text field feeding a prompt would
be the one exception. A note's id is client-minted, `note_<hex>`, so a lost reply is replayed with
the same id and never minted twice. Coach assigns its own stable note-save identity per generation;
exact title/body matches reuse an existing note. Its immutable save receipt survives later user edits
and deletion, so replay does not undo them. New Coach notes append at the bottom and respect the
same cap; when full, Coach reports that nothing was saved.

**The ceiling is said when it is reached, and here is where that is**, because "at the moment it
bites" is not a location:

- **The byte ceiling** is a live counter in the note editor — *"470 of 500 bytes"* — and it appears
  only in the last fifth, from 400 bytes, so a short note carries no chrome at all. Past the bound
  the counter goes alarm and reads *"501 of 500 bytes"*; Save stays tappable and refuses in place
  with the server's sentence, so nothing is silently dead.
- **The note ceiling** is the *Add a note* row: at ten it stops offering and says so, in these words
  on every surface — **"10 of 10 notes. Delete one to add another."**

  Numerals rather than words, because a figure is read at a glance where *"ten of ten"* has to be
  parsed. **Not** because of the mono face: the brand reserves that for a bare count readout or an id,
  never for prose, and this line is a sentence with a number in it. It is set in the body face on
  every surface, like any other sentence.


Every surface draws both.

**The note ceiling is counted off the ACCOUNT, and it follows the account.** The count is the notes
the store holds and never the rows drawn, so a note inside its delete window is still one of the ten
and the line stands for the whole window (`13-gestures.md` Law 2) — and the count **moves the moment
the delete lands**, so the screen never goes on refusing an eleventh note over nine stored, naming a
way out the lifter has already taken while the Add row it names stays shut. Both halves are one rule:
the cap reads the store, and the store is what a settled delete changes.

**Order is precedence.** The top note wins, and the list is dragged into the order the lifter wants.
That answers what Coach does when two notes disagree, and it needs three words on screen because the
drag handle carries the rest. **The handle is not only a grip**: iOS reorders through `.onMove`,
Android declares *Move up* / *Move down* as custom actions beside its long press, and the web's rail
is a real `<button>` answering the drag, ArrowUp / ArrowDown and a single pointer's pick-up /
place-down alike — the routine editor's grip exactly, off the one hook (`13-gestures.md` Law 1).

**A move writes one note.** Dropping a note writes one new position for that note and nothing else:
right after the row drawn above the drop point, in stored order, or before the first stored note
when dropped at the top ([engine](../../../foundation/engine.md) §7.6). A note inside an open delete
window is not drawn but is still stored, so it keeps its stored place, and every other note keeps
the position it has. What the lifter drags is what is on screen; what goes over the wire is the one
note they moved.

**Never in the cached prefix.** The system prompt must stay byte-stable, because it and the tool
catalogue are one cached prefix and a single interpolated byte moves it so the cache never reads.
Notes are welded into the **first user turn**, beside the log document.

The read is a **declared tool call**, never a silent injection. So the step line can say *"read your
notes"*, and the read receipt keeps its promise that every answer states what it read.

## Where it lives

**Notes is its own screen**, reached from Coach and gym settings.

That is not tidiness. The honesty line has to be literally true, and on a screen that also holds the
dials a line about what Coach reads *here* would be a lie, because Coach reads none of them. A rule
that is only true when you squint is worse than no rule.

**Coach's room is the front door — as a row, never a third icon in the top bar.** An icon beside the
thread implies Coach owns the notes, which is the opposite of what the honesty line exists to say, and
a third action crowds a phone top bar that already carries a two-line title. A lifter thinks about
what Coach knows while they are talking to Coach, so that is where the door belongs.

**Settings carries the secondary door**, and it lives in the product zone — registered as a `main`
section, not a `data` one. That is one word, and it is the difference between sitting with the
product's own settings and sitting at the bottom of the account page beside the button that closes
your account.

**Its own resource.** Notes are never stored inside the preferences document, which is a
whole-document last-write-wins replace — two screens open at once would silently discard one. That is
a hostile container for text somebody wrote.

**Account-only.** There is no local-first copy on the phones and no claim-replay slot. Signed out,
the Notes screen is a sign-in door — *"Notes live with your account, so they need you signed in."* —
and on the web the screen sits behind the same gate as the Coach room.

## Seeded, never pre-written

A blank notes screen teaches nothing. First open offers **two** titles as **placeholder text inside
empty rows**:

- How I want to be talked to
- What I am training for

Both are addressed *to the agent*, which is what a note is for. **Nothing is stored until the lifter
types**, and the product never authors a note and then shows it back as theirs.

**The seeds are offered to an account with nothing in it, not to a screen drawing nothing.** Like the
ceiling above them they read the store: an account holding one note the delete window has taken off
the screen is not an empty account — the note comes back on Undo, and a placeholder tapped meanwhile
would mint a second. Between the two the room draws no rows and the Add row, on all three surfaces.

A third candidate — *what my body is doing* — is deliberately not offered. It is a record about a
body, and `11-bodyweight.md` is where facts about a body are recorded.

## Coach saves

Coach may append useful user-provided insights directly, with a truthful saved-note receipt.
It must not overwrite, delete or reorder existing notes. Stable save identities make retries
recover the same result; exact title/body matches reuse a note. The account cap still applies.
The lifter keeps edit and delete controls.

## The rest

Notes are the lifter's, so they export with everything else and delete with the account. They are
gym's — not a brand-wide profile — and neither journal nor roadmap reads them. Gym publishes and
never imports.

## Open

- **Whether a note can be muted** — kept, but ignored for now. It would be one control, and the first
  piece of state on a note that is not its text.
- **Whether the one honesty line actually lands.** The guideline's easiness effect says a plainer
  sentence raises confidence faster than understanding, so *"it reads clearly"* is not evidence.
  This line should be tested on recall, not on approval.
