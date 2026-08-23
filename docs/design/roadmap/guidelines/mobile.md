# Windmill Mobile (X8) — two view models, and the input layer under them

Canon for the phone. It has two halves that must be read in order:

1. **The view models** — *the tree is the portrait; the list is the workbench.*
   Ruled and demonstrated in `explorations/mobile-list-view.html` (L0–L7);
   promoted here.
2. **The input layer** — gestures, keyboard, undo, reach, precision — specced
   *after* the view models, because which surface is primary decides what the
   input layer is even for. Live specimens:
   `explorations/mobile-foundations.html`.

Placement of canvas chrome stays X5 (`responsive.md`); beat physics stay X1
(`motion-language.md`).

## 1. Data priority — what a phone is actually for

Every ruling below falls out of this ladder. It is ordered by **how often the job
happens on a phone**, not by how much product surface it has today.

| | Job | Where it lives | Cost target |
|---|---|---|---|
| **P0** | **Explore** — what's next, why is this locked, where am I, find *that* step | **the list** | zero taps (it's the landing view) |
| **P1** | **Check off** | the list row | one tap |
| **P2** | **Capture intent** — "add a testing branch under backend" | the Tend bar (#16) | one sentence |
| **P3** | **Structural edit** — add · connect · recolor · delete | row card, below content | available, never featured |
| **P4** | **Arrange** — angular reorder (§07) | canvas, and desktop first | not on the phone yet |

**P3 is demoted on purpose.** Recolor and add-step were the loudest things in the
phone editor, and they are the two a user is least likely to want from a train
platform — the agent does them from one sentence (P2), and a desk does them
faster. They stay reachable and unhurried; they stop setting the layout.

**P0 is the promotion.** Reading a DAG was the job the phone was worst at and the
one it is asked to do most. It gets the default view, the header, the search, and
the primitives in §4.

## 2. The two views

- **List = the workbench, and the owner's default.** Outline shape: sections are
  branches, indent is depth, **Next up** pinned at the top, rows expand in place.
  Full spec: `mobile-list-view.html` L2–L4.
- **Tree = the portrait.** Shape at a glance, share identity, ceremony. A
  visitor's first view; one tap away for an owner. What it stops being asked to
  do: dense reading, hunting a step by name, bulk cleanup, typing.
- **One switch, one model.** Bark pill bottom-left, 240ms cross-fade, camera and
  scroll both preserved, **selection carries across** (the expanded row *is* the
  selected node). Last view wins per tree per device; deep links land on the list.
- **Tablet ≥744 defaults to the canvas** (the standing panel absorbs the
  workbench job); ≥1024 is unchanged.

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

- **Nothing means two things.** Tap = open. Long-press = select many. Swipe-right
  = done. A gesture absent from a view is absent, never repurposed.
- **Every hidden gesture has a visible twin:** multi-select also opens from a
  **"Select steps"** row; done is also a button in the row card. Phones have no
  `?` overlay, so a gesture-only capability is an unshipped capability.
- **Platform contract:** `-webkit-touch-callout: none` + `touch-action: none` on
  the canvas, or iOS eats the long-press with a selection callout. **The same
  contract binds every full-width button in the list** — a Next-up row looks like a
  list row, in a list that trains long-press = select many, so without it iOS
  raises the selection loupe over the label.

## 4. Explore primitives (P0) — a lens, a lookup, and the answer a locked row owes

*Reconciled 2026-07-25 against the shipped build. The three primitives were
originally written as one family — "all read-only, they close by tapping away."
Building them proved two of that sentence's three claims wrong, and the corrections
are the substance of this section.*

**They are not one job. They are a lens and a lookup.**

- **The lens — filter by kind.** *Persistent. It orients you. It composes with
  everything else on screen.* It is the F6 legend, and it lives as **the first
  element of the scroll body** — content, not chrome, so it scrolls away and costs
  nothing above the fold (§5), while still being there at zero taps on landing,
  which is what P0 asks for. It earns its row twice over: every row carries a kind
  dot, and without a visible key those dots are decoration. Tap a kind, the outline
  keeps that kind's steps; the rest **fold to a count, never vanish**
  (`+7 more in this branch`, tappable to reveal that branch in full).
- **The lookup — find a step by name.** *Transient. It replaces the screen. It ends
  on a result.* The header's quiet icon expands to a field, matching titles **and**
  descriptions, filtering the outline in place. Sections keep their headers so you
  never lose depth; a head that didn't match itself renders as scaffolding, dimmed
  **by weight, never by the meta token** (`--text-tertiary` on cream is 3.5:1, and
  scaffold heads are the most numerous head on a filtered screen).
- **They compose (AND), and only one is a door.** Closing the lookup clears the
  query and never the lens.
- **A description-only match must show its fragment.** Otherwise the row is a title
  that does not contain what the user typed, and it reads as a bug.
- **The lens filters the shelf; the lookup hides it.** *"Next up in Backend"* is one
  of the most natural questions on the ladder, so under a lens **Next up** takes the
  same predicate and relabels. *"Next up matching 'auth'"* is incoherent, so under a
  lookup it goes. This is the first thing the lens/lookup distinction buys, and it
  was invisible while the two were treated as one surface.
- **The lens does not suppress P3.** The dashed **Add step to X** stays under a
  lens (a lens is a way of working) and goes under a lookup (a filtered reading
  view). "Add a step to Backend" is the natural next thought after narrowing to
  Backend.

**Trace to root — the gate, and why one chain is usually the wrong shape.**

*"Why is this locked"* is **two questions wearing one coat**: *what do I do first*
(a set) and *how far away is this* (a number). A single breadcrumb answers the
second in the shape of the first, and points at the one step in the chain the user
**cannot start** — the far end is the most blocked thing there. So a locked row's
card reads:

```
WHY IS THIS LOCKED?
Blocked by 6 steps — 2 you can start now.
[● Compile, link, run by hand]  [● Kernel-bypass networking]
Longest chain: 4 steps deep.
```

- **The frontier** is the part of the owed set with nothing owed above it — the
  only steps that can be started today. Those are the chips.
- **Keep the breadcrumb only when the gate genuinely is a line** — every hop owing
  exactly one step. Then it is the clearer form and the data has earned it. Forcing
  a chain onto a branching gate is a lie with good typography. *Let the data pick
  the form.*
- A walk that merely runs out of blockers **is not proof of a line** — a two-node
  cycle satisfies that too. The proof is that it also covered the whole owed set.
- Cap the chain at six hops, keeping the **near** hops (the end you can act on) and
  eliding the far ones.
- Needs and Unlocks chips stay at the card's foot for one-hop moves; the gate is the
  whole answer.

**Read-only is true of the data and false of the position.**

This is the correction that matters most, because the original "they never mutate,
so they carry no undo and no confirmation" quietly implied there was nothing to get
wrong. Every one of these primitives *moves the user*, and movement needs rules:

- **A jump to a row the current view is not rendering clears whatever is filtering
  it.** Test the fact — *is this row on screen* — never a proxy for it. Kind-equality
  looks like the same question and is not: every branch head's **Needs** chip names
  the root, which no filter can ever render, so under the proxy that tap did nothing
  at all, silently.
- **One named step of "back."** After any jump, a chip in the top transient lane
  reads `← Back to <where you came from>`; it names its destination, so one level is
  honest rather than a truncated stack. It **stands until it is used** or superseded
  — a timed dismissal races the undo toast and fails WCAG 2.2.1 for no benefit. The
  undo lane stays undo's (§10).
- **The filters let go when the list does.** Carrying an invisible filter into the
  canvas is the worst of the available options; the lens is one tap away on return.
- **Multi-select clears them both.** A bulk bar reading *"Delete 3 steps"* over two
  rows the lens has hidden is not a thing to ship. Entering the mode drops the
  filters and takes the lens row and the search affordance off the screen.
- **A lens must let go of a kind that stops existing** — recolour or delete the last
  step wearing it and the lens is filtering to nothing under an empty label.
- The primitives still carry **no undo and no confirmation**: nothing here mutates.

## 5. Reach — a scrolling list changes the lanes
```
STICKY HEAD  ≤64px  tree name ▾ · readout · search icon — thin, because it never scrolls away
SCROLL BODY         the kind lens, then the outline; the only scroller on the page
ACTION LANE  bottom ≥300px  view pill (left) · Fork or Tend bar (centre) · Share (right) · undo above them
```
- **The top of a scrolling list is unreachable by definition** — so nothing lives
  there except identity and one search affordance. Every verb is in the action lane.
- **The head keeps its identity while searching.** The field grows *beside* the kind
  dot and an ellipsed name, taking the width the readout gives up. §5's whole
  argument for the head existing is that identity never scrolls away; a head that
  becomes a bare text field has stopped being the head.
- On the canvas the lanes are X5's: read-only chrome ≤180px top, verbs bottom.

## 6. Check-off (P1)
- **List: tap the fruit** (24px visual, 44px hit) — the fruit *is* the control, and
  it is the same object that shows state. **Swipe the row right** is the
  accelerator; the row card keeps the **Mark done** button as the visible twin.
- **Canvas: the peek's state chip is the toggle** — the same one-tap promise in
  the view that has no rows.
- Ripple in place: newly-ready children flip to rings where they sit (280ms) and
  the snackbar names them — "Docking done · unlocked Night docking."
- **The root never toggles.** The crown is earned.
- **Tier belongs to the fruit — so the fruit must actually carry it.** The lock
  glyph moves inside the dim fruit and the row's title returns to
  `--text-secondary`; a title is never dimmed to `--text-tertiary` (3.5:1) to say
  "locked". *Open:* the dim fruit itself measures 1.14–1.29:1 against the canvas, so
  locked and available currently differ by an 11px smudge in daylight — see
  `briefs.md` #21.
- Closes `whats-next.md` §6's open question.

## 7. The keyboard contract
Applies to every text surface: row rename/describe, the paste well (F3), the Tend
bar (#16), the search field (§4). Supersedes F3's "keyboard-up pass at build".

- **The list pads itself by the keyboard's height and pins the active row just
  above it** — if the keyboard would cover a field, the *list* scrolls; the field
  never hides and the page never jumps. On the canvas the sheet anchors to
  `visualViewport` and the camera re-fits the node (X5 §5).
- **Born visible:** a new step appears bud-dashed *in place*, indented under its
  parent, before you name it. `↵` plants, `esc`/empty removes.
- **A Done bar above the keyboard, always.** In the list's search field, that is the
  keyboard's own Search key: it dismisses the keyboard and **keeps the query**.
  Closing the field is a different act and belongs to the ✕.
- **Never two text inputs on one phone screen.** With the keyboard up, a header
  field and the Tend bar bracket a ~200px sliver of results and both read as "type
  here" — one filters, one writes. Typing in the header is a lookup (read); the Tend
  bar is intent (write); they must not be up at once. *This binds #16 at arming
  time.* Whether they should instead be **one input** — typing filters live, send
  hands it to the agent — is open: `briefs.md` #23.
- **No text field under 16px**, or iOS zooms the whole page on focus and the user
  has to pinch back. This is a constraint on the type ramp, not on the field —
  `briefs.md` #22.
- **Send dismisses the keyboard first** (tending), then the acts land as row
  changes — the theatre can't play behind a keyboard. Dictation rides the system
  mic and inherits all of this.

## 8. Undo — two tiers, one history
- **Tier 1, the snackbar:** 4s (6s destructive), one at a time, **offset from the
  last touch point** and **inert for 250ms** so the finish of a tap can't undo the
  tap.
- **Tier 2, Activity is the history:** every row carries **"Undo this"** for as
  long as the session holds it. On a phone Activity has no toolbar to be summoned
  from, so it shares the return-visit sheet with **Next up** (segmented
  *Next · Activity*).
- Destructive edits state their cost before the tap. Agent edits are ordinary
  edits: one sentence, one history step, one undo (`tending.md` §4).
- **Never:** a confirm dialog for an undoable act · a toast that blocks the canvas
  · an undo that expires mid-gesture.

## 9. Precision on the canvas — and the honest escape hatch
```
hit disc = max(44px, visual), capped at ½ the nearest-neighbour distance
below that cap  ⇒  a tap zooms 1.6× at the point instead of selecting
```
Two fruit can never overlap their targets. But the real answer to "I can't hit the
right node" is **switch to the list** — precision is a property of rows, not of a
zoom level. The canvas is a picture you may tap; the list is the surface you work.

**In the list, the same arithmetic binds every wrapped chip row.** A 44px hit box
extended past its border box overlaps its neighbour when the row gap is smaller than
the overhang, and the later element in the DOM wins — so a tap in the sliver jumps
to the wrong ancestor. Row gaps must exceed the overhang, not merely look airy.

## 10. Share surfaces on a phone

- **Share is a verb, so it lives in the action lane** — a ≥44px button in the
  lane's **right** slot, the owner's twin of the visitor's Fork pill. Centre stays
  Fork / the Tend bar, so nothing moves when tending lands, and the sticky head
  stays identity-only (§11: *never a verb above the fold*). It opens the same share
  sheet desktop opens, and it is **the standing door the week-card offer needs** —
  without it, retirement strands the owner (`og-progress-card.md`).
- **Fork is a persistent button below 1024** — there is no hover to reveal it.
- **The week card (#20) posts through `navigator.share`** with the PNG attached;
  Download / Copy is the desktop form of the same sheet.
- **Offer and announcement toasts sit in the top transient lane**, under the
  plaque; **undo keeps the undo lane.** The line: *a transient you can lose (undo,
  4s) sits in the thumb's lane; an invitation you can accept later sits at the top,
  off the verb rail.* Neither stacks with a milestone toast (the milestone wins).
  §4's back chip is a tenant of the top lane, and reserves its own height rather
  than floating over live rows.
- **The public shelf (#18) is held** — there is no gallery page for it to sit at
  the end of (`gallery.md` §2), and `/browse` keeps X5 §8's grid on a phone. If it
  ever ships it is one horizontal snap row, next card peeking — the only horizontal
  scroll in the product, earned because it is a shelf, not a list. (The kind lens in
  §4 is the second, and is likewise earned: it is a legend, not a list.)

## 11. Constants
```
PRIORITY  P0 explore (list, default) · P1 check off · P2 tell the agent · P3 structural edits, demoted · P4 arrange = desktop
VIEWS     list = workbench (owner default) · tree = portrait (visitor default) · pill bottom-left · 240ms · selection carries
GESTURES  tap = open · fruit = done · swipe-right = done · long-press = select many (your tree) · pinch/double-tap = canvas only
EXPLORE   the LENS (kind, persistent, first in the scroll body, filters Next up) · the LOOKUP (search, transient, in the head, hides Next up) · the GATE (frontier + depth; a breadcrumb only when the gate is a line)
MOVEMENT  a jump to an unrendered row clears the filters · one named "back", standing not timed · filters let go with the view · multi-select clears them
REACH     sticky head ≤64, identity survives search · one scroller · action lane bottom ≥300 · undo above it, off the finger
KEYBOARD  list pads by keyboard, active row pinned · new step born visible · Done bar above keys · send dismisses first · never two text inputs · nothing under 16px
UNDO      snackbar 4s/6s, inert 250ms · Activity rows carry "Undo this" · agent edits are ordinary edits
SHARE     verb in the action lane, right slot ≥44px (owner) · sheet → navigator.share · offer toast = top lane · undo lane stays undo's
CANVAS    disc = max(44, visual) capped at ½ nearest gap · under it, tap zooms · the list is the real escape hatch
NEVER     a swipe that destroys · a gesture with two meanings · a verb above the fold · a chat pane · precision the finger can't give · a tier the fruit can't carry
```

## 12. Ownership map
| Concern | Owner |
|---|---|
| Beat physics, easings, ceilings | `motion-language.md` (X1) |
| Canvas chrome placement, breakpoints, read-only rules | `responsive.md` (X5) |
| The list: shape, row anatomy, in-place editing, switcher, tending strip | `explorations/mobile-list-view.html` (L1–L6) |
| The canvas editor's touch verbs | `responsive.md` §13 · `explorations/mobile-editing.html` |
| Priority ladder, gestures, explore primitives, keyboard, undo, precision | **this doc** |
