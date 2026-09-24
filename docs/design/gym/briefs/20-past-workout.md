# Past workout — log a routine you already trained

The web's backfill: the workout that happened without the phone, written down afterwards. The
lifter's own words: *I want to log an existing routine, not a random collection of exercises. It
asks what time it was and how long it lasted, then makes me add every set as a line. Let me pick my
routine, have it prefilled, change what differed, and save.*

Obeys `../web-form.md` (the measures, the numeric row, the rail, `Add set` as the last row, the
trailing `×`, the unit named once), `17-set-targets.md` (the scheme and its nulls), `13-gestures.md`
(the withheld window), `16-the-workout.md` and `../../guidelines/text-budget.md`.

Boards: `Web · Gym` (`466:132`), section Record, the rows named
`Record / Add past workout / …` — Pick routine, Prefilled, Edited, Time changed, Overlap refusal,
Free session, No routines, Saved and From a routine, each at 1440 and 390.

## The flow — one pick, one form, one Save

**The routine is the default and the fast path.** `Add past workout` on the log opens a list of the
program's routines in program order, each row the log's index row: name, the day it was last trained
(`Never trained` when never), and `4 movements · 10 sets`. One click opens the form already filled, whose back link reads `Past workout`. The
last row, under a rule, is `+ Free session` — the only way to a workout with no routine.

**A second door sits on the routine itself.** The routine card's `⋯` holds `Log past` above
`Delete`, and lands on the same filled form without the pick.

**No routines, no pick.** An account with no routines skips the list and opens the free session,
with one card beside it (desktop) or above it (narrow): *No routines yet* · *Build one and this form
arrives filled in.* · `Build a routine`.

**The open phone session is not in the way.** The workout is written as one completed session in
one request that leaves an open workout untouched, so this door never refuses because a workout is
running.

## What fills the sets — the rack's own rule

The form is the rack's prefill, run for every set at once (`17-set-targets.md`, *The rack*):

- **A set with a named target** takes the target: `3 × 8 · 60` arrives as three sets of `60 × 8`.
- **A blank load or a blank rep count** (`last time`, `max`) takes last time's Nth working set for
  that movement, then last time's last set.
- **An open line** takes last time's working sets as they were lifted.
- **An open line never lifted** arrives with no sets: its line reads `open · no last time` and its
  only row is `Add set`. Nothing is saved for it unless the lifter adds a set.
- **A value with nothing to come from** — a named rep count on a load that was never lifted — is
  drawn empty, and Save stays inert until it is typed.

Nothing is invented: every number on the form is a target, a set the lifter lifted, or a number
they typed. A load of zero is the movement at bodyweight and reads the way the log reads it: the
line drops its load (`3 × 6–8`) and the row says `bodyweight × 8`. On desktop the side column says where the focused movement's numbers came from: its
`Target` readout, `Last time · 19 Sep` with those sets, and one caption.

## Time — a day in one tap, a time that is always shown

**The day is one tap.** Three chips: `Today` (the default), `Yesterday`, `Other day` — the last
opens the date field (latest day: today) and then reads the day it holds, `22 Sep`.

**Every workout is stored with a time, and the form says which before Save.** The lifter is never
asked for one. The default slot is an hour:

- **12:00–13:00** local on the chosen day.
- **Today before 13:00:** the hour ending now.
- **The slot crosses a session already in the log that day, or the open phone session:** it starts at
  the latest crossing session's finish, an hour long. If that would end after now, it ends at the
  earliest crossing session's start instead.

A default slot never meets the overlap refusal; only a time the lifter set can.

**The note beside Save always states the time that will be stored** — `Today · 12:00–13:00`,
`Today · 13:05–14:05` — so the stored time is read before it is written, and the log shows it as any
other time.

**`Change time`** beside the day chips opens one row: the start time, `for`, and the length chips
`45 min · 1 h · 1 h 30`, `1 h` held by default. The lifter's time replaces the default in the note.

Sets are spread evenly inside the span and read as approximate; nothing reads a rest interval off
them.

## Editing — the numeric row, and nothing else

- **Agreeing sets collapse.** A movement whose sets agree is one line — `3 × 8 · 60` and a
  three-tick rail. A click opens its rows. A movement whose sets disagree is always open.
- **A number is edited where it is drawn**, as an editable number with the focus underline, not in a
  keypad sheet. Tab walks load, reps, next set; Enter commits and moves down; ↑/↓ step the load by
  the movement's plate step and the reps by one.
- **An edit carries down.** Changing set 1 writes the new value into every later set of that movement
  the lifter has not touched — the rack's straight-scheme rule (*a lifter who chose 62.5 on set 1
  chose it for the day*). The carried numerals ink-lift one after another, 40ms apart.
- **`Add set`** is each movement's last row and copies the row above. A set leaves by its trailing
  `×`.
- **Skip a movement** with the `×` on its line. It leaves at once with the transient
  *Overhead Press is out of this workout.* · `Undo`.
- **`+ Add movement`** opens the movement picker; the movement arrives with last time's sets, or one
  empty row if it has never been lifted.

There is no line-with-a-count, no `−`/`+` stepper, and no set kind: every set is Working.

## Save

**One action: `Save · 9 sets`**, counting the sets that will land, inert at none. It writes the whole
workout in one request — its span, the routine, every set — so it lands whole or not at
all. The routine is frozen onto the session as its plan and **the routine itself is never edited**:
logging a day is not changing the plan. Its `trained …` line moves only if this is now its newest
session.

The button reads `Saved · 9 sets` for 900ms, then the session opens: on desktop the log's split with
the new row selected (`today · 12:00`), on narrow the session detail, whose meta reads
`Today · 1h 00m · 9 working · 2,220 kg` under `plan snapshot · frozen 12:00`. The transient
*Push A is in the log.* · `Undo` gives the discard its usual window.

**Overlap is refused only against a time the lifter set.** One that crosses a session in the log —
the open one included, from its start until now — is refused in place, Save inert, with the log's
own words: *These times cross a session already in the log.* · *Push A · today · 18:05 – 19:10 is
already in the log. One visit is one session — if sets are missing from it, add them there instead.*
· `Open that session ›` · `Change time`. A set time that ends after now reads *These times run past
now.*

## The feel

Feedback class throughout, inside the motion ceilings. A row that opens enters `wm-fade-in-up`
280ms; a collapsed line opening grows its rows from the line; a removed row collapses its height
180ms and the rail re-ticks; a changed number ink-lifts to the accent and settles over 280ms.
Reduced motion keeps every colour ramp and drops every spatial one.
