# Workout on the lock screen

A lock-screen surface reads the phone's existing workout and durable queue. It must never become
a second writer. Logging uses the same domain command, owner and action identity as the app.

## iOS design

The proposed presentations are the Lock Screen banner and Dynamic Island compact, expanded and
minimal forms. Show the current movement, elapsed time since the last set, rest-target bar and
prefilled next set. The time counts up; a target is a reference, never a countdown instruction.
The in-app logger's two clocks remain governed by [feedback](../feedback-contract.md).

**Log set** is the only action and requires device authentication. Reading remains available while
locked. Do not promise that tapping a locked control writes without unlocking. Finish, Undo and PR
announcements stay in the app. A timed Undo control must not remain available after its deadline.

Bind each displayed logging offer to one pre-minted set ID. Repeated taps replay that offer; only
advancing to the next set creates a new ID. Validate owner, session and current offer before every
write. Show unsynced work honestly.

The activity stale date follows the workout's four-hour idle limit, and a stale presentation must
remove the logging action. Verify stale rendering, over-target progress, truncation, the circular
presentation and locked-action behavior on the supported device matrix before accepting this
surface. Static drawings do not establish these behaviors.

## Android contract

The current notification implementation and acceptance matrix belong to
[Android delivery](../android-delivery.md#native-acceptance). It uses a stock ongoing notification,
requests Live Update promotion where eligible and retains an ordinary-notification fallback.
Promotion remains conditional on platform, user and OEM settings.

Show the actual routine, movement and offered load/reps; no rest target or chronometer is drawn.
Log set opens the logger through an authenticated, replay-safe action into the same durable queue.
Respect dismissal, preserve in-app logging when notifications are denied, and use actual system
chrome. There is no foreground service, sensor permission, rest alert or Dynamic Island.
