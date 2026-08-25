# Coach — the room, and the loop it runs

Coach is the second door onto the engine an MCP-connected agent already reaches. A lifter with their
own Claude or ChatGPT connects it and never opens this room. A lifter without one opens Coach, which
asks the same questions of the same tools.

The room's name matches the paid line, which has always called it the coach.

## What the name does not buy

**Windmill authors no personality. The lifter may author one for their own instrument.**

- **It does not speak first.** No greeting, no daily check-in, no "how did that feel?".
- **No unread badge, no count, no notification, nothing waiting.** Pinned by
  `../../guidelines/superapp-shell.md`.
- **No encouragement, no grade, no streak.** One genuine PR still gets one line and no more.
- **The model proposes, the human applies.** There is no apply tool at any grant level, and this
  wave does not add one.
- **It is refused mid-workout.** The room reads a log that is still being written.

The one personality in the room is the lifter's own, written in `10-notes.md`. That creates a trust
boundary this wave must draw, because it puts two free-text fields on adjacent screens with opposite
trust: a **set note is a record** and the prompt treats lifter-typed text as data, never instruction;
a **note is directive**, and Coach follows it. The Notes screen says so. The set-note field says
nothing, because it is a record.

## The loop — four beats

The same four beats on every surface. Only beat two changes container.

### One · the turn

Coach answers in prose. If it minted something, **one** proposal card follows, carrying the summary
it wrote, the counted changes, and a single affordance: **Review**.

The card carries no Apply button — `../../guidelines/thumb-reach.md` forbids a committing button
inside a card in a scroll, and that rule is why the routines home is wrong today. On the web the card
may show its inline diff when the column is wide enough, and Review is a link rather than a filled
button.

**One proposal per turn.** An answer *can* mint several, and two on the same routine kill each other:
the supersede runs before the second lands, so the first is dead while both ids come back, and
tapping Apply on it refuses with *"that routine changed after this proposal was written"* — which is
false. Nothing changed but Coach's mind. A second mint in one run is refused with a sentence the
model can act on: *"you already wrote a proposal this turn; fold both into one document."*

### Two · the review

Review opens the diff **over** the conversation — an iOS sheet, an Android modal bottom sheet **with**
its drag handle, a web dialog. Never a push: a push says *you have left*, a sheet says *you are
deciding, and you will be back*. The loop is the product, so the navigation has to agree with it.

**No fixed partial detent.** A routine holds up to fifty entries and the summary runs to four hundred
model-written characters, so the diff is unbounded — and a half-height detent does not grow with the
system's text size, so at the larger accessibility sizes the visible diff goes to zero while Apply
stays enabled. **Apply is never reachable while the diff is clipped.**

**Kept rows have one shape everywhere.** Changed rows at full weight; kept rows as a collapsed count
— *"and 7 lines unchanged"* — tappable to expand. The rows are the document as well as the diff, and
a lifter deciding needs to see the run the routine takes on, not only what moved.

**The model's prose is attributed.** The summary sits in a quoted block under a **Coach wrote:**
kicker, in the treatment a Coach turn gets, visually separate from the counted rows. The sheet never
puts two kinds of truth under one pair of buttons.

**Three exits, not two.** Closing the sheet — swipe, scrim, back — **decides nothing**: the proposal
stays pending and the card reads *still waiting*.

**The band holds one button, and it is Apply.** Turning a proposal down is a **plain text row beneath
it**, not the left half of a pair. A pair puts the one irreversible act exactly where a lifter's hand
expects *cancel*, and colour does not undo position — someone reaching for "not now" would settle
something permanently. "Not now" already exists and costs nothing: close the sheet. So the pinned
band is a single primary, which is also what the reach law asks for; two full-strength buttons of the
same weight is a failure to decide.

**"Turn this down"** stays destructive and stays confirmed.

**And the product currently says otherwise, which is a defect and not a disagreement.** One surface
tells a lifter a dismissed proposal *"stays in the routine's history in case you want it back"*
(`Proposal.swift:292`) while the web states the truth — *"every other state is settled and stays
settled; the wire has no path back"* (`proposals.js:13`) — and no route reopens one. The wire is the
truth, so the copy changes: a turned-down proposal stays in the routine's history **as a record**,
not as something you can take back. Once that line is true, the confirmation is honest rather than
ceremony: it guards an act that really is irreversible.

**At the rack, Apply says what it does not do.** A session's plan is a frozen snapshot, so applying
mid-workout changes nothing about the workout in progress. While a session is open the sheet carries
*"Coach changes next time's plan, not this workout."*

That line sits **above the diff, never inside the pinned band.** A line that appears and disappears
inside the band moves the Apply button, so the same tap lands somewhere different depending on
whether a workout is running. The band's height is constant; the caveat is content.

### Three · the apply

One atomic write against the base revision. A routine that moved underneath is superseded, never
merged over. All of it lands or none of it does.

### Four · the return

The sheet closes onto the thread and a **receipt line** lands in it:

> **Applied · Push A · 4 changes**

Turning down writes *"Turned down · nothing changed."*

The receipt is **derived from the server's reply, never from the model's prose** — a model that
mis-states what it just did is the failure this beat exists to make impossible. The wording is the
sentence the server can stand behind: the diff rows carry an exercise id and never a movement name,
so *"now runs 5 × 3 at 90"* is reachable only when exactly one field of one movement moved. That is a
special case, never the shape of the rule.

**The receipt must be durable, and today it is not.** Nothing writes a turn on apply, and the thread's
stored shape carries no settled-at, so on reopening a thread the receipt cannot be placed back in the
conversation's chronology. Until a ledger row exists the boards state plainly that the receipt is
ephemeral and vanishes on reopen. It must not be dressed up as history it cannot keep.

## The verbs

Three, and **Coach never creates**.

| Verb | What the lifter previews |
|---|---|
| change a routine | the entry diff — added, removed, retargeted, and kept as a collapsed count |
| remove a routine | the routine, its movement count, and how many logged sets it keeps |
| edit a note | the note, before and after, per line |

**Creating belongs to the lifter.** A proposal is anchored to a routine that already exists and to a
revision it is atomic against; a create has neither, and the domain asserts at compile time that
bringing a program into being is a *record* rather than an intent. So the first-run path is: the
lifter taps **New routine**, which mints an empty one, and Coach fills it with an ordinary change
proposal — previewed as an all-green diff. Nothing in the domain moves.

**Never proposable, at any grant level, this wave or later:** logging a set, fixing a set, deleting a
set, finishing a workout, discarding a session, writing a bodyweight.

**A verb does not ship without a phrase.** The step line's lookup falls back to printing the raw tool
name, so a new verb would ship the exact defect this wave closes below. The fallback prints nothing.

## What the room stops printing

The raw tool trace under every answer comes off. It is developer output on a lifter's surface.

**The read receipt stays.** *"read 214 sets · 6 weeks · 18 sessions"* is an honesty mechanism, not
chrome: it is how a lifter knows what the answer stands on. The step list collapses behind it and
opens on one tap.

The honesty claim rests on the **receipt**, which is always visible, and not on the step list, which
is detail for whoever wants it. A collapsed control is not a check on anything, so it must never be
the only thing standing between a lifter and knowing what Coach read.

The four rules under it do not move: counts are by identity, so one workout read twice is one
workout; a summary claims only what it named; a refused read counts nothing; and a reply that served
no rows says nothing at all rather than "read 0 sets".

## The limits, said on screen

The daily allowance and the back-to-back limit are stated in the room, never hidden behind a quietly
weaker answer. **In the room** means on the Coach screen itself, in one line — *"Ten questions a day,
three back to back."* — not in a paragraph explaining why the cap exists, and not only on the board
that draws the cap being hit.

Both are needed. The line in the room is the promise; the **cap-reached** state is the moment, and it
says what to do next rather than restating the rule. A wave that removes the paragraph and draws
neither has not trimmed the cap, it has deleted it. The thread ceiling is **four questions** — the copy must say four, because the code
counts a question and its answer as two turns against a ceiling of eight. Hitting the internal
iteration cap is a **failure**, not a truncation to be dressed up.

## The two stances, blessed

Both were authored by the build and pinned in tests without a copy owner ever adopting them, and both
diverge between the phones. They are settled here.

**Signed out** — the room needs an account because it reads an account's log.

> **Coach reads your log, so it needs you signed in.**

One sentence, and it gives the reason rather than the rule. The longer variant on one phone — *"reads
your account’s log … before it has anything to read"* — explains a mechanism nobody asked about.

**This deployment does not carry Coach** — not an outage, and the difference matters.

> **Coach isn’t part of this Windmill. Your log is still yours to read.**

*Part of* rather than *available on*: nothing is broken and nothing is coming back later, so a word
that implies a temporary fault would be a small lie. The second sentence is the useful fact — the
thing the lifter actually came for still works.

**The apostrophe is the typographic one** (’), everywhere, on every surface. One phone ships a
straight quote in this exact string today.

## Threads

**The title is the first message, verbatim**, written once. Nothing in this product summarises what a
lifter typed — no auto-title, no folders, no pinning. The outcome chip is derived, never stored.
Deleting a conversation deletes the conversation and not its consequence: a change that was applied
still says it came from Coach.

## Open

- **The mid-workout refusal.** The reason is sound, but a lifter at the rack with a question has
  nowhere to put it. Worth deciding whether the refusal should offer to hold the question for after
  the session rather than closing the door — and it should name the rack-side controls that *do*
  work, rather than only refusing.
- **Two stances carry build-authored copy** — signed-out and deployment-absent — pinned in tests with
  no copy owner having blessed them. This brief does not bless them either.
- **The server's own strings still say Ask** and reach all three clients verbatim. A client must
  never rewrite server text, so they change in this wave; who owns that change is unassigned.
