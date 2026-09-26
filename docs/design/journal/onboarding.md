# Journal — the first run (P9)

The onboarding canon for Journal. Parent canon: `journal.md` (rules, vocabulary, motion);
shell flow: `../guidelines/superapp-flow.md` §8.

---

## 1. The principle

> **Journal opens on a live cursor, with hand-drawn ink notes over the real canvas, once.**
> Everything else appears later, on a trigger, once the user's own writing has made it relevant.

The ink notes (§2) show once per install, only on a first open with no pages. They never block
writing: the first keystroke or tap lifts them, and the room menu brings them back. They point only
at what is on that screen and works. The drawings are section *2b · Journal onboarding · Ink notes*
of the Figma page [iOS · First run](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=112-2).

The product cannot demonstrate its value in a first session — an echo needs months, the week
needs a week, the nudge needs a rhythm. The first run's only job is: **get one page written,
and be worth reopening.**

## 2. Session one — the whole screen

The canvas opens at today, cursor placed, keyboard **not** raised. Beside the ink notes, exactly
two pieces of copy exist, and both retire permanently after the first save:

| Element | Copy | Retires |
|---|---|---|
| Placeholder | "Start anywhere. Nothing here is graded." | first keystroke |
| The one fact | "Only you. No prompts, no fields, nothing to fill in — write a line or a page." | first save |

- **Nothing animates before you can type** (`journal.md` §3.7). The cursor is live on the first
  frame; there is no entrance or fade-in of chrome, and the ink draws on over a canvas that
  already takes input.
- **The keyboard is not raised for the user.**
- **Mood and energy are visible and unasked** — the strip is there, dimmed, asking nothing.
- **"saved" is stated in mono**, never a button, never a spinner.
- No account, no permission.

### The ink notes

Hand-drawn notes in lamp ink over the first-open canvas, written in **Caveat**
(`brand-foundations.md`).

**When.** Once per install, on a Journal first open with no pages. A person whose account already
holds pages never sees them. The shown-once flag survives sign-in.

**What.** Five callouts, 15 words, listed in priority order:

| # | Note | Arrow tip |
|---|---|---|
| 1 | "Just start typing" | the caret line, leading edge |
| 2 | "Today's page", with the line "Saves as you go." | the date marker, trailing edge |
| 3 | an underline, no words | the words "Only you" in the one fact |
| 4 | "Switch rooms here" | the room menu |
| 5 | "You, and settings" | the account button |

No note points at the mood and energy strip.

**Draw-on.** Strokes run top to bottom: the room menu at 200 ms, the account button at 350 ms, the
date marker at 500 ms, the caret line at 650 ms and the underline at 800 ms. Each reveals along its
path in 320 ms, ease-out. A label fades in over 160 ms as its arrowhead lands. The notes are still
by 1.2 s; the caret stays the only moving thing.

**Lift.** The first keystroke or a tap anywhere on the page lifts the ink: opacity 1 → 0 and blur
0 → 3 pt over 360 ms, labels first. The keystroke is kept. The notes never return on their own, and
no haptic marks them.

**Show them again.** Journal's room menu carries **Show ink notes** between the rooms and You
(`../guidelines/superapp-shell.md` §3). It redraws the notes over today's canvas; the first
keystroke or tap lifts them again.

**Anchoring.** Every arrow tip sits on a named element's live frame: the room menu, the account
button, the date marker, the caret line and the one fact. Labels take the free space above the
page, and each curve is fitted per layout from the label's edge to its anchor, never in fixed
pixels. The layer takes no hits; taps and keys reach the canvas.

**Small screens.** When labels collide or leave the free space, labels move and curves refit first.
Then the line "Saves as you go." drops, then callout 5, then callout 4. Callouts 1–3 never drop. At
375 × 667 all five fit.

**Largest text.** Labels scale with Dynamic Type, relative to body, up to 40 pt, and wrap to two
lines. At the accessibility sizes the drop order usually leaves callouts 1–3. If callout 1 cannot
fit, the notes are not shown: the placeholder and the one fact already say it.

**Localisation.** A label may run about 35% longer. It wraps to two lines within 60% of the screen
width before anything drops.

**Reduce Motion.** Strokes appear with no draw-on and fade in over 200 ms; the lift is a 360 ms fade
with no blur.

**VoiceOver.** The layer is hidden from VoiceOver: every element it points at carries its own label.

## 3. The schedule — what appears when

Each item fires **once**, on its own trigger, and is dismissible with "Not now" which retires
it for good. Nothing counts declines.

| What | Trigger |
|---|---|
| **Mood & energy** invitation | first page saved |
| **Talk** | first short page written late |
| **The nudge** | 7+ days with a detectable hour; the offer shows the histogram and its confidence (`journal.md` §7) |
| **The week** | first Sunday with 3+ pages behind it |
| **Search** | never announced — it lives in the chrome from day one and explains itself when used |

**Never during the first run:** Echoes (needs a corpus), sign-in (the shell's Keep offer comes
only after the first kept page — `../guidelines/superapp-flow.md` §6), the notification
permission (asked *after* "yes", never before), and anything about the other rooms (the room
menu lists them; the ink notes name the menu, not a room).

**Never at all:** streaks, scores, percentages, "you missed 3 days", a congratulation for
showing up, a first-page celebration, a prompt library, a required mood check-in — and any
word from the tree (unlock, plant, quest, level). Journal drops the game metaphor entirely
(`journal.md` §9).

## 4. Coming back — the canvas teaches itself

Day two is where the model lands, and it must land **without copy**: yesterday sits above,
today is at the bottom, scrolling up is going back.

- **A skipped day is not drawn at all** — the day markers' dates carry the jump, and nothing
  is coloured as failure because nothing is there to colour. There is no streak to break.
- **Opening restores to the bottom, not animated** (`journal.md` §4).
- The first time the user scrolls into the past, the month pill confirms where they are. That
  is the only orientation aid, and it is not taught.

## 5. Talk — the one offer with a promise attached

The talk offer sheet must state the discard in the product's own words: audio becomes plain
editable text and **is discarded once transcription succeeds** (`journal.md` §3.2). The
feature does not rely on a settings page to be honest.

## 6. What this requires of the build

1. **First-run copy is state, not a flag on the page** — the placeholder and the Only-you line
   retire per user, and must not reappear after reinstall on the same signed-in account.
2. **Trigger state must survive sign-in** (anonymous → claimed) so a user is never re-offered
   mood, talk, or the nudge because their local identity was adopted.
3. **The nudge offer must be able to prove itself**: it needs the writing-hour histogram and a
   day count, and must not appear if either is missing.
4. **Nothing in this flow may read the user's text for anything but search and echoes**
   (`journal.md` §12).
5. **The ink notes need live anchors** — each arrow is fitted to its element's frame per layout
   (§2), and Caveat ships in the app bundle under the SIL Open Font License.

## 7. What the corpus buys

Neither is onboarding; both are what onboarding is *for*.

- **Search is free, semantic and on-device** (`journal.md` §5).
- **Echoes are included and use no AI credits** (`journal.md` §6). Today's page, answered with your own
  older line and a visible count — no interpretation, no advice. Beside the page, never above
  the cursor, always carrying "Not useful".
- **First-run rule:** an echo does not appear during onboarding.

## 8. Open

- Does the talk offer trigger on a **short page** or on a **late hour**?
- Someone arriving from another room already knows the app. Does their first open differ?
