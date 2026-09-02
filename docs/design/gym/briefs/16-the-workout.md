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

Built that way on **both phones**, and they earn the second sentence the same way: the room pushes
the closed session **before** the receipt rises, so what the sheet comes down onto is that workout's
own detail page. iOS presents it from `.sheet(item: $finished)` on the room and sets
`paths[.log] = [.session(…)]` inside `close()`; Android presents the same `finished` slot as the
room's `ModalBottomSheet` and sets `away = listOf(Away.Session(…))` in its own `close()`. Back is no
longer claimed for it on Android: `backMeans` returns four meanings besides `LeaveTheApp`, and the
receipt is not among them, because a sheet answers back by coming down (`GymRoom.kt`).

The web's `#/gym/finish/<id>` is a review of a past workout rather than the end of a live one — the
web starts no sessions — so it is a screen, and **three of its four branches open with the room's one
back**: `<Back href={sessionHref(id)}>Session detail</Back>` above the title on the ready state,
slight and ordinary alike, and above the retry line on a failed read;
`<Back href="#/gym/log">The log</Back>` where the session is not in the log. The fourth is the read
still running, which draws its one quiet line and no back, because it is not yet a place to be sent
back from.

**Exactly one dismissal per state, in the platform's own words.** On iOS it is a toolbar `Done` in
`.confirmationAction`, beside the drag indicator the sheet already declares — nothing here writes, so
it is a toolbar action rather than a second commitment in the reach band (`12-native-idiom.md`). A
top corner is where `../../guidelines/thumb-reach.md` §2 forbids an action, and this is the exception
that section names itself: dismissing a receipt is a door taken sitting down after the workout, never
one needed mid-set, and the sheet keeps its swipe in the reach band besides. On Android nothing is
drawn for it: the sheet comes down by back, the scrim or the handle. **iOS suppresses its `Done` on
the slight branch**, where `Keep it` is the affirmative half of a decided Keep/Discard pair rather
than a way out — Android's `Keep it` is the same act and neither phone draws a dismissal beside it,
because a second full-strength button there is the failure §3.2 names. **The web's ordinary state
draws none — the head back is the way out — and its slight branch keeps `Keep it`**
(`.gym-short-keep` in `Finish.jsx`), which is why the head back had to serve both branches: that
foot leaves for the routines home, so without a back the state reviewing a session had no route to
the session. Its *Just keep the session* is not a dismissal either — it declines the routine offer
in place, without leaving — which is why that spelling stays on the one surface whose finish is not
a sheet. **`Keep it` is therefore one act with two destinations** — dismissed in place on the phones,
navigated away from on the web — which nothing here decides yet (ledger `4d`).

**A sheet covers the room's bottom bar, so the receipt says its own refusals while it stands.**
`FinishScreen` takes a `failure` on both phones and draws it under the control that raised it — the
keep that the log would not take — rather than in the bottom band every other refusal in the room
lands in. The write outlives the sheet, though, so a keep refused after the receipt has been
dismissed falls back to that band on both phones rather than being drawn nowhere. And **why
`Save routine` is grey is said where it is grey**: *Name it to save it.*, the routine editor's own
words, drawn on the finish card on all three surfaces and **on the empty name only**, never while the
write is in flight, where it would name a cause that is not the one holding the button. **One
sentence at a time, the empty field first**, on both phones: a field just cleared is why the button is
dead now, and a refusal the log raised before it cannot be raised again while Save cannot be pressed.

**And a keep that succeeds is answered too, on every surface.** The keep is the one thing the receipt
does that writes, so it owes an answer either way. Both phones draw *Kept as {name}.* where the form
stood, in the same words to the byte (`Finish.keptAs` on each), because the form is gone by then and
the room's own note line is behind the sheet. The web has no sheet over that band, so it says it
there, in the transient's own words — *{name} is in your routines.* (`Finish.jsx`). **A drawn line
where a sheet covers the room, the room's transient where it does not**: that is the split, and it is
the only reason two sentences exist for one fact.

**Two taps on `Save routine` keep one routine, on all three surfaces.** The log mints no id for a
routine, so a second tap is a second routine and not a replay of the first — which is why the button
cannot be left live across the write. Both phones hold an in-flight flag beside the one the routine
editor's Save already had — `keepingRoutine` next to `savingRoutine` in each room — and the web
returns early while `saving` and holds one minted id in a ref for the whole card, so its second press
is a replay even if it lands.

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
away in place. On Android it is an `AssistChip` on the set line, labelled by the kind's wire word
and opening a `DropdownMenu` of the four, the armed one carrying a check (`KindChip` in
`LoggerScreen.kt`; spoken *Set kind*, state the wire word); on iOS a `Menu` holding a `Picker`
(`LoggerScreen.swift:363-366`). **The default is working**, because it always is, and the control
disarms itself the moment a set lands so a warmup toggle left on cannot file the working sets after
it as ramp-ups.

## The Android logger is the ruled shape

The live screen has one canon and Android draws it; iOS's logger still draws the older shape and
follows in its own wave (ledger `5m`). The web starts no sessions and has no logger to follow. Read
against `LoggerScreen.kt`, top to bottom:

- **The chrome is the platform's.** A centred top bar: `Finish` as the navigation action, the
  routine's name as the title — `Free session` when there is none, `Readout.noRoutine`, the same
  bytes the log's rows and the finish sheet draw on all three surfaces — and a settings gear
  (*Gym settings*) that opens the room's settings screen. A planning door in a top corner is what
  `../../guidelines/thumb-reach.md` §2 allows there: a destination, not an action.
- **Two regions.** The reading region — name, set line, history, clocks, the logged strip — is the
  only elastic part, centred while it is short and scrolling only once the largest text leaves it no
  room; the walk's dots and the `+` sit under that scroller, pinned above a hairline. The rack —
  `Weight`, the ladder, `Reps`, `Log set` — is pinned to the bottom, never scrolls and never shrinks.
- **The set line is the domain's, capitalised at the draw site.** `Set 2 of 4` (`Set 2` with no
  count) from `LiveLines.counter`, whose bytes stay `set 2 of 4`; when the plan line carries a rep
  or load target the tail ` · target 5 @ 82.5` follows in the target ink, and a plan with no target
  draws no tail — the absence says it. The kind chip shares the line and wraps under it at the
  largest text.
- **History is a chip, or nothing.** With a last time, an `AssistChip` reads the one matching set —
  last time's Nth working set for the coming Nth, `LiveLines.lastTimeSet` — as `20 kg × 15`; its
  spoken description is the whole card `LiveLines.prefillCard` builds (the day, how long ago, the
  other routine, every set) and its menu dials any of those sets. With no history **nothing is
  drawn** — no chip, no row, no reserved height. A read that missed draws a disabled chip reading
  *didn’t load*, because a failed read must never draw as no history.
- **The rest is two numerals and a ring, and it still says the old words.** From the first landed
  set of a movement: the time since, counting up, beside a ring filling toward the target and the
  target's numeral — a check at overrun. The row is one node whose description keeps the bytes the
  label used to draw, `resting · target 1:30 · from the routine  ·  0:03`, and tapping it clears the
  rest. When the routine's own rest is in force the caption *from the routine* is drawn under the
  clocks and hidden from the reader, which the merged node already told.
- **Unsynced and refused work is said, never hidden.** The stranded band (`LiveLines.onThisDeviceLine`)
  keeps its sentences with a cloud-off glyph, and the refusal rows keep theirs. This is the only
  prose on the screen, and it exists only while something is wrong.
- **The logged sets are a strip of pills**, one fixed row scrolling sideways: index and `20 × 5`,
  a warmup in its own ink, a stalled set carrying a cloud-off glyph whose name is *on this device*.
  Every pill is a door — *fix this set* — to the same `FixSheet` the session screen raises, and a set
  still owed to the log is fixed or deleted in the queue it waits in (`TrainingStore.fixSet`,
  `deleteSet`), so the corrected body is what lands. A pill without the cloud is synced: an absence
  needs no glyph.
- **The walk's dots say their position** — *Movement 1 of 3*, `LiveLines.place` capitalised — and
  are drawn only for a walk of two or more; the `+` beside them is *Add movement*, the free
  session's one way to a next movement, and opens the picker directly.
- **The rack.** `Weight` over the numeral and its unit, one node (*Weight 20 kg*, *type a weight*)
  that raises the rack keypad; four **equal** ladder pills whose labels are the golden's by weight
  band (`Ladder.labels`), never a fixed ±1/±5; `Reps` over the numeral (*Reps 5*, *type the reps*)
  between two filled circles named *one rep fewer* / *one rep more*; and one full-width primary
  reading **`Log set`** with no echo — the two numerals stand directly above it. While a finish is
  in flight the primary is drawn disabled under the same label.
- **What is gone from Android's screen, and where each fact went.** The first-time card (*First time
  logging this* and its two lines): an absence, said by the absent chip and the set line's target
  tail. *reading your log…*: the chip appears when the answer lands. The uppercase `SET N` and
  `MOVEMENT N OF M` eyebrows: the set line and the dots' spoken name. `plan 4 × 5 @ 82.5` / *no
  target*: the set line's tail, or nothing. The `× 5` beside the weight and the `Log set  ·  20 × 5`
  echo: the reps numeral. The picker subtitle *the session is already running*: the title and
  `Finish` exist only while one runs. The four-segment kind row: the chip.

**The keypad's own words**, pinned here so nothing holds them by test alone: a valid load's line is
its unit, `kg` (`WEIGHT_UNIT` in `logger/entry.js`, `KeypadEntry.weightUnit` in `KeypadSheet.swift`,
`KeypadEntry.weightHint` in `KeypadSheet.kt`); a valid rep count's is *whole reps*; the empty-buffer
line is *Enter a number, or cancel to keep {n}*; the refusals are `15-the-routine.md`'s four with
this screen's 1–99 band; and the two glyphs are named *Flip the sign — band-assisted* and *Delete*.
No hint about separators stands under the pad on any surface.

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
- **What the logger shows when the queue is behind**, on iOS. Android answers it above — the
  stranded band in the reading region and a cloud-off glyph on the stalled pill, nothing in the
  rack — and iOS's logger answers it its own way until it follows (`5m`).
