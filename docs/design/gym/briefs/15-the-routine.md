# The routine — building it, changing it, starting it

The Coach wave redrew the rooms a lifter reads. This one redraws the screen they *work* on, which is
the heaviest in the product: the routine editor runs 472 lines, draws 21 buttons and two inputs, and
stacks three overlay layers. Five of the ten cuts in `../../../PRODUCT_LOG.md`'s simplification list
live on it or beside it.

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

- **Nav bar** carries *Cancel*, *Save* and the overflow. Nothing else is a header button.
- **The name** is the first field.
- **The movements** are a list: drag to reorder, swipe to remove, tap to set targets.
- **Add movement** is the last row of that list, not a floating button.
- **Duplicate** lives in the overflow, and it also has a home on the row's own menu in
  `13-gestures.md` — one of the two, never both. **Delete routine** stays a row of its own until the
  withheld delete exists (`13-gestures.md`'s gate), and then it joins the overflow.
- **History** is a section, not an inline aside.

That is roughly twenty-one buttons down to *Cancel*, *Save*, *Add movement* and an overflow.

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

## The connect pitch loses two of its four homes

It currently appears on the routines list, on the proposal screen, as a settings row, and as a whole
page. The first two are interruptions in the middle of doing something else. **The settings row and
the page stay.**

## Starting a workout

`Start workout` lives on the routine's own screen, and `13-gestures.md` puts it on the row's
long-press menu as well — the only place it exists twice on purpose, because it is the verb this whole
screen is for.

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
concatenated: *Name it to save it.* then *A routine is at least one movement.*

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

**Removing a row is as destructive as a swipe, and takes the same undo — and no surface gives it one
yet.** The web draws an `×` (a pointer drag would otherwise be the only way to remove a line, and Law
1 forbids a gesture being the only path); both phones remove by a trailing swipe, complete on iOS
through `.swipeActions` and completed by hand on Android with a declared custom action. All three
drop the line from an unsaved draft whose only other recovery is Cancel, which discards every other
edit. All three owe it the transient undo, which lands with the rest of `13-gestures.md`.
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
