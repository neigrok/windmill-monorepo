# Android cleanliness delivery

The implementation follows [the build plan](gym-android-cleanliness-plan.md). Scope is Android;
the backend, web and iOS keep their current behavior. The work is tracked by
`gym-android-cleanliness` in the Windmill dogfood tree, with one child per wave.

## Delivery gates

| Area | Implementation | Verification |
|---|---|---|
| Rest settings and alerts | Complete | Debug/release regression runs and lint passed |
| Routine sheet and plan-only editor | Complete | Debug/release regression runs and lint passed |
| Woven Log | Complete | Debug/release regression runs and lint passed |
| Target during movement creation | Complete | Debug/release regression runs and lint passed |
| Simplification and adversarial review | Complete | Final regression runs passed |
| Native acceptance | Complete | Final Log captures accepted; spoken TalkBack not exercised |
| Android 0.10.0 release | Release notes prepared | Signing, update verification and publication pending |

The five Android cleanliness drift entries filed on 24 September are closed in
`docs/design/consistency.md`. Release readiness remains subject to the gates above.

## Contracts and observations

- `StatsProgress` reads all finished working sets, without a date limit. Presentation windows do
  not truncate the source used to choose moments. A paginated Log must reveal moments only within
  its loaded date range until the final session page arrives. The boundary uses all loaded
  sessions, including rows temporarily held for Undo. The regression for withholding every loaded
  workout verifies that Load older remains reachable and older moments appear only after paging.
- Preferences are a whole-document replacement on the server. Removing Android's rest fields
  requires preserving opaque fields at the HTTP boundary; omitting them would reset other
  surfaces' settings. A failed preservation read must prevent the write.
- The workout's elapsed and since-set readings are independent of target alerts and remain in the
  logger. Rest-target preferences, alarm authority and alert state are removed.
- Routine replacements preserve opaque server fields by movement identity while taking targets,
  order and expected revision from the Android draft. An open scheme removes only the owned sets
  field; deleted movements remain deleted. The preservation read never supplies a newer revision.
- Auto-close reads the latest persisted set event directly, before any derived workout refresh.
  Legacy rest state is ignored, and a recent set remains the activity anchor after an app upgrade.
- The notification adapter renders the immutable workout projection directly; no second card DTO
  or rest alarm lifecycle remains. Existing callback identities outside Open, Log set and Hide
  have no effect.
- The moment rule's one-per-week cap takes precedence over illustrative Figma sample dates.
  A completed-month moment needs factual month information, without an invented movement record.
- Month headings and completed-month moments have distinct lazy-list keys. A UI regression
  scrolls through the completed month so both rows are composed together without a key collision.
- Both target-entry callers use one draft and one target block. Movement creation returns the
  movement and its complete scheme in one routine-draft update. Raw invalid input and hidden rows
  belong to the recoverable draft; the workout creation path still asks only name and equipment.

## Verification results

The final Gradle build, lint, debug/release tests and APK builds passed in 1 minute 31 seconds.
Each gym variant reports 1,252 tests: 1,240 executed, zero failures or errors, and 12 live-wire tests
skipped without runtime configuration. The separate configured live-wire run passed all 12 tests
against the local backend with zero skips. Each platform variant passed 90 tests with zero skips.
The release helper passed all 18 tests.

Evidence is `accepted-build.log`, `accepted-gym-Debug/`, `accepted-gym-Release/`,
`accepted-platform-Debug/`, `accepted-platform-Release/`, `live-wire-tests.log`,
`live-wire-results.xml` and `release-tools.log` under the verification directory below.
Release-certificate checks, installation update verification and publication remain pending.

Native acceptance on the isolated emulator verified:

- The routine sheet opens over the list; the editor contains the plan. A new Meadows Row with
  four sets of 10 at 17.5 kg lands with its target in one draft step and persists in routine
  revision 2. The existing Bench Press entry retains its server rest value of 120 seconds.
- Changing Settings from kg to lb and back preserves the server's rest value and sound flag.
- A Log best expands to its chart using the moment's date, and Open record reaches Record.
- The 80.3 kg weigh-in moment opens Bodyweight, and the Bench Press name in a session readback
  opens its Record.
- The completed July month moment shows five of five weeks trained, scrolls beside the July
  heading and expands without a key collision or crash (`month-expanded-final.png`).
- The silent ongoing notification shows routine, movement, rack numbers and set counter. Log set
  advances the counter from Set 1 to Set 2, with one 60 kg × 10 set persisted and finished.
- Design review accepted the six normal-size canonical screen captures. Settings, routine and
  editor remain readable at 320 dp / 200% text. The final narrow Log capture is also accepted:
  the date stacks and the caption wraps to two lines without clipping (`log-320-200-final.png`).

Spoken TalkBack was not exercised. Sign-in used a local test-token mail bridge; the real email
provider was not exercised.

## Verification environment

Acceptance uses an isolated Android 14 emulator on port 5558 and a backend built from the committed
source in `/private/tmp/windmill-android-cleanliness`. Existing backend and web work in the checkout
is outside this change. Screenshots and command logs are kept under the same temporary directory.
Native captures cover the routine sheet, editor, creation, Settings, Log, expanded moment, Record
and workout notification, with additional 320 dp / 200% text captures.
