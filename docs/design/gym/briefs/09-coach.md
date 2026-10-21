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

## First open — Coach greets

An empty Gym, signed in or not, opens on Coach. Before the first accepted message Coach speaks
first, locally — two bubbles, no model turn, no allowance line:

> I’m Coach. I can help with:
>
> **Build** — a program from a screenshot or your own words.
> **Goals** — set them here, and I’ll plan around them.
> **Notes** — I keep what matters, like an old injury.
> **Adjust** — I review your routines as you train; nothing changes until you apply.

Signed out the second bubble reads **Build** and **Goals** (*tell me what you’re after, and I’ll
plan around it*) and then **With an account** — *I keep notes and review your routines as you
train.*, since saving notes and proposing changes need an account. Each claim is a tool Coach has:
`create_routine` from an attached image or text; goals, limits and other insight the lifter states
go into Notes through `save_note`, which every later turn reads; `propose_routine_change` and
`propose_routine_removal` change nothing until the lifter applies. When the lifter states a goal,
Coach saves it as a note in that turn.

Under the last bubble sit **Add screenshot** (the system photo picker, no permission) and **Build
myself** (the routine builder). The greeting and its actions stay until the first user message is
accepted; tab changes, a cancelled picker, relaunch and a refused or failed send keep them. There
is no goal form, no chips and no Just log.

Signed-in program and question text share an 8,000-byte UTF-8 limit. A refusal retains the entire
draft and asks the person to shorten it; it never truncates text silently.

**Routines Coach writes are drafts, confirmed inline.** They hang under the answer as one card: each
routine a row that expands in place to its movements, equipment and set targets in their load
basis, and **Save routines** (**Save routine** for one) on the card. Nothing is saved until that tap.
After it, the card becomes one receipt per saved routine, *<name>* · *Routine created · N
movements*, each with **Open routine**. One turn can prepare at most six routines; each has its own
stable operation identity, so a retry recovers the same draft and the same receipt. Signed-out
setup adds the Keep row (`../../guidelines/superapp-flow.md` §6). With routines, Gym opens on
Routines.

## The loop — four beats

The same four beats on every surface, and all of them in the conversation: the diff, the decision
and the receipt live on the proposal card. There is no review sheet.

### One · the turn

Coach answers in prose. On web, one inline proposal follows with the routine name, counted changes,
full diff, **Apply** and **Turn this down**. The decision replaces its actions with a receipt in the
same place. A routines-home preview opens the conversation at its inline proposal.

On the phones, the proposal card under the answer carries the diff, **Apply** and **Turn down**.
It shows up to three changed rows, then **Show all N changes**, which expands the card in place to
every change and kept run; **Show less** folds it. A routines-home proposal row opens its
conversation at the card.

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
name truncates on one line. Phone cards use *Proposal · <routine name>*. The source attribution remains separate from the routine
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

The review is the card. Web and the phones render the same thing: the complete diff — changed rows
at full weight, each kept run a collapsed count *in its own place* (*and 7 lines unchanged*) that
unfolds where it stands — then the actions and the atomic promise. On the phones a long diff opens
on its first three changes and **Show all N changes** expands it in place; nothing opens over the
conversation.

**Every change reads as a diff, at body size.** Each change is its own block: its kind as a symbol
and a word (*Changed*, *Added*, *Removed*, *Moved*), the movement name, then one line per field —
sets, reps, load, equipment, order. A changed field shows its old value struck through and dimmed,
then its new value in full ink: old on the left, new on the right, so the strikethrough and the
position carry it without colour. Unchanged fields stay plain; an added movement is all new; a
removed one is struck through whole. Drafts use the same blocks (every movement *Added*), and so
does the receipt for a movement Coach edited.

**The actions are on the card.** **Apply all N** (**Apply** when N is 1, **Remove <routine>** for a
removal, in the destructive style) and **Turn down**, side by side under the diff, then the promise —
*All or none. Nothing changes until you tap.* (*Nothing changes until you tap.* for one change;
*Your logged sets stay. Nothing is removed until you tap.* for a removal). The label carries the
count the store will apply, never a number the screen counted for itself. Both are disabled while
a request runs; the server's refusal stays on the card.

**Turn down asks once** on the phones: *Turn this down?* / *Nothing changes, and it stays in the
routine’s history as a record.* / **Turn down** (destructive) · **Keep it**. Web settles directly.
Leaving the card alone decides nothing: the proposal stays pending in the conversation.

**The card attributes the proposal.** A proposal from a connected tool carries *from Claude
Desktop* (the agent's name, else the connection's; *from your agent* with neither) under its
eyebrow; Coach's own needs no byline, since its answer sits above.

**At the rack, Apply says what it does not do.** A session's plan is a frozen snapshot, so applying
mid-workout changes nothing about the workout in progress. A pending card seen during a workout on
web carries *"You are mid-workout. Applying changes next time, not this session."* above the diff,
never inside the actions, so Apply never moves.

### Three · the apply

One atomic write against the base revision. A routine that moved underneath is superseded, never
merged over. All of it lands or none of it does.

### Four · the return

On web, the inline proposal replaces its actions with the stored outcome. Reopening the conversation
reloads that proposal's state and renders the same outcome. On the phones the card collapses to its
receipt line in place; a proposal that is out of date stays readable in grey with the server's
reason and no actions. The card or stored-thread row carries the receipt line:

> **Applied · Push A · 4 changes**

*1 change* when one; **Applied · Push A · routine removed** for a removal. Turning down writes
*"Turned down · nothing changed."*

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
actual request and settled to actual provider cost. No allowance line is shown before it is in
the way: no countdown, no urgency colour, no *only 1 left*. When the allowance is spent, the next
send is refused once, as a centred line in the conversation with its way out:

> Your AI allowance is fully used or reserved.
> Sign in to continue. **Sign in**

Use that refusal only for a spent balance. A request that cannot fit positive remaining capacity
needs its own explanation. Sign-in binds the installation permanently and includes its current
month's anonymous spend in the account's $0.25 monthly free usage; it does not reset usage or
promise capacity. Unresolved calls remain accounted for across sign-in and period boundaries.

**Continue with Apple** leads and **Use email instead** follows, as on the Keep sheet. The draft
stays in the composer and the conversation stays on screen. After sign-in the conversation and the
phone's routines join the account by the sign-in rule (`../../guidelines/superapp-flow.md` §6): the
same conversation continues under the account, receipts included, unless the person discards the
phone's gym work when asked, which discards the conversation with it.

Signed-out Coach is plain dialogue: each message makes one bounded provider request of up to
4,000 UTF-8 bytes, optionally with one photo (JPEG or PNG up to 1 MiB), and may return routine
drafts confirmed inline. Limits preserve the full editable draft.
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
