# G8 · The web as mirror — the session you are not holding, and the door to a past workout

**Blocks:** `gym-live-mirror` (phase 1) and `gym-backfill` (phase 1–2). Design both together;
they ship apart.

## Why this brief post-dates the others

Every brief in this folder was written on 2026-07-29 assuming one surface. On 2026-08-02 the
product split in two, and the web's job changed underneath `G1` and `G3`: **the phone owns the
open session; the web owns everything else.**

The reason is not preference. Everything the logger does — workout mode, the keypad, the ladder,
sticky carry-forward, the rest countdown, the wake lock, the offline queue — is *live-state work
needing a device that is with you, awake, and able to log in a basement with no signal*. Everything
else is keyboard work over a log that has stopped moving. A laptop is very good at the second and
structurally bad at the first.

So the web logger that `G1` specified and that shipped is being **demoted**, not extended. Where it
used to be, two new surfaces go. Neither has been designed.

| | Phone (native iOS) | Web |
|---|---|---|
| owns | the **open** session | everything retrospective and prospective |
| | workout mode, keypad, ladder, carry-forward, rest timer, wake lock, the flush queue | the log, progression, routines, export, MCP connect, settings, the strength tree, **backfill** |
| writes | sessions · sets | routines, and **past** sessions only |

One rule falls out of that table and constrains everything below: **the web never Finishes a live
session.** Only the device holding the offline queue knows every set actually landed, and a set
that never landed may not land after the close. A Finish pressed on a laptop over a phone holding
three unflushed sets refuses those sets forever. There is no button. The session closes itself
after four hours idle and stamps its end at the **last set**, which is truer than a manual finish
three hours late anyway.

---

## Surface 1 — the mirror

Where the logger used to be, the web renders **the live session as it happens**. Not a disabled
Start button. Not an apology. Roughly this much is known:

```
Training now · Upper A · 34:12
Bench press — set 3 · 82.5 × 8 · resting 1:47
     82.5 × 8   ·   82.5 × 8   ·   60 × 10 (warmup)
```

On a laptop at a desk that is worth having on its own terms, and it makes the phone's ownership
legible without a word of copy explaining it.

**The rule that shapes it: never an absence, and never a greyed-out control.** A disabled Start is
the one shape that would make this read as a restriction rather than a division of labour. With no
session open, the slot says *start a workout on your phone* and carries the install door.

**What we need from you:**

- **The resting state.** No session open is the state a lifter sees most — most visits are not
  during a workout. What is in that slot? It has to carry the install door without becoming an ad,
  and it must not read as an error or an empty state.
- **The live state, and its grain.** How much of the session is shown — the current movement only,
  or the whole session so far? A set lands roughly once every 60–120 seconds; the rest clock ticks
  continuously. What moves and what does not?
- **Arrival.** A set landing is the only moment this surface has. Does it announce itself? The
  roadmap's motion language is in `../guidelines/motion-beats.card.html`; gym is quieter than
  roadmap by design (see `03-G2-palette.md`), and a training log watched from a desk is not a
  place for ceremony. Propose the restraint level.
- **Staleness.** The mirror polls; it can be behind, and the network can drop. When the last
  successful read is 30 seconds old, is that visible? Our instinct is that a mirror which lies
  quietly is worse than one that admits a lag, but a permanent connection indicator is noise.
- **Where it lives.** Does the mirror occupy the log tab, its own tab, or a band above the log?

---

## Surface 2 — backfill, the door that keeps the promise

A lifter whose phone died must not lose a session. Gym exists because a training log is a
multi-year artifact nobody can regenerate — so the web keeps exactly **one** write door, and it is
deliberately a different door with different vocabulary: **"Add a past workout"**, never *Start*.

It mints a session with a past start, finishes it in the same flow, and appends sets with past
timestamps. No live session ever opens on a laptop.

**Backfill is refused while a session is open**, and this is the single most important rule on the
surface. It is not a policy choice — it is a data bug we are designing around. The database allows
one open session per person, so a backfill started during a live workout would not fail; it would
silently **join** the live workout and file yesterday's sets into today's. The refusal happens on
the client, before the request, with the reason said plainly — *your phone is mid-workout* — never
as a server error the lifter has to interpret.

**What we need from you:**

- **The entry shape.** A past workout is: a date and time, a duration or an end, and then movements
  with sets under them. This is the most form-like thing in gym, in a product whose whole identity
  is *not being a form*. It is also rare and done at a keyboard. How much does it borrow from the
  logger's language, and how much does it admit to being data entry?
- **The refusal.** What the lifter sees when they reach for this door mid-workout. It must not read
  as a bug or a permission problem — the honest message is that their phone is holding the session
  and this door opens when that one closes.
- **How much at once.** One set at a time, or a whole session? Repeating a movement's set line is
  the common case (`3 × 8 @ 82.5` is three rows that differ in nothing).
- **Where the door lives**, and how it stays findable without competing with the log itself. It is
  rare — it must not look like the primary action.
- **Correcting a backfill.** Note this collides with `G3`'s fix-it path; if the same editing mode
  serves both, say so rather than designing a second one.

---

## What already shipped, so you design against reality and not the briefs

- **`G1` shipped and is being demoted.** The set logger exists on web — keypad, ladder,
  carry-forward, queue. Do not design its replacement; design what stands where it stood.
- **`G2` shipped.** Gym's scoped palette is live (`gym-tokens.css`). Use it.
- **`G3` has NOT been fulfilled and is now partly stale.** The session list and session detail were
  built without a design, along with paging to the bottom of the log. That brief is still open and
  still wanted — including its unanswered question about what the honest "is this more than last
  time?" comparison should be. When you take it, you are redesigning something on screen, not
  filling a blank.
- **One thing in `G3` needs an eye specifically, because engineering invented it:** the foot of the
  log has four states — *load older* / *loading* / *nothing older* / *that read failed* — and the
  copy in them is ours, not yours. It works and it is honest; it has never been designed.

## Also open, and smaller

Two decisions from the build that belong to design, filed here so they are not lost. Neither blocks
this brief.

- **The zero crossing has no detent** (`G1`'s territory). Weight is signed: a chin-up logs at 0 kg
  and a band-assisted pull-up at −20. The button row is identical at 0, at +0.5 and at −0.5, so
  tapping − from bodyweight silently converts a bodyweight rep into a band-assisted one — a
  different physical setup — with no confirmation. We think a step that would *cross* zero should
  land *on* zero, making bodyweight a real detent. Open question underneath it: the loaded side's
  step sizes come from plate granularity, and band assistance has no plate physics, so the assisted
  side's steps may want to be something else entirely.
- **The rest timer has no design** (`G1` reserved the column). It is device-local, so the mirror
  cannot show a trustworthy countdown — a handoff between devices resumes the log but not the
  timer, and the receiving device should say that rather than fake it.

## What to deliver

The mirror in both its states, the backfill flow end to end including its refusal, and every empty
and edge state below. **Phone first for the backfill** (a dead phone is often replaced by a hand-me-
down phone, not a laptop); the mirror is desk-first and must survive a phone.

Edge states to cover explicitly:

- No session open — the resting mirror, with the install door.
- A session open that this tab has never seen before, mid-load.
- The connection dropping while mirroring, and coming back.
- A session that **auto-closed by timeout** rather than by a tap. This is not an error and the log
  will show it; decide whether and how it is disclosed.
- A backfill attempted during a live session — the refusal.
- A backfill of a session that overlaps one already logged.
