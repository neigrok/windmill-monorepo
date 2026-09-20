# Android gym design

The approved editable design lives in [Android · Screens](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=56-2),
at the original Android page URL. Its shared controls live in
[Android · Components](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=656-3),
and behavior contracts and stress specimens live in
[Android · Specifications](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=673-9987).
Implementation coverage is tracked in `android-delivery.md` and the repository `worklog.md`.
Wave 1 implements shared chrome, system palettes, Settings and the approved control removals.
Wave 2 implements routines, target editing, duplication, independent Undo and movement creation
from planning or quick logging. Wave3 implements planned/free training, offline recovery, correction,
receipts, sharing and save as routine, with native and real-backend verification. Log, Coach and
the wider native behavior audit remain assigned to later delivery waves.

## Screen library

The base library contains 90 phone screens and states in eight named sections; the feedback section adds eight representative interaction/theme specimens. Routines, Log and Coach
are together at the top; Create movement has its own section immediately below.

| Section | States | Coverage |
|---|---:|---|
| [Start here](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=686-2) | 3 | Routines, Log and Coach roots |
| [Routines](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=686-3) | 22 | Empty, detail, create, edit, movement picker, targets, fill, duplicate, delete and Undo |
| [Create movement](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=686-4) | 6 | Empty and ready forms, routine insertion and immediate logging |
| [Log](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=686-5) | 8 | Empty, movement record, rename, bodyweight, weigh-in correction and removed workout |
| [Coach](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=686-6) | 15 | Conversation, read receipt, history, notes, sign-in door, review, apply and turn down |
| [Account](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=686-7) | 6 | Settings, account sheet, sign-in, email code and connected log |
| [Log sets](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=686-8) | 15 | Planned and free sessions, Daylight, numeric entry, session assembly, refusal, offline queue and notification specimens |
| [Review and finish](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=686-9) | 15 | Complete and partial receipts, matching records, set correction/removal, sharing and save as routine |

Seven prototype starts open Routines, Log, Coach, Create movement, Start workout, Quick logging
and Settings. Shared navigation stays on the screen page; component state changes stay in the
component library. Redundant source boards and the empty staging page are removed. Current flows,
contracts and ten computed text-scale specimens are retained on the three Android pages.

## Form

- Ease of use leads: one primary action, fixed in the reach band during training.
- Android owns navigation bars, top app bars, sheets, back behavior and system notifications.
  Routines, Log and Coach are the three destinations; the account seat belongs in the top bar.
- Windmill owns the weight readout, plate ladder, set progress and factual training record.
  Flat surfaces, restrained borders and space establish hierarchy.
- Controls have at least 48 dp targets. The logger's primary is 64 dp. Reference phones are
  412 × 915, with 24 dp status and gesture insets; runtime insets must come from Android.
- Actions use at most three words; labels at most two. Remove explanatory chrome when the control
  already communicates its purpose. Keep consequential disclosures where the decision happens.
- Figma uses Nunito for interface text, Baloo 2 for the logger's display numeral and JetBrains Mono
  for instrument facts. These remain design stand-ins: Android currently uses system sans and mono.
- Shared components bind to Gym · Colour. Instrument uses the existing mint accent. Daylight
  specimens use the existing mode; the open Daylight accent issue remains `consistency.md` F44.
- Press feedback and the visual saved state are brief. Saving a set uses no sound or vibration;
  Settings has no Sound or Haptic set-confirmation controls. Ordinary Android gesture feedback
  remains system-owned. Native sheet and back transitions carry spatial movement. Reduced motion
  removes translation and scale while preserving the state change.

## Fixture

The reference date is 13 September 2026. Push A contains these sets:

| Movement | Sets | Reps | Load | Volume |
|---|---:|---:|---:|---:|
| Bench Press | 3 | 8 | 60 kg | 1,440 kg |
| Overhead Press | 3 | 8 | 30 kg | 720 kg |
| Cable Fly | 3 | 12 | 15 kg | 540 kg |

The complete example is nine sets, 2,700 kg and 48 minutes. Previous Bench Press is
three sets of eight at 57.5 kg. Epley estimates are 76 kg and 72.8 kg respectively.
Finishing after one, two or three bench sets means 480, 960 or 1,440 kg; the complete receipt
must never be the result of ending those partial states.

Start logging opens a movement picker and an unplanned Workout. Its Bench Press example carries
forward 57.5 kg × 8 from Last time; the one-set receipt is 460 kg. Starting Push A remains a
separate path through the routine's detail screen.

The custom movement example is Meadows Row, Barbell, with 20 kg × 5 ready to log and no previous
history. It returns to the calling routine picker or quick logger. The free-session save-as-routine
example contains four sets of eight at 60, 60, 57.5 and 55 kg: 1,860 kg in total.

## Behavior contracts

- Create movement asks for Name and Equipment. The name limit is 60 Unicode code points; the
  counter appears from 48. The prototype demonstrates a fixed Meadows Row entry. Cancel preserves
  the calling picker and its query.
- Planning uses native keyboard entry. Blank Sets disables Reps and Weight while retaining the
  draft values; saving open targets drops the scheme. Bounds are 20 sets, 1–100 reps and ±500 kg.
  Rack logging keeps its weight ladder and dedicated numeric sheet.
- Routine deletion has a nine-second Undo. Multiple deletions retain independent Undo windows;
  another deletion does not settle the first. A visible More menu and Duplicate are design proposals.
- Coach starts quietly with an empty composer. Sharing the complete receipt sends one line,
  “Check my last session.”, and opens the corresponding answer. History opens the same retained conversation with an active composer. Notes disclose that any connected agent can read them; limits are ten notes,
  60 code points per title and 500 UTF-8 bytes per body.
- Review displays all four proposed changes before Apply. Applied and turned-down states have
  matching readbacks. The specifications cover availability, allowance, pending replies, notes
  limits, review gating and account failures without duplicating every rule as a phone frame.
- Log keeps manual bodyweight entry and correction, movement aliases and exact performed sets.
  Set removal retains stored set numbers. Bodyweight charts do not interpolate gaps over seven days.
- Set entry and correction have no Kind selector or classification control. Reconcile stored set
  classification, metrics and cross-surface contracts during implementation; this Figma change
  does not migrate data or change runtime behavior.
- Receipts open matching complete, partial or free-session records. Public sharing discloses its
  contents and 30-day expiry before Get a link; the prototype does not mint a link.
- Android routine writes currently omit the expected revision. A stale-edit 409 guard is an
  implementation gap, not a reachable prototype state. The email-code resend countdown is also
  a proposal; the existing 30-second resend delay and 15-minute expiry are the underlying limits.

## Research applied

[Hevy's recording flow](https://www.hevyapp.com/features/track-workouts/) informs the proximity of
previous performance to entry. [Strong](https://www.strong.app/) reinforces direct logging.
[Fitbod's 2026 history update](https://fitbod.me/blog/exercise-history-and-records/) places useful
history and exact set results together. Windmill borrows that clarity while retaining its own
factual tone and avoiding streaks or scores.

[Material 3 Expressive research](https://design.google/library/expressive-material-design-google-research)
supports emphasis through size, grouping and responsive feedback. The proposal applies this to
the weight and logging controls, using Windmill's existing palette.

[Android Live Updates](https://developer.android.com/develop/ui/views/notifications/live-update)
support user-started workouts. The proposal uses a stock notification with movement, next set,
count-up rest and Log set. Promotion is conditional; an ordinary ongoing notification is the
fallback. SDK support, background execution, authentication, permissions and replay safety require
implementation verification. The design does not promise promotion or locked-device writing.

## Structure observations

The current design separates shared controls, composed screens and specifications. Logger and
receipt states share masters. Performed-set rows, support rows, fields, target fields,
create-movement forms and native chrome use instances. Changes to a control should land in its
master before screen-specific overrides. Captions travel with their screens inside named sections.
The unused confirmation switch component and Kind menu are removed with their controls and routes.
Removing a setting includes the components that have no remaining instances.

The existing faint text token measures 3.77:1 on the Instrument surface, so readable small metadata
uses ink-dim instead. The primary action's token pairs measure 9.46:1 in Instrument and 8.89:1 in
Daylight. These are token calculations, not device-rendering measurements.

## Verification and limits

Coverage was compared with every source-board family and the current Android contracts before
source removal. A cross-page audit found no external instance or prototype references into the
source boards; the replacement library and retained specifications also had no such dependencies.
The Figma audit found 90 phones and no placeholders. Screens has no component masters, section
overflow or direct-child overlap. All 442 inspected node destinations on Screens resolve, with no
navigation to another page or references to retired nodes. All 201 visible click targets carrying
prototype reactions meet the 48 dp minimum. Components has 28 resolving destinations. Specification
links are supporting references, not part of the phone-flow audit.

Screenshots, font families, fixture arithmetic, relevant scroll containers, action bounds and
prototype destinations were checked through Figma MCP. Partial receipts contain only their
performed movements and do not route to the complete workout's Coach answer.

The ten retained 1.15× and 2× text specimens are computed, unreflowed stress models, not production
layouts or Android device results. Android 14 supports
[nonlinear font scaling to 200%](https://developer.android.com/about/versions/14/features): use
`sp` for text and line height, and test the largest setting on device. Multiplying everything by
one scale factor does not reproduce the platform. Native implementation must also verify
[48 × 48 dp touch targets](https://developer.android.com/guide/topics/ui/accessibility/apps).

The prototype demonstrates representative navigation, press feedback and logging states.
Arbitrary text/numeric entry, chart scrubbing, actual saves, public-link creation and Coach replies
to partial workouts are specified rather than simulated. Native font scaling,
TalkBack, keyboard entry, predictive back, ordinary gesture feedback, notification behavior and
queue persistence need Android implementation tests; a Figma specimen does not establish those behaviors.
The embedded browser requires a separate Figma sign-in, so browser playback was not verified.
Application implementation and device verification are tracked by dogfood node
`android-gym-implement-refined-flows`.
