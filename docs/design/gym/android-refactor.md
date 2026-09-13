# Android gym design

The editable proposal lives in [Android · Refined](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=656-2).
Its shared controls live in [Android · Components](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=656-3).
Android · Source boards contains the source references and a link to the proposal.
These are design artifacts, not a claim that the Android application implements the proposal.

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
- Press and set-confirmation feedback are brief. Native sheet and back transitions carry spatial
  movement. Reduced motion removes translation and scale while preserving the state change.

## Fixture

The reference date is 13 September 2026. Push A contains these working sets:

| Movement | Sets | Reps | Load | Volume |
|---|---:|---:|---:|---:|
| Bench Press | 3 | 8 | 60 kg | 1,440 kg |
| Overhead Press | 3 | 8 | 30 kg | 720 kg |
| Cable Fly | 3 | 12 | 15 kg | 540 kg |

The complete example is nine working sets, 2,700 kg and 48 minutes. Previous Bench Press is
three sets of eight at 57.5 kg. Epley estimates are 76 kg and 72.8 kg respectively.
Finishing after one, two or three bench sets means 480, 960 or 1,440 kg; the complete receipt
must never be the result of ending those partial states.

Start logging opens a movement picker and an unplanned Workout. Its Bench Press example carries
forward 57.5 kg × 8 from Last time; the one-set receipt is 460 kg. Starting Push A remains a
separate path through the routine's detail screen.

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

The current design separates shared controls, composed screens and source references. Logger
states share a master; repeated rows and native chrome use instances. Changes to a control should
land in its master before screen-specific overrides.

The existing faint text token measures 3.77:1 on the Instrument surface, so readable small metadata
uses ink-dim instead. The primary action's token pairs measure 9.46:1 in Instrument and 8.89:1 in
Daylight. These are token calculations, not device-rendering measurements.

The proposal contains 25 phone screens and states. The prototype entry points are Explore gym,
Start Push A and Quick logging. Screenshots, font families, fixture arithmetic, scroll containers,
action bounds and prototype destinations were checked through Figma MCP. No placeholder nodes or
component masters remain on the composed-screen page.

The prototype demonstrates representative navigation and logging states; numeric entry, chart
scrubbing and Coach replies to partial workouts are specified rather than simulated. Native font scaling,
TalkBack, keyboard entry, predictive back, haptics, notification behavior and queue persistence
need Android implementation tests; a Figma specimen does not establish those behaviors.
The embedded browser requires a separate Figma sign-in, so browser playback was not verified.
