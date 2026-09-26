# Coach — the room, and the loop it runs

Coach is the second door onto the engine an MCP-connected agent already reaches. A lifter with their
own Claude or ChatGPT connects it and never opens this room. A lifter without one opens Coach, which
asks the same questions of the same tools.

## What the name does not buy

Coach uses the owner’s supplied system prompt: friendly, informal, direct and grounded in the lifter’s records. It reads user data before deciding, asks when needed and saves useful user-provided insights to Notes. It limits its questions to wellbeing and general health. Notes retain the lifter’s instructions and stated context.

- **It does not speak first.** No greeting, no daily check-in, no "how did that feel?".
- **No unread badge, no count, no notification, nothing waiting.** Pinned by
  `../../guidelines/superapp-shell.md`.
- **No grade or streak.** Keep factual progress distinct from supportive conversation.
- **Existing routine changes are proposed; the human applies.** Requested routine creation has its own truthful creation receipt. There is no apply tool at any grant level.
- **It is refused mid-workout.** The room reads a log that is still being written.

The lifter’s Notes are written in `10-notes.md`. The trust boundary distinguishes two fields: a **set note is a record** and the prompt treats lifter-typed text as data, never instruction;
a **note is directive**, and Coach follows it. The Notes screen says so. The set-note field says
nothing, because it is a record.

## The loop — four beats

The same four beats on every surface. Web keeps the diff, decision and receipt inline; the phones
open a review sheet.

### One · the turn

Coach answers in prose. On web, one inline proposal follows with the routine name, counted changes,
full diff, **Apply** and **Turn this down**. The decision replaces its actions with a receipt in the
same place. A routines-home preview opens the inline panel through **Review**.

On the phones, the proposal card carries its summary, counted changes and **Review**. It has no
Apply button: `../../guidelines/thumb-reach.md` keeps the committing action in the review sheet's
pinned band. Android's skim shows at most three changed rows and a *+ N more* line; iOS's shows no
diff rows. The complete routine and kept runs belong to the sheet.

**The count describes the proposed change.** Web's inline heading combines the routine name and
counted phrase; routines-home previews show changed rows or the proposal summary. Phone cards
place the counted phrase on its own line below the summary. A removal reads *a removal*.

**A removal reads *a removal* and never a count.** The domain forces `standing == 0` for a removal,
so every base entry arrives as a `removed` change and a count would say *12 changes* for a proposal
that deletes the routine. The phrase asks the intent
first, in one function per surface: `countedLabel` (`proposals.js:110`), `Proposal.counted`
(`domain/Proposal.kt:220`), and `historyLine`'s own branch (`Proposal.swift:101`) on iOS. Two places
still count a removal and are owed the branch: iOS's two proposal cards, which draw the bare
`changes` beside *still waiting*, and every surface's conversation rows, whose wire rows carry no
intent to ask (ledger `3l`, which also records the one card that keeps the phrase in its eyebrow
row). Whether that line names the routine a second time is a copy owner's call the ledger holds
(`3j`): Android draws *`<routine>` · `<counted>` · waiting* after its eyebrow has named the routine. Web's inline heading names the routine once beside the count.

**The proposal names its routine.** Web's inline heading reads *<routine> · <counted>*; its routine
name truncates on one line. Phone cards and review sheets use *Proposal · <routine name>*; the
review sheet's heading may take two lines. The source attribution remains separate from the routine
name.

**Pending promises disappear when the decision is settled.** Web draws *Logged sets stay unchanged.*
for a revision, and the intent-specific atomic promise for a removal. Its actions become the server's
applied or turned-down receipt. Phone cards retain their promise while pending and remove it after
the decision. A read still in flight is not a settled decision.

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

Web renders the complete diff inline with collapsed kept runs, one Apply button, its atomic promise
and a plain **Turn this down** action. It has no review dialog or scroll-to-end gate. Both actions
are disabled during the request; the server's refusal stays beside the proposal.

On the phones, Review opens the diff **over** the conversation: an iOS sheet or Android modal bottom
sheet with its drag handle. Closing returns to the same conversation without deciding. The following
sheet and scroll-gate rules apply to iOS and Android.

**No fixed partial detent.** A routine holds up to fifty entries and the summary runs to four hundred
model-written characters, so the diff is unbounded — and a half-height detent does not grow with the
system's text size, so at the larger accessibility sizes the visible diff goes to zero while Apply
stays enabled. The iOS sheet is `.large` only; Android's skips the partial state. **Apply is never
reachable while the diff is clipped:** on both phones it stays disabled until the diff has been
scrolled to its end, or fits without scrolling. A kept run unfolding past the height already seen
clips the diff again, so it takes Apply away until the new end is seen — and scrolling back up never
re-locks it, because that end has been seen. **Both phones enforce that rule**, with `seenExtent` on Android and `ReviewGate.seenAt` on iOS.

**And the gate says why, on the screen and not only to a screen reader:**

> **Scroll to the end to apply.**

Six words, byte-identical on both phones (`Proposal.applyHint` in `Proposal.swift` and `Proposal.kt`), inside `../../guidelines/text-budget.md`'s refusal row
because it names the way out rather than only refusing. It is driven off the **gate alone**, never
off whatever else has Apply inert: while an apply request is in flight Apply is shut for a different
reason, and a sentence bound to the disabled state would tell a lifter to read further while the
write is already going. So it is the sentence while the diff is unseen and nothing once it has been
seen, whatever the request is doing.

**Both channels, on both phones: the pixels, and the control that is refusing.** iOS hands
VoiceOver the button's `accessibilityHint`; Android uses `stateDescription`. Hide the duplicate
visual refusal from semantics so the gate is announced once.

**Kept rows have one shape everywhere.** Changed rows at full weight; every run of kept rows as a
collapsed count **in its own place** — *"and 7 lines unchanged"*, *"and 1 line unchanged"* — tappable
to unfold where it stands. The rows are the document as well as the diff, and a lifter deciding needs
to see the run the routine takes on, not only what moved, in the order it will apply.

**The phone review attributes the model's prose to whoever wrote it.** The summary sits in a quoted block under a
kicker, visually separate from the counted rows: **Coach wrote:** for a proposal that came through the
Coach door; **<name> wrote:** for one that came over MCP from a source with a name — the agent's own,
else the connection's, as the byline *from Claude Desktop* already reads; **Your agent wrote:** for
an MCP source with neither. The kicker is an attribution, not an eyebrow: drawn as written, sentence
case, never uppercased. The sheet never puts two kinds of truth under one pair of buttons.

**Three exits, not two.** Closing the sheet — swipe, scrim, back, × — **decides nothing**: the proposal
stays pending, and the card it was opened from reads *still waiting*.

**The phone review band holds one button, and it is Apply.** Its label carries the count the store will apply —
**Apply all N**, **Apply** when N is 1, **Remove <routine>** for a removal — and never a number the
screen counted for itself. Turning a proposal down is a **plain text row beneath it**, not the left
half of a pair. A pair puts the one irreversible act exactly where a lifter's hand expects *cancel*,
and colour does not undo position — someone reaching for "not now" would settle something
permanently. "Not now" already exists and costs nothing: close the sheet. So the pinned band is a
single primary, which is also what the reach law asks for; two full-strength buttons of the same
weight is a failure to decide. The atomic promise — *All N or none. Nothing is applied until you
tap.* — is always drawn, never toggled, so the band's height never changes.

**The phone band's order is four things on iOS and Android: Apply · the gate's
refusal · the atomic promise · turn down.** The promise is inside the band because a promise that
scrolls with the diff is not pinned, and above turn-down because below it puts the last word under
the irreversible act.

**The refusal's slot is held open in both states**, empty once the diff has been seen and empty
again while the apply request runs, so Apply never moves under a thumb already reaching for it. It
holds in the returning direction too — a kept run unfolding past the end already seen shuts the gate
again on both phones, and the sentence comes back into a slot that was already its size.

**"Turn this down"** is confirmed on iOS and Android. The phone confirmation reads: *Turn this down?* / *Nothing changes, and it stays in the routine’s history as a
record.* / **Turn down** (destructive) · **Keep it**. Web settles directly from the inline action and replaces it with the turned-down receipt; it adds no confirmation dialog.

**One word for one act.** Every surface calls the settled decision *turned down*. Web's inline
receipt reads *Turned down · nothing changed.* Phone history and settled-proposal views keep that
same term. No route reopens a settled proposal, so the copy promises no way back. The phone
confirmation guards that irreversible decision. The wire state `dismissed` and route `/dismiss`
are machine tokens and stay.

**At the rack, Apply says what it does not do.** A session's plan is a frozen snapshot, so applying
mid-workout changes nothing about the workout in progress. Outside the refused Coach room, a pending inline proposal on web
carries *"You are mid-workout. Applying changes next time, not this session."* That state exists on
the web only: both phones draw the logger over every other screen while a session is open, so no
review is reachable there mid-workout, and they draw nothing for it — a board that drew the caveat on
a phone would be drawing a state the phone cannot reach.

That line sits **above the inline diff, never inside its action band.** A line that appears and disappears
inside the band moves the Apply button, so the same tap lands somewhere different depending on
whether a workout is running. The band's height is constant; the caveat is content.

### Three · the apply

One atomic write against the base revision. A routine that moved underneath is superseded, never
merged over. All of it lands or none of it does.

### Four · the return

On web, the inline proposal replaces its actions with the stored outcome. Reopening the conversation
reloads that proposal's state and renders the same outcome. On the phones, the sheet closes onto
what opened it and a receipt line lands under the proposal card or stored-thread row:

> **Applied · Push A · 4 changes**

*1 change* when one; **Applied · Push A · routine removed** for a removal. Turning down writes
*"Turned down · nothing changed."* A phone proposal opened outside a thread uses the room's
transient for that return receipt.

The receipt is **derived from the server's reply, never from the model's prose** — the routine's name
as it now stands (else the name it had) and the store's own change count. A model that mis-states
what it just did is the failure this beat exists to make impossible. The wording is the sentence the
server can stand behind: the diff rows carry an exercise id and never a movement name, so *"now runs
5 × 3 at 90"* is reachable only when exactly one field of one movement moved. That is a special
case, never the shape of the rule.

**History must use stored evidence.** Restore proposal outcomes from their recorded state; do not
invent a historical conversation turn from a transient return receipt.

## The verbs

Coach can create a routine when the lifter requests it. Read relevant goals, constraints and the movement catalog; ask only for materially missing context. Creation carries a stable operation/routine identity and a factual receipt with Open routine. Retry must recover the same result, never create a duplicate. Changes to existing routines retain the current proposal and human Apply path.

| Verb | What the lifter receives |
| --- | --- |
| create a routine | A saved routine, truthful creation receipt and Open routine |
| change a routine | The existing proposal review and human Apply |
| remove a routine | The existing review including retained logged sets |
| save a useful insight | An appended note and a truthful saved-note step; the lifter controls later edits/deletion |

**Never proposable, at any grant level:** logging a set, fixing a set, deleting a
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

Limits are contextual. The empty room leads directly to its composer without a standing allowance paragraph. When a limit prevents a question, show the server’s accurate reason and available recovery once; preserve the draft and conversation. A daily allowance, burst limit and account AI ceiling are distinct states. New chat does not reset an account limit and must not be presented as a way around one.

A retained conversation has no lifetime question cap. History opens that same editable conversation, including after the fifth question. Backend model-context bounds are independent of visible retained history. Generating, stopped and interrupted answers keep their truthful partial state and completed action receipts.

The full quiet-room, copying, image attachment and streaming contract is [feedback-contract.md](../feedback-contract.md). The owner’s supplied prompt is preserved by the implementation.

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

**The title is the first text message, verbatim**, written once. An attachment-only first message uses **Photo**, never its filename. Nothing in this product summarises what a
lifter typed — no auto-title, no folders, no pinning. The outcome chip is derived, never stored.
The finish receipt's `Share with Coach` is one such first message: it opens a fresh conversation and
sends *Check my last session.* through the send path a typed question takes, so that sentence is the
thread's title verbatim and the receipt's caption promises exactly what the title will read
(`16-the-workout.md`). The lifter's tap sent it, so Coach has still not spoken first.
History opens a retained conversation with an active composer and the same identity. Copy works for either speaker, including partial text; attachment-only messages offer no empty text copy. Deleting a conversation deletes the conversation and not its consequence: a change that was applied
still says it came from Coach.

## Open

- **The mid-workout refusal.** The reason is sound, but a lifter at the rack with a question has
  nowhere to put it. Worth deciding whether the refusal should offer to hold the question for after
  the session rather than closing the door — and it should name the rack-side controls that *do*
  work, rather than only refusing.
