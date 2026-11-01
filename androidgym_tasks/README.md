# Android gym tasks

These 72 tasks describe the Android implementation backlog. Numbers are stable task identities, not build order. Each task's **Depends on** line and its named backend/design prerequisites govern when it can be completed.

The six revised Gym flows were approved on **2026-10-25**. Each task records its current implementation and design status. Approval covers the linked revisions, including the headerless Workout and retained weigh-in Undo; it does not approve every other Gym or Shell board in this backlog.

| Approved flow | Canonical Figma frame | Main task contracts |
|---|---|---|
| Coach | [Fresh chat](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27790) | [28](28-coach-messages-chat.md), [37](37-coach-history-sources.md) |
| Log | [Chronological entries](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-39834) | [05](05-swipe-delete-immediate.md), [22](22-the-log.md) |
| Weigh-in | [Native entry and calendar](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-31991) | [24](24-bodyweight.md) |
| Workout | [Compact rack](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036) | [09](09-rack.md), [10](10-fix-set.md), [11](11-this-workout.md), [19](19-create-movement.md) live-workout route |
| Finish | [Receipt and top overflow](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32362) | [14](14-finish-receipt.md) |
| Routine editor | [Name, equipment and targets](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30392) | [18](18-targets.md), [19](19-create-movement.md) routine route |

Before visual work, use the task's approved **✅ Ready for dev** frame and resolve any explicit missing-state design gate. Keep domain/transport work separate from a screen whose new state is not drawn. Existing source behavior and a Figma URL alone do not establish approval of a new visual state.

Implement one commit per numbered task. Ship batches to main after adversarial review, a simplification pass, targeted tests and native/local-stack acceptance including failures and content-free events. Create coordinated Android and iOS releases after all tasks in the current release scope are complete. The user authorized the explicit Other category, uncapped finite loads and an older-client upgrade. Source carries registry 12 / minimum 11. Production's hello advertised schema 11 / minimum 11 when last verified, on 2026-10-30; the [release runbook](../backend/deploy/README.md#coordinated-client-cutoff) holds the deployment receipts. The `android-v0.13.0` tag has no GitHub release and predates tasks 19, 25, 50 and the nine below, so Android publication needs a new tag; the latest published Android release is 0.12.1. Postponed tasks do not gate this release. Update `docs/ANDROID_OBSERVABILITY.md` with the implemented boundaries and events. Mark each Figma flow **🚀 In production** only after its verified implementation is merged; design approval does not mark app delivery complete.

## Current release scope

**All 42 tasks of the original active scope are on main.** Tasks **36, 38–40, 43 and 46–49** landed with pull request [#41](https://github.com/neigrok/windmill-monorepo/pull/41) (`de637b58`) after native and local-stack acceptance; its last fix pass awaits native re-acceptance in the release. Their boards turn 🚀 In production when the release that carries them is published. Tasks 19, 25 and 50 are shipped and their frames are 🚀 In production on the canonical Android page (`56:2`).

At the user's request, tasks **29–35, 41–42 and 44 are postponed from this release**. Preserve the existing Coach action appearance: proposal/change cards, Apply/Reject controls, diff blocks and action/save receipts. Keep their existing review routes and outcome wording. The task identities remain unchanged; 42 numbered tasks made up that release scope.

Task 28's general bubbles, composer and chrome and task 37's History/chat lifecycle remain active. Task 37 does not wait for task 30's postponed outcome-word changes, and retains tool-write receipt content in its current presentation while task 35 waits. Task 17 keeps the existing proposal review route while task 29 waits. Task 49 remains active: its choices populate chat input and its kept draft is composer text, not a tool-action output.

The additional U/P proposals and A2 local-save cards are deferred from this release and are not approved. A request-recovery cards and B.2 pending-result recovery remain unapproved. The two [08.58b signed-out access screens](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49152), formerly B.1, are human-approved 2026-10-28 and ✅ Ready for dev on the Android design page. [Z zero-set Finish](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49458) is 🚀 In production with task 14. [D account-deletion recovery](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=116-754) is ✅ Ready for dev. Both additions were human-approved 2026-10-25. Active tasks retain their remaining scoped design and backend prerequisites.

## Scoped prerequisites

These review follow-ups affect the named subparts, not all 52 tasks. Approved independent flows and shared foundations can start while the owning designer/backend work proceeds. The identifiers are tracked in the Windmill dogfood tree.

| Gate | Affected task | Work that waits |
|---|---|---|
| `android-gym-signed-load-input-design` · resolved | [07](07-number-stepper.md), [10](10-fix-set.md), [18](18-targets.md) | Use the approved native-keyboard minus interaction and original sizing; verify negative decimal entry on the target emulator |
| `android-regular-stepper-overflow-design` · resolved for unit-below layout | [18](18-targets.md), [19](19-create-movement.md) | [02.25 Load unit below](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1661-33960) is 🚀 In production, human-approved 2026-10-28. Preserve text size, native keyboard and pinned action; the older full-width/buttons-below fallback remains unapproved. |
| `android-routine-target-summary-responsive-design` · postponed by human 2026-10-29 | [18](18-targets.md) | The [Target summary proposal](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1675-10931) stays unapproved on Proposals. Keep the current summary layout; its known overlap at 320 dp / 200% text is excluded from this release. The approved Load-field fix continues. |
| `android-gym-equipment-variants-design` · resolved | [08](08-units-by-equipment.md), [19](19-create-movement.md), [20](20-edit-exercise.md), [21](21-record.md) | [Canonical plain Barbell / Dumbbells / Other](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1548-7642), 🚀 In production; no Name/Equipment hints. Preserve legacy values/history. New iOS/web pickers require separate design approval. |
| `android-gym-empty-finish-design` · resolved | [14](14-finish-receipt.md) | [Z zero-set outcome](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49458) is 🚀 In production with task 14, human-approved 2026-10-25 |
| `android-gym-no-routine-picker-design` | [13](13-free-workout-start.md) | Changing the existing picker for an externally started workout without a routine |
| `android-gym-mcp-proposal-row-design` | [17](17-routines-list.md), [29](29-coach-change-card.md) | New proposal route without a Coach conversation; keep its existing review path |
| `android-coach-uncertain-apply-design` · deferred from release scope, unapproved | [34](34-proposal-long-failure-retry.md) | New unknown-outcome Apply/removal state |
| `android-coach-partial-drafts-design` · deferred from release scope, unapproved | [41](41-coach-drafts-card.md), [42](42-coach-drafts-saved.md) | New signed-in partial-save/recovery states |
| `android-coach-bound-installation-design` · resolved for access | [36](36-coach-access-states.md), [38](38-signed-out-coach.md) | Approved 08.58b retains History and Sign in; no anonymous Send. The separate B.2 recovery card remains unapproved. |
| `android-account-delete-recovery-design` · resolved | [48](48-delete-account.md) | [D1–D5 recovery states](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=116-754) are ✅ Ready for dev, human-approved 2026-10-25; backend receipt/recovery is deployed in `ac1e0c75`; Android task 48 remains pending |
| `account-delete-reconciliation` · resolved | [48](48-delete-account.md) | Backend receipt/recovery across session revocation is deployed in `ac1e0c75`; task 48 still owns Android integration and acceptance |

Existing task-local drawing gaps remain authoritative, including anonymous refusal copy in task 38. This table does not waive them or expand approval to undrawn states.

The approved three-choice equipment control also governs tasks 18 and 19: Barbell, Dumbbells and
Other, implicit 1/2/1, no count selector or Name/Equipment hints. Their existing combined-form
composition remains; those Figma frames use the approved shared control from canonical section
[1548:7642](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1548-7642).
Unchanged and name-only edits preserve all legacy equipment/count values.

## Native wave (tasks 53–72)

The 2026-10-31 review of the Android app (native experience on the emulator, code quality, and the Codex backlog) produced tasks 53–72. The owner approved their new boards on 2026-10-31: 00.5, 00.6, 00.7, 02.20, the 02.17 revision, 02.21, 03.33–03.36 and 05.17, all ✅ Ready for dev on the Android page. The owner approved task 65's boards 27h and D6 on 2026-11-01. Tasks 55, 62, 63 and 64 conform to boards that were already approved; 66–71 change no visuals. The designer renumbered the Android page the same day so that no number names two screens across the phone pages; task 66 carries the map into the repo.

| Stage | Tasks |
|---|---|
| A | [53](53-predictive-back-and-motion.md), [55](55-sheets-above-the-keyboard.md), [57](57-load-zero-or-more.md), [59](59-rack-fits-and-scrolls.md), [63](63-sign-in-code-keyboard.md), [66](66-board-renumber-references.md), [69](69-gym-owns-its-telemetry-schema.md), [70](70-sweep.md) |
| B | [54](54-nav-labels-and-top-bar.md), [56](56-routine-editor-asks-before-discard.md), [58](58-planned-rows-offered-load.md), [60](60-receipt-at-large-text.md), [61](61-undo-above-a-still-fab.md), [62](62-native-buttons-and-icons.md), [64](64-accessibility-pass.md), [71](71-one-gym-domain.md), [72](72-honest-reads-before-first-pull.md) |
| C | [67](67-theme-roles.md), [68](68-split-the-store-and-the-room.md), [65](65-delete-account-clock-and-not-deleted.md) |

Stage A is on main (`70ec2dbe`, and 70 at `5e0bb26d`); its boards 00.5, 00.6, 02.21, 03.33, 03.34 and 03.35 are 🚀 In production. Stage B's visual tasks (54, 56, 58, 60, 61, 62, 64) are on main (`ef0f05fb`); their boards 00.7, 02.20, 02.17, 03.36, 05.17 and Shell 16b are 🚀 In production, and 05.16 is deleted. 71 is on main (`33848694`), and so is 72 except the parts waiting for design (its log foot's waiting copy, board 05.18, and Routines' empty line). 56 uses 53's back guard; 68 follows 53 so the room is not rewritten twice; 67 and 68 are wide refactors best done when the visual tasks have landed.

### Working on a native-wave task

- **Read first:**
  - [AGENTS.md](../AGENTS.md)
  - [apps/android/README.md](../apps/android/README.md): toolchain, local backend, release flow
  - [tools/DESIGN_CAPTURE.md](../apps/android/tools/DESIGN_CAPTURE.md): the capture rig
  - [docs/ANDROID_OBSERVABILITY.md](../docs/ANDROID_OBSERVABILITY.md)
  - [docs/foundation/domain-kit.md](../docs/foundation/domain-kit.md), for tasks 57, 58, 71 and 72
- **Figma:**
  - Gym file `vdmdiKWrmZoS1FtcvJRf6O`, Android page `56:2`.
  - Shell file `tkI7GnS6TcZvQSDi9lwrBf`, Android page `1:6`.
  - Android numbers follow ledger 11r: no number names two screens across the phone pages.
- **The gate:**
  - Run the full `./gradlew build`, with `ANDROID_SENTRY_DSN` set to any well-formed DSN. CI runs exactly that, release unit tests and lint included. A narrower local run has turned CI red before.
  - Tasks that touch iOS (57, 58, 71) also pass `swift test` for `GymDomain`. CI pins Xcode 26.3, so keep `#expect` expressions simple and never name a closure like a method it shadows.
- **Traps:**
  - **apiBase:** an APK with a malformed `apiBase` silently falls back to production. Check `BuildConfig` before every install, and never point a build or a test at production.
  - **Parallel work:** several agents may share this machine. Use a private backend port, your own emulator instance (`-read-only -port …`) and namespaced scratch, and never stop an emulator or backend you did not start.
  - **Kotlin:**
    - Every store `catch` rethrows `CancellationException`.
    - A value with an injected source (a clock, a window length) is never read from the ambient one; Robolectric shadows only the virtual clock.
    - Compose tests wait for a condition, never a moment.
  - **Shared rules:** a domain rule lands as vectors in `packages/api-contract/gym/domain/` and passes on Kotlin, Swift and web. A rule the server also judges must hold in the C++ backend and both model servers too.
  - **Emulator limits:** on the API 37 image the notification shade draws empty pills, and `screencap` can omit the status bar. Judge those from `dumpsys`.
- **Delivery:**
  - One commit per task, then the gauntlet: an adversarial review that executes its findings, one fix pass, then native and local-stack acceptance including failures, Sentry and content-free events.
  - Once the verified implementation is on main, mark its boards 🚀 In production and delete the boards it supersedes.

## Execution order

Build the shared foundations first, then choose a task whose numbered and named prerequisites are satisfied. The ordering below includes only the active release scope and is checked against its dependency graph; independent work within a row may proceed in parallel. Backend or design gates written inside a task still apply.

| Stage | Active tasks whose numbered prerequisites are complete in earlier stages |
|---|---|
| 1 | [01](01-design-capture-rig.md), [06](06-remove-set-types.md), [12](12-heavier-than-plan.md), [13](13-free-workout-start.md) |
| 2 | [02](02-colour-roles.md), [15](15-ongoing-notification.md) |
| 3 | [03](03-room-chrome.md), [04](04-shared-native-parts.md), [08](08-units-by-equipment.md), [16](16-quick-settings-tile.md), [27](27-sign-in-fields.md) |
| 4 | [05](05-swipe-delete-immediate.md), [07](07-number-stepper.md), [20](20-edit-exercise.md) |
| 5 | [09](09-rack.md), [10](10-fix-set.md), [14](14-finish-receipt.md), [17](17-routines-list.md), [18](18-targets.md), [21](21-record.md), [26](26-notes.md), [28](28-coach-messages-chat.md) |
| 6 | [11](11-this-workout.md), [22](22-the-log.md), [23](23-workout-detail.md), [37](37-coach-history-sources.md), [50](50-routine-history-yours.md), [51](51-connected-log-notes-signed-out.md), [52](52-onboarding-gym-glimpse.md) |
| 7 | [19](19-create-movement.md), [24](24-bodyweight.md), [25](25-on-this-phone.md), [38](38-signed-out-coach.md), [45](45-hide-workout.md) |
| 8 | [36](36-coach-access-states.md), [39](39-coach-greeting.md), [43](43-coach-allowance-used.md), [46](46-remove-gym-settings.md), [49](49-coach-choices-kept-draft.md) |
| 9 | [40](40-coach-photo-caption.md), [47](47-sign-out-asks.md) |
| 10 | [48](48-delete-account.md) |

Task 17 supplies the Routines list/navigation contract while preserving the existing proposal review route. Task 29's conversation destination and review-sheet replacement are postponed; task 17 does not depend on them. Task 38 supplies anonymous transport/import before 36 and 39–44 use it. Task 52 follows the revised rack in 09 and its Shell design handoff.

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
- [29](29-coach-change-card.md) — **Postponed from this release.** The proposal card in the conversation, with a field diff (no review sheet)
- [30](30-proposal-decided-states.md) — **Postponed from this release.** Proposal decided states: Applied, Rejected, Out of date, two proposals
- [31](31-proposal-routine-changes.md) — **Postponed from this release.** Proposal: rename a routine, remove a routine
- [32](32-proposal-movement-changes.md) — **Postponed from this release.** Proposal movement changes and durable applied-history diffs
- [33](33-proposal-target-changes.md) — **Postponed from this release.** Proposal: sets, reps and load; vary by set; ramp up; rest and a first target
- [34](34-proposal-long-failure-retry.md) — **Postponed from this release.** Proposal failures: known refusal, unknown outcome and safe reconciliation
- [35](35-coach-write-receipts.md) — **Postponed from this release.** Coach write receipts: changed a movement, saved a note
- [36](36-coach-access-states.md) — Coach access states with server-derived retry timing
- [37](37-coach-history-sources.md) — Fresh-entry chat lifecycle, retained drafts, History, deletion and sources
- [38](38-signed-out-coach.md) — Signed-out Coach transport, bound-installation handling and atomic local draft import
- [39](39-coach-greeting.md) — First open: Coach greets in two bubbles; an empty Gym opens on Coach
- [40](40-coach-photo-caption.md) — The photo in the composer and its caption
- [41](41-coach-drafts-card.md) — **Postponed from this release.** Routine draft decisions with atomic local import and durable per-draft account outcomes
- [42](42-coach-drafts-saved.md) — **Postponed from this release.** After Apply: receipts, one tap from Start
- [43](43-coach-allowance-used.md) — Allowance used: signed out, signed in (interim), Windmill One
- [44](44-coach-after-sign-in.md) — **Postponed from this release.** After sign-in, the conversation continues and proposes a change
- [45](45-hide-workout.md) — Hide workout: the workout bar above the tabs, and the notification's swipe only turns it off
- [46](46-remove-gym-settings.md) — Remove Gym settings and the lb toggle; You holds Notes, Connected log, About Windmill (Shell file)
- [47](47-sign-out-asks.md) — Sign out asks first, with Keep or Discard for unconfirmed changes (Shell file)
- [48](48-delete-account.md) — Account deletion with pinned cleanup, lost-response recovery and backend prerequisites
- [49](49-coach-choices-kept-draft.md) — Coach asks with choice chips; a draft written signed out waits as Draft kept on this phone
- [50](50-routine-history-yours.md) — The routine editor's History, and *· yours* on a movement the lifter made
- [51](51-connected-log-notes-signed-out.md) — Connected log follows iOS, names ChatGPT or Claude and says it saves notes; Notes signed out
- [52](52-onboarding-gym-glimpse.md) — Onboarding Gym glimpse uses the approved compact headerless rack
- [53](53-predictive-back-and-motion.md) — Predictive back and navigation motion: pushed screens follow the gesture, sheets keep the stock preview
- [54](54-nav-labels-and-top-bar.md) — Navigation labels stay whole at large text; the top app bar tints on scroll
- [55](55-sheets-above-the-keyboard.md) — Sheets stay below the status bar when the keyboard opens
- [56](56-routine-editor-asks-before-discard.md) — The routine editor asks before Back discards unsaved changes; Keep editing on both discard questions
- [57](57-load-zero-or-more.md) — Barbell and dumbbell loads are 0 or more on every surface; the field shows a real minus sign
- [58](58-planned-rows-offered-load.md) — Planned rows show the load the rack will offer, never the word "last"
- [59](59-rack-fits-and-scrolls.md) — The rack fits its number, scrolls as one at large text, and keeps a typed value when focus moves
- [60](60-receipt-at-large-text.md) — The Finish receipt opens full height at large text and never hides Performed
- [61](61-undo-above-a-still-fab.md) — Undo rises above a Weigh-in button that never moves, for the system's accessibility timeout
- [62](62-native-buttons-and-icons.md) — Real Material buttons, a real disabled Log set, icons instead of text chevrons
- [63](63-sign-in-code-keyboard.md) — Sign-in: a digit keyboard for the code, autofill for email and code
- [64](64-accessibility-pass.md) — Accessibility pass: status lines announced, 48 dp targets, labels said once
- [65](65-delete-account-clock-and-not-deleted.md) — Delete account: the wrong-clock refusal (27h) and a way out when nothing was deleted (D6)
- [66](66-board-renumber-references.md) — Repo references follow the renumbered Android boards
- [67](67-theme-roles.md) — Type and colour come from the theme's roles
- [68](68-split-the-store-and-the-room.md) — Split TrainingStore into feature stores; screens take state and events
- [69](69-gym-owns-its-telemetry-schema.md) — Gym owns its event schema; the observability doc is complete and checked
- [70](70-sweep.md) — Sweep: deprecated APIs, dead code, warnings and stale references
- [71](71-one-gym-domain.md) — One gym domain: the last app-side rules move into :gym:domain; the presentation package says what it is
- [72](72-honest-reads-before-first-pull.md) — Before the first pull, nothing counts or claims from partial history

The [handoff record](../docs/engineering/android-task-handoff.md) maps the 16 review corrections to their owning tasks and records the current delivery boundaries.
