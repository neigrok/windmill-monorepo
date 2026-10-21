# Gym Coach onboarding

Gym setup shares the existing Coach room and creation receipts. Signed-in requests use the account
Coach contract. Anonymous iOS setup uses a server-issued installation credential, one bounded
provider request and an atomic local routine import. Android onboarding, the broader phone-hosted
Coach protocol and customer Usage screens remain separate work.

## Design sources

The canonical iOS flow is
[Gym onboarding · Coach-led](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1081-565)
on the Gym file's
[Gym · iOS](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=11-2)
page. The Gym file's
[iOS READ ME](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1118-1772) links directly to it.
The flow uses the existing Coach room, Routines destination and workout logger, with links to the
shared workout and account boards.

| State | Figma |
| --- | --- |
| Coach greeting (🚧 target) | [1173:3860](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1173-3860) |
| Draft to review (🚧 target) | [1173:4370](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1173-4370) |
| Review and save (🚧 target) | [1156:3154](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1156-3154) |
| Created routines (🚧 target) | [1173:4471](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1173-4471) |
| Routine to workout (🚧 target) | [1182:4650](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1182-4650) |

The drawn states are targets for the next build (`design/consistency.md` 10p, 10q); the app still
ships the starters. Screenshots are user attachments, not bundled illustrations. Starter symbols are
`photo.on.rectangle`, `text.alignleft` and `target`; creation receipts use `checkmark.circle` and
`arrow.up.right`.

## Structure

- GymRoom owns destination selection and the existing manual logging and routine-editor routes.
- CoachTab owns first-use composition, existing attachment/composer controls, conversation rendering
  and navigation from results. It uses the room's existing palette, type and navigation components.
- CoachConversation owns the seat-scoped persisted draft and explicit sending. Selecting a
  starter or clarification option changes a draft; it does not invoke the model.
- The backend owns bounded clarification data, creation identities and factual receipts. Existing
  routine changes retain Review and Apply. Clients do not infer actions from generated prose.
- Anonymous onboarding is a separate Gym feature with no account repositories or tools. It uses
  public exercise seeds, persists an input digest and validated result for recovery, and never
  persists the supplied program or photo. The model receives inline image data when requested.
- The Gym domain imports all returned routines and its replay receipt in one Plan. Existing
  account adoption owns the resulting local routines; local Coach history and photos follow the
  same Add/Discard decision without a promise of cloud chat backup.

Automatic setup requires a ready local replica or loaded account data and an empty Gym. Active workouts, account
changes, data adoption and a saved conversation or draft take precedence. A deliberate manual route
is remembered for that account. Empty Routines retains a quiet setup action without repeatedly redirecting the
person.

## Signed-in verification scope

High-fidelity Figma contexts and screenshots for all five states have been inspected. The target
uses GymPalette and ShellType rather than a parallel token collection. Native hit targets remain
44 pt even where the drawing's chip capsule is 36 pt; text and rows grow at accessibility sizes.

All nine backend suites pass. Local HTTP verification against the running backend and PostgreSQL
passed clarification/history, immutable request purpose, owner isolation, two persisted routines
after an interrupted answer,
retry with different model tool IDs, completed replay without provider dispatch, USD refusal
without dispatch, the 8,000-byte bound and all eight setup-event actions at the event intake. The
provider was a controlled local fixture; this does not establish live-model response quality.
Local telemetry delivery and privacy checks pass. The existing web client loads the new receipts
and routines; its inaccurate capability subtitle remains recorded in the consistency ledger.

All 106 native tests and 15 distinct targeted UI cases pass, including result-to-routine-to-workout,
relaunch, manual exits and the empty-Routines setup action. Light and dark entry, dark goal and
creation results match the requested content hierarchy and grouped actions. At Accessibility XXXL,
starter symbols and labels remain separate, selected long choices remain reachable, and the editable
composer preserves the full draft while showing at most two lines. Send and jump symbols fit their
controls. The final multiline choice screenshot and targeted UI test pass: an 18 pt corner radius
keeps wrapped text inside the outline while preserving the default 36 pt pill shape.

Ten focused Gym UI regression cases pass locally, covering account adoption, light/dark log charts,
routine building, workout ledger details, offline restoration, Live Activity and Control Center.

The signed-in live-provider run passed 77 checks across four generations and 13 provider rounds,
including photo interpretation and authenticated image handling, at $0.326676250 actual cost
([run 39288592147](https://github.com/neigrok/windmill-monorepo/actions/runs/39288592147)).
The production runtime has USD allowances enabled and a 2,000-token Coach output ceiling.

## Anonymous verification boundary

The backend build and 1,288 adapter cases pass, including PostgreSQL credential issuance, quota
races, binding and replay. The domain suite passes 2,171 cases with 28 existing skips; all 15
deployment checks, three schema reapplication checks and the photo-memory regression pass.
The new native domain action passes atomic import, replay, invalid-result and seat-change tests.

Local HTTP verification passes 88 checks against the running backend and PostgreSQL. The fixture
covers three goal routines, exact program/photo targets, a 1 MiB photo forwarded inline, immutable
replay, account isolation, binding attribution, per-installation/global spending, charged truncation,
an uncertain charge and a shared-budget pause. Structured logs, expected Sentry failures and the
native event labels arrive without private input or credential canaries.

The native client passes real HTTP goal/photo creation, atomic local import, starting a workout,
verified account binding and engine adoption while retaining local Coach history. All 89 Coach
tests pass. Light, dark and Accessibility XXXL anonymous flows also pass in CI.

The [anonymous live-provider run](https://github.com/neigrok/windmill-monorepo/actions/runs/39513495133)
passes 59 checks across exactly three calls: three goal routines cost $0.014618, two program routines
cost $0.009686, and two photo routines cost $0.011990. Program and photo targets match their sources
without invented weights. All $0.036294 settles at actual cost, with no debt or duplicate replay
spending. Every installation stays below its $0.05 lifetime allowance.

[Full native CI](https://github.com/neigrok/windmill-monorepo/actions/runs/39523283374) passes packages,
App unit tests, Debug and Release builds, and all 152 UI cases. Two UI shards passed 120 cases on the
first attempt; the 32 Coach/offline cases passed on one unchanged-source rerun after two offline UI interaction
timeouts. Both affected cases also passed unchanged locally. The verified native source matches
merged source `617b373a8af3181acc7fc4b9e1b5a64670263f2c`.

The [enabled production deployment](https://github.com/neigrok/windmill-monorepo/actions/runs/39571832936)
and [main-source deployment](https://github.com/neigrok/windmill-monorepo/actions/runs/39573012755)
verify USD enforcement, anonymous installation admission, Cloudflare client-IP handling and the
2,000-token output ceiling. All eight public activation checks pass at 2026-10-21 08:47:42 UTC,
including schema 6, installation credential issuance and readback, `no-store` responses and the
$0.05 lifetime allowance with zero used or reserved cost. This activation proof makes no provider calls;
actual-provider goal, program and photo behavior is covered by the separate live-provider run above.

TestFlight **0.2.0 (20)** uses the same merged source and was uploaded by
[iOS release run 20](https://github.com/neigrok/windmill-monorepo/actions/runs/39572022225) at
2026-10-21 09:01:38 UTC. The release artifact confirms bundle `works.windmill.app`, processing `VALID`,
internal state `IN_BETA_TESTING` and external state `READY_FOR_BETA_SUBMISSION`; external beta review
has not been submitted. The app and workout widget dSYMs are retained in `ios-dsyms-20`. Export reports
a nonblocking missing `Sentry.framework` dSYM warning; production Sentry symbolication is not verified.

## Structure observations

Keep one canonical onboarding flow and link its shared workout and account destinations. Individual
board links remain stable when the flow's page changes.

Keep setup beside the Coach conversation instead of introducing a separate onboarding coordinator.
Keep presentation-only prompt choices in the Coach contract, not the routine or sync domain. Reuse
one receipt row shape for one or several creations. Keep entry preference account-scoped and
separate from content so deleting a routine cannot silently reset the person's navigation choice.

UI tests use surviving chart points and target semantic row elements. The shared workout-ledger
helper traverses virtualized lists while asserting exact saved-set identifiers, values and counts.

Existing native composer and toolbar differences from the first-run drawings remain recorded in
the [consistency ledger](design/consistency.md); this phase does not redefine room chrome.

Installation credentials are separate from account credentials, so ordinary sign-out cannot reset
the trial. Binding waits for any credential issuance already in flight; otherwise sign-in could
cache an empty installation before the issuance response arrives. IPv6 rate limits group a /64,
so rotating interface addresses does not create independent IP budgets.

Technical request slots renew daily and remain separate from the lifetime USD balance. A temporary
free-pool pause must not permanently consume the trial. Request recovery tombstones prevent a
second dispatch; expired validated payloads can be removed without reopening the request.

Anonymous cancellation is “Stop waiting”: it cancels local waiting and import, while the same
request remains recoverable. A local persistence retry uses the retained result and cannot trigger
another paid generation. Seat checks guard both response handling and the domain commit.

The anonymous admission switch is separate from identity and recovery. Disabling new trials
preserves account binding and saved-result reads/replays, including through the production proxy.
A server-rejected installation credential stays on the phone without reopening the trial; a
verified account can continue after that specific rejection. Transport and accounting failures
still prevent dispatch until binding can be resolved.

Backend CI reconstructs its tested builder through the cache for each downstream job. Source-layer
cache misses in the live-provider run caused 10–12 minutes of repeated compilation per job; image
loading itself took about 20 seconds. An immutable tested-image handoff is tracked in the dogfood
node `ci-reuse-builder-and-balance-ios`; the source-cache miss cause is not established.
