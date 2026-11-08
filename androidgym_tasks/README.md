# Android gym tasks

These tasks describe the Android implementation backlog; the quality wave's design work is in [the design brief](design-brief-quality-wave.md), and the review wave's (D1–D7) in [its brief](design-brief-review-wave.md). Numbers are stable task identities, not build order. Each task's **Depends on** line and its named backend/design prerequisites govern when it can be completed.

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

Implement one commit per numbered task. Ship batches to main after adversarial review, a simplification pass, targeted tests and native/local-stack acceptance including failures and content-free events. Create coordinated Android and iOS releases after all tasks in the current release scope are complete. The user authorized the explicit Other category, uncapped finite loads and an older-client upgrade. Source carries registry 12 / minimum 11. Production's hello advertised schema 12 / minimum 11 when last read, on 2026-11-01; the [release runbook](../backend/deploy/README.md#coordinated-client-cutoff) holds the deployment receipts. The published Android release is [0.14.0](https://github.com/neigrok/windmill-monorepo/releases/tag/android-v0.14.0) (code 277), tagged `android-v0.14.0` at `3b136a3d`; the `android-v0.13.0` tag has no GitHub release. Postponed tasks do not gate a release. Update `docs/ANDROID_OBSERVABILITY.md` with the implemented boundaries and events. Mark each Figma flow **🚀 In production** only after its verified implementation is merged; design approval does not mark app delivery complete.

## Current release scope

**All 42 tasks of the original active scope are on main.** Tasks **36, 38–40, 43 and 46–49** landed with pull request [#41](https://github.com/neigrok/windmill-monorepo/pull/41) (`de637b58`) after native and local-stack acceptance, and ship in Android 0.14.0. That release's acceptance was signed out and did not re-accept #41's last fix pass natively. Their boards are 🚀 In production. Tasks 19, 25 and 50 are shipped and their frames are 🚀 In production on the canonical Android page (`56:2`).

Tasks **29–34 and 44 are postponed**: the owner keeps Android's proposal cards, review route and outcome wording (ledger 11k). The phone Coach supersedes tasks **35, 41 and 42**. Coach writes land at once with their cards, `update_exercise` is withheld, and only a retained onboarding answer still holds drafts. The task identities remain unchanged; 42 numbered tasks made up that release scope.

Task 28's general bubbles, composer and chrome and task 37's History/chat lifecycle are on main. Task 17 keeps the existing proposal review route while task 29 waits. Task 49's kept draft is composer text, and Coach asks in prose.

The additional U proposals are deferred and not approved. The two [08.58b signed-out access screens](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49152), formerly B.1, are human-approved 2026-10-28 and 🚀 In production on the Android design page. [Z zero-set Finish](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49458) is 🚀 In production with task 14. [D account-deletion recovery](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=116-754) is 🚀 In production. Both additions were human-approved 2026-10-25. Active tasks retain their remaining scoped design and backend prerequisites.

## Scoped prerequisites

These review follow-ups affect the named subparts, not all 52 tasks. Approved independent flows and shared foundations can start while the owning designer/backend work proceeds. The identifiers are tracked in the Windmill dogfood tree.

| Gate | Affected task | Work that waits |
|---|---|---|
| `android-gym-signed-load-input-design` · resolved | [07](07-number-stepper.md), [10](10-fix-set.md), [18](18-targets.md) | Use the approved native-keyboard minus interaction and original sizing; verify negative decimal entry on the target emulator |
| `android-regular-stepper-overflow-design` · resolved for unit-below layout | [18](18-targets.md), [19](19-create-movement.md) | [02.25 Load unit below](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1661-33960) is 🚀 In production, human-approved 2026-10-28. Preserve text size, native keyboard and pinned action; the older full-width/buttons-below fallback remains unapproved. |
| `android-routine-target-summary-responsive-design` · resolved 2026-11-03 | [18](18-targets.md), [87](87-large-text-everywhere.md) | [02.26 Target stacks at 320 dp · 200 %](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30891) is ✅ Ready for dev, human-approved 2026-11-03: Target and its summary stack when they do not fit on one line. The approved Load-field fix continues. |
| `android-gym-equipment-variants-design` · resolved | [08](08-units-by-equipment.md), [19](19-create-movement.md), [20](20-edit-exercise.md), [21](21-record.md) | [Canonical plain Barbell / Dumbbells / Other](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1548-7642), 🚀 In production; no Name/Equipment hints. Preserve legacy values/history. New iOS/web pickers require separate design approval. |
| `android-gym-empty-finish-design` · resolved | [14](14-finish-receipt.md) | [Z zero-set outcome](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49458) is 🚀 In production with task 14, human-approved 2026-10-25 |
| `android-gym-no-routine-picker-design` | [13](13-free-workout-start.md) | Changing the existing picker for an externally started workout without a routine |
| `android-gym-mcp-proposal-row-design` | [17](17-routines-list.md), [29](29-coach-change-card.md) | New proposal route without a Coach conversation; keep its existing review path |
| `android-coach-uncertain-apply-design` · deferred from release scope, unapproved | [34](34-proposal-long-failure-retry.md) | New unknown-outcome Apply/removal state |
| `android-coach-bound-installation-design` · resolved for access | [36](36-coach-access-states.md), [38](38-signed-out-coach.md) | Approved 08.58b retains History and Sign in; no anonymous Send. |
| `android-account-delete-recovery-design` · resolved | [48](48-delete-account.md) | [D1–D5 recovery states](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=116-754) are 🚀 In production, human-approved 2026-10-25; backend receipt/recovery is deployed in `ac1e0c75`; Android task 48 ships them in 0.14.0 |
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

Stage A is on main (`70ec2dbe`, and 70 at `5e0bb26d`); its boards 00.5, 00.6, 02.21, 03.33, 03.34 and 03.35 are 🚀 In production. Stage B's visual tasks (54, 56, 58, 60, 61, 62, 64) are on main (`ef0f05fb`); their boards 00.7, 02.20, 02.17, 03.36, 05.17 and Shell 16b are 🚀 In production, and 05.16 is deleted. 71 is on main (`33848694`). 72 and 65 are on main (`63844df3`); their boards 05.18, 27h and D6 are 🚀 In production, and so are 05.3b and its revisions 05.14b, 05.4b, 05.5b and 05.13b (the workout page's quiet set count, task 23); 05.3, 05.14, 05.4, 05.5 and 05.13 are deleted. Android 0.14.0 carries stages A and B, 65, 70, 71, 72 and the quiet set count. 68 is on main (`c124425c`) after 0.14.0 and is not yet in a published release; 67 is on main (`a925bfd9`), so tasks 53–72 are all on main. 56 uses 53's back guard; 68 follows 53 so the room is not rewritten twice; 67 and 68 are wide refactors best done when the visual tasks have landed.

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

## Quality wave (tasks 73–105)

On 2026-11-01 the dogfood tree's open Android, gym and sync nodes were checked against main (`28c3d48a`). Work already on main was closed with its evidence, and superseded work was closed as obsolete. What is still open became tasks 73–105, ordered by what a person would notice first. The wave's parent node on the tree is **Android · quality wave**. Task 67 and the 0.14.1 release are in flight and not part of the wave; the logger Back and sign-out event fixes reached main afterwards (`363feb3b`).

| Stage | Tasks, in order |
|---|---|
| A · Bugs a person can hit | [73](73-finish-after-last-set.md), [74](74-load-floor-on-every-door.md), [75](75-update-required-always-arrives.md), [76](76-reads-off-the-main-thread.md), [77](77-callbacks-held-by-identity.md), [78](78-proposal-over-a-dead-routine.md), [79](79-recovery-through-the-domain.md), [80](80-keep-the-rest-of-a-partly-landed-copy.md), [81](81-machine-reads-kg.md) |
| B · Release confidence | [82](82-release-test-account.md), [83](83-play-store-decision.md) |
| C · Accessibility | [84](84-delete-on-the-focused-row.md), [85](85-talkback-on-a-real-phone.md), [86](86-headings-talkback-can-walk.md), [87](87-large-text-everywhere.md) |
| D · Reliability | [88](88-flaky-tests.md), [89](89-alerting.md), [90](90-web-sync-noise.md), [91](91-outbox-costs-linear.md) |
| E · Cross-platform parity | [92](92-catch-up-after-a-reopen.md), [93](93-share-page-set-count.md), [94](94-web-planned-rows-offered-load.md), [95](95-one-stated-best.md), [96](96-shared-performed-range.md), [97](97-coach-read-receipt-weeks.md), [98](98-coach-during-a-workout.md) |
| F · Polish | [99](99-destructive-actions-in-red.md), [100](100-proposal-diff-unit-space.md), [101](101-capture-recipes-name-current-boards.md), [102](102-planless-movement-heading.md), [103](103-proposal-still-arriving.md), [104](104-record-before-the-first-pull.md), [105](105-quiet-set-count-follow-ups.md) |

**What each waiting task waits for**
- **A board or ruling** from the [design brief](design-brief-quality-wave.md):
  - 80 (QW5), 81 (QW6) and 94 (QW7);
  - 96's iOS screen (QW8), 97's numberless wording (QW10) and 98 (QW9);
  - 99 (QW11) and 100 (QW13);
  - 102–105 (QW1–QW4).
  Domain and backend halves can start before their board.
- **The owner:**
  - 82 needs the release test account and its mailbox;
  - 83 is the owner's decision;
  - backend halves (74, 89, 97, 98) redeploy production when pushed.

Tasks that touch iOS or web pass their own gates too: `swift test` for `GymDomain` and the iOS engine, and web's test suite.

## Nativeness wave (2026-11-08)

The owner approved the nativeness wave on 2026-11-08 with every default: the gym screens are rebuilt from stock Material 3
parts on the theme's roles and shapes ([wave NOTE](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2040-38794)).
The build covers 02.1N, 02.2N, 02.4N, 02.5N, 02.6N, 03.1N, 03.2N, 03.3N, 03.3Nk, 05.1N, 05.10N, 06.1N, 06.2N and 09.1N,
and the wave's code-only items: Material's default `Shapes` in `GymMaterial` (`ThemeRolesTests` keeps radius literals out
of gym screens), stock pill buttons, stock sheet drag handles, 16 dp cards, stock menu shapes, one press layer on the
stepper's − / +, and a time picker that follows the phone's 24-hour setting. Sheet heads share `GymSheetBar` (✕ Close and
the title); the drag handles of the editor, This workout and Notes share `GymDragHandle`. By the owner's ruling of the same day, Fix set, the movement form,
Edit movement and the weigh-in keep their commit a full-width stock pill, `GymSheetCommit`, 56 dp, at the foot of the sheet in
thumb reach and pinned above the keyboard, as the redrawn 03.3N, 03.3Nk, 02.6N, 05.10N and 06.1N draw it; the weigh-in
reads **Save weight** in both modes, and Delete set and the routine's line end Fix set's body above **Save fix**. The board recipe is
`apps/android/tools/capture-recipes/nativeness-wave.json`.

The owner rejected 09.6N (Notes signed out) and 06.9N (Correct a weigh-in) on 2026-11-08 to keep the thumb-reach
bottom action: signed-out Notes keeps its full-width **Sign in**, and the correction sheet keeps its field captions, its
fixed day, and **Save weight** and **Delete weigh-in** at its foot under the shared ✕ Close head, all on stock pill
buttons.

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
- [29](29-coach-change-card.md) — **Postponed.** The proposal card in the conversation, with a field diff (no review sheet)
- [30](30-proposal-decided-states.md) — **Postponed.** Proposal decided states: Applied, Rejected, Out of date, two proposals
- [31](31-proposal-routine-changes.md) — **Postponed.** Proposal: rename a routine, remove a routine
- [32](32-proposal-movement-changes.md) — **Postponed.** Proposal movement changes and durable applied-history diffs
- [33](33-proposal-target-changes.md) — **Postponed.** Proposal: sets, reps and load; vary by set; ramp up; rest and a first target
- [34](34-proposal-long-failure-retry.md) — **Postponed.** Proposal failures: known refusal, unknown outcome and safe reconciliation
- [35](35-coach-write-receipts.md) — **Superseded.** Coach write receipts: changed a movement, saved a note
- [36](36-coach-access-states.md) — Coach access states with server-derived retry timing
- [37](37-coach-history-sources.md) — Fresh-entry chat lifecycle, retained drafts, History, deletion and sources
- [38](38-signed-out-coach.md) — The installation credential, bound-installation handling and retained answers' atomic draft import
- [39](39-coach-greeting.md) — First open: Coach greets in two bubbles; an empty Gym opens on Coach
- [40](40-coach-photo-caption.md) — The photo in the composer and its caption
- [41](41-coach-drafts-card.md) — **Superseded.** Routine draft decisions with atomic local import and durable per-draft account outcomes
- [42](42-coach-drafts-saved.md) — **Superseded.** After Apply: receipts, one tap from Start
- [43](43-coach-allowance-used.md) — Allowance used: signed out, signed in (interim), Windmill One
- [44](44-coach-after-sign-in.md) — **Postponed.** After sign-in, the conversation continues and proposes a change
- [45](45-hide-workout.md) — Hide workout: the workout bar above the tabs, and the notification's swipe only turns it off
- [46](46-remove-gym-settings.md) — Remove Gym settings and the lb toggle; You holds Notes, Connected log, About Windmill (Shell file)
- [47](47-sign-out-asks.md) — Sign out asks first, with Keep or Discard for unconfirmed changes (Shell file)
- [48](48-delete-account.md) — Account deletion with pinned cleanup, lost-response recovery and backend prerequisites
- [49](49-coach-choices-kept-draft.md) — A draft written signed out waits as Draft kept on this phone
- [50](50-routine-history-yours.md) — The routine editor's History, and *· yours* on a movement the lifter made
- [51](51-connected-log-notes-signed-out.md) — Connected log follows iOS, names ChatGPT or Claude and says it saves notes; Notes signed out
- [52](52-onboarding-gym-glimpse.md) — Onboarding Gym glimpse uses the approved compact headerless rack
- [53](53-predictive-back-and-motion.md) — Predictive back and navigation motion: pushed screens follow the gesture, sheets keep the stock preview
- [54](54-nav-labels-and-top-bar.md) — Navigation labels stay whole at large text; the top app bar tints on scroll
- [55](55-sheets-above-the-keyboard.md) — Sheets stay below the status bar when the keyboard opens
- [56](56-routine-editor-asks-before-discard.md) — The routine editor asks before Back discards unsaved changes; Keep editing on both discard questions
- [57](57-load-zero-or-more.md) — Barbell and dumbbell loads are 0 or more on every surface; the field shows a real minus sign
- [58](58-planned-rows-offered-load.md) — Planned rows show the load the plan expects, never the word "last"
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
- [73](73-finish-after-last-set.md) — A finish never lands before the last set
- [74](74-load-floor-on-every-door.md) — The load floor holds on Coach Apply and on the server
- [75](75-update-required-always-arrives.md) — Update required always arrives, and delivery state comes from the engine alone
- [76](76-reads-off-the-main-thread.md) — Nothing the engine reads runs on the main thread
- [77](77-callbacks-held-by-identity.md) — No screen keeps a callback from an earlier composition
- [78](78-proposal-over-a-dead-routine.md) — A proposal over a dead routine reads as out of date instead of failing to decode
- [79](79-recovery-through-the-domain.md) — Signed-out workout recovery runs through the domain's actions
- [80](80-keep-the-rest-of-a-partly-landed-copy.md) — A saved copy that partly reached the server keeps the sets that did not
- [81](81-machine-reads-kg.md) — A machine's load reads kg
- [82](82-release-test-account.md) — Every release is accepted signed in, on production, with a dedicated test account
- [83](83-play-store-decision.md) — Play Store distribution: a decision for the owner
- [84](84-delete-on-the-focused-row.md) — Every swipe row offers Delete on the node TalkBack focuses
- [85](85-talkback-on-a-real-phone.md) — A TalkBack pass on a real phone, and each thing said once
- [86](86-headings-talkback-can-walk.md) — Headings TalkBack can walk
- [87](87-large-text-everywhere.md) — Every screen holds at 320 dp and 200 % text
- [88](88-flaky-tests.md) — Flaky tests fail fast and then stop failing
- [89](89-alerting.md) — Someone is told when the server is refusing or saturated
- [90](90-web-sync-noise.md) — Web reports sync failures the way both phones do
- [91](91-outbox-costs-linear.md) — A phone back from a long time offline drains its outbox in linear time
- [92](92-catch-up-after-a-reopen.md) — iOS and web catch up after a live socket reopens
- [93](93-share-page-set-count.md) — The web share page counts sets 1..N in logged order
- [94](94-web-planned-rows-offered-load.md) — The web live mirror's planned rows read the load the plan expects
- [95](95-one-stated-best.md) — The Best tile follows the stated rule the records follow
- [96](96-shared-performed-range.md) — Every surface states what was lifted, every set counted
- [97](97-coach-read-receipt-weeks.md) — What Coach read counts only weeks it can show
- [98](98-coach-during-a-workout.md) — Coach answers during a workout on Android, on the phone turn
- [99](99-destructive-actions-in-red.md) — The last three destructive actions use the error role
- [100](100-proposal-diff-unit-space.md) — A proposal's load change spaces its unit like every other readout
- [101](101-capture-recipes-name-current-boards.md) — The capture recipes name the workout page's current boards
- [102](102-planless-movement-heading.md) — A movement with no plan has a heading that leaves no gap
- [103](103-proposal-still-arriving.md) — Coach shows that its proposal is still arriving
- [104](104-record-before-the-first-pull.md) — The record page's Recent sets before the first pull
- [105](105-quiet-set-count-follow-ups.md) — The quiet set count: the owner's open questions
- [106](106-notes-and-navigation-state.md) — Notes keep separate visits, handle swipes scroll, and failed reads can retry
- [107](107-history-reads.md) — History paging belongs to its job, and opened records follow their replica
- [108](108-workout-writes-and-recovery.md) — Workout writes and recovery retain the whole saved source
- [109](109-auth-and-rest.md) — Auth failures say what happened, and REST keeps its boundaries
- [110](110-telemetry-queue.md) — Telemetry saves off the caller and dormant accounts yield capacity
- [111](111-release-mapping-headings.md) — Release mappings and accessible headings
- [115](115-faint-ink-and-sheet-width.md) — Dark faint ink clears small-text contrast; every modal sheet is bounded to 560 dp
- [116](116-coach-links.md) — Coach answer links open and keep their destinations when copied
- [117](117-workout-link-sharesheet.md) — Share a workout link through the Android Sharesheet beside Copy link

The [handoff record](../docs/engineering/android-task-handoff.md) maps the 16 review corrections to their owning tasks and records the current delivery boundaries.
