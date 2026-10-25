# Android gym tasks

These 52 tasks describe the Android implementation backlog. Numbers are stable task identities, not build order. Each task's **Depends on** line and its named backend/design prerequisites govern when it can be completed.

The six revised Gym flows were approved on **2026-10-25** and their affected frames and captions are **✅ Ready for dev**. Approval covers the linked revisions, including the headerless Workout and retained weigh-in Undo; it does not approve every other Gym or Shell board in this backlog.

| Approved flow | Canonical Figma frame | Main task contracts |
|---|---|---|
| Coach | [Fresh chat](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27790) | [28](28-coach-messages-chat.md), [37](37-coach-history-sources.md) |
| Log | [Chronological entries](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-39834) | [05](05-swipe-delete-immediate.md), [22](22-the-log.md) |
| Weigh-in | [Native entry and calendar](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-31991) | [24](24-bodyweight.md) |
| Workout | [Compact rack](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036) | [09](09-rack.md), [10](10-fix-set.md), [11](11-this-workout.md), [19](19-create-movement.md) live-workout route |
| Finish | [Receipt and top overflow](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32362) | [14](14-finish-receipt.md) |
| Routine editor | [Name, equipment and targets](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30392) | [18](18-targets.md), [19](19-create-movement.md) routine route |

Before visual work, use the task's approved **✅ Ready for dev** frame and resolve any explicit missing-state design gate. Keep domain/transport work separate from a screen whose new state is not drawn. Existing source behavior and a Figma URL alone do not establish approval of a new visual state.

Implement the six approved flows as one commit per flow, with shared prerequisites in their own reviewed commits. Each flow needs adversarial review, a simplification pass, targeted tests and native/local-stack acceptance including failures and content-free events. Update `docs/ANDROID_OBSERVABILITY.md` with the implemented boundaries and events. Mark its Figma flow **🚀 In production** only after verified implementation is merged; design approval does not mark app delivery complete.

## Scoped prerequisites

These review follow-ups affect the named subparts, not all 52 tasks. Approved independent flows and shared foundations can start while the owning designer/backend work proceeds. The identifiers are tracked in the Windmill dogfood tree.

| Gate | Affected task | Work that waits |
|---|---|---|
| `android-gym-signed-load-input-design` | [07](07-number-stepper.md), [10](10-fix-set.md), [18](18-targets.md) | New explicit sign-action placement; retain a working signed-input path until approved |
| `android-gym-equipment-variants-design` | [08](08-units-by-equipment.md), [19](19-create-movement.md), [20](20-edit-exercise.md), [21](21-record.md) | New cable/kettlebell menu/icon presentation; preserve stored values and current presentation |
| `android-gym-empty-finish-design` | [14](14-finish-receipt.md) | New zero-set outcome surface; normal and ended-early receipts remain approved |
| `android-gym-no-routine-picker-design` | [13](13-free-workout-start.md) | Changing the existing picker for an externally started workout without a routine |
| `android-gym-mcp-proposal-row-design` | [17](17-routines-list.md), [29](29-coach-change-card.md) | New proposal route without a Coach conversation; keep its existing review path |
| `android-coach-uncertain-apply-design` | [34](34-proposal-long-failure-retry.md) | New unknown-outcome Apply/removal state |
| `android-coach-partial-drafts-design` | [41](41-coach-drafts-card.md), [42](42-coach-drafts-saved.md) | New signed-in partial-save/recovery states |
| `android-coach-bound-installation-design` | [36](36-coach-access-states.md), [38](38-signed-out-coach.md) | Signed-out stance for a bound installation |
| `android-account-delete-recovery-design` | [48](48-delete-account.md) | Unknown closure and pending local-cleanup states |
| `account-delete-reconciliation` | [48](48-delete-account.md) | Backend receipt/recovery across session revocation; required before shipping deletion |

Existing task-local drawing gaps remain authoritative, including anonymous refusal copy in task 38. This table does not waive them or expand approval to undrawn states.

## Execution order

Build the shared foundations first, then choose a task whose numbered and named prerequisites are satisfied. The ordering below is checked against the task dependency graph; independent work within a row may proceed in parallel. Backend or design gates written inside a task still apply.

| Stage | Tasks whose numbered prerequisites are complete in earlier stages |
|---|---|
| 1 | [01](01-design-capture-rig.md), [06](06-remove-set-types.md), [12](12-heavier-than-plan.md), [13](13-free-workout-start.md) |
| 2 | [02](02-colour-roles.md), [15](15-ongoing-notification.md) |
| 3 | [03](03-room-chrome.md), [04](04-shared-native-parts.md), [08](08-units-by-equipment.md), [16](16-quick-settings-tile.md), [27](27-sign-in-fields.md) |
| 4 | [05](05-swipe-delete-immediate.md), [07](07-number-stepper.md), [20](20-edit-exercise.md) |
| 5 | [09](09-rack.md), [10](10-fix-set.md), [14](14-finish-receipt.md), [17](17-routines-list.md), [18](18-targets.md), [21](21-record.md), [26](26-notes.md), [28](28-coach-messages-chat.md) |
| 6 | [11](11-this-workout.md), [22](22-the-log.md), [23](23-workout-detail.md), [29](29-coach-change-card.md), [50](50-routine-history-yours.md), [51](51-connected-log-notes-signed-out.md), [52](52-onboarding-gym-glimpse.md) |
| 7 | [19](19-create-movement.md), [24](24-bodyweight.md), [25](25-on-this-phone.md), [30](30-proposal-decided-states.md), [32](32-proposal-movement-changes.md), [33](33-proposal-target-changes.md), [35](35-coach-write-receipts.md), [45](45-hide-workout.md) |
| 8 | [31](31-proposal-routine-changes.md), [34](34-proposal-long-failure-retry.md), [37](37-coach-history-sources.md), [46](46-remove-gym-settings.md) |
| 9 | [38](38-signed-out-coach.md), [47](47-sign-out-asks.md) |
| 10 | [36](36-coach-access-states.md), [39](39-coach-greeting.md), [41](41-coach-drafts-card.md), [43](43-coach-allowance-used.md), [48](48-delete-account.md), [49](49-coach-choices-kept-draft.md) |
| 11 | [40](40-coach-photo-caption.md), [42](42-coach-drafts-saved.md), [44](44-coach-after-sign-in.md) |

Task 17 supplies the Routines proposal-row/navigation contract; task 29 owns activation of the conversation destination and review-sheet replacement. Task 17 does not depend back on 29. Task 38 supplies anonymous transport/import before 36 and 39–44 use it. Task 52 follows the revised rack in 09 and its Shell design handoff.

## Task index

- [01](01-design-capture-rig.md) — An emulator capture script that screenshots every board's state in Dark and Daylight
- [02](02-colour-roles.md) — Colour roles: the M3 error role in red and the Daylight accent in verdigris
- [03](03-room-chrome.md) — Room chrome: one top app bar, the account seat on every root, the navigation bar
- [04](04-shared-native-parts.md) — Shared native parts: FAB, extended FAB, error buttons, menus, the swipe row, the number stepper
- [05](05-swipe-delete-immediate.md) — Deletion by resource: confirmed workouts/conversations, immediate rows, nine-second weigh-in Undo
- [06](06-remove-set-types.md) — Remove remaining Android app set types; preserve the shipped domain migration and compatibility vectors
- [07](07-number-stepper.md) — The number stepper and the decimal keyboard replace the keypad sheet
- [08](08-units-by-equipment.md) — Equipment-aware load units and preservation of every supported equipment value
- [09](09-rack.md) — Workout: compact headerless ledger, visual position markers and native entry
- [10](10-fix-set.md) — Fix set on steppers, Delete set in red
- [11](11-this-workout.md) — This workout sheet
- [12](12-heavier-than-plan.md) — Remove the Heavier than the plan sheet
- [13](13-free-workout-start.md) — Remove the free workout: no Start logging, no first-movement start, no Save a routine
- [14](14-finish-receipt.md) — Finish: crowned Share with Coach, Done, and Discard in the top overflow
- [15](15-ongoing-notification.md) — The ongoing notification and Live Update show the time since the last set
- [16](16-quick-settings-tile.md) — Quick Settings tile for the workout
- [17](17-routines-list.md) — Routines list and empty Routines with the FAB
- [18](18-targets.md) — Name, Equipment and Targets in one staged routine movement editor
- [19](19-create-movement.md) — Create movement in a routine draft or through This workout, with explicit save ownership
- [20](20-edit-exercise.md) — Edit movement replaces Rename movement
- [21](21-record.md) — Record: Edit movement in the overflow, Earlier records, no set kinds, workouts
- [22](22-the-log.md) — Every workout and weigh-in in chronological order, with distinct record markers
- [23](23-workout-detail.md) — Workout detail
- [24](24-bodyweight.md) — Compact Weigh-in, native calendar, correction and held deletion with Undo
- [25](25-on-this-phone.md) — On this phone: the head of The log, the list, Inspect, Fix workout, Discard, the sign-in decision
- [26](26-notes.md) — Notes and the note editor
- [27](27-sign-in-fields.md) — Sign-in: outlined fields, no standing line, the server's refusal (Shell file)
- [28](28-coach-messages-chat.md) — Fresh Coach chat, stable navigation, clean composer and Material messages
- [29](29-coach-change-card.md) — The proposal card in the conversation, with a field diff (no review sheet)
- [30](30-proposal-decided-states.md) — Proposal decided states: Applied, Rejected, Out of date, two proposals
- [31](31-proposal-routine-changes.md) — Proposal: rename a routine, remove a routine
- [32](32-proposal-movement-changes.md) — Proposal movement changes and durable applied-history diffs
- [33](33-proposal-target-changes.md) — Proposal: sets, reps and load; vary by set; ramp up; rest and a first target
- [34](34-proposal-long-failure-retry.md) — Proposal failures: known refusal, unknown outcome and safe reconciliation
- [35](35-coach-write-receipts.md) — Coach write receipts: changed a movement, saved a note
- [36](36-coach-access-states.md) — Coach access states with server-derived retry timing
- [37](37-coach-history-sources.md) — Fresh-entry chat lifecycle, retained drafts, History, deletion and sources
- [38](38-signed-out-coach.md) — Signed-out Coach transport, bound-installation handling and atomic local draft import
- [39](39-coach-greeting.md) — First open: Coach greets in two bubbles; an empty Gym opens on Coach
- [40](40-coach-photo-caption.md) — The photo in the composer and its caption
- [41](41-coach-drafts-card.md) — Routine draft decisions with atomic local import and durable per-draft account outcomes
- [42](42-coach-drafts-saved.md) — After Apply: receipts, one tap from Start
- [43](43-coach-allowance-used.md) — Allowance used: signed out, signed in (interim), Windmill One
- [44](44-coach-after-sign-in.md) — After sign-in, the conversation continues and proposes a change
- [45](45-hide-workout.md) — Hide workout: the workout bar above the tabs, and the notification's swipe only turns it off
- [46](46-remove-gym-settings.md) — Remove Gym settings and the lb toggle; You holds Notes, Connected log, About Windmill (Shell file)
- [47](47-sign-out-asks.md) — Sign out asks first, with Keep or Discard for unconfirmed changes (Shell file)
- [48](48-delete-account.md) — Account deletion with pinned cleanup, lost-response recovery and backend prerequisites
- [49](49-coach-choices-kept-draft.md) — Coach asks with choice chips; a draft written signed out waits as Draft kept on this phone
- [50](50-routine-history-yours.md) — The routine editor's History, and *· yours* on a movement the lifter made
- [51](51-connected-log-notes-signed-out.md) — Connected log follows iOS, names ChatGPT or Claude and says it saves notes; Notes signed out
- [52](52-onboarding-gym-glimpse.md) — Onboarding Gym glimpse uses the approved compact headerless rack

The [handoff record](../docs/engineering/android-task-handoff.md) maps the 16 review corrections to their owning tasks and records the current delivery boundaries.
