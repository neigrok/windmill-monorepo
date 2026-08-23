# Mobile — two view models, and the input layer under them

Canon for the phone. *The tree is the portrait; the list is the workbench.* Canvas chrome
placement stays `responsive.md`; beat physics stay `motion-language.md`.

## 1. Data priority
Ordered by how often the job happens on a phone.

| | Job | Where it lives | Cost target |
|---|---|---|---|
| **P0** | **Explore** — what's next, why is this locked, where am I, find *that* step | the list | zero taps (it's the landing view) |
| **P1** | **Check off** | the list row | one tap |
| **P2** | **Capture intent** — "add a testing branch under backend" | the Tend bar | one sentence |
| **P3** | **Structural edit** — add · connect · recolor · delete | row card, below content | available, never featured |
| **P4** | **Arrange** — angular reorder | canvas, desktop only | not on the phone |

**P3 is demoted on purpose.** The agent does those edits from one sentence (P2) and a desk
does them faster; they stay reachable but never set the layout. **P0 gets the default view,
the header, the search, and the primitives in §4.**

## 2. The two views
- **List = the workbench, and the owner's default.** Outline shape: sections are branches,
  indent is depth, **Next up** pinned at the top, rows expand in place.
- **Tree = the portrait.** Shape at a glance, share identity, ceremony. A visitor's first
  view; one tap away for an owner. Not asked to do dense reading, name-hunting, bulk cleanup
  or typing.
- **One switch, one model.** Bark pill bottom-left, 240ms cross-fade, camera and scroll both
  preserved, **selection carries across** (the expanded row *is* the selected node). Last
  view wins per tree per device; deep links land on the list.
- **Tablet ≥744 defaults to the canvas** (the standing panel absorbs the workbench job);
  ≥1024 is unchanged.

## 3. Gestures — one meaning per gesture, in both views

| Gesture | List | Canvas |
|---|---|---|
| scroll / drag | scroll the list | pan 1:1 (also during aim mode) |
| tap row / node | **expand in place** | select → sheet |
| tap the fruit | **mark done / undone** | — (the sheet's state chip does it) |
| swipe row right | mark done — accelerator | — |
| swipe down | — | dismiss the sheet |
| long-press | enter multi-select | enter multi-select (**your tree only**; on a stranger's tree: nothing, OS callout suppressed) |
| pinch · double-tap | — | zoom 0.5–2.5× · 1×↔1.6× at the point |

- **Nothing means two things.** A gesture absent from a view is absent, never repurposed.
- **Every hidden gesture has a visible twin:** multi-select also opens from a **"Select
  steps"** row; done is also a button in the row card. Phones have no `?` overlay, so a
  gesture-only capability is an unshipped capability.
- **Platform contract:** `-webkit-touch-callout: none` + `touch-action: none` on the canvas,
  or iOS eats the long-press with a selection callout. **The same contract binds every
  full-width button in the list** — a Next-up row looks like a list row in a list that trains
  long-press = select many, so without it iOS raises the selection loupe over the label.

## 4. Explore primitives (P0)
They are not one job. They are a lens and a lookup.

- **The lens — filter by kind.** Persistent; it composes with everything else on screen. It
  is the kind legend, and it lives as **the first element of the scroll body** — content, not
  chrome, so it scrolls away and costs nothing above the fold (§5) while still being there at
  zero taps on landing. Tap a kind and the outline keeps that kind's steps; the rest **fold to
  a count, never vanish** (`+7 more in this branch`, tappable to reveal that branch in full).
- **The lookup — find a step by name.** Transient; it replaces the screen and ends on a
  result. The header's quiet icon expands to a field, matching titles **and** descriptions,
  filtering the outline in place. Sections keep their headers so depth is never lost; a head
  that didn't match itself renders as scaffolding, dimmed **by weight, never by the meta
  token** (`--text-tertiary` on cream is 3.5:1).
- **They compose (AND), and only one is a door.** Closing the lookup clears the query and
  never the lens.
- **A description-only match must show its fragment**, or the row is a title that does not
  contain what the user typed and reads as a bug.
- **The lens filters the shelf; the lookup hides it.** Under a lens, **Next up** takes the
  same predicate and relabels ("Next up in Backend"); under a lookup it goes.
- **The lens does not suppress P3.** The dashed **Add step to X** stays under a lens (a lens
  is a way of working) and goes under a lookup (a filtered reading view).

### Trace to root — the gate
*"Why is this locked"* is two questions: *what do I do first* (a set) and *how far away is
this* (a number). A locked row's card reads:

```
WHY IS THIS LOCKED?
Blocked by 6 steps — 2 you can start now.
[● Compile, link, run by hand]  [● Kernel-bypass networking]
Longest chain: 4 steps deep.
```

- **The frontier** is the part of the owed set with nothing owed above it — the only steps
  that can be started today. Those are the chips.
- **Keep the breadcrumb only when the gate genuinely is a line**, every hop owing exactly one
  step. A walk that merely runs out of blockers is not proof of a line — a two-node cycle
  satisfies that too; the proof is that it also covered the whole owed set.
- Cap the chain at six hops, keeping the **near** hops and eliding the far ones.
- Needs and Unlocks chips stay at the card's foot for one-hop moves; the gate is the whole
  answer.

### Movement
The primitives never mutate, so they carry no undo and no confirmation — but each one *moves
the user*, and movement needs rules.

- **A jump to a row the current view is not rendering clears whatever is filtering it.** Test
  the fact — *is this row on screen* — never a proxy for it. Kind-equality is not the same
  question: every branch head's **Needs** chip names the root, which no filter can render, so
  under that proxy the tap silently does nothing.
- **One named step of "back."** After any jump, a chip in the top transient lane reads
  `← Back to <where you came from>`; it names its destination, so one level is honest rather
  than a truncated stack. It **stands until it is used** or superseded — a timed dismissal
  races the undo toast and fails WCAG 2.2.1. The undo lane stays undo's (§8).
- **The filters let go when the list does.** Nothing carries an invisible filter into the
  canvas; the lens is one tap away on return.
- **Multi-select clears them both.** Entering the mode drops the filters and takes the lens
  row and the search affordance off the screen.
- **A lens must let go of a kind that stops existing** — recolour or delete the last step
  wearing it and the lens filters to nothing under an empty label.

## 5. Reach
```
STICKY HEAD  ≤64px  tree name ▾ · readout · search icon — thin, because it never scrolls away
SCROLL BODY         the kind lens, then the outline; the only scroller on the page
ACTION LANE  bottom ≥300px  view pill (left) · Fork or Tend bar (centre) · Share (right) · undo above them
```
- **The top of a scrolling list is unreachable by definition** — nothing lives there except
  identity and one search affordance. Every verb is in the action lane.
- **The head keeps its identity while searching.** The field grows *beside* the kind dot and
  an ellipsed name, taking the width the readout gives up. A head that becomes a bare text
  field has stopped being the head.
- On the canvas the lanes are `responsive.md`'s: read-only chrome ≤180px top, verbs bottom.

## 6. Check-off (P1)
- **List: tap the fruit** (24px visual, 44px hit) — the fruit *is* the control, and it is the
  same object that shows state. **Swipe the row right** is the accelerator; the row card keeps
  the **Mark done** button as the visible twin.
- **Canvas: the peek's state chip is the toggle** — the same one-tap promise in the view that
  has no rows.
- Ripple in place: newly-ready children flip to rings where they sit (280ms) and the snackbar
  names them — "Docking done · unlocked Night docking."
- **The root never toggles.** The crown is earned.
- **Tier belongs to the fruit, so the fruit must carry it.** The lock glyph sits inside the
  dim fruit and the row's title stays `--text-secondary`; a title is never dimmed to
  `--text-tertiary` (3.5:1) to say "locked". Open: the dim fruit measures 1.14–1.29:1 against
  the canvas (`../briefs.md` #21).

## 7. The keyboard contract
Applies to every text surface: row rename/describe, the paste well, the Tend bar, the search
field (§4).

- **The list pads itself by the keyboard's height and pins the active row just above it** —
  if the keyboard would cover a field the *list* scrolls; the field never hides and the page
  never jumps. On the canvas the sheet anchors to `visualViewport` and the camera re-fits the
  node.
- **Born visible:** a new step appears bud-dashed *in place*, indented under its parent,
  before you name it. `↵` plants, `esc`/empty removes.
- **A Done bar above the keyboard, always.** In the list's search field that is the keyboard's
  own Search key: it dismisses the keyboard and **keeps the query**. Closing the field is a
  different act and belongs to the ✕.
- **Never two text inputs on one phone screen.** Typing in the header is a lookup (read); the
  Tend bar is intent (write); they must not be up at once. Whether they should instead be one
  input is open (`../briefs.md` #23).
- **No text field under 16px**, or iOS zooms the whole page on focus. This is a constraint on
  the type ramp, not on the field.
- **Send dismisses the keyboard first**, then the acts land as row changes — the theatre can't
  play behind a keyboard. Dictation rides the system mic and inherits all of this.

## 8. Undo — two tiers, one history
- **Tier 1, the snackbar:** 4s (6s destructive), one at a time, **offset from the last touch
  point** and **inert for 250ms**, so the finish of a tap can't undo the tap.
- **Tier 2, Activity is the history:** every row carries **"Undo this"** for as long as the
  session holds it. On a phone Activity shares the return-visit sheet with **Next up**
  (segmented *Next · Activity*).
- Destructive edits state their cost before the tap. Agent edits are ordinary edits: one
  sentence, one history step, one undo (`tending.md` §4).
- **Never:** a confirm dialog for an undoable act · a toast that blocks the canvas · an undo
  that expires mid-gesture.

## 9. Precision on the canvas
```
hit disc = max(44px, visual), capped at ½ the nearest-neighbour distance
below that cap  ⇒  a tap zooms 1.6× at the point instead of selecting
```
Two fruit can never overlap their targets. The real answer to "I can't hit the right node" is
**switch to the list**: precision is a property of rows, not of a zoom level.

**In the list, the same arithmetic binds every wrapped chip row.** A 44px hit box extended
past its border box overlaps its neighbour when the row gap is smaller than the overhang, and
the later element in the DOM wins — so a tap in the sliver jumps to the wrong ancestor. Row
gaps must exceed the overhang, not merely look airy.

## 10. Share surfaces
- **Share is a verb, so it lives in the action lane** — a ≥44px button in the lane's **right**
  slot, the owner's twin of the visitor's Fork pill. Centre stays Fork / the Tend bar; the
  sticky head stays identity-only. It opens the same share sheet desktop opens, and it is the
  standing door the week-card offer needs (`og-progress-card.md`).
- **Fork is a persistent button below 1024** — there is no hover to reveal it.
- **The week card posts through `navigator.share`** with the PNG attached; Download / Copy is
  the desktop form of the same sheet.
- **Offer and announcement toasts sit in the top transient lane**, under the plaque; **undo
  keeps the undo lane.** A transient you can lose (undo, 4s) sits in the thumb's lane; an
  invitation you can accept later sits at the top, off the verb rail. Neither stacks with a
  milestone toast (the milestone wins). §4's back chip is a tenant of the top lane and
  reserves its own height.
- **There is no public shelf** — no page for it to sit at the end of (`gallery.md` §2).
  `/browse` keeps its grid on a phone.

## 11. Never
A swipe that destroys · a gesture with two meanings · a verb above the fold · a chat pane ·
precision the finger can't give · a tier the fruit can't carry.

## 12. Ownership map

| Concern | Owner |
|---|---|
| Beat physics, easings, ceilings | `motion-language.md` |
| Canvas chrome placement, breakpoints, read-only rules | `responsive.md` |
| The canvas editor's touch verbs | `responsive.md` §13 |
| Priority ladder, gestures, explore primitives, keyboard, undo, precision | **this doc** |
