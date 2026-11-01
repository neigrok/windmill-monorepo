# Android task design readiness

The [52-task backlog](../../androidgym_tasks/README.md) uses the current Gym and Shell Android
frames. The live Figma audit on 2026-10-25 finds every linked implementation frame marked
**✅ Ready for dev** or **🚀 In production**, except the explicitly excluded Windmill One
allowance example in task 43. Those markers describe the drawn states; they do not approve
additional states named as missing in a task. The six revised Gym flows have explicit human
approval dated 2026-10-25 in the task handoff.

Numbered dependencies still govern build order. **Ready** below means the visual contract can be
implemented after those dependencies. **Scoped** means the approved portion can proceed while
the named additional state waits. **Gate** means the task cannot be completed without the named
handoff. No status here claims implementation or runtime acceptance.

## Current release scope

Tasks **29–35, 41–42 and 44 are postponed at the user's request**. Preserve current Coach proposal/change cards, Apply/Reject controls, diff blocks, action/save receipts, review routes and outcome wording. Their existing approved drawings do not override the release exclusion.

Tasks 28 and 37 remain active for ordinary chat bubbles, composer/chrome, History and chat lifecycle. Task 37's active prerequisites are 04, 05 and 28; task 30's outcome-word changes are deferred. Keep tool-write content in its current presentation while task 35 waits. Task 49 remains active because its chips and retained draft feed chat input rather than presenting tool-action outputs.

U/P additional proposals are deferred from the current release scope and remain unapproved. A and B.2 recovery proposals still require human approval. The two canonical 08.58b signed-out access screens are ✅ Ready for dev, human-approved 2026-10-28. Z zero-set Finish is 🚀 In production with task 14. D account-deletion recovery is ✅ Ready for dev, human-approved 2026-10-25; its backend receipt/recovery prerequisite is deployed in `ac1e0c75`; Android task 48 remains pending.

## Task matrix

| Task | Design readiness | Canonical entry and scope |
|---|---|---|
| 01 | Tooling | [Android target page](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=56-2); no screen redesign. |
| 02 | Ready | [00.2 Colour roles](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-43776). |
| 03 | Ready | [00.1 Room chrome](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38215). |
| 04 | Ready | [00.4 Native parts](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38403); signed stepper integration uses the native keyboard. |
| 05 | Ready | [00.3 Transient band](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38296); resource-specific deletion, including nine-second weigh-in Undo. |
| 06 | Ready | [03.1 Workout](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036); remove remaining app-layer set kinds. |
| 07 | Ready | [03.2 Native load entry](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28178); use the native minus key and verify negative decimals on the target emulator. |
| 08 | Scoped | [02.2 Routine summary](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28969); approved unit examples can proceed; gate E covers new Cable/Kettlebell visuals. |
| 09 | Ready | [03.1 Compact rack](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036); task 07 remains a numbered prerequisite. |
| 10 | Ready | [03.3 Fix set](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29581); native signed entry follows task 07 and retains the approved sizing. |
| 11 | Ready | [03.4 This workout](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29834). |
| 12 | Removal | No replacement drawing; delete the heavier-than-plan offer and implicit retargeting. |
| 13 | Scoped | No replacement drawing for removal of free-workout start/save. Preserve the external no-routine picker; gate N applies only if replacing it. |
| 14 | Ready | [03.7 Finish](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32362), ended-early receipts and [Z zero-set outcome](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49458) are 🚀 In production. Z is human-approved 2026-10-25. |
| 15 | Ready | [04.2 Notification](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46754), plus ready Live Update and lock-screen twins. |
| 16 | Ready | [04.1 Quick Settings tile](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46694). |
| 17 | Scoped | [02.1 Routines](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27415); retain the existing MCP proposal review route under gate M. |
| 18 | Scoped | [02.6 Combined editor](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30392); native signed entry is approved. Gate E applies only to new equipment visuals; preserve current supported presentation. |
| 19 | Scoped | [02.9 Create movement](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29027); retain supported equipment values under gate E; task 18 remains a prerequisite. |
| 20 | Scoped | [05.9 Edit movement](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-6349); gate E applies only to new equipment presentation. |
| 21 | Scoped | [05.6 Record](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30001); preserve current supported-equipment presentation under gate E. |
| 22 | Ready | [05.1 Chronological log](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-39834). |
| 23 | Ready | [05.3 Workout detail](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27642); approved Log and Finish contracts apply. |
| 24 | Ready | [06.1 Weigh-in](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-31991); calendar, compact keyboard, validation and Undo specimens are ready. |
| 25 | Ready | [07.7 On this phone at the log head](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-42660); linked inspect/fix/discard and account-decision frames are ready. |
| 26 | Ready | [09.1 Notes](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39045). |
| 27 | Ready | [Shell 15a Sign in](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-1946); email, code and refused-code twins are ready. |
| 28 | Ready | [08.1 Fresh Coach](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27790); deliberate fresh entry retains drafts and pending replies. |
| 29 | Postponed from release | [08.2 Proposal card](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27854); preserve the MCP review fallback under gate M. |
| 30 | Postponed from release | [08.12 Applied proposal](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-30728); rejected, out-of-date and two-proposal states are ready. |
| 31 | Postponed from release | [08.15 Rename routine](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-37242); removal state is ready. |
| 32 | Postponed from release | [08.17 Add movement](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-37305); remove/swap/reorder states are ready. |
| 33 | Postponed from release | [08.21 Target change](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-37543); vary/ramp/rest states are ready. |
| 34 | Postponed from release | [08.29 Known no-write failure](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38166) is ready; [unknown outcome drafts](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1488-3459) need human approval. |
| 35 | Postponed from release | [08.9 Movement receipt](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28915); note and movement-detail receipts are ready. |
| 36 | Ready; implementation pending | [08.58 No seat](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28737), existing access states and canonical 08.58b [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49152) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49306) are ready; 08.58b is human-approved 2026-10-28. The separate B.2 recovery card remains unapproved. |
| 37 | Ready | [08.4 History](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28552), [08.61 Pending reply](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1442-18583) and restored draft are ready. |
| 38 | Transport; scoped visuals | Transport, durable archive and atomic local import can proceed. Approved bound-installation access uses 36’s canonical 08.58b; other undrawn anonymous-refusal and request-recovery presentations retain their separate approval gates. |
| 39 | Ready | [01.1 Setup greeting](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-4776); signed-in twin is ready. |
| 40 | Ready | [01.4 Photo composer](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-30368); native picker and signed-in twin are ready. |
| 41 | Postponed from release | [01.7 Drafts](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-8716) supports all-draft decisions; mixed account-save outcomes need a handoff. |
| 42 | Postponed from release | [01.8 Saved drafts](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32583) supports all-saved receipts; [partial receipt drafts](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1488-3460) need human approval. |
| 43 | Ready, excluded paid variant | [01.10 Anonymous allowance](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-35870) and [01.11 Account allowance](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-35979) are ready. 01.12 is 🚧 In progress and explicitly must not be built while checkout is closed. |
| 44 | Postponed from release | [01.13 After sign-in](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-36454). |
| 45 | Ready | [03.5 Hide workout](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-41318). |
| 46 | Ready | [Shell 16a You](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-1569); signed-in twin is ready. |
| 47 | Ready | [Shell 16c Sign out](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=52-1053); unconfirmed-change states are ready. |
| 48 | Design and backend prerequisite ready; Android pending | [Shell 27a Delete account](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=54-1269) through 27g and [D1–D5 recovery](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=116-754) are ready. D is human-approved 2026-10-25; backend reconciliation is deployed in `ac1e0c75`. Task 48 owns Android integration and acceptance. |
| 49 | Ready | [01.17 Coach choice](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40111); local retained-draft twin is ready. |
| 50 | Ready | [02.13 Routine history](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-39087). |
| 51 | Ready | [09.3 Connected log](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39148); explanation, empty and signed-out Notes states are ready. |
| 52 | Ready | [Shell A4 Gym](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-10131) uses the current approved rack inside its existing composition. |

## Additional handoffs

| Key | Tracked gate | Required design; implementation boundary |
|---|---|---|
| S · resolved | `android-gym-signed-load-input-design` | Native keyboard minus interaction is human-approved on 2026-10-25. Keep existing board sizing and verify negative decimal input in rack, Fix set and combined editor on the target emulator. No added app-level sign control. |
| E | `android-gym-equipment-variants-design` | Cable/Kettlebell chooser, icon and load-basis states. Existing stored values and current presentation remain valid; four approved creation examples do not narrow saved-record support. |
| Z · approved | `android-gym-empty-finish-design` | [Zero-set Finish](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49458) is 🚀 In production, human-approved 2026-10-25. No saved-workout or Coach-sharing claim. |
| N | `android-gym-no-routine-picker-design` | External/no-routine workout entry only if replacing its existing picker; task 13's routine-start cleanup proceeds. |
| M | `android-gym-mcp-proposal-row-design` | Review entry and destination for a proposal with no Coach conversation. Keep its functioning review path until a replacement is approved. |
| U · deferred from release scope, unapproved | `android-coach-uncertain-apply-design` | Awaiting confirmation, Check again and resolved Apply/removal states; no opposing decision while unresolved. Existing failure boards only establish proven no-write failures. |
| P · deferred from release scope, unapproved | `android-coach-partial-drafts-design` | Pending, saved and refused account drafts together; Retry/Reject scoped to unresolved work and durable per-draft receipts. |
| B · access approved; recovery unapproved | `android-coach-bound-installation-design` | Canonical 08.58b signed-out access retains History and Sign in with no anonymous Send; human-approved 2026-10-28. B.2 recovery of already-submitted requests remains unapproved. |
| A · unapproved | Consistency ledger 6t | Anonymous provider refusal, truncated output, invalid/unavailable installation credentials, waiting versus local saving, and truthful Stop waiting copy. Task 38 must retain the originating draft. |
| D · approved | `android-account-delete-recovery-design` | [D1–D5 recovery](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=116-754) is ✅ Ready for dev, human-approved 2026-10-25. The `account-delete-reconciliation` backend contract is deployed in `ac1e0c75`; task 48 still owns Android integration and acceptance. |

The [combined editor Load keyboard](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1452-22388)
and its [Daylight twin](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1452-22836)
are ready. Their [caption](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1452-23280)
requires the field/refusal above pinned Done and native IME insets. The intended sign interaction
uses the native keyboard’s minus key, including where simplified mock keyboards omit it.

The [extra sign-control proposal](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1481-2)
is **💡 Withdrawn**. Its 14 frames are not approved and do not supply implementation sizing or controls.

The [Gym recovery packet](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1488-3458)
contains deferred U/P drafts, unapproved B.2 recovery drafts and the approved Z zero-set Finish.
[Anonymous refusals and access](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1494-5069),
[anonymous waiting and local saving](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1494-5070)
and [Shell deletion recovery](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=116-754)
complete the recovery handoffs. D is **✅ Ready for dev** and Z is **🚀 In production**, both human-approved 2026-10-25.
U/P are deferred from this release scope and remain unapproved. A and B.2 remain **💡 Needs human review**
and do not authorize visual implementation. The approved 08.58b access screens are on the Android design page. E, N and M retain their existing supported
presentation/routes; no optional replacement is part of this review. Ready portions, domain logic
and transport work remain independent.
