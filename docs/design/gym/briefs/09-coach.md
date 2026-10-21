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

## First open — set up your routines

Signed-in iOS Gym offers setup automatically after account data has loaded, when the account has
no Gym data and no active workout, account transition or adoption decision. A saved conversation or
draft takes precedence. A person who deliberately chose a manual route is not redirected on each
visit; empty Routines retains a quiet **Set up routines** action. Signed-out setup uses the
installation and local persistence boundary below.

The empty setup room is headed **Set up your routines** · *Built from what you bring.* and offers
three starters as one list:

- **Add a screenshot** opens the system photo picker, which needs no permission; the photo waits
  in the composer as the attachment draft (`../feedback-contract.md`).
- **Describe your program** takes pasted or typed program text.
- **Share your goal** takes a goal. Coach asks only the materially missing questions, each
  answered with chips that fill one draft. Selecting chips invokes no AI work; submitting the
  draft can use USD allowance.

Two quiet escapes sit under the starters: **Just log** opens the logger, **Build it myself** opens
the routine editor. Both preserve the choice for that account. Text starters prepare an editable
draft and focus the composer; they never send automatically. The starters leave after the first
send. The heading and starters are the room's, not a message: Coach still does not speak first.

Signed-in program and question text share an 8,000-byte UTF-8 limit. A refusal retains the entire draft and
asks the person to shorten it; it never truncates text silently. Clarification choices arrive as
bounded, typed days/equipment groups. The client does not derive buttons from Coach's prose. A
selection updates the editable draft, and the person still taps Send.

When Coach creates requested routines, show one creation receipt per saved routine, *<name>* ·
*Routine created · N movements*, each with **Open routine** — three saved routines yield three receipts.
One turn can create at most six routines. Each creation has its own stable operation identity;
replaying the same request recovers the same saved routine and receipt. An interrupted answer keeps
its completed creation rows even if the next provider call is refused by an allowance.
Open routine shows the routine with **Start workout**. Signed-out setup adds the Keep row
(`../../guidelines/superapp-flow.md` §6); signed-in setup has no phone-only or Keep claim. With
routines, Gym opens on Routines.

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
reloads that proposal's state and renders the same outcome. On iOS, decisions remain in Review
until the person closes it. Android keeps removals there and returns other decisions to what
opened them. The proposal card or stored-thread row carries the receipt line:

> **Applied · Push A · 4 changes**

*1 change* when one; **Applied · Push A · routine removed** for a removal. Turning down writes
*"Turned down · nothing changed."* Other Android decisions opened outside a thread use the room's
transient for their return receipt.

A removal applied on either phone keeps its receipt state with the account until the receipt is
shown. Retries, timeouts and relaunch preserve the pending decision and its confirmed outcome;
an unseen receipt remains reachable from Routines after relaunch. Showing the confirmed receipt
in the foreground acknowledges it; reading or refreshing the model does not consume it. A refused
removal shows its refusal, never an applied receipt.

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
collapsed behind it and opens on one tap. Signed in, every answer carries at least one step, because
the notes read — *read your notes* — opens every conversation.

The honesty claim rests on the **receipt**, which is always visible, and not on
the step list, which is detail for whoever wants it. A collapsed control is not a check on anything,
so it must never be the only thing standing between a lifter and knowing what Coach read.

The four rules under it do not move: counts are by identity, so one workout read twice is one
workout; a summary claims only what it named; a refused read counts nothing; and a reply that read
nothing says so in words — *read nothing from your log* — never *read 0 sets*.

## The limits, said on screen

Limits are contextual. Signed in, the empty room leads directly to its composer with no allowance line; the signed-out room has one quiet allowance line once installation access exists. When a limit prevents a question, show the server’s accurate reason and available recovery once; preserve the draft and conversation. Individual lifetime/monthly/funded allowance, a request too large for its remaining balance, shared free daily/monthly pools, concurrent calls and burst limits are distinct states. New chat resets none of them. Use the refused budget's reset metadata; a shared daily-pool pause is not the account's monthly reset.

A conversation has no question cap of its own: History reopens the same editable conversation however many questions it holds. Backend model-context bounds are independent of visible retained history. Generating, stopped and interrupted answers keep their truthful partial state and completed action receipts.

The full quiet-room, copying, image attachment and streaming contract is [feedback-contract.md](../feedback-contract.md). The owner’s supplied prompt is preserved by the implementation.

## Signed out, and not carried

**Signed-out Coach uses $0.05 for the lifetime of an installation credential.** The server issues
the credential; the phone keeps it separately from account credentials and retains it on sign-out.
IP issuance and generation limits and the shared free daily/monthly pools bound exposure.
Installation resets are not guaranteed to preserve identity. Input tokens are estimated for each
actual request and settled to actual provider cost. Show the server's lifetime grant once under
the first-open starters, without promising a number of questions:

> $0.05 of AI use without an account. Does not renew.

No countdown, no urgency colour, no *only 1 left*. When the allowance is spent, the next send is
refused once, in place of an answer:

> **You’ve used this phone’s AI allowance.**
> Sign in to keep your routines. If your account already has training, you’ll be
> asked first.

Use that refusal only for a spent balance. A request that cannot fit positive remaining capacity
needs its own explanation. Sign-in binds the installation permanently and includes its current
month's anonymous spend in the account's $0.25 monthly free usage; it does not reset usage or
promise capacity. Unresolved calls remain accounted for across sign-in and period boundaries.

**Continue with Apple** leads and **Use email instead** follows, as on the Keep sheet. The draft
stays in the composer and the conversation stays on screen. After sign-in the conversation and the
phone's routines join the account by the sign-in rule (`../../guidelines/superapp-flow.md` §6): the
same conversation continues under the account, receipts included, unless the person discards the
phone's gym work when asked, which discards the conversation with it.

Signed-out setup makes one bounded provider request. A goal accepts up to 1,000 UTF-8 bytes and
requires local Days (1–6) and Equipment (Full gym, Dumbbells, Barbell, Bodyweight) choices before
Send. A supplied program accepts up to 4,000 bytes without mandatory goal choices. A photo accepts
JPEG or PNG up to 1 MiB with an optional 1,000-byte note. Limits preserve the full editable draft.
The result contains at most three reusable routines, six movements per routine and eight target
sets per movement; it does not promise a weekly calendar. Unknown movements or insufficient
source details are refused rather than invented.

The phone validates and saves the entire result and its replay receipt atomically before showing
**Routine created**. Opening a routine and starting a workout need no account. **Stop waiting**
stops waiting and local saving, not provider spending; **Check response** recovers the same request.
Local save retry uses the saved result without another provider request.

**A signed-out photo is sent to the AI provider when the person sends. Windmill keeps the photo
only on the phone.** The application server does not persist the image or input text. The provider
processes it under its own retention terms. A validated routine result is retained briefly for
request recovery. Signing in keeps routines through the ordinary Add/Discard rule; local Coach
history and photos must follow that same ownership decision without implying cloud chat backup.
Signed in, a newly sent photo is kept privately with the account's conversation.

**Android and web keep Coach account-only**, with one stance:

> **Coach reads your log, so it needs you signed in.**

Android draws it as the signed-out room (`../android-delivery.md`), and its suite pins it. On the web the room sits behind
the gym's own sign-in door, so the sentence is the mid-room 401 stance rather than a screen.

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

- **Android's signed-out Coach**: whether the phone allowance reaches Android.
- **The mid-workout refusal.** The reason is sound, but a lifter at the rack with a question has
  nowhere to put it. Worth deciding whether the refusal should offer to hold the question for after
  the session rather than closing the door — and it should name the rack-side controls that *do*
  work, rather than only refusing.
