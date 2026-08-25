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
putting the same actions in the overflow. The routine row is in that position today; the set row is
not, and has to declare its action by hand. Check the row, not the platform.

### 2 · A gesture that destroys needs an undo, not a confirmation.

A confirmation on a swipe defeats the swipe: you swiped to be quick, and a dialog puts back the tap
you just saved.

Gym already has the mechanism — a window, declared once per platform. So the shape is swipe → gone →
*"Deleted · Undo"* → really gone.

**But it is not one window, and this brief said it was.** The phones hold a delete for **9000 ms**
(`SetQueue.swift:48`, `SetQueue.kt:51`); the **web holds it for 5000** (`fix.js:9`, `UNDO_MS`, with
`useTrainingLog.js:16` pinning the toast to the same span by comment). `ARCHITECTURE.md:1078` states
*"The undo window is 9000 ms on every surface"*, and that has never been true.

It matters here more than it looks: the gate above says a swipe ships only where an undo already
exists, and on the web a lifter gets **four fewer seconds** than every document in this project
promises them. **Reconciling the two is a prerequisite of any web swipe, not a detail of it.**

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
discoverable. Every gesture below names the control that comes off. Where the answer is "none", it is
a convenience and it sits at the bottom of the list.

**And the law as first written was wrong in a way worth keeping visible.** It counted the control
that disappears and not the *state that control was carrying*. Removing the drawn "Undo" from the
logger's set row takes away the only on-screen signal that the nine-second window is open at all —
the undoable row becomes identical to the settled one, and the lifter cannot tell whether they still
have a way back.

> **So when an action leaves a row, its state goes to the transient surface the platform already
> owns** — an Android snackbar, an iOS bottom transient — which carries the action AND the fact that
> a window is open, and retires itself when the window closes.

**And the undo lives there on every surface, not only where a swipe displaced it.** The session
screen draws its undo as an inline row today and the logger draws a button in the row; after this
both are the transient. Three reasons: it is one pattern instead of two; the inline row **can scroll
out of view**, so the way back disappears while the window is still open; and a transient retires
itself when the window closes, which is the only honest way to show that a way back has expired.

The transient **floats above the reach band rather than growing the bottom inset** — the screen must
not jump twice for every set logged. It sits over the controls beneath it while the window runs,
which is a real cost and is drawn rather than hidden.

That is better than both alternatives: the row loses its button, and the closing of the window
becomes visible for the first time. Note gym has **no snackbar at all** today on Android — one
mono status line above the rail is the whole messaging system — so this and the native-idiom brief
are asking for the same thing.

### 5 · Haptics are the gesture's receipt.

A gesture with no felt response is one you cannot tell succeeded, which matters most when you are not
looking at the screen.

**Gym ships exactly one haptic today** — the set confirmation, gated on a preference. There is no
vocabulary yet. The three-part one — *light on a swipe, medium on a save, success on a finish* — is
Lift's, recorded on the parked lock-screen node, and this wave adopts it as intent. The two phones
also disagree about the one haptic they have; see the ledger. Nothing buzzes on a scroll, and nothing
buzzes twice for one act.

## The gate: a swipe-to-delete ships only where an undo already exists

This is the finding that shapes the whole wave, and it is not a matter of taste.

**Exactly one row in gym is ready today: the set row in a past session.** Both platforms already hold
a delete for 9000 ms — iOS deletes and offers a restore, Android withholds the send entirely — and
both already draw an undo row. A swipe there is safe on the day it ships.

**Three rows are not ready, and a swipe on any of them would put an unrecoverable delete one careless
thumb away:**

| Row | What deleting it does today |
|---|---|
| a routine | fires immediately, no confirm, no undo — and on one platform it cascades the proposal ledger |
| a conversation | fires immediately, no confirm, no undo |
| a finished session | fires immediately, and the copy correctly says *"There is no undoing it."* |

> **Ruling: those three get a withheld delete before they get a gesture.** The pattern already exists
> — Android's withheld-delete generalises cleanly — and until it does, those rows keep their drawn
> buttons. A gesture is not worth an unrecoverable loss.

**And leaving commits.** Navigating away from the session settles the withheld delete immediately,
and nothing on screen says so. Behind a two-tap trip through a sheet that is survivable; behind a
swipe it means *swipe, then press back* — a completely ordinary pair of actions — destroys the row
while the undo is still nominally on screen. Either leaving keeps the window, or the act of leaving
says what it just did.

**And the undo has one slot.** A second delete *settles* the first rather than replacing it. That is
tolerable behind a two-tap trip through a sheet and dangerous behind a swipe, where two rows can be
gone in a second. Either the window holds more than one, or the second swipe is **refused with the
reason said plainly** — which is how this room already handles a refusal it can see coming.

## What ships, and what it removes

Ordered by what each one takes off the screen.

**The set row, past session** — **one action, and it is *Delete*.** Trailing swipe, nothing on the
leading edge.

*Fix* was in the first draft and comes out, because it **removes nothing**: tapping the row already
opens the fix sheet on both platforms. Law 4 counts controls that come off, and Fix comes off
nothing. Dropping it solves two more problems at once — two trailing actions ate about half a
353-point row and pushed the set's own number and load off the leading edge, so a lifter could not
see *which* set they were deciding about; and on Android a parked two-action lane is not something
`SwipeToDismissBox` can hold at all, since it carries one background and dismisses at its own
threshold. One action that genuinely dismisses is exactly what that component is for.

So: **tap to fix, swipe to delete.** It removes the delete button buried inside the fix sheet, and on
one platform a pressed-state hint that literally reads "tap to fix". The only ready row.

**And the two directions do not cost the same, which is why one action settles it.** A trailing
action pushes the row's leading edge under itself: the set's ordinal disappears and the load is
clipped to its tail. A leading action moves the row the other way and the ordinal survives whole.
With **two** actions revealed that mattered — a lifter was being asked to choose between them while
the row was unreadable. With **one**, there is nothing to choose between: the swipe *is* the choice,
and the row is under the thumb that swiped it.

**No full-swipe.** A swipe carried all the way through, triggering without lifting, is off until the
undo window holds more than one delete — otherwise the fastest possible gesture is the one most
likely to settle a previous delete the lifter has not noticed yet.

**The routine row** — **trailing swipe gives *Delete***, once the withheld delete exists.
**Duplicate goes to the overflow, not the swipe** — for the same reason Fix left the set row's: two
trailing actions hide the row's own name behind them, and a lifter cannot see *which* routine they
are deciding about while they decide. It also costs nothing to put it there, because that row already
carries an overflow control, which satisfies Law 1 for free. Between them the two removes both buttons
from the editor's foot, which today sit **three screens deep**: Routines → the routine → Edit → scroll
to the bottom.

**The thread row** — trailing swipe gives *Delete*, once the withheld delete exists. Removes the
delete block and its caption from inside the conversation. Note the constraint it trades against: the
list is deliberately re-read from the server rather than crossed out locally, so an optimistic swipe
needs the round trip or the undo pattern above.

**The logger's today-set row** — **no swipe at all.** The drawn "Undo" text button comes off the
busiest screen in the product, and the transient takes both the action and the state, per Law 4. A
swipe here would be a second path to something already one tap away on a surface that is already
showing — it removes nothing, so Law 4 leaves it out.

**The refusal row** — swipe to dismiss. Removes its "Dismiss" button. Safe: it discards a notice, not
data.

**Walking between movements in the logger** — a horizontal swipe on the body. Removes **two chevron
buttons** from the screen a lifter looks at with a bar in their hands. The progress dots stay: they
are the position readout the swipe needs.

Three collisions, all knowable: the today-column is a nested vertical scroll, so the gesture needs a
horizontal-dominance threshold; the title is a full-width tap target, so the stroke must be attached
above it; and **leaving a movement can raise a sheet, guarded by a check that was written for taps and
must be re-verified at swipe velocity.**

**And a fourth on Android, which is the opposite of what this brief first said.** Mid-workout the room
hands back to the platform — its handler is enabled only when a session is *not* live — so an edge
stroke during a workout is plain system back and **it leaves the room.** The logger is therefore the
*most* exposed screen to an edge-started horizontal gesture, not the safest. A predictive back handler
on the live logger is a **prerequisite** of this gesture, not a nicety. What Android is genuinely
clear of is the *shell's* claim: it has no shell chrome, so there is no go-home swipe layered
underneath as a simultaneous gesture. That is the iOS risk, and it does not exist here.

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

**iOS has two `List`s and eleven `ScrollView` screens.** `.swipeActions` requires a `List`. So the
Session, Routines and Threads screens convert before they can carry a swipe — and the session's
grouping by movement means sections, not a flat list.

**Android has one `LazyColumn` in the whole room** and every swipe in it is hand-built on raw pointer
input with a hand-tuned threshold and a hand-drawn alpha ramp. The containers convert, and the
bespoke swipes become the platform's — the assembly sheet is the cheapest win, since it is already
lazy.

**Two gestures the platform owns that gym re-implements** should simply stop being ours: the
hand-built long-press reorder, and the hand-built navigation stack with its drawn back button and no
interactive pop at all.

**And one parity gap the audit found:** a routine draft can be reordered by dragging on iOS and
cannot on Android at all.

## Where a long-press earns its place

There is no context menu anywhere in gym on either platform. The highest-value one is not a
duplicate of a swipe — it is the **session row in the log**, which today has exactly one action.
*Share this workout* currently lives only inside the session, and discarding one lives only on the
finish screen. A long-press puts both on the row without drawing anything.

**But the menu ships with *Share this workout* alone.** Discarding a session is exactly the
unrecoverable delete the gate above withholds a gesture from, and a menu item is a tap that reaches
it in one — so it waits for the withheld delete like everything else. A confirmation would not rescue
it: Law 2 refuses a dialog on a gesture, and a menu item is already a tap.

After that: the routine row (*Start · Duplicate · Delete*), which would put **Start** on the row
where it does not exist today; and the set row, as the discoverable twin of its swipe — which is Law
1 being satisfied by something a sighted first-timer can also find.

## Open

- **Whether the undo window should hold more than one delete.** A swipe makes two-in-a-second normal,
  and the single slot was sized for a slower path.
- **Whether dropping a movement mid-session should gain an undo.** It is already a swipe, already has
  no undo and no confirmation, and is tolerable only because the domain refuses to drop a movement
  that has sets or sits in the frozen plan. That guard is doing a lot of work quietly.
