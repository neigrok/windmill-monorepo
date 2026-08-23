# Reach — where a phone screen puts its controls

**The rule, in one line: controls go to the bottom, guidance goes to the middle, identity goes
to the top.** A phone screen is not a page; it is a hand. Anything the user must *touch* belongs
in the band their thumb already covers, and anything they must *read* belongs where their eyes
already are.

This is a whole-system rule, not a gym rule. It applies to every phone surface in every product,
and to any narrow web surface that will be used on a phone. Live specimen:
`guidelines/thumb-reach.card.html`.

## 1. The three bands

Measured on a 402 × 874 logical frame (the design frame for all Windmill phone boards):

| Band | Where | Holds | Never holds |
|---|---|---|---|
| **Top** — identity | safe top → ~120px | the shell capsule, the screen title, one context/meta line, a back affordance | a primary button, a destructive button, a required input |
| **Middle** — the reading band | ~120px → ~600px | the content, and any explanatory copy, **vertically centred when the content is short** | the primary action, if the body does not fill it |
| **Bottom** — the reach band | last ~230px, above the tab rail | primary action, secondary action, the input being filled, keypads, steppers, ladders | long explanatory prose |

A dashed **thumb line** at 46% of frame height marks the top of the reach band on the layout
board (`templates/gym-app` §F, screen 15). Everything a user has to hit while standing, tired,
one-handed, sits below it.

## 2. What this forbids

- **A short screen that hugs the top.** If the content does not fill the middle band, the copy
  centres itself in that band and the buttons drop to the bottom — the screen is never a
  top-anchored stack with dead space beneath it. This is the single most-corrected defect in this
  project; it looks like a web page and behaves like a reach problem.
- **A primary button inside a card in the middle of a scroll.** A card may hold the *content* of
  a decision; the buttons that commit it live in the bottom band, pinned, so they do not move
  when the body scrolls.
- **Anything important in a top corner.** With a phone in one hand there is no top-right.
- **A destructive action above the fold of the reach band** — it belongs at the bottom too, but
  as the *secondary* slot, never as the widest target.

## 3. What it prescribes

1. **One primary action per screen**, full width, 54–58px tall, 14–16px from each edge, directly
   above the tab rail (or above the safe-bottom inset where there is no rail).
2. **The secondary action sits under or beside it**, visibly lighter: an outline at 48–50px, or a
   plain text row. Two full-strength buttons of the same weight is a failure to decide.
3. **Explanatory copy is centred** in the middle band when the screen is short, left-aligned when
   the body is a list or a document. Centre the *block*, not every line of a paragraph.
4. **Inputs travel with the keyboard**: a field the user is filling belongs in the reach band, so
   the keyboard does not cover the thing it is typing into.
5. **Numbers stay big and high; the controls that change them stay low.** The gym logger is the
   canonical case: a 104px numeral in the middle band, the ladder and the log button beneath it.
6. **Scroll bodies keep their bottom band pinned** (`flex: none` after a `flex: 1; overflow: auto`
   body), so the action is reachable at every scroll position — including the top.

## 4. How to check a screen in five seconds

- Cover the top 54% of the frame with your hand. Can you still finish the task?
- Is there empty space below the last button? If yes, the button is in the wrong band.
- Does the primary action move when you scroll? If yes, it is not pinned.
- Is any paragraph longer than two lines inside the reach band? Move it up.

## 5. Where this is already true

`templates/gym-app` §F states the contract and screen 15 draws it; screens 1, 3, 9–11 and 24 are
built to it, as are 12–13 on `templates/gym-programs`. `templates/superapp-shell` puts the hub's
doors low for the same reason and says so
in `guidelines/superapp-shell.md` §3 — "the reach order is the priority order". This file is the
general statement those two were each making locally.
