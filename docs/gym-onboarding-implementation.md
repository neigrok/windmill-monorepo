# Gym Coach onboarding

Gym setup uses the existing Coach room. Signed-in requests use the account Coach contract;
anonymous iOS requests use a server-issued installation credential and bounded conversation
context. Coach can return text without routines. Returned routines remain drafts until the human
reviews and saves them. Account confirmation persists server-held drafts; anonymous confirmation
imports the returned collection atomically on the phone.

## Design sources

The current interaction contract is
[Gym and Coach feedback](design/gym/feedback-2026-10-21.md), with the room rendering in
[iOS redesign](design/ios/ios-redesign.md) and shared behavior in the
[Coach brief](design/gym/briefs/09-coach.md).

The drawing references live in
[Gym onboarding · Coach-led](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1081-565)
on [Gym · iOS](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=11-2).
The [iOS READ ME](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=11-25)
links to this flow. The drawings need the interaction updates recorded in the
[consistency ledger](design/consistency.md); their presence does not establish parity with the build.

| Drawing reference | Required current behavior |
| --- | --- |
| [Entry · 1081:607](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1081-607) | Conversational greeting, Add screenshot and Build myself |
| [Conversation · 1081:858](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1081-858) | Ordinary dialogue, without goal fields or mandatory choices |
| [Routine results · 1081:800](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1081-800) | Review pending drafts before explicit Save; creation receipts follow persistence |
| [Program result · 1081:925](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1081-925) | Anonymous device ownership, retained draft and explicit save |
| [Routine to workout · 1081:829](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1081-829) | Open the saved routine, then start its workout |

“Only on this phone” and “Keep it” belong to anonymous results. Screenshots are user attachments,
not bundled illustrations. The current native attachment control uses `photo.badge.plus`; the
builder action uses `plus`. Room controls reuse Theme, system typography and native navigation.

## Current interaction

An eligible empty Gym account opens Coach. The local greeting explains that Coach can help plan
training and understand the log, without claiming to have read it. Add screenshot opens the photo
picker; Build myself opens the routine builder. The greeting and actions stay together at the top
of scrollable content and can scroll fully above the composer at accessibility text sizes.

There is no goal form, required equipment/days questionnaire, Just log action or standing allowance
line. The existing composer accepts conversation and attachments. The welcome remains until the
first accepted message; picker dismissal, tab changes, relaunch and refused or failed sends retain
it. An attachment-only message counts. The local greeting makes no provider call.

Active workouts, account transitions, adoption and restored conversations take precedence over
automatic setup. The manual builder remains available independently of Coach. Empty Routines has
one bottom-trailing plus, without a central setup action or duplicate toolbar plus.

Coach-created routines first appear as pending drafts. Review shows their movements, equipment and
set targets. Save routine or Save routines is the only creation commit. Closing review retains the
draft. Only a successful commit yields Routine created and Open routine. Existing-routine changes
retain their separate Review/Apply path; external MCP authorization is a separate entry point.

Exhausted anonymous access offers Sign in while keeping the draft and attachment. Signed-in
non-One access can open Windmill One information, which states that subscriptions are unavailable
while checkout is closed. No surface offers an enabled purchase action or promises that sign-in
immediately restores capacity. Admission remains server-controlled.

Silence between streamed deltas is not a connection failure. Reconnecting indicates an actual
transport failure; recovery resumes the same logical turn and clears the warning. Terminal failure
preserves partial output and offers retry. Anonymous Stop cancels local waiting, explains that the
request may still finish, and keeps the same request recoverable.

## Structure

- GymRoom owns destination selection, account-scoped entry preference and manual routes.
- CoachTab composes the welcome, conversation, attachment controls and navigation from results.
- CoachConversation owns the seat-scoped persisted draft, first-message state, explicit send and
  retained pending routine drafts. Clients never infer creation from generated prose.
- Signed-in Coach creation stores durable server-held drafts. Explicit confirmation validates the
  current request and returns factual creation receipts, with stable identities for retry.
- Anonymous requests carry bounded recent conversation context and inline image data when supplied.
  Installation identity, request recovery and account identity remain separate boundaries.
- The Gym domain imports an explicitly confirmed anonymous routine collection and its replay
  receipt in one Plan. Account adoption owns the resulting local routines. Local Coach history and
  photos follow the same Add/Discard decision, without promising cloud chat backup.

Installation credentials are separate from account credentials, so ordinary sign-out cannot reset
the trial. Binding waits for credential issuance already in flight. IPv6 rate limits group a /64.
Technical request slots remain separate from lifetime USD balance; a temporary free-pool pause
must not permanently consume trial access. Recovery tombstones prevent a second dispatch.

A retained response survives local persistence failure and can be saved again without another
provider request. Seat checks guard both response handling and the domain commit. Disabling new
anonymous admission preserves account binding and saved-result recovery. A rejected installation
credential does not reopen the trial; transport or accounting failures still prevent dispatch until
binding can be resolved.

## Verification boundary

Current feedback verification uses deterministic local-provider fixtures. It exercises draft review
and explicit save without establishing live-model conversation quality or provider behavior.
Protocol and persistence checks are distinct from rendered acceptance; screenshots cannot prove
retry idempotency, event delivery or durable account adoption.

Actual native captures have been inspected for the light and dark Coach welcome, the largest-text
welcome actions above the composer, light and dark routine-review button contrast, workout reflow,
equipment editing with the keyboard open, one-dumbbell load labels and renamed workout history.
The completed largest-text review capture shows the final Lat Pulldown target, Set 3 · 10 reps,
fully above Save routines. Its targeted native check passes hittability and at least 28 pt of
clearance. The corrected web draft-review and saved-receipt captures have also been inspected.

No physical-device timing or haptic behavior, VoiceOver auditory navigation, smallest-phone matrix,
or Live Activity Lock Screen/Island rendering is established by those captures. Two-dumbbell
selection has functional native coverage; the inspected rack capture shows One. Current acceptance
does not inherit a previous release's test totals, live-provider run or TestFlight status.

## Release compatibility and maintenance

Routine confirmation requires a client that renders `routineDrafts` and invokes explicit
confirmation. Coordinate backend and client availability or provide update guidance before an
older client receives an unusable pending draft. Silent creation is not a compatibility fallback.

Keep setup within the Coach conversation and reuse one receipt shape for single or multiple
creations. Entry preference stays separate from content; deleting a routine must not reset a
person's navigation choice. Semantic UI targets and gestures inside visible scroll content avoid
mistaking a pinned action for the list during tests.

Cross-file Figma moves change node IDs. Preserve the verified destination map in
[Figma organization](figma-organization.md) when updating links; moving boards does not resolve
copy, binding or interaction gaps. Current drawing work remains in the consistency ledger.
