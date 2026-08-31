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
inside a card in a scroll — and Review is a link rather than a filled button.

**The card is a skim; the document is drawn once, behind Review.** Where a card draws diff rows at
all it draws the **changed** ones, at most three, with one *+ N more* line beneath them: the web's
and Android's do, iOS's draws none. Kept rows, kept runs and the whole run the routine takes on
belong to the review sheet, which is the screen that asks for a decision.

**How much a proposal is, is one phrase, and a removal is not a count.** The rule is a **slot**, not
a requirement on every card: where a card says how much, it says it on its own line under the
summary and never in the eyebrow. The Coach card says it, because the proposal has just been minted
and nothing else on that turn measures it. On the routines home the phones' standing cards say it
too, and the web's says the **consequence** instead — `intentLine`, what applying would do to the
routine the card is sitting beside — and says how much nowhere; whether that card owes the phrase as
well is a copy owner's call the ledger holds (`3u`).

**A removal reads *a removal* and never a count.** The domain forces `standing == 0` for a removal,
so every base entry arrives as a `removed` change and a count would say *12 changes* for a proposal
that deletes the routine. The phrase asks the intent
first, in one function per surface: `countedLabel` (`proposals.js:105`), `Proposal.counted`
(`domain/Proposal.kt:220`), and `historyLine`'s own branch (`Proposal.swift:101`) on iOS. Two places
still count a removal and are owed the branch: iOS's two proposal cards, which draw the bare
`changes` beside *still waiting*, and every surface's conversation rows, whose wire rows carry no
intent to ask (ledger `3l`, which also records the one card that keeps the phrase in its eyebrow
row). Whether that line names the routine a second time is a copy owner's call the ledger holds
(`3j`): the web's card draws the phrase alone, Android's draws *`<routine>` · `<counted>` ·
waiting*, and the eyebrow above both has already said the name.

**The eyebrow names the routine — `Proposal · <routine name>` — on the card and on the review sheet,
on all three surfaces**, and on Android in the thread as well. Who wrote it is a different fact with
its own home: the review sheet's header, and the routine's history row. The name is a lifter-typed
string of up to 60 code points, so the eyebrow **holds one line**: the name truncates and the stamp
beside it keeps its room. **The review sheet's head is the one place it may take two.** An eyebrow
shares its row with a stamp and a clipped name there costs a reader nothing they cannot get one tap
away; the head is the screen the routine is decided on, and clipping the name hides the subject of
the decision.

**The promise under the card is drawn while the proposal waits, and dropped once it is decided.**
*Nothing changes until you tap Apply on the diff. Your logged sets are never part of a proposal.* is
a claim about what Apply will do, and it is spent the moment Apply has been taken or turned down.
What survives the decision is the door to the rows the card counted, which every surface keeps.
Ruled 2026-08-31; both phones draw the promise unconditionally and owe the move (ledger `3t`).

**One proposal per turn.** An answer *can* mint several, and two on the same routine kill each other:
the supersede runs before the second lands, so the first is dead while both ids come back. A second
mint in one run is refused with a sentence the model can act on: *"you already wrote a proposal this
turn; fold both into one document."*

**A dead proposal says why, and never guesses.** Applying one past settling is refused with the reason
the store recorded, in this order: *a newer proposal replaced this one, so it was not applied* when a
later proposal took its slot — decided first, because a routine can move after the second mint too,
and nothing changed but Coach's mind; *that routine changed after this proposal was written, so it
was not applied* when only the routine's revision moved; *this proposal was superseded before it was
applied* for a row settled before the reason was kept. Turning one down meets the same three ending
*…so it was not turned down* (the third: *this proposal was superseded before it was turned down*).
Every surface shows the server's sentence as sent; local words only for a reply with none.

### Two · the review

Review opens the diff **over** the conversation — an iOS sheet, an Android modal bottom sheet **with**
its drag handle, a web dialog. Never a push: a push says *you have left*, a sheet says *you are
deciding, and you will be back*. The loop is the product, so the navigation has to agree with it.

**No fixed partial detent.** A routine holds up to fifty entries and the summary runs to four hundred
model-written characters, so the diff is unbounded — and a half-height detent does not grow with the
system's text size, so at the larger accessibility sizes the visible diff goes to zero while Apply
stays enabled. The iOS sheet is `.large` only; Android's skips the partial state. **Apply is never
reachable while the diff is clipped:** on every surface it stays disabled until the diff has been
scrolled to its end, or fits without scrolling. A kept run unfolding past the height already seen
clips the diff again, so it takes Apply away until the new end is seen — built that way on the web
and Android; iOS keeps Apply open once seen (ledger `2p`). The web's design-system `Dialog` carries
the gate for any dialog that asks for it.

**Kept rows have one shape everywhere.** Changed rows at full weight; every run of kept rows as a
collapsed count **in its own place** — *"and 7 lines unchanged"*, *"and 1 line unchanged"* — tappable
to unfold where it stands. The rows are the document as well as the diff, and a lifter deciding needs
to see the run the routine takes on, not only what moved, in the order it will apply.

**The model's prose is attributed to whoever wrote it.** The summary sits in a quoted block under a
kicker, visually separate from the counted rows: **Coach wrote:** for a proposal that came through the
Coach door; **<name> wrote:** for one that came over MCP from a source with a name — the agent's own,
else the connection's, as the byline *from Claude Desktop* already reads; **Your agent wrote:** for
an MCP source with neither. The kicker is an attribution, not an eyebrow: drawn as written, sentence
case, never uppercased. The sheet never puts two kinds of truth under one pair of buttons.

**Three exits, not two.** Closing the sheet — swipe, scrim, back, × — **decides nothing**: the proposal
stays pending, and the card it was opened from reads *still waiting*.

**The band holds one button, and it is Apply.** Its label carries the count the store will apply —
**Apply all N**, **Apply** when N is 1, **Remove <routine>** for a removal — and never a number the
screen counted for itself. Turning a proposal down is a **plain text row beneath it**, not the left
half of a pair. A pair puts the one irreversible act exactly where a lifter's hand expects *cancel*,
and colour does not undo position — someone reaching for "not now" would settle something
permanently. "Not now" already exists and costs nothing: close the sheet. So the pinned band is a
single primary, which is also what the reach law asks for; two full-strength buttons of the same
weight is a failure to decide. The atomic promise — *All N or none. Nothing is applied until you
tap.* — is always drawn, never toggled, so the band's height never changes.

**And it has one slot: inside the pinned band, between Apply and the turn-down row**, on all three
surfaces — iOS's placement (`ReviewSheet.swift:278`). A promise that scrolls with the diff is not
pinned, and a promise below turn-down puts the last word under the irreversible act. Ruled
2026-08-30; the web and Android owe the move (`../BUILD.md` §8, ledger `3e`).

**"Turn this down"** stays destructive and stays confirmed, and the confirmation's words are pinned
on every surface: *Turn this down?* / *Nothing changes, and it stays in the routine’s history as a
record.* / **Turn down** (destructive) · **Keep it**.

**One word for one act.** Wherever a lifter reads the settled state of a turned-down proposal it is
*turned down* — the chip *Turned down*, the history line *turned down N changes from …*, the thread
outcome *N changes turned down*, and the settled sentence *"Turned down {when}. Nothing changed, and
it stays in the routine’s history as a record."* — on all three surfaces. No route reopens a settled
proposal, so the copy promises no way back, and the confirmation guards an act that really is
irreversible. The wire state `dismissed` and the route `/dismiss` are machine tokens and stay.

**At the rack, Apply says what it does not do.** A session's plan is a frozen snapshot, so applying
mid-workout changes nothing about the workout in progress. While a session is open the web's dialog
carries *"You are mid-workout. Applying changes next time, not this session."* That state exists on
the web only: both phones draw the logger over every other screen while a session is open, so no
review is reachable there mid-workout, and they draw nothing for it — a board that drew the caveat on
a phone would be drawing a state the phone cannot reach.

That line sits **above the diff, never inside the pinned band.** A line that appears and disappears
inside the band moves the Apply button, so the same tap lands somewhere different depending on
whether a workout is running. The band's height is constant; the caveat is content.

### Three · the apply

One atomic write against the base revision. A routine that moved underneath is superseded, never
merged over. All of it lands or none of it does.

### Four · the return

The sheet closes onto what opened it and a **receipt line** lands under the proposal's card in the
Coach room, or under its row in a stored thread:

> **Applied · Push A · 4 changes**

*1 change* when one; **Applied · Push A · routine removed** for a removal. Turning down writes
*"Turned down · nothing changed."* Where there is no thread to land in — the web's routines home, or
a proposal opened from an outside link — the same line is said through the room's transient.

The receipt is **derived from the server's reply, never from the model's prose** — the routine's name
as it now stands (else the name it had) and the store's own change count. A model that mis-states
what it just did is the failure this beat exists to make impossible. The wording is the sentence the
server can stand behind: the diff rows carry an exercise id and never a movement name, so *"now runs
5 × 3 at 90"* is reachable only when exactly one field of one movement moved. That is a special
case, never the shape of the rule.

**The receipt is ephemeral, and it is not dressed up as history.** Nothing writes a turn on apply,
and the thread's stored shape carries no settled-at, so the receipt lives in the screen that drew it:
on reopening a thread it is gone, and nothing pretends otherwise. The durable ledger row is the
deferred programme (`../BUILD.md`, B12); the boards state the receipt is ephemeral until it lands.

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

**A verb does not ship without a phrase.** A tool the step line has no phrase for prints nothing, on
every surface, and the receipt stays — so a verb shipped without its words is a step the lifter never
sees. The three phrase tables (`coach.js` `TOOL_PHRASE`, `Ask.swift` `Ask.phrase`, `Ask.kt`
`Ask.phrases`) carry the same words and travel with the tool.

## What the room does not print

The raw tool trace. It is developer output on a lifter's surface, and no surface draws it.

**The read receipt is always visible.** *"read 214 sets · 6 weeks · 18 sessions"* is an honesty
mechanism, not chrome: it is how a lifter knows what the answer stands on. The step list sits
collapsed behind it and opens on one tap; every answer carries at least one step, because the notes
read — *read your notes* — opens every conversation.

The honesty claim rests on the **receipt**, which is always visible, and not on the step list, which
is detail for whoever wants it. A collapsed control is not a check on anything, so it must never be
the only thing standing between a lifter and knowing what Coach read.

The four rules under it do not move: counts are by identity, so one workout read twice is one
workout; a summary claims only what it named; a refused read counts nothing; and a reply that served
no rows says nothing at all rather than "read 0 sets".

## The limits, said on screen

The daily allowance and the back-to-back limit are stated in the room, never hidden behind a quietly
weaker answer. **In the room** means on the Coach screen itself, in one line — *"Ten questions a day,
three back to back."* — not in a paragraph explaining why the cap exists, not only on the board that
draws the cap being hit, **and not only on the empty state.** A lifter who has asked one question is
still in the room; putting the promise only where there is nothing to read means it is seen once,
by someone who has not yet spent any of it, which is the least useful moment of all.

**And it sits immediately above the composer, on every surface.** The composer is where a question is
spent, so that is where the allowance belongs — the same *moment of consequence* logic that put the
ceiling on the Add row. Not in the head, which is where the room's standing facts live, and not below
the composer, which reads as a footnote to the keyboard.

**The cap-reached state says what to do next, not the rule again:**

> **The next question frees up in a couple of hours.**

That is true rather than approximate: the allowance is ten a day on a bucket that refills steadily, so
a question comes back roughly every two and a half hours. It carries the same *connect your own agent*
door the empty room does, because that is the one path that is not rationed.

**Two refusals reach that state, and the second one is the account's 30-day AI ceiling.** A ceiling
with a live composer is a dead end that fails the same way on the next question, and the connect
door is unrationed under either refusal, which is what makes it one state. What must not be shared
is the sentence: every surface renders the server's own words where the reply carries them, and the
local constant is the **wordless fallback, chosen on the refusal's code** — `ask-daily-limit` or
`ask-out-of-budget` — so a ceiling never says the daily line's *couple of hours*. And under the
ceiling the **connect door is the primary and *Ask something new* sits beneath it**: a new
conversation there cannot take a question either, so it is a way out of this one rather than a way
to an answer. Ruled 2026-08-30 and owed a build (`../BUILD.md` §8, ledger `3f`).

Both are needed. The line in the room is the promise; the **cap-reached** state is the moment, and it
says what to do next rather than restating the rule. A room that drew neither would not have trimmed
the cap, it would have deleted it.

**There is no clock on the cap-reached state.** It replaces the composer's input and send control for
the rest of that visit to the room, with the allowance line still drawn above it so the promise and
the moment sit together, and it carries an *Ask something new* door: the composer returns when the
lifter opens a new conversation or re-enters the room, and a question sent while still capped meets
the 429 again. The sentence is never on one screen twice — the exchange's own refusal card is not
drawn while the state is.

The thread ceiling is **four questions** — the copy says four, because the code counts a question
and its answer as two turns against a ceiling of eight. The server's 409 sentence is shown verbatim;
when it arrives without one, every surface falls back to *"This conversation holds four questions.
Start a new one."* Nothing a lifter reads says eight. Hitting the internal iteration cap is a
**failure**, not a truncation to be dressed up.

## The two stances, pinned

Every surface draws these bytes, and the suites pin them.

**Signed out** — the room needs an account because it reads an account's log.

> **Coach reads your log, so it needs you signed in.**

One sentence, and it gives the reason rather than the rule. On the web the room sits behind the gym's
own sign-in door, so this sentence is the mid-room 401 stance rather than a screen.

**This deployment does not carry Coach** — not an outage, and the difference matters.

> **Coach isn’t part of this Windmill. Your log is still yours to read.**

*Part of* rather than *available on*: nothing is broken and nothing is coming back later, so a word
that implies a temporary fault would be a small lie. The second sentence is the useful fact — the
thing the lifter actually came for still works. The Notes door stays drawn in this stance, because a
connected agent reads notes whether or not this Windmill carries Coach.

**The apostrophe is the typographic one** (’), everywhere, on every surface — the server included.

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
