# Android Gym task handoff

The [52-task backlog](../../androidgym_tasks/README.md) describes implementation work. The six revised
Coach, Log, Weigh-in, Workout, Finish and Routine editor flows were human-approved on 2026-10-25;
92 affected frames and 46 captions are **✅ Ready for dev**. This task correction changes documents,
not Android behavior. Other Gym/Shell states retain their own design status and prerequisites.

## Corrected contracts

| Review issue | Task owner | Required contract |
|---|---|---|
| Apply response lost after a write | [34](../../androidgym_tasks/34-proposal-long-failure-retry.md) | Separate known refusal from unknown outcome; reconcile the same command and block an opposing decision while unresolved. |
| Account deletion response lost | [48](../../androidgym_tasks/48-delete-account.md) | Pin the cleanup account, dispose of every sign-out hold and satisfy the named backend recovery contract before shipping. |
| Separate Targets and premature movement save | [18](../../androidgym_tasks/18-targets.md), [19](../../androidgym_tasks/19-create-movement.md) | One Name/Equipment/Targets editor stages changes; the outer routine Save uses the existing `SaveRoutinePlan`. |
| Top Bodyweight card and omitted weigh-ins | [22](../../androidgym_tasks/22-the-log.md) | Every factual weigh-in remains in chronological order; decorative record/month selection cannot suppress it or invent its time. |
| Fresh Coach entry discards drafts | [28](../../androidgym_tasks/28-coach-messages-chat.md), [37](../../androidgym_tasks/37-coach-history-sources.md) | A deliberate entry starts a fresh chat, retains drafts/history and routes a pending response to its originating chat. |
| Obsolete workout count, arrows and ledger head | [09](../../androidgym_tasks/09-rack.md), [52](../../androidgym_tasks/52-onboarding-gym-glimpse.md) | Headerless compact rows and visual position markers; Add movement remains in This workout. |
| Global deletion cleanup removes weight Undo | [05](../../androidgym_tasks/05-swipe-delete-immediate.md), [14](../../androidgym_tasks/14-finish-receipt.md), [24](../../androidgym_tasks/24-bodyweight.md), [37](../../androidgym_tasks/37-coach-history-sources.md) | Delete by resource; preserve the nine-second held weigh-in deletion and the machinery it uses. |
| Bound installation used anonymously | [38](../../androidgym_tasks/38-signed-out-coach.md) | Keep binding state and credential, handle `device_bound`, and recover pending results without resetting the lifetime allowance. |
| Multi-routine import described as atomic without a batch | [38](../../androidgym_tasks/38-signed-out-coach.md), [41](../../androidgym_tasks/41-coach-drafts-card.md) | Anonymous import and receipt commit together; account confirmations retain per-draft outcomes and retry only unresolved work. |
| Applied movement diff reads the new order | [32](../../androidgym_tasks/32-proposal-movement-changes.md) | Retain original comparison metadata and use existing domain `ProposalDiff` matching while pending. |
| Cable/kettlebell lost by a four-option menu | [08](../../androidgym_tasks/08-units-by-equipment.md), [19](../../androidgym_tasks/19-create-movement.md), [20](../../androidgym_tasks/20-edit-exercise.md) | Preserve every supported stored equipment value; approved creation choices are a separate constraint. |
| Signed decimal entry | [07](../../androidgym_tasks/07-number-stepper.md), [18](../../androidgym_tasks/18-targets.md) | Use the native keyboard's minus key, as confirmed by the user, and verify negative decimal entry on the target emulator. No additional app-level sign control. |
| Discard remains beside primary Finish actions | [14](../../androidgym_tasks/14-finish-receipt.md) | Crowned Share with Coach and Done are the main actions; Discard lives in the native top overflow. |
| Weigh-in calendar/IME acceptance absent | [24](../../androidgym_tasks/24-bodyweight.md) | Native calendar confirmation/cancellation, compact IME layout, validation and recreation preserve the staged weight/date. |
| Constant two-hour cap message | [36](../../androidgym_tasks/36-coach-access-states.md) | Use server timing and a nonnumeric fallback when unavailable. |
| Domain set-kind migration commissioned twice | [06](../../androidgym_tasks/06-remove-set-types.md) | Remove remaining app-layer kinds and filters; retain the shipped domain behavior and legacy-input vectors. |

## Implementation boundaries

`SaveRoutinePlan` already owns one routine's atomic metadata/target edits. It is neither the standalone
Record movement edit action nor a multi-routine import transaction. The task owners must keep those
three save boundaries distinct. Proposal screens adapt the existing domain diff and shared vectors;
they do not introduce a competing formatter or reconstruct historical facts from mutable current rows.

The task dependency graph is acyclic. Routines task 17 establishes the row and navigation contract;
Coach task 29 activates its destination. The signed-out transport/import in 38 precedes its visible
consumers. Numeric task identity is not a build order, and an explicit backend or design prerequisite
is not satisfied by completing an unrelated numbered task.

The missing-state design gates and account-deletion recovery prerequisite are tracked in the task
contracts and the [design consistency ledger](../design/consistency.md). They must be resolved for
their affected flow; they do not prevent independent foundations or approved flow work from starting.

Runtime verification belongs to implementation: local engine/backend cases, native keyboard and
recreation, TalkBack, small phones, pending/failed writes and privacy-safe telemetry. Documentation
checks validate task coverage, links, dependency order and consistency; they do not establish that
the Android app behaves as these tasks require.
