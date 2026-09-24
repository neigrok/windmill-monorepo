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
| 0.9.3 active-workout upgrade | Complete | Focused/full tests, native fixture preflight and signed-release upgrade passed |
| Android 0.10.0 release | Published | Signing, signed upgrade, clean installation and public download verification passed |

The five Android cleanliness drift entries filed on 24 September are closed in
`docs/design/consistency.md`.

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
- The saved-workout boundary ignores only the four retired version-1 control keys. Remaining
  fields still use strict decoding: future versions, unknown control fields and malformed known
  fields keep writes blocked. Opening a compatible queue does not rewrite it. An unreadable queue
  reports recovery during reconnect instead of reaching the movement-selection writer.
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

The final Gradle build, lint, debug/release tests and APK builds passed in 1 minute 54 seconds.
Each gym variant reports 1,254 tests: 1,242 executed, zero failures or errors, and 12 live-wire tests
skipped without runtime configuration. The separate configured live-wire run passed all 12 tests
against the local backend with zero skips. Each platform variant passed 90 tests with zero skips.
The release helper passed all 18 tests.

Evidence is `release/upgrade-full-build.log`, the debug/release test-result XML, `live-wire-tests.log`,
`live-wire-results.xml` and `release-tools.log` under the verification directory below.

The active-workout upgrade correction passed 178 focused tests with zero failures, errors or skips
in 35 seconds: `WorkoutQueueTests` (10), `GymRuntimeTests` (10), `SetQueueTests` (26) and
`TrainingStoreTests` (132). The exact 0.9.3 queue from the disposable upgrade installation is a
test fixture; its regression restores, reconnects, logs the next set exactly once and reopens the
queue with both set identities intact. Other regressions retain rejection of unknown top-level and
nested controls, unsupported versions and malformed current fields. Independent review found no
remaining issues. Evidence is `release/upgrade-regression.log`.

Native debug preflight on emulator 5558 loaded the exact 0.9.3 queue, restored its 20 kg × 5 set,
and logged one more set. The queue held exactly two 20 kg × 5 entries and an offer for set 3;
both entries survived a restart. Captures are `upgrade-preflight-restored` and
`upgrade-preflight-next-set`. The signed-release upgrade also passed, as recorded below.

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

Spoken TalkBack was not exercised. The 320 dp / 200% text Routines navigation-label clipping remains
a tracked follow-up. Sign-in used a local test-token mail bridge; the real email provider was not
exercised.

## Published release

[Android 0.10.0/code108](https://github.com/neigrok/windmill-monorepo/releases/tag/android-v0.10.0)
is published from `7a419e4664a8c380bac839946fc3cc8decf64c89`.
[Tag CI run 36055932135](https://github.com/neigrok/windmill-monorepo/actions/runs/36055932135),
attempt 1 from a tag push, passed the full build and signing-input job.
[Main CI run 36055927071](https://github.com/neigrok/windmill-monorepo/actions/runs/36055927071)
also passed. Local finalization verified the retained certificate, non-debuggable package,
unchanged application payload and linked provenance.

- APK SHA-256: `80d47e2ad5a48399b8cdf4aadf0218043ccd14a982f5ceff2da00f630fb71185`.
- Certificate SHA-256: `e911c90024117df99a2852a0d7820889e3d8a399506a8557148af7171c63e2bb`.

The signed APK passed a direct code98-to-code108 installation update on emulator 5560. Its actual
0.9.3 saved queue restored one 20 kg × 5 set, accepted a second set once, and retained both sets
and offer 3 after restart. Finishing stored 200 kg total volume. The routine opens in the new sheet,
and the Log retains the earlier 100 kg session and the new 200 kg session.

An independent clean installation saved a free-session 20 kg × 5 workout and retained its session
and best moment in the Log after restart. Notifications remained declined during signed-APK
acceptance.

All three public release assets downloaded anonymously with curl configuration disabled are
byte-identical to the accepted signed files. Inspection of the downloaded APK confirms the SHA-256
above, retained certificate, `works.windmill.app` package, non-debuggable flag and version
0.10.0/code108. The release is neither a draft nor a prerelease and has exactly three assets.
Evidence is `release/public-proof.json`.

## Verification environment

Acceptance uses an isolated Android 14 emulator on port 5558 and a backend built from the committed
source in `/private/tmp/windmill-android-cleanliness`. Existing backend and web work in the checkout
is outside this change. Screenshots and command logs are kept under the same temporary directory.
Native captures cover the routine sheet, editor, creation, Settings, Log, expanded moment, Record
and workout notification, with additional 320 dp / 200% text captures.
