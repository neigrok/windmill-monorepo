# The routine — building it, changing it, starting it

This brief redraws the screen a lifter *works* on, which is the heaviest in the product: the routine
editor and the home it opens from share `Routines.jsx`, and the editor still stacks the target sheet
and the movement picker over a draft nothing has saved.

Everything here obeys three documents already written: `12-native-idiom.md`,
`../../guidelines/text-budget.md`, and `13-gestures.md`.

## The naming step dies

There is no interstitial on any surface, and no suggestion chips anywhere.

> **The name is the editor's first field.** Tapping *New routine* opens the editor with an empty name
> field already focused and the keyboard up.

A modal that exists to collect one string, before a screen that has a field for that string, is a
screen we invented. No suggestion chips either — a lifter naming their own training block does not
need three guesses from us, and `01-context.md` says this room is uninterested in helping you feel
clever.

**Save waits for a name, and that is the domain's rule rather than ours.** `Routine.cpp:40` refuses a
routine with an empty name outright — *"a routine needs a name"* — so the choice is between gating Save
and inventing a name on the lifter's behalf. We do not invent one: this product does not author text
and then attribute it to a person, which is the same rule that keeps a conversation's title the first
message verbatim.

So Save is disabled until the field has a character. That is a field with the keyboard already up, not
a screen — the interstitial existed because a name is required, and the requirement survives while the
screen does not.

## The target sheet is three fields

It held **five affordances for a three-field object** — tap-to-type, *use last time*, a ± plate
ladder, *take it to max*, and *leave it open · decide at the rack*. One remains, and it is the
typing.

> **Three fields — sets, reps, weight. No escape hatch, because clearing the first one *is* the
> escape.**

And the move that removes four affordances without losing a single state:

> **Emptying a field is how you clear it, and the placeholder says what empty means.**

- Weight, cleared → placeholder reads **last time**
- Reps, cleared → placeholder reads **max**
- Sets, cleared → placeholder reads **open**

Null targets are not zeros: no load means *last time*, no rep target means *max*. That semantic was
already in the domain and was previously exposed as **two extra buttons**. Now the empty field *is*
the null, and it explains itself where it is, in one word, instead of in a control the lifter has to
find and a caption explaining what the control does.

**And *leave it open · decide at the rack* is not a separate act at all.** The domain says so:
`Routine.cpp:17` refuses an entry that names reps or a load without naming sets — *"an open entry
names no sets, so it names no reps and no weight either."* So an open line is exactly a line whose
sets are cleared — and clearing that field while the other two hold values is **refused**, not
cascaded. See the strings below: the illegal shape has two ways in and each takes its own sentence.

Five affordances are **three fields**, the escape is one of them, and the rule the domain has always
enforced is visible in the interface instead of hidden behind a button that did it silently.

**The ± ladder comes off this sheet.** It belongs at the rack, where plate granularity is what you are
actually reasoning about, and it is drawn there already. In a planning sheet you know the number you
want; you do not step to it.

## Which kills the third overlay

The editor opens the target sheet, and the target sheet's third layer is **the platform's own
decimal keyboard** on every surface. Two layers, no custom keypad, no DOM-sibling workaround.

The keypad itself is not gone from the product — it is a **rack** control and stays there
(`16-the-workout.md`), raised from the logger and from the fix sheet on every surface. What the
planning sheet inherited from it is the refusals, pinned below.

## The editor after the cuts

- **Nav bar** carries the way back and *Save*. Nothing else is a header button — except on iOS,
  where an overflow beside Save holds Duplicate, which copies the draft.
- **The name** is the first field.
- **The movements** are a list: reorder by dragging the handle, **by pressing ArrowUp / ArrowDown on
  it, or by tapping it once to pick the row up and once more where it goes**, swipe or `×` to
  remove, and one control over the row body — the movement's name, its *yours* tag and its numbers
  together — opening the target sheet. **A row is not a door out of the editor:** a link from here
  discards the unsaved draft with no question, so the name is part of the sheet's own control rather
  than an anchor.
- **Add movement** is the last row of that list, not a floating button.
- **Duplicate** has one home and it is the routine **row's** overflow, the menu that also carries
  **Delete** (`13-gestures.md` Law 1). The editor draws neither, save iOS's copy of the draft above.
- **History** is a section, not an inline aside.

**The reorder handle is a control, not only a grip, and it answers three paths.** On the web it is a
real `<button>` whose accessible name says the row *and* its place — `Move Back Squat, 2 of 3`. The
**drag** is unchanged. **ArrowUp / ArrowDown** move the row; the ends do not wrap, and an arrow the
handle cannot spend falls through to the page like every other key it does not take. And **an
activation with nothing held picks the row up** — the name becomes `Move Back Squat, 1 of 3 — picked
up`, every other handle stops reading as a move and reads as the place it would put the held row
(`Place Back Squat at 3 of 3`), a second activation there puts it down at that index, the same handle
again puts it back where it stands, and Escape cancels. **The move is said once, on a `role="status"`
line under the list, whichever path took it**: a drag says nothing on its own, and a name changing
under a focus that has just jumped is not an announcement either. Focus follows the row that moved on
every path, because the list is keyed by index and the row it left is a new node. The state machine
behind all three is `rail.js`'s `useRail`, shared with the notes list; what stays in the editor is
what only the editor knows — `entryPlaceLabel` from `routines.js`, which the target sheet also reads,
and the focus-follow the index keying needs (`EntryList` in `Routines.jsx`).

No per-row *Move up* / *Move down* menu was bought for any of that — a drawn menu on every row is
chrome traded for a grip that already works — and **that closes `13-gestures.md` Law 1 and WCAG 2.2
SC 2.5.7 together.** The pointer half is the one that matters on the surface this room designs for: a
phone browser has no arrow keys, so a lifter on TalkBack or VoiceOver reaching the handle and
double-tapping it is who the single-pointer criterion is about, and a keyboard path answers 2.1.1
rather than that (`13-gestures.md` Law 1). iOS reorders through the platform's `.onMove`
(`RoutineBuilderScreens.swift:117`), which declares its own alternative.

> **Android cannot reorder a draft at all, and that is a feature this programme does not build.**
> It is a missing capability rather than a control disagreeing with canon, so it is owed as work and
> not carried as drift (ledger `3p`).

**A movement's record has a drawn door that does not cost a draft.** A routine line for a
never-logged movement is a first-class state here, and every other route on the web to that
movement's record needs it to have been trained or to stand in a proposal, whose diff rows are
anchors to the movements they name (`Proposals.jsx:275`). The phones reach it from the routine's own
screen, whose rows are movement doors (`RoutineScreen.swift:82`, `RoutinesScreen.kt:410-418`). The
web's editor rows are not doors, so the routines home's head draws a **Movements** door beside
**New** (`Routines.jsx:67`) — the only drawn way there to the movement chooser, and the one door to
a never-trained movement's record, and to Rename on it, that no proposal has to be standing for.

That is roughly twenty-one buttons down to the way back, *Save*, *Add movement* — and, on iOS, an
overflow.

## The movement picker

`.searchable` on iOS, the platform search field on Android, the design system's `Input` on the web —
no hand-built field styled as a rounded rectangle. The six keep their section under the head **The
six**; that is a genuine shortcut and not chrome.

> **The six are the account's own most-trained, ranked over the last fifty sessions that surface
> holds, and topped up in order from one shared opener list — Back Squat · Bench Press · Deadlift ·
> Overhead Press · Barbell Row · Chin Up — so a log-less account is offered six it has never
> trained.** The window is fixed at fifty and frozen on the first non-empty read, for the life of an
> open picker: paging further back, or a claim landing underneath, may not reshuffle the six under a
> thumb already reaching for one of them. Never gated on a first session.

**Creating a movement stays inside the picker.** It is the one place a lifter discovers the movement
they want does not exist yet, and sending them elsewhere to make it loses the search they just typed.

**The create step is drawn OVER the picker, never in place of it, and the picker owns it** — a
`.sheet` the picker itself presents on iOS, a nested `ModalBottomSheet` from the picker's own
`rememberSaveable` slot on Android, `.gym-sheet-catch` over the rows on the web. So Cancel comes back
to the rows with the typed query still in the field and the frozen six unshuffled, and on the phones
the create step gets its own frame with its own keyboard inset rather than competing with the
picker's height cap (ledger `2u`). It keeps the **two questions** it has always asked on every
surface — the name, with the cap and counter below it, and *How is it loaded?* Where the refusal is said still splits by
surface and is meant to: iOS holds the step up until the log answers and says it there, Android
closes the picker first and says it on the room's transient.

## The connect pitch loses two of its four homes

It currently appears on the routines list, on the proposal screen, as a settings row, and as a whole
page. The first two are interruptions in the middle of doing something else. **The settings row and
the page stay.**

## The routine on the list, and the routine on its own screen

A routine on the routines list is a **door**, and a door does not restate what is behind it.

> **The list card draws the routine's name, whether it is untested, one meta line — `{n} movements ·
> trained {ago}` — and its tie to whatever is waiting on it. Nothing else.** The movements, their
> targets and the settled history are read one tap deeper, on the routine's own screen, which is the
> only screen that draws them.

What that tie looks like is each surface's own, and the standing card is the one that names the
proposal (ledger `3o`): the web draws one card per waiting routine at the head of the list
and nothing on the row itself (`Proposals.jsx:51-66`, `Routines.jsx:102-114`); both phones give the
waiting routine's row the accent border (`RoutinesScreen.swift:232`, `ui/RoutinesScreen.kt:301`) and
draw a row of their own only for a routine whose waiting proposal is not the card's
(`RoutinesScreen.swift:226`, `ui/RoutinesScreen.kt:323`).

**The routine's own screen names every movement with its target column and the `· yours` suffix**,
and each row is that movement's record door (`RoutineScreen.swift:82`, `RoutinesScreen.kt:410-418`).
On the web that screen is the editor, and its rows are not doors — see the editor's own rule above.

**Its settled history is the newest twenty proposals, not all of them**
(`kRoutineHistoryProposals`, `backend/products/gym/ports/ProgramRepository.h:48`). No surface writes
*all*: a routine a connected agent has worked on for a year has more, and this screen is a recent
record rather than the ledger of every change.

**A history the log could not read is not an empty one, and it says so in one line** —
*the log didn’t answer — this routine’s history is out of reach*. **The phones share the subject and
each composes the prefix**, because that sentence is a claim about the log: a read the log REFUSED
keeps the log's own words, and only silence earns the composed line. iOS holds the bytes as
`RoutineReadout.historySubject` and builds the rest through `WriteFailure.noAnswer.line`; Android's
history block draws `why.line(…)` off the failure it was handed. The web needs no such state: its
history arrives inside the routine read it already has, so a read that fails has no half to report.

> **Inside a block, that line stands alone.** The *Try again* button belongs to the whole-screen
> failure — the state where nothing rendered — and never to one block of a screen that drew fine.

`../../guidelines/thumb-reach.md` §3.1 gives a screen one primary and §3.2 refuses two full-strength
controls of the same weight, so a full-width bordered button inside the History block would compete
with `Start workout` for the decision the screen exists to take.

## Starting a workout

`Start workout` lives on the routine's own screen, and `13-gestures.md` puts it on the row's
long-press menu as well — the only place it exists twice on purpose, because it is the verb this whole
screen is for.

**On a phone it is pinned in the reach band**, not inline in the scroll, so the one thing a lifter
does with a bar in their hands is reachable at every scroll position
(`../../guidelines/thumb-reach.md` §3.1, §3.6). iOS draws it that way
(`RoutineScreen.swift:191-203`); Android still draws it inline and owes the move (ledger `3r`).

## The strings, pinned

Three surfaces drew this wave in parallel and invented **seven different strings for four new states**,
because the rulings were pinned and the words were not. Every new state a wave creates needs its words
decided before anything is drawn, or each surface will decide them separately and all three will be
defensible.

**The typed field's refusals** — these were the custom keypad's, and removing it left them homeless on
all three surfaces. They live inline under the field, one at a time:

| when | the words |
|---|---|
| a second decimal point | **One decimal point only.** |
| the entry is not yet a number | **That is not a number yet.** |
| a load beyond the stored range | **Over 500 kg — check the number.** |
| reps outside the domain's band | **Whole reps, 1 to 100.** |
| sets outside the domain's band | **Sets, 1 to 20.** |
| a typed zero | **A zero target is no target — clear the field instead.** |

The field takes **a comma or a point**, and the screen says so once beside it rather than refusing.
The pinned bytes carry no full stop, because it is a note under a field and not a sentence:
`comma or point, both read as a decimal`. Refusing a comma would be refusing how most of the world
writes a number.

**The illegal shape has two ways in, and each takes its own sentence, because each has its own way
out.** Only one refusal is ever drawn at a time — the refused keystroke first, then the line's shape,
then the three fields topmost first.

> **Clearing sets while reps or weight hold values: Clear reps and weight first — an open line names
> neither.** The keystroke does not land: the field **keeps its value and that value is selected**,
> so the next digit replaces the number rather than appending to it. Retyping a one-digit count is
> the commonest edit on this sheet and it must not turn `5` into `54`.

> **Typing reps or weight onto a line whose sets are already empty: Name the sets first — an open
> line names neither.** That keystroke *does* land — refusing it would throw away what the lifter
> just asked for — and the **commit** is refused instead. Nothing typed is ever dropped in silence,
> and the remedy named is the one that fits: the other sentence would tell them to clear what they
> have just typed.

**Save with no name** keeps the two strings the product already ships, shown one at a time, not
concatenated: *Name it to save it.* then *A routine is at least one movement.* The first of them is
**one constant per surface and no fourth copy** — `NAME_IT_TO_SAVE_IT` (`routines.js`),
`RoutineDraft.nameItToSaveIt` (`RoutineBuilder.swift`), `Program.nameItToSaveIt` (`Program.kt`) —
because the finish card's keep-as-routine form draws the same sentence under the same inert Save
(`16-the-workout.md`).

**The open line** keeps its sentence on every surface, not just one:
*You decide the numbers at the rack.* It has **one placement rule**: in the target sheet while the
line on that sheet is open, drawn **above** the three fields beside the never-logged note (anything
under a field is that field's own note); and **once** beneath any list of a routine's movements that
holds an open row — the editor's and the routine's own screen — never once per row. The word `open`
in a row's target column says *which* rows; the sentence says what that word means, and a list needs
it said once. It is suppressed while a refusal stands, and while a target sheet stands over the list:
a blessing and a refusal of the same state are never on screen together.

**The sign control is `±`, everywhere**, and **its spoken name is *Flip the sign***. A standalone `−`
reads as *decrement* in this product — that is what it means in the stepper on the adjacent sheet —
and it cannot express "back to positive". The name is pinned because the glyph reads as nothing
aloud, and it is one control met on two screens: the planning sheet's weight field and the rack
keypad.

**A key that is not a character says what it does.** The rack pad is thirteen keys — a twelve-key
grid of the ten digits, `±` and the decimal separator, plus `⌫` in the action row. Eleven of them
speak themselves; the two glyphs do not, so each carries a name: **`±` → *Flip the sign*** and
**`⌫` → *Delete***. A screen reader left to read the glyphs says "plus minus sign" and "erase to the
left", or nothing at all.

**The picker's placeholder is `Search {n} movements`**, and `n` is the catalogue's real size. The seed
is 64. No board invents a larger number to look busy.

**An empty query shows the six and then the whole catalogue.** The six are a shortcut, not a
replacement for browsing, and a picker that shows only six has removed the ability to find the
seventh.

**The name cap stays at the shipped 60 characters.** A design wave does not change a shipped bound
because it found the store would tolerate more; that is a product decision with no reason attached
yet.

**And the counter beside it is `53/60`, appearing in the last fifth** — from 48 characters, silent
before that, and counting **characters** on every surface. The form and the threshold match the note
editor's counter exactly, because a lifter should not have to learn two rules for the same idea. It
is the shape a wave gets wrong by leaving it unpinned: a cap without its counter is three surfaces
inventing three answers.

**And the same rule governs the other end of the field: what counts as NO name is measured in one
unit per surface, and it is the routine editor's.** A cap is a count in a unit and a blank check is a
trim in a unit — the same trap one step down, and the cheaper one to get wrong, because every
surface's obvious fixture is `""` and `"   "` and those two agree under every unit there is. They do
not discriminate.
`"\n"` does: on iOS `CharacterSet.whitespaces` is Unicode `Zs` plus tab and **excludes**
U+000A–U+000D, so a predicate built on it calls a pasted newline a name where JS `trim`,
Kotlin `trim` and `.whitespacesAndNewlines` all call it blank. **Where the unit is a choice, the
editor states it once and everything else reads that** — `RoutineDraft.trimmed` /
`RoutineDraft.isNamed` on iOS, which the finish card's `Finish.keepRefusal` and its grey `Save
routine` both go through, and `Program.named` on Android; on the web the language leaves no choice to
make, since `String.prototype.trim` is the only trim there is. **And a fixture that cannot tell two
units apart has not pinned the unit**: the pin carries a newline, or it is green either way.

**Removing a row is as destructive as a swipe, and takes the same undo.** The web draws an `×` (a
pointer drag would otherwise be the only way to remove a line, and Law 1 forbids a gesture being the
only path) and **it has the undo**: the removed line opens a window of its own like every other
delete in the room, and taking it back puts the line **at its own index**, never appended
(`Routines.jsx:172-181`, `withEntryAt` in `routines.js:123-126`). Nothing is sent either way — a
draft line is not on the wire — so the window closing simply drops the way back, and a draft that
goes away closes its windows with it.

Both phones remove by a trailing swipe, complete on iOS through `.swipeActions` and completed by hand
on Android with a declared custom action, and **they are unchanged**: there the row leaves an unsaved
draft whose only other recovery is Cancel, which discards every other edit.
**The gate is the act, not the gesture.**

## What removing a control obliges you to do

The text budget already says *a move is not done until the destination is drawn*. This wave found the
companion rule the hard way, for the third time in this project:

> **When a wave removes a control, it inherits that control's refusals — and they are assigned to a
> named board on a named surface before drawing starts.**

All three agents noticed the keypad's four refusals had nowhere to go. All three said so in an
annotation. **None drew them**, because the brief had not made them anyone's job. A capability that
every reviewer flags and no board owns is still a capability that was deleted.

## Open

- **Whether the editor needs a Save at all.** The note editor saves as you leave it, and a routine is
  no more precious. Save exists here because the plan snapshot means a half-edited routine could be
  started mid-edit — but that is an argument for blocking the start, not for a button.
- **Whether the picker's section head should assert its ranking.** It reads `The six` on all three
  surfaces and says nothing about *how* they were chosen, which is deliberate: the surface ranks over
  the log it happens to hold, and a head that claimed *most trained* would be asserting something a
  page that has read fifty sessions cannot prove about an account. The alternative is a head that
  says what it counted.
