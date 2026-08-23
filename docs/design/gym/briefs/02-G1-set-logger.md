# G1 · The set logger — the whole product in one screen

**Blocks:** `set-logger` (phase 1, size L), the first user-visible bet.
**Status:** no canon exists. This is the brief that matters most.

If this screen is right, gym is a product. If it is wrong, nothing later saves it. The user is
standing in a gym holding a phone in one hand, between sets, and the design's entire job is to make
"I just did 82.5 kg for 8" cost as close to one tap as physics allows.

## The core decision to honour

**One value at a time, not a grid.** Every competitor shows a table of sets you fill in. Lift showed
one exercise, one weight, one rep count, one button — and that is why a full set could be logged from
a locked phone. Keep the single-value model even though we have a whole browser viewport to spend.
The spare room buys legibility and thumb-sized targets, not a spreadsheet.

## What is on the screen

Design the phone at 390×844 first.

1. **The exercise** — which movement, and where you are in the session (`Back Squat`, `set 3 of 5`).
2. **The weight** — the largest number on the screen. Tappable to type a value directly.
3. **The reps** — the second number.
4. **Log the set** — one primary action, thumb-reachable, impossible to miss.
5. **What you already did today** — the sets logged so far for this exercise, with their real
   timestamps, so the user can see 82.5 × 8, 82.5 × 8 without remembering.
6. **What you did last time** — see `last-time-prefill` below. This is the product's soul and it
   needs a home on this screen.
7. **A way to move to the next exercise**, at the user's decision, never automatically.

## The weight ladder — design this precisely

Four buttons around the weight: two decrements, two increments, small and large. The step sizes are
not fixed — they scale with the load:

| current weight | small step | large step |
|---|---|---|
| under 20 kg | 1 | 5 |
| 20 – 49.9 kg | 2 | 5 |
| 50 kg and up | 5 | 10 |

Two details that are easy to lose and must not be:

- **The buttons re-label themselves** as you cross a boundary. At 17.5 kg they read −1 / −5 / +1 / +5;
  at 60 kg they read −5 / −10 / +5 / +10. The user sees the tool adapting.
- **Stepping down from exactly 20 kg gives 19, not 18** — the down-step is computed just below the
  current weight, so you land back inside the range you came from. Please don't design this away.

Reps move by ±1 only, floored at zero. Lift's asymmetry here (four weight buttons and typing, but
only two rep buttons) was a real gap — decide deliberately whether reps deserve a type-to-enter path
too, and say why.

**Tap-to-type on the weight.** The number becomes a field with a decimal keypad. A comma parses as a
decimal point (a European lifter types `72,5`). Committing happens on return, on the confirm control,
and on tapping away. Design what an invalid entry looks like — Lift silently reverted, which is worse
than nothing.

**Negative weight is legal.** Band-assisted pull-ups log as −20 kg. It is one number line, not a
special mode, and the minus sign is not an error state.

## `last-time-prefill` — the thesis, visible

Before the user touches anything, the weight is **already dialled to what they did last time**, and
last time is shown:

> Last time · 82.5 × 8, 82.5 × 8, 80 × 7

Design this line. It is the single highest-value pixel in the product. Questions to answer: how far
back does "last time" reach before it stops being useful? What does it say on the first ever session
for a movement? Does it distinguish "last time you did this exercise" from "last time you did this
routine"?

Sticky carry-forward is the companion rule: after logging a set, the weight and reps **stay where
they are**, so three straight sets at one weight are three taps total. Nothing resets between sets.

## Workout mode

While a session is live the surface goes into a mode: screen wake lock on (the phone must not sleep
mid-session), navigation chrome gone, targets at their largest. Design the entry and the exit, and
what persists at the top so the user always knows a session is running and how long it has been.

A session has a running clock. It must stay honest across a backgrounded tab and a reloaded page — it
is computed from the start time, never counted up in JS.

## The rest timer (design now, ships as `rest-timer`)

Between sets there is rest. Lift's counted up forever, had no target, no alert, and never reset —
the loudest gap in its live loop. Design a rest **target** with a countdown, a state when it lands
(a browser notification is available; a sound is permitted here — this and the set-saved confirmation
are the only two sounds the product allows), and a reset when the user moves to a different exercise.
Consider whether the target is per-exercise, per-routine, or one global default.

## States to design

- **Nothing logged yet today** — the session just started.
- **Mid-exercise** — some sets done, more to go.
- **Past the target** — a fourth set on a 3-set exercise is legal and normal. "Set 4 of 3" must not
  look like an error.
- **First ever session** — no history, so no prefill. What goes in that line?
- **Offline** — the phone has no signal in the basement. Writes queue locally and flush later. The
  user must be able to tell the difference between *saved* and *saved on this device only*, without
  being alarmed. Journal's offline state is the precedent.
- **A mistake was just made** — the user logged 8 reps and meant 3. What is the immediate escape?
  (The full fix-it path is `G3`; this is about the last set, seconds after.)

## Explicitly out of scope

No chat. No coach. No form videos, no plate calculator, no barcode scanning, no auto-detected reps.
No streaks, no XP, no badges, no confetti. Supersets and circuits are cut from v1.

The plate calculator has now been cut **twice**. This line has stood since the first brief; W4 built one
anyway on 2026-08-12 and it left the product on 2026-08-13, taking the settings inventory it needed with
it. A third proposal is a proposal to change this brief, not to fill a gap in it.

## What to deliver

A phone-first spec for the logging surface: the layout and its measurements, the ladder behaviour
with its labels, the prefill line, the completed-sets list, workout mode's entry/exit, the rest
timer, every state above, and the touch-target sizes. Note anything you think is wrong in this brief
— the brief is a hypothesis, and you have seen more logging screens than we have.
