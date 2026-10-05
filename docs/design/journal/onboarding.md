# Journal — the first run (P9)

The onboarding canon for Journal. Parent canon: `journal.md` (rules, vocabulary, motion);
shell flow: `../guidelines/superapp-flow.md` §8.

---

## 1. The principle

> **Journal opens on a live page, with nothing drawn over it.**
> Everything else appears later, on a trigger, once the user's own writing has made it relevant.

There is no onboarding layer: no overlay, no coach marks, no tour. The page invites writing by its
own geometry — the parked caret, the page-sized tap target and the Write seat (`journal.md` §4) —
every night, not once. The drawings are section *2 · Journal first run* of the Figma page
[iOS · First run](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=112-2): board 05
is the first open, 07c and 07d the empty and the one-line page later.

A person arriving with written pages sees no re-onboarding: the placeholder, privacy fact,
first-page cue and scale invitation are retired. The mood and energy controls remain available
and unasked.

The product cannot demonstrate its value in a first session — an echo needs months, the week
needs a week, the nudge needs a rhythm. The first run's only job is: **get one page written,
and be worth reopening.**

## 2. Session one — the whole screen

The canvas opens at today, cursor placed, keyboard **not** raised. Only today's page is writable;
past days stay read-only, as on web. Exactly two pieces of copy exist, and both retire permanently
after the first save:

| Element | Copy | Retires |
|---|---|---|
| Placeholder | "Start anywhere. Nothing here is graded." | first keystroke |
| The one fact | "Only you. No prompts, no fields, nothing to fill in — write a line or a page." | first save |

- **Nothing animates before you can type** (`journal.md` §3.7). The caret is parked on the first
  frame and still; there is no entrance or fade-in of chrome.
- **The keyboard is not raised for the user.** The whole of today's page takes the tap, and the
  Write seat sits bottom-right for the thumb (`journal.md` §4). Neither is first-run furniture;
  both are there every night.
- **The room's name, top-left, is a plain title** while Journal is the only room on the phone — no
  chevron, no menu. It becomes the room menu, in the same seat, when Gym joins
  (`../guidelines/superapp-shell.md` §3).
- **Mood and energy are visible and unasked** — the strip is there, dimmed, asking nothing.
- **"saved" is stated in mono**, never a button, never a spinner.
- No account, no permission.

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

**One invitation at a time.** Signed out, the quiet Keep row appears only after the mood and energy
invitation is answered or dismissed. Signed-in pages never show Keep
(`../guidelines/superapp-flow.md` §6).

**Never during the first run:** Echoes (needs a corpus), sign-in (the shell's Keep offer comes
only after the first kept page and the scale invitation is answered or dismissed —
`../guidelines/superapp-flow.md` §6), the notification
permission (asked *after* "yes", never before), and anything about the other rooms (the room
menu, once there is one, lists them).

**Never at all:** streaks, scores, percentages, "you missed 3 days", a congratulation for
showing up, a first-page celebration, a prompt library, a required mood check-in — and any
word from the tree (unlock, plant, quest, level). Journal drops the game metaphor entirely
(`journal.md` §9).

## 4. Coming back — the canvas teaches itself

Day two is where the model lands, and it must land **without copy**: yesterday sits above,
today is at the bottom, scrolling up is going back. Past days are read-only; writing and scale
entry belong to today.

- **A skipped day is not drawn at all** — the day markers' dates carry the jump, and nothing
  is coloured as failure because nothing is there to colour. There is no streak to break.
- **Opening restores to the bottom, not animated** (`journal.md` §4).
- **An empty night is still a page**: the marker, the parked caret, three lines of room and the
  Write seat (`journal.md` §4). Nothing says "write"; the page is simply there to be written on.
- The first time the user scrolls into the past, the month pill confirms where they are. That
  is the only orientation aid, and it is not taught.

## 5. Talk — the one offer with a promise attached

The talk offer sheet must state the discard in the product's own words: audio becomes plain
editable text and **is discarded once transcription succeeds** (`journal.md` §3.2). The
feature does not rely on a settings page to be honest.

## 6. What this requires of the build

1. **First-run copy is state, not a flag on the page** — the placeholder and the Only-you line
   retire per user, and must not reappear after reinstall on the same signed-in account. Adoption
   uses `firstRunPolicy = retire-existing`: existing written pages retire the placeholder, privacy
   fact, first-page cue and scale invitation; no native first-open invitation is replayed.
2. **Trigger state must survive sign-in** (anonymous → claimed) so a user is never re-offered
   mood, talk, or the nudge because their local identity was adopted.
3. **The nudge offer must be able to prove itself**: it needs the writing-hour histogram and a
   day count, and must not appear if either is missing.
4. **Nothing in this flow may read the user's text for anything but search and echoes**
   (`journal.md` §12).
5. **The write invitation is permanent, not first-run state**: the tap target, the parked caret
   and the Write seat (`journal.md` §4) hold on every page, in both auth states, after reinstall.

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
