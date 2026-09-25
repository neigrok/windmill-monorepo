# Gym web content parity review

The content pass covers the 102 boards on [Web · Gym](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=466-132). Navigation is protected by the owner's instruction. Release and acceptance results belong in [web-verification.md](web-verification.md); the current board statuses belong in [web-build-contract.md](web-build-contract.md).

## Structure

Focused pages use a centered 640px measure. The routine editor uses 360px movements, a 32px gap and a 420px task pane. Workout correction and conflict comparison use two 420px regions. Log, Coach, Notes and populated past-workout forms retain their 1024px workspaces.

Notes and progress presentation live with their features. The shared chart accepts explicit presentation options while keeping its data, range calculation and keyboard interaction product-neutral. The Bodyweight consumer retains its own presentation.

Numeric fields size from their value, including decimals and negative loads. Metadata columns shrink with their available form width; saved totals can wrap. Native date and time inputs remain the editing controls, with formatted resting labels where the design requires a stable date or 24-hour measure.

## Verification observations

- A matching route is insufficient evidence for a board. Set counts, variable versus collapsed movements, pending proposals, empty states, filters and focused controls must match the state being compared.
- The density fixture uses 982 workouts, 2,952 sets and 22,638 reps. Its selected 16-set workout and visible history rows match the drawing; the 2024 scope contains 366 workouts, 1,098 sets and 8,418 reps.
- Past-workout and correction fixtures are separate from the history and Coach account. State-specific edits cannot invalidate another area's comparison.
- Coach decisions and share links use real local requests and restore their isolated fixtures. Model requests are blocked during verification.
- Viewport boundaries include 320px and the transition into the desktop correction split. A pass at 390px and 1440px alone does not prove intermediate layouts fit.
- Production rendering must identify the deployed release and asset bytes. Running those bytes against isolated local fixtures verifies the deployed frontend; it is distinct from testing an authenticated production account.

## Protected navigation differences

The runtime's narrow Coach shortcuts, contextual rail, public reader header/navigation and back-link glyphs have differences from the drawings. Narrow sheet scrims also treat the shared header differently. The owner Log hides its Weigh in / Add past workout footer when filters have no matches; the narrow drawing retains those actions. These remain outside the content changes while the navigation source-of-truth decision is pending. The shared header and bottom navigation match their pre-change runtime geometry, typography, colors and labels at 1440px and 390px.

Existing capabilities such as Rename, More movement facts and contextual Log/Workout options remain available. A drawing that omits an existing capability is not authorization to remove it.
