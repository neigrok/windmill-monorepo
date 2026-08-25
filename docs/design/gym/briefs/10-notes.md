# Notes — the context a lifter writes for Coach

A gym-only screen, reached from gym settings and from Coach's own room: **title-and-text pairs the
lifter writes and Coach reads.** A note holds anything from *keep your tone blunt* to the exact
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

Not *what Coach reads about you* — a note is not something the product noticed about a lifter, it is
an instruction they addressed to their own instrument, and "about you" implies an accumulating
profile, which is the thing this feature is not. It also weakens the honesty line: if these are things
you wrote deliberately, *any agent you connect can read these* is a fact you can act on; if they were
things the product noticed, it reads as a confession.

### Three lines that used to be here, and where they went

This screen is the worked example in `../../guidelines/text-budget.md`. It carried **four** true
sentences in a column, which is not four times as honest as one — it is a paragraph, a paragraph is
not read, and stacking them made the product **less** honest.

- *"…and nothing else you have set"* answers a question you ask **in settings, looking at the dials**,
  so it moved there and became six words beside them:

  > **Coach reads your notes, not your settings.**

  On the Notes screen it answered a question nobody was asking; among the dials it answers the obvious
  one. That is the *moment of consequence* move, and the salience finding — the same fact placed where
  it is surprising rather than where it is merely true.

  **It names what it excludes, rather than pointing.** The first draft said *"not these"*, which
  depends entirely on which control it happens to sit beside — and it landed under the haptic and
  sound toggles on one surface, and one divider above the notes list on another, where *"these"* read
  as the notes it plainly does read. A caption that changes meaning with its position is not a
  caption, it is a bug. Naming the thing costs one word and works anywhere on the screen.
- *"Ten notes, 500 bytes each"* moved to **the moment it bites**. A lifter with two notes does not
  need the ceiling.
- *"Drag to reorder"* was **structure explaining itself** under a drag handle. Only the part a handle
  cannot show survives: **"Top note wins."**

## The shape

A note is **a title and a body**. Nothing else. No tags, no folders, no colours. Both stored
**verbatim**, exactly as typed — nothing in this product summarises what a lifter wrote.

**Bounded, and the bounds are one number in three places.** Ten notes per account; a title of at
most 60 characters (Unicode code points, non-empty after trim); a body of at most 500 UTF-8 bytes
after trim, which may be empty. The same numbers sit in the schema CHECK, the domain constructor and
the `list_notes` tool's description, and the server refuses in three sentences every surface shows
verbatim: *a note needs a title*, *a title runs to 60 characters*, *a note runs to 500 bytes*.
Everything around this is bounded by name, and an unbounded free-text field feeding a prompt would
be the one exception. A note's id is client-minted, `note_<hex>`, so a lost reply is replayed with
the same id and never minted twice.

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

  *(An earlier draft of this brief justified the numerals by the mono face. That was wrong — the
  string is right for the other reason.)*

Every surface draws both.

**Order is precedence.** The top note wins, and the list is dragged into the order the lifter wants.
That answers what Coach does when two notes disagree, and it needs three words on screen because the
drag handle carries the rest.

**Never in the cached prefix.** The system prompt must stay byte-stable, because it and the tool
catalogue are one cached prefix and a single interpolated byte moves it so the cache never reads.
Notes are welded into the **first user turn**, beside the log document.

The read is a **declared tool call**, never a silent injection. So the step line can say *"read your
notes"*, and the read receipt keeps its promise that every answer states what it read.

## Where it lives

**Notes is its own screen**, not a section between the units toggle and the rest timer.

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

A third candidate — *what my body is doing* — is deliberately not offered. It is a record about a
body, and `11-bodyweight.md` is where facts about a body are recorded.

## How Coach writes one, and what that costs

Not silently, and not directly. Coach proposes a note the same way it proposes a routine change: a
card in the thread, the diff in a sheet, **Apply**, and a receipt line back in the conversation. The
diff is per line, before and after; a note the lifter has never written renders as an addition, every
line green.

**This is a new kind of proposal, not a reuse, and the brief says so rather than letting a build
discover it.** The existing proposal is routine-shaped all the way down — its head carries a required
routine id, its rows carry an exercise and target fields, and the guarantee that only one can be
pending is a database index over that routine id. A note has none of those, and making the column
optional does not extend the index, because null values do not collide. Pending note proposals would
be unbounded.

So the write needs its own subject, identifier, pending-uniqueness rule, base version, apply route and
preview. **Reading notes needs none of it and lands first.**

**Why it is an intent** is the reason the domain actually uses, not tense: *something already stands
that this write would overwrite*. A routine is nothing but a plan for next time, and creating one is
still a record.

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
