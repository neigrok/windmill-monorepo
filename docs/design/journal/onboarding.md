# Journal — the first run (P9)

The onboarding canon for Journal, expanded out of `guidelines/superapp-flow.md`
§5 because this product's first run is mostly a list of things that must **not**
happen yet. Parent canon: `journal/journal.md` (rules, vocabulary, motion).
Live board: `templates/journal-onboarding/JournalOnboarding.dc.html`.

**Status:** designed Aug 2026. Not yet built.

---

## 1. The principle

> **Journal has no onboarding screen. It has a cursor.** Everything else appears
> later, on a trigger, once the user's own writing has made it relevant.

The product cannot demonstrate its value in a first session — an echo needs
months, the week needs a week, the nudge needs a rhythm. So the first run's only
job is: **get one page written, and be worth reopening.** Anything that delays
the first sentence is a cost with no return.

## 2. Session one — the whole screen

The canvas opens at today, cursor placed, keyboard **not** raised. Exactly two
pieces of copy exist, and both retire permanently after the first save:

| Element | Copy | Retires |
|---|---|---|
| Placeholder | "How was today?" | first keystroke |
| The one fact | "Only you. No prompts, no fields, nothing to fill in — write a line or a page." | first save |

- **Nothing animates before you can type** (`journal.md` §3.7). The cursor is
  live on paint; no entrance, no fade-in of chrome.
- **The keyboard is not raised for the user.** A phone that opens keyboard-first
  steals the seconds in which someone decides what to say.
- **Mood and energy are visible and unasked** — two dim chips in the bottom bar.
- **"saved" is stated in mono**, never a button, never a spinner.
- No account, no permission, no tour, no dismissible anything.

## 3. The schedule — what appears when

Each item fires **once**, on its own trigger, and is dismissible with "Not now"
which retires it for good. Nothing counts declines.

| What | Trigger | Why then |
|---|---|---|
| **Mood & energy** invitation | first page saved | the only thing the canvas can't say for itself; asked after the user has proven they'll write |
| **Talk** | first short page written late | the moment typing is the obstacle; on day one a mic is just another thing to refuse |
| **The nudge** | 7+ days with a detectable hour | below 7 days adaptive is off and says so (`journal.md` §7); the offer shows the histogram and its confidence |
| **The week** | first Sunday with 3+ pages behind it | a weekly readout of one page is an insult |
| **Search** | never announced | it lives in the chrome from day one and explains itself when used |

**Never during the first run:** echoes / One (needs a corpus — selling it early
sells nothing real), sign-in (the shell's, from You only), the notification
permission (asked *after* "yes", never before), and anything about the other two
rooms (the shell's house sheet owns that).

**Never at all:** streaks, scores, percentages, "you missed 3 days", a
congratulation for showing up, a first-page celebration, a prompt library, a
required mood check-in — and any word from the tree (unlock, plant, quest,
level). Journal drops the game metaphor entirely (`journal.md` §9).

## 4. Coming back — the canvas teaches itself

Day two is where the model lands, and it must land **without copy**: yesterday
sits above, today is at the bottom, scrolling up is going back.

- **A skipped day is not drawn at all** (native 2026-08-04, web 2026-08-09) — the
  day markers' dates carry the jump, and nothing is coloured as failure because
  nothing is there to colour. There is no streak to break. This replaces the gap
  row this section used to specify (hollow dot, "nothing written", 50% ink).
- **Opening restores to the bottom, not animated** (`journal.md` §4).
- The first time the user scrolls into the past, the month pill confirms where
  they are. That is the only orientation aid, and it is not taught.

## 5. Talk — the one offer with a promise attached

The talk offer must state the discard, in the product's own words: audio becomes
plain editable text and **is discarded once transcription succeeds**
(`journal.md` §3.2). The offer sheet carries that sentence; the feature does not
rely on a settings page to be honest.

## 6. What this requires of the build

1. **First-run copy must be state, not a flag on the page** — the placeholder and
   the Only-you line retire per user, and must not reappear after reinstall on the
   same signed-in account.
2. **Trigger state must survive sign-in** (anonymous → claimed) so a user is never
   re-offered mood, talk, or the nudge because their local identity was adopted.
3. **The nudge offer must be able to prove itself**: it needs the writing-hour
   histogram and a day count, and must not appear if either is missing.
4. **Nothing in this flow may read the user's text for anything but search and
   echoes.** The agent does not read pages to plan roadmaps (`journal.md` §12).

## 7. What the corpus buys — search and echoes (shown on the board, ruled in `journal.md`)

Neither is onboarding; both are what onboarding is *for*, and the board carries
them so the first run can be judged against its payoff.

- **Search is free, semantic and on-device.** Every hit states why it matched;
  opening one flies the canvas to that day with its neighbours intact. Threads
  are derived — there is no tagging UI (`journal.md` §5).
- **Echoes are the one paid thing (One).** Today's page, answered with your own
  older line and a visible count — no interpretation, no advice. It sits beside
  the page, never above the cursor, and always carries "Not useful".
- **Without One, the mark is shown and the reading-across is not** (revised
  2026-08-04): the same lamp mark everyone sees, and one tap in the nearest passage
  is **cut mid-clause with the withheld words counted**, the other matches listed as
  dates, and the cut page named as free to scroll to. Still no blurred text and no
  invented preview. One offer card per page, "Not now" retires it there
  (`journal.md` §6; screens in `templates/journal-echoes`).
- **First-run rule:** neither the offer nor an echo may appear during onboarding.
  Echoes need months of corpus; offering them early sells nothing real.
- **Still open, and not Journal's to decide alone:** One is defined as "a bigger
  tending allowance", but echoes are passive and can't be metered per run —
  including them makes One *allowance + passive intelligence*, a change to
  `marketing/guidelines/pricing.md` §3 that needs an owner.

## 8. Open

- Is "How was today?" too leading as a placeholder, or is a blank canvas colder
  than it is free?
- Does the talk offer trigger on a **short page** or on a **late hour** — the
  board shows both conditions met at once.
- Someone arriving from Roadmap or Gym already knows the house. Does their first
  open differ, or is one door simpler and truer?
- Where does the first run belong when the user skipped the shell's opening
  question and browsed to Journal from the hub — same screen, or does the hub's
  card carry the invitation?
