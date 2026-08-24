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

### 2 · A gesture that destroys needs an undo, not a confirmation.

A confirmation on a swipe defeats the swipe: you swiped to be quick, and a dialog puts back the tap
you just saved.

Gym already has the mechanism — **a 9000 ms window, declared once per platform** and threaded
through both stores. So the shape is swipe → gone → *"Deleted · Undo"* → really gone.

**The corollary is the load-bearing half: an act with no undo path may never be a gesture.** Turning
a proposal down settles permanently and the wire has no way back, which is exactly why closing the
review sheet decides nothing. That ruling and this law are the same rule seen twice.

### 3 · One gesture, one meaning, and never two in one place.

The system owns some strokes and the room may not take them back: **a swipe from the leading edge is
back**, a swipe down on a sheet dismisses it, a pull at the top of a scroll refreshes. Anything gym
invents starts **away from the edge**, and any screen wanting a horizontal gesture in its body must
say what happens when the stroke begins in the edge strip.

### 4 · A gesture earns its place by removing something, and the something is counted.

A swipe that adds capability but removes no drawn control has not made the screen cleaner — only less
discoverable. Every gesture below names the control that comes off. Where the answer is "none", it is
a convenience and it sits at the bottom of the list.

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

**And the undo has one slot.** A second delete *settles* the first rather than replacing it. That is
tolerable behind a two-tap trip through a sheet and dangerous behind a swipe, where two rows can be
gone in a second. Either the window holds more than one, or the second swipe is **refused with the
reason said plainly** — which is how this room already handles a refusal it can see coming.

## What ships, and what it removes

Ordered by what each one takes off the screen.

**The set row, past session** — trailing swipe gives *Fix* and *Delete*. Removes the delete button
buried inside the fix sheet, and on one platform a pressed-state hint that literally reads "tap to
fix". The only ready row.

**The routine row** — trailing swipe gives *Duplicate* and *Delete*, once the withheld delete exists.
Removes both buttons from the editor's foot, which today sit **three screens deep**: Routines → the
routine → Edit → scroll to the bottom.

**The thread row** — trailing swipe gives *Delete*, once the withheld delete exists. Removes the
delete block and its caption from inside the conversation. Note the constraint it trades against: the
list is deliberately re-read from the server rather than crossed out locally, so an optimistic swipe
needs the round trip or the undo pattern above.

**The logger's today-set row** — leading swipe gives *Undo*. Removes the "Undo" text button drawn
inside the row on the busiest screen in the product.

**The refusal row** — swipe to dismiss. Removes its "Dismiss" button. Safe: it discards a notice, not
data.

**Walking between movements in the logger** — a horizontal swipe on the body. Removes **two chevron
buttons** from the screen a lifter looks at with a bar in their hands. The progress dots stay: they
are the position readout the swipe needs.

Three collisions, all knowable: the today-column is a nested vertical scroll, so the gesture needs a
horizontal-dominance threshold; the title is a full-width tap target, so the stroke must be attached
above it; and **leaving a movement can raise a sheet, guarded by a check that was written for taps and
must be re-verified at swipe velocity.**

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

After that: the routine row (*Start · Duplicate · Delete*), which would put **Start** on the row
where it does not exist today; and the set row, as the discoverable twin of its swipe — which is Law
1 being satisfied by something a sighted first-timer can also find.

## Open

- **Whether the undo window should hold more than one delete.** A swipe makes two-in-a-second normal,
  and the single slot was sized for a slower path.
- **Whether dropping a movement mid-session should gain an undo.** It is already a swipe, already has
  no undo and no confirmation, and is tolerable only because the domain refuses to drop a movement
  that has sets or sits in the frozen plan. That guard is doing a lot of work quietly.
