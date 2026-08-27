# Gestures — what the platform already knows how to do

A gesture is more intuitive than a rendered control and leaves a cleaner screen. That is the whole
argument for this brief, and it is right. But a gesture is also invisible, and gym is used by
somebody tired, one-handed, mid-set. So the ruling needs laws around it or it costs more than it
buys.

## The five laws

### 1 · A gesture may replace a control. It may never be the only way to reach an action.

A swipe cannot be seen. A first-time lifter does not know it is there, and a lifter using VoiceOver
or TalkBack cannot perform one at all.

**The platforms are asymmetric here and the build has to know it.** On iOS a `.swipeActions` action
is automatically offered to VoiceOver through the Actions rotor, so declaring the swipe declares the
alternative. On Android a swipe is a drag, and TalkBack sees a drag — the same action must be
declared again as a custom accessibility action, by hand, on every row.

> **On iOS a swipe action is complete. On Android it is half-built until its custom action exists.**

Every Android board drawing a swipe says so on the board.

**And the law is a per-row test, not a blanket cost.** A row that already carries an overflow control
has a real, screen-reader-reachable button, and a swipe on that row satisfies this law for free by
putting the same actions in the overflow. The **routine row** is in that position on the web and on
Android — one overflow holding Duplicate and Delete (`Routines.jsx:104-110`,
`RoutinesScreen.kt:327-346`) — so neither declares its swipe's action twice. iOS's routine row draws
no overflow and needs none: `.swipeActions` is the whole of it (`RoutinesScreen.swift:45-52`) and the
rotor carries it. The **set row** carries no overflow on either phone, so Android declares `Delete`
by hand (`SessionScreen.kt:441`) and iOS declares nothing. The **log's session row** carries no
drawn control at all — both its acts live in a long press, which is why Android declares both of them
by hand (`LogScreen.kt:313-316`). Check the row, not the platform.

### 2 · A gesture that destroys needs an undo, not a confirmation.

A confirmation on a swipe defeats the swipe: you swiped to be quick, and a dialog puts back the tap
you just saved.

Gym has the mechanism — one window, declared once per platform. So the shape is swipe → gone → a
transient that names what left and offers *Undo* → really gone.

**And it is one length, held in two constants.** Every surface holds a delete for **9000 ms** —
`SetQueue.swift:48`, `SetQueue.kt:52`, `fix.js:66` (`UNDO_MS`) — and a said sentence stands for the
same 9000 (`useTrainingLog.js:21`, `TOAST_MS`). They are pinned equal and they are **two spans, never
one number**: the window is how long a delete is still the lifter's, the toast is how long a sentence
stands, and a window retires its own transient when its last clock closes rather than on a sentence's
clock. `ARCHITECTURE.md:1233` states the invariant (ledger `2m`).

It matters here more than it looks: the gate below says a swipe ships only where an undo already
exists, and that gate means the same nine seconds on every surface.

**The corollary is the load-bearing half: an act with no undo path may never be a gesture.** Turning
a proposal down settles permanently and the wire has no way back, which is exactly why closing the
review sheet decides nothing. That ruling and this law are the same rule seen twice.

### 3 · One gesture, one meaning, and never two in one place.

The system owns some strokes and the room may not take them back: **a swipe from the leading edge is
back**, a swipe down on a sheet dismisses it, a pull at the top of a scroll refreshes. Anything gym
invents starts **away from the edge**, and any screen wanting a horizontal gesture in its body must
say what happens when the stroke begins in the edge strip.

### 4 · A gesture earns its place by removing something — but count the STATE, not just the control.

A swipe that adds capability but removes no drawn control has not made the screen cleaner, only less
discoverable. Every gesture below names the control that comes off, and the one whose answer is
"none" says so.

**And the law as first written was wrong in a way worth keeping visible.** It counted the control
that disappears and not the *state that control was carrying*. Removing the drawn "Undo" from the
logger's set row takes away the only on-screen signal that the nine-second window is open at all —
the undoable row becomes identical to the settled one, and the lifter cannot tell whether they still
have a way back.

> **So when an action leaves a row, its state goes to the transient surface the platform already
> owns** — an Android snackbar, an iOS bottom transient — which carries the action AND the fact that
> a window is open, and retires itself when the window closes.

**And the undo lives there on every surface, not only where a swipe displaced it.** The session
screen's inline row and the logger's row button are both the transient now. Three reasons: it is one
pattern instead of two; an inline row **can scroll out of view**, so the way back disappears while
the window is still open; and a transient retires itself when the window closes, which is the only
honest way to show that a way back has expired.

The transient **floats above the reach band rather than growing the bottom inset** — the screen must
not jump twice for every set logged. It sits over the controls beneath it while the window runs,
which is a real cost and is drawn rather than hidden.

That is better than both alternatives: the row loses its button, and the closing of the window
becomes visible for the first time.

**It is built, one transient per platform, hosted by the room and not by a screen.** Android's is the
`SnackbarHost` in the room's own Scaffold, run for the queue's own window and never a snackbar
default (`GymRoom.kt:392-421`, hung on the Scaffold at `:730-735`). iOS's is hand-rolled, because
SwiftUI provides none: a
bottom transient with a draining rule, floating over the reach band and growing no inset
(`Withheld.swift:217-289`, hung on the room at `GymRoom.swift:298-303`). The web's is the design
system's Toast, carrying the window's line and its Undo (`useTrainingLog.js`, `withheld.js`). Every
row-borne undo is gone with it — the logger's text button, the session's inline row, Android's
`WithheldRow`, the web's row Undo.

Three properties the transient holds on all three, because each of them is a way it could lie:

- **No dismiss while a window is open.** It retires itself when the last clock closes, which is the
  only honest way to show that a way back has expired. A send in flight offers no Undo and keeps the
  row hidden.
- **A count never names one of several.** One held thing says which thing left; two or more can only
  be counted, because naming one would be saying the wrong thing about the rest.
- **A refusal outranks a way back.** A refusal said while a window still runs takes the transient,
  and the window's Undo is offered again once it has been read.

### 5 · Haptics are the gesture's receipt.

A gesture with no felt response is one you cannot tell succeeded, which matters most when you are not
looking at the screen.

**Both phones spend one vocabulary, one sensation per kind of act:** *light on a swipe that reveals,
medium on a save, a closing note on a finish* (`GymConfirm.swift:19-31`, `GymConfirm.kt:22-42`).
Nothing buzzes on a scroll, and nothing buzzes twice for one act — a logged set **is** a save and
spends the save's impact, which is why it is not a fourth sensation. Only the set confirmation is
gated on a preference, because that is the one the settings screen names; the other three answer to
the system's own haptics switch.

The two platforms name the sensations differently and that is native idiom, not drift: iOS spends
`.light` / `.medium` impacts and a `.success` notification, Android spends
`GestureThresholdActivate` / `Confirm` / `GestureEnd` where the API level has them. Where a constant
does not exist the fallback is the nearest one the platform **does** have, never a stronger one: an
unknown constant is silence, and a long press is not a light tick. Ledger `1z` closes here.

## The gate: a swipe-to-delete ships only where an undo already exists

This is the finding that shapes the whole wave, and it is not a matter of taste. **Every row a swipe
is ruled for clears it.** The withheld delete is one abstraction over the room's delete verbs, which
share no shape at all — a set leaves through the log or the shelf, a device-held routine through an
orphan write and an account's through the wire, a conversation is server-only, a session's discard
answers with a bool, and on the web a routine draft's line is not on the wire in the first place.
One window over all of them: `Withheld.swift`, `store/WithheldDelete.kt`, `withheld.js`.

> **Withheld means NOT SENT.** Nothing reaches the log for the length of the window, for a
> server-only verb exactly as for a set — because an Undo offered after the send would be a lie, and
> there is no undelete on any of these routes.

| Row | What deleting it does |
|---|---|
| a set in a past session | withheld 9000 ms · no confirm · Undo on the transient |
| a routine | withheld 9000 ms · its proposals go with it · Undo on the transient |
| a conversation | withheld 9000 ms · Undo on the transient |
| a finished session | withheld 9000 ms · no confirm · Undo on the transient |

**The confirmation went with the gate.** A dialog in front of an act that has an undo is the ceremony
Law 2 refuses, so the *Discard this session?* question and the sentence *There is no undoing it.* are
deleted from all three surfaces, and the discard is the same nine seconds, the same transient and the
same Undo as every other door into the act.

**And leaving keeps the window.** A pop, a tab change, a sheet closing, a screen going away: none of
them settles a held delete. The window is the room's and not the screen's — `WithheldWindow`
(`Withheld.swift:98-213`), the store's own list (`TrainingStore.kt:1296-1352`), the room's ref
(`useTrainingLog.js:87-167`) — and the transient follows the lifter. *Swipe, then press back* is an
ordinary pair of actions again and destroys nothing.

**The app leaving the foreground abandons what is still held.** The window lives only while the room
is on screen in a live process: leaving the app or losing the process puts the rows back, sends
nothing, and says nothing afterwards, because nothing happened. Nothing is persisted; deleting again
costs one stroke. The alternative — settling on the way out — would make *swipe, switch apps, come
back* destroy a row with the way back already gone, which is the exact shape this whole pattern
exists to prevent. **All three surfaces spend the rule**: iOS on `.background` and on the room going
(`Withheld.swift:190-197`, `GymRoom.swift:192`, `:207-212`), Android on `ON_STOP` and on the
composition's disposal, taking the transient down with what it was offering
(`TrainingStore.kt:1333-1339`, `GymRoom.kt:462`, `:469`), the web at the room's unmount
(`useTrainingLog.js:157-167`). What still leaves the room is the queue's drain — sets already logged,
on disk, retried — and no delete rides out with it. Ledger `2s`. **The web's trigger is narrower than
the phones' and nothing here decides whether it should be:** a hidden browser tab unmounts nothing,
so a window opened there runs its clocks out and sends. Ledger `3d`.

**The exemption for a set holds only where the durability does.** A set's delete is excused from the
abandon on iOS, and the reason is not that it is a set: it is that its hold lives in `SetQueue` on
disk, with its own held-until instant, so the delete survives the app dying and retries
(`SetQueue.swift:280-283`, `Withheld.swift:57` `isHeldOnDisk`, spent at `:196`). Android has no such
queue for a delete — a set's delete sits in the same in-memory list as every other verb — so the same
exemption there would leave it strictly worse off than the deletes that abandon: those put the row
back honestly, that one would fire into a backgrounded app, time out with nobody to read the answer,
and be dropped whichever way it went. **So Android abandons a set's delete with the rest**: one rule
for the whole window on that surface, and no silent loss. The two phones therefore differ today —
iOS retries a set's delete across app death, Android abandons it — and the item that ends the
divergence is Android's set delete riding `SetQueue` as iOS's does. Ledger `2y`.

**And a row that comes back is a NEW row.** A refused settle and an Undo both put a deleted row back
into its list, so no per-row gesture state may survive the row's absence: Android's rows build their
dismiss state with `remember` and never `rememberSaveable`, through one shared `rememberRowDismiss`
(`ui/RowSwipe.kt:45-64`), because a `LazyColumn` hands a saved state back under the item's own key and
the row would return already dismissed — spending the delete again on a stroke nobody made. Ledger
`2z` keeps the class.

**And the window holds more than one.** Each held delete carries its own clock and a second one
settles nothing; Undo takes the newest and the transient re-reads for the rest. Two rows gone in a
second — which a swipe makes ordinary — both come back.

## What shipped, and what it removed

**The set row, past session** — **one action, and it is *Delete*.** Trailing swipe, nothing on the
leading edge.

*Fix* is not the second action, and never becomes one. It **removes nothing**: tapping the row
already opens the fix sheet on both platforms, and Law 4 counts controls that come off. Two trailing
actions eat about half a 353-point row and push the set's own number and load off the leading edge,
so a lifter cannot see *which* set they are deciding about; and on Android a parked two-action lane
is not something `SwipeToDismissBox` can hold at all, since it carries one background and dismisses
at its own threshold. One action that genuinely dismisses is exactly what that component is for.

So: **tap to fix, swipe to delete** (`SessionScreen.swift:232-236`, `SessionScreen.kt:424-446`).

**And this row is the one gesture in the wave that takes nothing off the screen.** The `Delete set`
row inside the fix sheet stays on all three surfaces (`FixSheet.swift:331`, `FixSheet.kt:242-245`,
`FixSheet.jsx:131`) and both doors withhold the same nine seconds; Android's `tap to fix`
pressed-state hint stays too (`SessionScreen.kt:510`). By Law 4's own accounting that makes the set
row a convenience rather than a removal, and by Law 1's it is the row whose drawn door never depended
on a rotor or a hand-declared action to exist.

**And the two directions do not cost the same, which is why one action settles it.** A trailing
action pushes the row's leading edge under itself: the set's ordinal disappears and the load is
clipped to its tail. A leading action moves the row the other way and the ordinal survives whole.
With **two** actions revealed that mattered — a lifter was being asked to choose between them while
the row was unreadable. With **one**, there is nothing to choose between: the swipe *is* the choice,
and the row is under the thumb that swiped it.

**No full-swipe on iOS.** `allowsFullSwipe: false` on every ruled row (`SessionScreen.swift:232`,
`RoutinesScreen.swift:45`, `ThreadsScreen.swift:71`). The window holding more than one delete is no
longer the argument — it does. The row is: a trailing action pulls the row's own leading edge under
itself, so a stroke that fires **without a lift** fires over a row whose ordinal and load the lifter
can no longer read. Android's `SwipeToDismissBox` has no equivalent state — it carries one background
and settles at its own threshold, which is the shape one dismissing action is for — so there the
stroke *is* the act, and what is pinned instead is that a stroke carried the whole way across
deletes exactly once.

**The routine row** — **trailing swipe gives *Delete*** (`RoutinesScreen.swift:45-52`,
`RoutinesScreen.kt:258-269`). **Duplicate stays in the overflow, not the swipe** — for the same
reason Fix left the set row's: two trailing actions hide the row's own name behind them, and a lifter
cannot see *which* routine they are deciding about while they decide. Between them the two empty the
editor's foot, which sat **three screens deep**: Routines → the routine → Edit → scroll to the
bottom. It draws neither on any surface now — Duplicate sits in the routine row's overflow on
Android and in the editor's own head on the web and iOS, and Delete has left the editor entirely.

**The thread row** — trailing swipe gives *Delete* (`ThreadsScreen.swift:71`, `ThreadsScreen.kt:170-177`).
The constraint it trades against is real and is handled by the window rather than by a round trip:
the list is re-read from the server, so a screen drawn around an open window filters the read by what
the window holds rather than crossing a row out locally.

**The logger's today-set row** — **no swipe at all.** The drawn "Undo" text button is off the busiest
screen in the product and the transient carries both the action and the state, per Law 4. A swipe
here would be a second path to something already one tap away on a surface that is already showing —
it removes nothing, so Law 4 leaves it out.

**The refusal row** — swipe to dismiss, either direction, with the same act declared by hand for
TalkBack (`RefusalBanner.kt:54-66`). Removes its "Dismiss" button. Safe: it discards a notice, not
data.

**Walking between movements in the logger** — a horizontal swipe on the body
(`LoggerScreen.swift:87`, `:232-246`; `LoggerScreen.kt:472-494`). Removes **two chevron buttons**
from the screen a lifter looks at with a bar in their hands. The progress dots stay: they are the
position readout the swipe needs, and on Android each step is declared again as a custom action on
the title (`LoggerScreen.kt:462-467`).

Three collisions, all three answered in the build: the today-column is a nested vertical scroll, so
the stroke claims the pointer only once horizontal dominance is proven and a vertical one still
reaches the scroll; the title is a full-width tap target, so the stroke is attached above it and a
tap still opens the session; and **leaving a movement can raise a sheet, guarded by a check written
for taps** — at swipe velocity a second walk over a deviation still pending is **refused in words
that name the movement**, never allowed to overwrite the first.

**And a fourth on Android.** The logger is the *most* exposed screen to an edge-started horizontal
gesture, not the safest, because an edge stroke there is the system's back and back mid-workout would
otherwise leave the room. Its prerequisite is built: back mid-workout means **stay in the workout** —
the handler is claimed, the logger stands, and the app is never backgrounded. What Android is
genuinely clear of is the *shell's* claim: it has no shell
chrome, so there is no go-home swipe layered underneath as a simultaneous gesture. That is the iOS
risk, and it does not exist here — where, at the logger, the room reports depth zero and the shell's
edge still means home. Law 3's question is answered the same way on both: a stroke that starts inside
the system's edge strip is never the room's (`LoggerScreen.swift:235`, `:244`;
`LoggerWalk.startsInTheEdge`, `LoggerScreen.kt:475-477`).

## What does not ship, and why

**A swipe on a proposal card.** Law 2. Dismissal is irreversible.

**Swiping between tabs.** It would collide with row swipes and with the edge, and neither platform's
current navigation offers it.

**Scrubbing a chart.** Canon already rules one chart with **no scrub**; a bodyweight point is reached
by tapping it.

**Pull-to-refresh, for now.** It is available on iOS today without converting anything, but it *adds*
an action rather than removing one — nothing on either surface currently offers a refresh at all — so
Law 4 puts it at the bottom. What would remove the "Load older" button is infinite scroll, and that
is a different decision.

**A swipe in the live mirror.** There is no live mirror on either phone; it is web-only. Recorded
because it was assumed otherwise.

## What has to change underneath

Gestures are not free here, and the brief says so rather than letting a build discover it.

**The containers were converted last wave and the swipes landed on them this one.** iOS holds eight
`List`s against fifteen `ScrollView` sites across thirteen files, and every screen a swipe is ruled
for — the session, the routines list, the threads list, the log, the routine editor — is one of the
Lists, which is what made `.swipeActions` available at all. Android holds six `LazyColumn`s: the log,
the session, the routines list, the threads list, the notes list and the assembly sheet, whose swipe
is a `SwipeToDismissBox` with the non-droppable rows simply left unwrapped. Thirteen
`verticalScroll` sites remain, all of them screens no swipe is ruled for — one of them new, the fix
sheet's own, which is what lets a lifter reach Save and Delete with the keyboard up.

**What is still hand-built and should stop being ours** is now Android's alone: the long-press
reorder (the notes list, the assembly sheet), and **one** hand-rolled horizontal swipe — the routine
editor's remove-a-movement row (`RoutineBuilder.kt:312-313`), which carries its own threshold, its
own alpha ramp and a declared custom action beside it. iOS reorders through the platform's `.onMove`
everywhere it reorders (`RoutineBuilderScreens.swift:119`, `NotesScreen.swift:88`,
`JumpSheet.swift:42`).

**And one parity gap:** a routine draft can be reordered by dragging on the web and on iOS, and
cannot on Android at all.

## Where a long-press earns its place

**One long press in gym opens a menu, and it is the session row in the log** — a row whose only drawn
action is its own tap (`LogScreen.swift:146-156`, `LogScreen.kt:279-340`). It carries *Share this
workout* and *Discard session*, and it draws nothing: no `⋮` is added to a log row, because adding a
control to carry an act a menu can already hold is Law 4 backwards. Every other long press in the
room still starts a reorder drag (the notes list, the assembly sheet), and every other menu is
tapped: the routine row's overflow, the editor's, the logger's set-kind picker.

**Discard belongs in it because the gate is met.** It waited only until the withheld delete existed;
it does, so the menu item withholds the same nine seconds with the same transient and the same Undo,
and it is not the unrecoverable tap the gate refused.

**Law 1 then asks for a drawn door beside it, and both phones have one.** iOS draws
`Discard session` on the past-session screen, unconditionally (`SessionScreen.swift:153`, the control
at `:184-190`), and Android now does the same (`SessionScreen.kt:172`, `:265-279`). On Android the
three doors — that screen, the finish screen's slight-session stance (`FinishScreen.kt:394-411`) and
this long press — run through one act (`GymRoom.kt:540-545`) and print one constant
(`FinishScreen.kt:56`), so three spellings of the act cannot drift apart. The web is outside this
law, having no gesture at all; what it has instead is a gap — its `Discard session` is drawn for a
`slight` session alone (`Finish.jsx:96`), so an ordinary past workout can be discarded from no web
door. Ledger `3c`.

Still unbuilt: a long press on the routine row (*Start · Duplicate · Delete*), which would put
**Start** on the row where it does not exist today; and one on the set row, as the discoverable twin
of its swipe — which is Law 1 being satisfied by something a sighted first-timer can also find.

## Open

- **Whether dropping a movement mid-session should gain an undo.** It is already a swipe, already has
  no undo and no confirmation, and is tolerable only because the domain refuses to drop a movement
  that has sets or sits in the frozen plan. That guard is doing a lot of work quietly.
