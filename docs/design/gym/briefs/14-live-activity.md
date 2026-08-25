# The lock screen — a second window onto the same queue

A workout is open. The phone is face-down on a bench, and the lifter picks it up between sets. Today
they unlock, find the app, and read the logger. A Live Activity puts three facts on the glass — which
movement, how long since the last set, what the next set will be — and lets the one act that matters
happen from there.

The phone owns the open session because it holds the offline queue. **A Live Activity does not change
that. It is a second window onto the same device's queue, and the whole design turns on keeping it a
window rather than letting it become a second writer.**

## Read this first, because it sizes the feature

> On a locked device, buttons and toggles are inactive, and the system does not perform an action
> unless the person authenticates.

**The reading is free; the writing needs the phone unlocked.** The movement, the clock and the bar
are legible on a locked screen with no authentication at all. **Log set** is inert until the phone
has recognised the lifter.

On a phone you pick up and look at, that is a glance and then a tap — still far less than unlock,
find the app, tap. On a phone lying flat on a bench, in bad light, or with a face the sensor cannot
read, the button does nothing until it can.

That is a real limit and it goes first rather than in a footnote, because a designer who does not
know it will draw a one-tap action that is really two.

## What it shows

The open session as an instrument: the movement, the time since the last set, the bar against the
rest target, and the next set already filled in. One action.

Four presentations — the Lock Screen banner, and the Dynamic Island compact, expanded and minimal.
The hero is the clock. There is one accent-coloured control and no second one.

## The clock, and the rule that does not bind here

The web mirror never says "resting", because a server cannot know whether 1:47 is a rest running or a
rest over. **That rule does not bind this surface, because its premise is false here** — the activity
runs on the device that holds the rest target. Refusing to say something true would be a different
dishonesty.

So the activity **may** name the target and **does**, on the bar.

**But the number still counts up, and reads as time since the last set** — the same reading the web
prints. Three reasons, and the API constraint is the least of them:

1. **One vocabulary.** Divergence in vocabulary is a defect; copy may change between surfaces only
   where the capability changed. What changed is *knowing the target*, so the target appears as a new
   fact. The number that was already there does not change meaning between surfaces.
2. **A countdown to zero tells you what to do, and gym does not.** Rest is over when you pick the bar
   up, not when a number reaches zero, and a lock screen showing you `0:00` is the closest this
   product would come to nagging. A filling bar says *you are there* without giving an instruction.
3. **A countdown has a mode to flip**, and a suspended app cannot flip it.

### And the room's rest row changes to match

This would otherwise leave two readings of one clock on one device, which is exactly the drift this
wave exists to stop.

> **Ruling: the room adopts the count-up reading and keeps the bar.**

Built on all three surfaces: the room's rest row counts up throughout — time since the last set —
and keeps the bar against the target, with no flip at the target. The optional sound at the target
still fires: that is the event, and it stays opt-in. All three surfaces read one clock the same way,
and gym has one sentence about rest instead of two.

## The one button

**Log set, at the number already shown.** That is gym's craft claim — the number is right before you
touch it — made physical, and the only thing worth doing without opening anything.

**Finishing is not here.** The finish screen carries an offer and a destructive door, and a workout
ended by accident on a lock screen is one somebody has to repair.

**Undo is not here either**, and the reason is a capability rather than a preference: a Live Activity
control cannot retire itself when a nine-second window closes, and the act still available afterwards
is a deletion, not an undo. A button that quietly changes meaning is worse than no button.

**No personal record is announced on this surface.** One PR gets one line, in the room, once.

### The same button twice

**Idempotency does not cover this on its own**, and that is worth stating plainly because it is the
kind of thing a build assumes. Every gym write is idempotent by a client-minted id — but two taps
would mint *two ids*, and two ids are two sets.

> **So the app mints the id and hands it to the button as part of the activity's state.** A second tap
> carries the same id and lands as a replay of the first. A new id is minted only when the activity
> advances to the next set.

## Lifecycle, and a limit that never bites

The platform allows an activity eight hours active and twelve in total. **Gym closes a stale session
after four hours, stamped at the last set — so gym's own rule always fires first** and the platform
limit is only ever a backstop. The activity's stale date is set to exactly that four-hour mark, which
leaves a stale face with no button; a set arriving after it would be refused by the server anyway.

**Unsynced work is said, never hidden.** A set sitting in the offline queue says so on the card, in
the room's own words.

## What Android gets, and it is not parity

Android has no Live Activity. The counterpart is an ongoing notification from a foreground service,
and it is buildable — Google names starting a workout as an appropriate case.

Three honest caveats, and they are why this is a **separate wave** rather than a parity item:
the promotion mechanism arrives one SDK level above where this app currently compiles; it needs a
dependency bump to reach it; and a health-type foreground service at the SDK gym targets asks for a
**sensor permission to run a stopwatch**, which does not obviously pass this product's own honesty
bar. The clock and the bar transpose exactly. The Dynamic Island does not exist and nothing should
imply it does.

## What this costs

A widget extension target and a small shared library, plus one key on the app target. **No
entitlement** — so unlike some capabilities, this does not deepen the existing signing blocker. There
is no Live-Activity-specific App Store guideline to satisfy.

## Open

- **Five simulator checks before any board is called finished**, listed in the spec: how a stale date
  actually re-renders, what a progress view does past the end of its range, a one-point layout margin
  against the truncation threshold, the circular presentation, and **what a tap on an inactive
  locked-screen button actually shows the lifter**. Nothing here has been run on a device.
- **Whether asking for a sensor permission to run a stopwatch is acceptable on Android.** It is a
  permission for a thing the feature does not do.
