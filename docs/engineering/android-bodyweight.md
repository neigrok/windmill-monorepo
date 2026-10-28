# Android Bodyweight

The form uses native outlined input, DatePickerDialog, standard segmented controls and the existing
error-toned text button. The normal 360 × 800 form is content-sized near 314 dp; native supporting
text grows the error state near 340 dp. Large text and constrained IME viewports scroll the editor
while keeping actions reachable. A shared 24 dp handle serves the Log and correction hosts, which
disable extra host content insets; the form owns remaining IME/navigation padding once.

Weight text, selected day and edited validation state survive recreation. The native calendar owns
its staged day, displayed month/year and calendar/input mode; confirmation only commits the form
date. Cancellation paths preserve raw weight and the committed day. Corrections cannot change their
key. One submission guard feeds the existing store save, and identical repeated refusals unlock
retry without discarding the draft.

Both weight swipe surfaces and correction Delete use the existing durable engine hold. Navigation
keeps its receipt and deadline; Undo restores the exact fact. Fresh Account wrappers with the same
origin, user and identity revision retain only current engine-backed weight receipts. Reconnect
validates their replica and offer after projection inside the connection failure boundary; the offer
supplies its original deadline. Existing expiry/release/restart and
rewrite tests remain, with cross-screen navigation, failed-hold and refused-release coverage. There
is no extra weight timer, delete transport or confirmation dialog.

The simplification pass removes the custom chip treatment from the native segmented row, the
calendar's redundant vertical scroll wrapper and duplicated layout imports. Validation is derived
from the retained raw value, and only the first visible validation sentence is shown. Recovery stays
in the shared engine/store path instead of being duplicated in the screen.

Compact/error measurements, double-text constrained viewports, calendar modes/staging/dismissal,
nullable correction state, refusal retry and cross-screen failure checks pass. The held-weight suite
passes 15 cases without skips, including fresh caller wrappers, changed origin/revision, released or
expired offers, owner changes and a controlled read failure reported as gym.connect. Capture tooling
passes 31 cases. The root integration gate owns the composed aggregate result and its qualifications.

Installed paired ordinary states and changed-date flows pass. Cancel preserves raw weight/date; Use
date, reopen and recreation retain the changed selection; native Save reaches that day while all six
prior facts remain unchanged. Recreation retains the exact outbox offer/deadline, and cross-screen
Undo restores the row before expiry with server facts unchanged. Hierarchy query start/return and
client/collector clocks remain distinct in the retained timing evidence. Native SDK session intake
and deterministic failure-reporting tests are separate receipts; no native unexpected Issue is claimed.

Account wrappers are referential caller values. Weight recovery uses explicit authority fields and
the current engine offer, while the other connection resets keep their existing ownership semantics.
