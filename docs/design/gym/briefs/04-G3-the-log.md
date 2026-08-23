# G3 · The log — sessions, detail, and the fix-it path

**Blocks:** `training-log` (phase 1, read-only) and `log-editing` (phase 2, the fix-it path).
Design both together; they ship apart.

## What this is for

Two different jobs wear the same clothes and should not:

1. **Looking back.** What did I squat three weeks ago? Is this heavier than last time? This is
   reading, it happens on a couch, and it is the majority of visits to this surface.
2. **Fixing a mistake.** I logged 8 and meant 3; I forgot to log the last set; I logged bench twice.
   This is editing, it happens rarely, and it must be impossible to trigger by accident.

Lift merged them and paid for it: its editing mode bound text fields straight to the saved record,
writing on every keystroke, so its Done button was decorative and there was no Cancel. Design the
read surface as read-only, and make editing a deliberate mode with a commit and an escape.

## The session list

Sessions newest first. Each row needs enough to recognise the day without opening it: when, which
routine (if any), how long, how much. Design what a row says when the session had no routine — ad-hoc
training is normal and must not look degraded.

## The session detail

One visit, read back the way it was trained. Sets grouped by exercise, and the groups in
**first-performed order** — not alphabetical, not by muscle. The log should read like the session
happened.

Per exercise: the sets, their weights and reps, their real timestamps (rest intervals are
reconstructable from them), and the honest comparison — *is this more than last time?* Lift showed a
volume delta against the previous session of the same routine, in green or red. Volume is a weak
metric for this (four sets of light work beats three heavy ones), so propose what the comparison
should actually be. e1RM is available from `G5`.

## The fix-it path (phase 2)

Three operations, all rare, all destructive-adjacent:

- **Edit a set** — change the weight or reps of something already logged.
- **Delete a set** — and the remaining sets renumber, so the log never shows a hole.
- **Add a missed set** — usually cloned from the last one; the common case is "I forgot to log set 4".

Design rules:
- Editing is a **mode** you enter and leave, with a visible commit and a real cancel.
- **No one-gesture destruction.** Lift deleted an entire training program on a full swipe with no
  confirmation and no undo. A training log is a multi-year artifact a person cannot regenerate;
  design deletion accordingly — confirm, or undo, and preferably reversible.
- Deleting a whole session is a different weight of decision from deleting one set. Treat it as such.

## Empty and edge states

- **No sessions ever** — a first-run state on the log tab. It should point at the logger, not explain
  the app.
- **A session with one set** — someone started and left. Not an error.
- **A very long session** — 40+ sets across 8 exercises. Does the layout survive scanning?
- **An unfinished session** — the user closed the tab mid-workout. The rule is that an open session
  with no set for a few hours auto-closes at its last set's timestamp, so this surface may show a
  session that ended by timeout rather than by a tap. Design how (and whether) that is disclosed.

## What to deliver

The session list, the session detail, the editing mode with its commit/cancel, the three destructive
confirmations, and every empty state. Phone first.
