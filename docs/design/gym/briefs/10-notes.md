# Notes — the context a lifter writes for Coach

A gym-only section in gym settings: **title-and-text pairs the lifter writes and Coach reads.** A note
holds anything from *keep your tone blunt* to the exact programme they are running and the goal they
are chasing.

## The section's own line

Under the heading, one line, and the wording is load-bearing:

> **what you write for Coach**

Not *what Coach reads about you*, and no longer *· yours to change* either — an editable field is
obviously yours to change, and the budget does not pay for words a control already says. A note is not something the product noticed about a lifter — it is
an instruction they addressed to their own instrument. The "about you" phrasing implies an
accumulating profile, which is the thing this feature is not, and it quietly contradicts the honesty
lines below it. It also weakens them: if these are things you wrote deliberately, *any agent you
connect can read these* is a fact you can act on; if they were things the product noticed, it reads
as a confession.

## What the screen says out loud — one line

**One.** Not four.

> **"Any agent you connect can read these too."**

That is the only genuinely surprising fact on the screen, and alone it lands. Coach's tool set can
only *narrow* the catalogue every connected agent already sees, and the MCP grant is a name prefix —
so a notes read is served to **every agent holding the gym read scope**. Unsaid, this feature ships
the most personal free text in the product readable by every agent the lifter ever connected. The
word *too* carries the rest: it says Coach reads them without a second sentence saying so.

**Three lines that used to be here, and where they went.**

- *"…and nothing else you have set"* answers a question you ask **in settings, looking at the dials**,
  so it moved there and became six words beside them:

  > **Coach reads your notes, not these.**

  On the Notes screen it was answering a question nobody was asking; next to the units toggle and the
  rest timer it is the answer to the obvious one. That is the guideline's *moment of consequence*
  move, and it is also the salience finding — the same fact placed where it is surprising, rather
  than where it is merely true.
- *"Ten notes, 500 bytes each"* moved to **the moment it bites**. A lifter with two notes does not
  need the ceiling.
- *"Drag to reorder"* was **structure explaining itself**, under a drag handle. Only the part a handle
  cannot show survives: **"Top note wins."**

Four true sentences in a column is not four times as honest as one. It is a paragraph, a paragraph is
not read, and stacking them made the product **less** honest — see `../../guidelines/text-budget.md`,
which this screen is the worked example for.

The read is a **declared tool call**, never a silent injection into the prompt. So the step line can
say *"read your notes"*, and the read receipt keeps its promise that every answer states what it read.

## The shape

A note is **a title and a body**. Nothing else. No tags, no folders, no colours. Both stored
**verbatim**, exactly as typed — nothing in this product summarises what a lifter wrote.

**Bounded, and the bounds are said on screen** the way the daily limit is: **ten notes, five hundred
bytes each.** Everything around this is bounded by name — four questions a thread, a thousand bytes a
question, four hundred a summary, two hundred rows a log page — and an unbounded free-text field
feeding a prompt would be the one exception.

**Order is precedence.** The top note wins; drag to reorder; one line under the list saying so. That
gives the list the lifter's own ordering for free, and it answers the question the shape otherwise
leaves open — what Coach does when two notes disagree.

**Never in the cached prefix.** The system prompt must stay byte-stable, because it and the tool
catalogue are one cached prefix and a single interpolated byte moves it so the cache never reads.
Notes are welded into the **first user turn**, beside the log document.

## Where it lives

**The two honesty lines head the screen.** They go **above** the list, not beneath it. A rule you read
after you have written is not a rule; and on a screen that scrolls, a footer is a promise below the
fold.

**Notes is its own screen**, and **Coach's room is its front door — as a row, never a third icon in
the top bar.** An icon beside the thread implies Coach owns the notes, which is the exact opposite of
what the second honesty line exists to say, and a third action crowds a phone top bar that already
carries a two-line title. Settings carries a row to the same place, but that row is the secondary way
in — a line reading *"Notes · 2 notes ›"* in a settings
list reads like account admin, which is exactly what these are not. A lifter thinks about what Coach
knows while they are talking to Coach, so that is where the door belongs.

It is not a section sitting between the Units toggle and the rest timer.

That is not tidiness. The honesty line says *"Coach reads every note here, and nothing else you have
set"* — and on a screen that also holds the dials, **"here" would be a lie**, because Coach reads
none of them. A rule that is only true when you squint is worse than no rule. Giving Notes its own
screen makes the sentence literally true, and it gives the Coach door somewhere to land.

**The settings row lives in the product zone.** It is registered as a `main` section, not a `data`
one. That is one word, and it is the difference between the context that makes Coach good
sitting with the product's own settings, and it sitting at the bottom of the account page beside the
button that closes your account.

**The Coach room carries a door to it**, in its own top chrome beside Threads. That is the only room
where a lifter is thinking about what Coach knows.

**Its own resource.** Notes are never stored inside the preferences document, which is a
whole-document last-write-wins replace — two screens open at once would silently discard one. That is
a hostile container for text somebody wrote.

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

**This is a new kind of proposal, not a reuse, and the brief says so rather than discovering it in
the build.** The existing proposal is routine-shaped all the way down — its head carries a required
routine id, its rows carry an exercise and target fields, and the guarantee that only one can be
pending is a database index over the routine id. A note has none of those, and making the column
optional does not extend the index, because null values do not collide. Pending note proposals would
be unbounded.

So the write needs: its own subject, its own identifier, its own pending-uniqueness rule, its own base
version, its own apply route and its own preview. **Reading notes needs none of it and lands first.**

**Why it is an intent** is the reason the domain actually uses, not tense: *something already stands
that this write would overwrite*. A routine is nothing but a plan for next time, and creating one is
still a record.

## The rest

Notes are the lifter's, so they export with everything else and delete with the account. They are
gym's — not a brand-wide profile — and neither journal nor roadmap reads them. Gym publishes and never
imports.

## Open

- **The byte bound.** Ten notes at five hundred bytes is proposed, not decided.
- **Whether a note can be muted** — kept, but ignored for now. It would be one control, and it would
  also be the first piece of state on a note that is not its text.
