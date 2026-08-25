# The routine — building it, changing it, starting it

The Coach wave redrew the rooms a lifter reads. This one redraws the screen they *work* on, which is
the heaviest in the product: the routine editor runs 472 lines, draws 21 buttons and two inputs, and
stacks three overlay layers. Five of the ten cuts in `../../../PRODUCT_LOG.md`'s simplification list
live on it or beside it.

Everything here obeys three documents already written: `12-native-idiom.md`,
`../../guidelines/text-budget.md`, and `13-gestures.md`.

## The naming step dies

Creating a routine currently opens a **full-screen interstitial** asking what to call it, with
suggestion chips and a character counter, before the editor is ever seen. It exists only when the id
is `new`.

> **The name is the editor's first field.** Tapping *New routine* opens the editor with an empty name
> field already focused and the keyboard up.

A modal that exists to collect one string, before a screen that has a field for that string, is a
screen we invented. The suggestion chips go with it — a lifter naming their own training block does
not need three guesses from us, and `01-context.md` says this room is uninterested in helping you
feel clever.

**Save waits for a name, and that is the domain's rule rather than ours.** `Routine.cpp:40` refuses a
routine with an empty name outright — *"a routine needs a name"* — so the choice is between gating Save
and inventing a name on the lifter's behalf. We do not invent one: this product does not author text
and then attribute it to a person, which is the same rule that keeps a conversation's title the first
message verbatim.

So Save is disabled until the field has a character. That is a field with the keyboard already up, not
a screen — the interstitial existed because a name is required, and the requirement survives while the
screen does not.

## The target sheet becomes three fields

Today it offers **five affordances for a three-field object**: tap-to-type, *use last time*, a ± plate
ladder, *take it to max*, and *leave it open · decide at the rack*.

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

**And *leave it open · decide at the rack* turns out not to be a separate act at all.** The domain
already says so: `Routine.cpp:17` refuses an entry that names reps or a load without naming sets —
*"an open entry names no sets, so it names no reps and no weight either."* So an open line is exactly
a line whose sets are cleared, and clearing that field cascades the other two.

Five affordances become **three fields**, the escape is one of them, and the rule the domain has always
enforced is now visible in the interface instead of hidden behind a button that did it silently.

**The ± ladder comes off this sheet.** It belongs at the rack, where plate granularity is what you are
actually reasoning about, and it is drawn there already. In a planning sheet you know the number you
want; you do not step to it.

## Which kills the third overlay

The editor opens the target sheet, and the target sheet opened a **custom numeric keypad** — three
layers deep, and both files carry a comment saying the layering is fragile and is worked around by
placing the keypad as a DOM sibling rather than fixing it.

With typed fields, the third layer is **the platform's own decimal keyboard**. Two layers, no
workaround, and the comment can be deleted rather than inherited.

## The editor after the cuts

- **Nav bar** carries *Cancel* and *Save*. Nothing else is a header button.
- **The name** is the first field.
- **The movements** are a list: drag to reorder, swipe to remove, tap to set targets.
- **Add movement** is the last row of that list, not a floating button.
- **Delete routine** and **Duplicate** move to the overflow. Duplicate already has a home on the
  row's own menu in `13-gestures.md`; the editor's foot button was the second of two.
- **History** is a section, not an inline aside.

That is roughly twenty-one buttons down to *Cancel*, *Save*, *Add movement* and an overflow.

## The movement picker

`.searchable` on iOS, the platform search field on Android — replacing a hand-built text field styled
as a rounded rectangle. The six most-used movements keep their section; that is a genuine shortcut and
not chrome.

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

## Open

- **Whether the editor needs a Save at all.** The note editor saves as you leave it, and a routine is
  no more precious. Save exists here because the plan snapshot means a half-edited routine could be
  started mid-edit — but that is an argument for blocking the start, not for a button.
- **Whether clearing sets should warn before it cascades.** It silently empties reps and weight,
  because the domain refuses any other shape. That is correct and it is invisible — a lifter who
  clears sets to retype it loses two numbers they did not mean to lose. The undo rules in
  `13-gestures.md` may apply, or the field may simply refuse to clear while the other two hold values.
