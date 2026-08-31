# The workout — doing it, ending it, reading it back

The largest undrawn surface in the product, and the one a lifter actually uses with a bar in their
hands: the live logger, the finish, the session read back afterwards, and the fix.

Obeys `12-native-idiom.md`, `../../guidelines/text-budget.md`, `13-gestures.md`, and the rulings in
`15-the-routine.md` that reach this far.

## The keypad stays at the rack

Wave two replaced the target sheet's custom keypad with the platform's decimal keyboard, and that was
right **there**. It is wrong here, and the difference is the whole reason this room exists.

A planning sheet is used sitting down, two hands, looking at the screen. The rack is one hand, sweaty,
mid-set, at arm's length. A twelve-key pad with 64-point targets and a comma-and-point key beats a
system keyboard whose keys are sized for prose and whose layout moves between locales.

> **The ladder and the keypad are rack controls. They stay. Nobody should "finish the job" wave two
> started by removing them here too.**

**And the correction is at the rack as well**, so the fix sheet raises the same keypad the logger
does, on every surface: tapping the weight numeral or the rep value opens the pad rather than the
system keyboard. A repair mid-session is one-handed for the same reason the set was.

The same logic in one line: *the planning sheet knows the number it wants; the rack is where you find
out what you can lift.*

## One primary action, and Finish is not it

The logger's bottom band holds **Log set**, and that is the screen's one primary — it is pressed
between five and forty times a session.

**Finish moves to the top chrome**, as a toolbar action. The earlier spec put it in the bottom band
beside Log set, which is two full-strength commitments in the reach band and the failure
`thumb-reach.md` names by name. Finishing is also the rarer act by two orders of magnitude, and the
one you never want to hit by accident with a wet thumb.

## Finish becomes a sheet over the session it finished

The screen owns a major offer (*keep this as a routine*) and a destructive door (*discard session*),
and it must not be a dead end while it does.

> **It is a sheet presented over the session it just closed.** Dismissing it leaves you in the
> workout you finished, which is where you wanted to be.

Built that way on iOS (`GymRoom.swift:163-171`). Android draws it as a screen of its own with back
claimed and inert; the web's `#/gym/finish/<id>` is a review of a past workout rather than the end of
a live one — the web starts no sessions. The web's ready state draws **no back at all**: an ordinary
workout ends in a footer holding *Session detail* and *Done* (`Finish.jsx:103-108`) and a slight one
in *Keep it* and *Discard session* (`:134-139`), and neither foot is a way back. The two `<Back>`
doors in that file are the absent (`:29`) and failed (`:41`) branches, which a lifter reaching a
finished workout never sees.

The offer and the destructive door keep their places inside it. **Discard asks nothing.** It withholds
the session for the same nine seconds every other delete in the room is held for, puts the transient's
*Undo* beside it, and sends nothing until the clock closes — so the confirmation dialog and the
sentence *There is no undoing it.* are gone from all three surfaces. A question in front of an act
that has a way back is the ceremony `13-gestures.md` Law 2 refuses.

## The rest reading counts up

Ruled in `14-live-activity.md` and built on all three surfaces: the room's rest row counts up —
time since the last set — and keeps the bar against the target; the optional chime at the target
still fires. One reading of one clock, on the room and on the lock screen alike.

## The set kind gets a control that costs no trip

Warmup · working · drop · failure are columns the backend has always written. Only working sets
count toward anything, so a lifter who cannot mark a warmup is feeding the wrong numbers into every
stat the product shows them.

It belongs on the set being logged, not in a sheet: the kind is a property of the rep you are about
to do, and choosing it must not cost a trip. Built that way on both phones — all four kinds one tap
away in place, on the logger's own pill (`LoggerScreen.swift:356-360`, `LoggerScreen.kt:291-296`).
**The default is working**, because it always is, and the pill disarms itself the moment a set lands
so a warmup toggle left on cannot file the working sets after it as ramp-ups.

## The undo lives on the transient

Built, on the screen that owns it: the drawn *Undo* is out of the logger's set row on every surface,
and one transient per platform — hosted by the room, not by a screen — carries both the action and
the fact that a window is open, and retires itself when the last clock closes. It floats above the
reach band and grows no inset, because `Log set` is pressed five to forty times a session and may not
jump when a window opens. `13-gestures.md` Law 4 has the whole of it.

**The window is 9000 ms on every surface** (ledger `2m`); a board that draws a duration draws 9000.
It is **two constants pinned equal, not one number** — the span a delete is held, and the span a said
sentence stands — and the transient retires on the window's clock, never on a sentence's.

## Drawn in both skins, and at three text sizes

Two gaps wave two left, closed here rather than inherited:

- **Every board in this wave exists in Instrument and Daylight.**
- **Every board carrying a big numeral is drawn at three text sizes** — default, large, and the
  largest accessibility size — because `12-native-idiom.md` asks for exactly that and no board in the
  product has ever had it. The largest is where every hand-set fixed-width column breaks.

## The strings are pinned before anything is drawn

Wave two let three surfaces invent seven strings for four states because the rulings were pinned and
the words were not. This wave enumerates its states and fixes their words **first**, and any surface
that disagrees draws the pinned string and argues in its report.

**And every refusal has a named owner.** When a control is removed or added, the refusals it carries
are assigned to a board on a surface before drawing starts — the rule wave two learned by losing four
of them.

**Five sentences are outstanding against that rule right now** and are recorded in the ledger as `2x`
rather than left to drift: the set note's over-the-bound refusal, the unrated seat's label, the
refusal a second walk gets while a deviation is still pending, what deleting a conversation keeps,
and the transient's count line. Three of the five belong to screens this brief owns.

## Open

- **Whether a drop set needs to name its parent.** The column exists; the relationship does not.
- **What the logger shows when the queue is behind.** Unsynced work is said, never hidden, but the
  logger is the screen where saying it competes with the numeral for the only space there is.
