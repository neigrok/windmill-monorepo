# Android design captures

`design_capture.py` owns an isolated Postgres database, local backend, local model and mail fixtures, and a
fresh Pixel 8 emulator directory. It never clears or replaces an existing emulator. It builds a
debug APK with an explicit local origin, verifies the generated `WM_API_BASE_URL` before installation,
and preserves that APK with its SHA-256, source revision and dirty status in the manifest.
The private cold-start marker carries the exact seeded routine identities as a JSON array. The
debug provider waits for that complete set and a drawn frame; missing or empty marker bytes disable
the probe, while a valid `[]` explicitly expects an empty program. Identities never enter telemetry.

## Run

Requirements: JDK 17+, Python 3, PostgreSQL client tools and a running server on `/tmp`, an Android
SDK with an API 36+ arm64 system image, and a backend binary rebuilt from the current source.
The default ports are backend 8098, model 8099, mail 8101 and emulator 5580/5581; occupied ports are refused.
Run from the monorepo root:

```sh
JAVA_HOME="/path/to/jdk" ANDROID_HOME="/path/to/android-sdk" \
  python3 apps/android/tools/design_capture.py \
  --backend-binary backend/build/windmill_server \
  --output /tmp/windmill-android-capture
```

The output directory must be new. The script creates the database from `backend/db/schema.sql`,
seeds three routines, twelve finished workouts across four weeks, six weigh-ins and two notes
through the MCP and sync doors, then signs the native app into that fixture account. Sync seeding
retains each intent and replica across bounded prefix acknowledgements; refusals, invalid replies
or exhausted retries stop the run before fixture acceptance. A separate
empty installation captures signed-out states. Each appearance starts with clean app data;
transient recipes run after the Dark/Daylight switch.
Use `--fresh-mode-fixture` for independent Coach capture groups: Light gets a fresh disposable
seeded account, so Dark conversations and the per-account question allowance do not carry into it.
The default retains one fixture account across appearances.

The backend inherits only runtime environment variables and explicit local configuration. Its
Anthropic endpoint is the in-process deterministic model fixture; no hosted provider credential is
inherited. Its Resend endpoint is the local mail fixture, with an explicit dummy key and sender.
The fixture acknowledges only sign-in-code envelopes, keeps the current challenge only in memory
and records only a call count in the manifest. No mail body is printed or saved. Android debug telemetry is enabled and uses the local backend event intake. Optional
`--sentry-dsn http://android-capture@10.0.2.2:8100/1` targets a separately running local envelope
collector. Hosted collector DSNs are refused.

The debug fixture activity accepts its single-use auth token from a private app file. Credentials
are not passed in activity extras or command arguments. Its private readiness provider is enabled
only by the capture marker and a local origin; neither class is in the release manifest.

## Recipes and readiness

The default recipes capture empty Routines (02.7), populated Routines (02.1), Log (05.1), Coach
(08.1) and a deterministic Coach answer (08.1). These are current native states, not assertions
that later visual tasks match their Figma boards.

Supply `--scenarios recipes.json` to replace the default array. Later tasks add board recipes
without changing the existing screen implementation:

`--scenarios apps/android/tools/capture-recipes/colour-roles.json` captures the new-routine editor,
movement picker, share offer and live link in both appearances. Optional `after` steps run after a
recipe's screenshot, allowing transient sheets to close before the next recipe or readiness check.

`--scenarios apps/android/tools/capture-recipes/deletion-lifecycle.json` captures the routine Delete
menu, held editor-movement and detail-set swipes, a settled temporary-routine deletion, and weight
Undo in both appearances. The editor leaves its draft unsaved; the detail-set gesture returns before
release. The weight recipe accepts Undo after its screenshot. Settled write and background-release
checks use the same disposable account during the bounded acceptance pause.

`--scenarios apps/android/tools/capture-recipes/routines-list.json` captures full and empty Routines,
including the fixed New routine FAB, in both appearances and at 320 dp / 200% text. Each recipe
opens and leaves a new routine draft without saving. The selector matches the FAB's content
description, so existing editor recipes keep the same New routine target.

`--scenarios apps/android/tools/capture-recipes/notes.json` captures the Notes row mid-swipe and
outlined note editor in both appearances using the default two synthetic notes. The row returns
to its starting position before release, so the canonical capture does not delete it. Supplemental
acceptance checks real handle reorder, save/delete readback, and 320 dp/200% keyboard clearance.

`--scenarios apps/android/tools/capture-recipes/native-parts.json` opens a debug-only native-control
specimen guarded by the same local-origin check. The wide 1460 × 426 board is component-specimen
evidence; portrait recipes exercise actual phone width, signed Display values and inline refusals.
A recipe's optional `viewport` supplies bounded integer `width`, `height` and `density`, plus an
optional `fontScale` from 1 to 2. The owned emulator's size, density and text scale reset in `finally`,
before subsequent recipes or performance measurements. O recipes cover signed Display overflow at
phone and 320dp widths, editing from `24` to `-499.99`, and 200% text.

`--fixture apps/android/tools/capture-recipes/number-entry-fixture.json` with
`--scenarios apps/android/tools/capture-recipes/number-entry.json` captures the actual rack's pressed,
changed and native-keyboard states in both appearances. These recipes opt into `workout_clock`,
which uses the same zero-idle shell hierarchy helper as notifications. Settlement compares every
node and value except exact app-package descriptions `Workout time, …`, `Since start, …` and
`Since last set, …` whose suffix is a clock. Raw XML retains the timestamps; numeric input, error
text, geometry and any similar label in another package must still settle. The pressed and 300 ms
changed states use transient-frame capture; they do not skip the actual user action.

`--scenarios apps/android/tools/capture-recipes/edit-movement.json` opens More → Edit movement on Record
and captures the standalone editor and captures Barbell, Dumbbells, Other and the three-choice menu in both appearances. It saves
Other through the native form, reopens the accepted value, then restores Barbell before the next
appearance. The final native acceptance also checks draft cancellation, name refusal and small-height
keyboard reachability on that same isolated account. The recipe includes 320 × 480 dp keyboard-up
and 200% text refusal captures in both appearances; its after-steps discard these drafts.

`--fixture apps/android/tools/capture-recipes/record-fixture.json` with
`--scenarios apps/android/tools/capture-recipes/record.json` captures the Record overflow and a
retained point opened from a Log new-best moment in both appearances. Optional fixture `history`
contains 1–40 explicit workouts: zero-based `routine`, integer `daysAgo` (0–3650), integer
`minutesAgo` (0–1439), `weightKg` (−500–500 in hundredths), and integer `reps` (1–500). Each workout
lasts 40 minutes and must finish by the fixture clock. The supported `gym_import_session` door
writes three working sets per movement unless an explicit workout supplies `setsPerMovement`
(1–20). Custom history permits at most 20 total working sets per workout, preserving its 40-minute
duration. Omitting history preserves the default seed.
The Record fixture has six factual workouts, five daily chart points and two earlier records.

`--fixture apps/android/tools/capture-recipes/compact-rack-fixture.json` with
`--scenarios apps/android/tools/capture-recipes/compact-rack.json` covers the three equipment rack
boards plus native keyboard, long-name/many-movement and single-movement variants. The canonical
loads are 24 kg each, 10 kg added and 75 kg total. These recipes retain exact numeric values and
geometry while normalizing only the identified workout clock descriptions for settlement.

The same compact-rack fixture with `--scenarios apps/android/tools/capture-recipes/fix-set.json`
opens the actual logged row for 03.3, then captures the signed raw field with its native keyboard and
an inline numeric refusal. It cancels that refused draft and ends the fixture workout. These
recipes use the exact clock-only settlement option; native minus/Done interaction and the
small-height/200% text check also require the installed-app acceptance pass.

Scenarios with explicit `model_timing` use the existing zero-idle hierarchy helper while their
steps run. This keeps live text and Stop observable without waiting for generation to finish;
it does not normalize text or geometry. Other scenarios retain ordinary hierarchy capture.
Thinking and streaming recipes enter through Routines then Coach, so the Coach header cannot be
mistaken for its navigation item.

Transient recipes may use `frame_delay_ms` (0–1000, only with `settle: false`) to select a
known animation phase; the manifest records that delay. This does not establish screen readiness.
Transient recipes may set `settle: false` to capture a native pressed state or the 300 ms change
flash. These transient captures omit the settling hierarchy read so it cannot outlast
the state being captured; all ordinary captures retain their settled XML. Pointer steps use the
observed control bounds and release in `finally` as described below.

```json
[
  {
    "board": "08.1",
    "name": "coach-answer",
    "account": "fixture",
    "responses": [[{"type": "text", "text": "Your three training days are ready."}]],
    "steps": [
      {"tap": "Coach"}, {"wait": "Question"}, {"tap": "Question"},
      {"text": "Summarize my training days"}, {"tap": "Send"},
      {"wait": "Your three training days are ready."}, {"wait": "Send"}
    ]
  }
]
```

`tap` and `wait` match exact accessibility text, description or resource ID. `wait_contains`
explicitly matches a visible partial label while a model answer grows. Other steps are `text`, `key`
(Android key name) and `swipe` (`[fromX, fromY, toX, toY, durationMs]`). Canonical board IDs such as
`02.7`, `15a`, `27g` and `A4`, and filename
slugs are validated. Choose a body-state selector, not the navigation label. Two matching fresh
accessibility trees establish settlement. Recipes may opt into `resend_countdown: true`, which
normalizes only the bounded `Resend in 1s` through `Resend in 30s` label for that comparison; the
native timer remains visible in the screenshot.

`--scenarios apps/android/tools/capture-recipes/notification-clock.json` captures the ongoing card,
status-bar chip and secure public lock screen in both appearances. Its `notification_clock` option
builds the shell-only `design-capture/CaptureTree.java` helper with the configured JDK, Android 36
SDK platform and build tools 36.0.0. The helper reads the active accessibility root without waiting
for a ticking chronometer to become idle; it has a bounded root-acquisition deadline and is never
packaged in the app. Only the newly owned emulator receives its synthetic PIN and private-content
lock-screen policy. `notification` steps select `shade`, `home`, `lock` or `unlock`; `absent` checks
that exact private labels are missing and fails on an unreadable hierarchy.

Notification settlement normalizes only text and description on SystemUI's `android:id/chronometer`
with class `android.widget.Chronometer`. All body text, other numeric labels, bounds and attributes
must settle. The raw tree is retained unchanged beside each PNG, along with a notification dump for
these synthetic fixtures. A status-bar chip is not exposed in the active Home accessibility root;
its screenshot requires visual review, supported by the saved promoted-notification flags. App
logger clocks are outside this normalization. The auth resend-countdown option remains separate.

`--scenarios apps/android/tools/capture-recipes/workout-tile.json` captures inactive and active
Workout tiles in both appearances. Its `tile_clock` option uses the same shell helper without
changing lock-screen settings. The owned emulator's system commands add the tile and give it a large slot. `quick_settings: "show"` opens the expanded shade;
`workout_tile: "off"` or `"active"` waits for the tile's actual accessibility state description.
Only the clock suffix of SystemUI's large tile with a **Workout** label is normalized. The workout
title, inactive/active transition, other tiles, bounds and raw state description remain intact.
The helper records `state-desc` because the system represents the subtitle there rather than as a
separate text node. Recipes tap the inactive tile back to Routines, open an active workout, log a
set, and finish through the ordinary app controls.

`capture-recipes/sign-in-fields.json` captures 15a with the native Email keyboard and 15b/15c with
the keyboard hidden, plus focused Code states with the Number keyboard, in both appearances. Use
it with `--scenarios` after rebuilding the backend.
These recipes request a real code through AuthService and Postgres, show the real wrong-code refusal,
then complete sign-in after the 15c screenshot with the locally delivered code. A consumed challenge
and a newly persisted session confirm each completion; the manifest records their count. The `after` array runs
only after saving that recipe's screenshot. `keyboard: "show"` enables the software keyboard for the
next field tap; `keyboard: "hide"` sends Back only when the native IME reports it is visible.
`auth_code: "wrong"` inserts a guaranteed mismatch and `auth_code: "valid"` inserts the current
challenge. Both replace the fixture's six-digit field through stdin; no credential is passed in host
command arguments. The code, email and token never enter the manifest or event properties.

`--fixture capture-recipes/equipment-units-fixture.json` replaces the isolated account's seeded
program with explicit routine entries and targets, after creating its missing custom movement through
the normal MCP write. Pair it with `--scenarios capture-recipes/equipment-units.json` for 02.2 summary,
02.5 editor and a lifted row in both appearances. The default program is unchanged when omitted.
The file accepts `exercises`, `routines` and optional `history`; it supplies no origin, account or
arbitrary tool. Explicit histories retain their validated 40-minute duration. Default histories
last at least 40 minutes and finish after their final generated set, including long routines.
Existing catalogue identities/names cannot be replaced by a custom exercise fixture.

A `touch` down may set `row: true` to use the nearest observed clickable ancestor of its text target; otherwise it uses the target’s own bounds. Missing clickable ancestry refuses the capture.

A `touch` step has `phase: "down"`, an accessibility `target`, and optional `at: [x, y]` fractions
inside that control's observed bounds. `move` uses those same bounds; `up` releases the pointer.
Every scenario releases an outstanding pointer in `finally`, including capture failures. The normal
settle check gives a long-pressed reorder handle time to expose its raised state. Local fixture sync
accepts a valid acknowledged prefix, retains operation identity for the suffix, and bounds retries.

Each `responses` entry is one Anthropic response's content blocks. Text and `tool_use` blocks work
in JSON and streaming responses. `$routine0` is replaced with the first fixture routine's id.
Optional `model_timing` supplies integer `start_delay_ms` (0–10000), `chunk_chars` (1–4096)
and `chunk_delay_ms` (0–1000). Validation bounds the entire scenario to 256 text chunks and ten
seconds of fixture delay before startup. Text chunks preserve Unicode characters; tool JSON and
default responses retain their existing event sequence. A stopped response may close its local
fixture connection without a transport log.

With `--fresh-mode-fixture` and `--fixture capture-recipes/coach-history-fixture.json`,
`capture-recipes/coach-messages.json` captures empty Coach, Markdown, thinking and streaming;
`capture-recipes/coach-history.json` captures History, sources, delete confirmation, Copy and
Jump to latest. Each group uses at most three asks per fresh account. Coach recipes wait for
exact native input echo before sending or navigating; a partial fixture input fails that
precondition. Use two separate runs, each with a new output directory. The synthetic source workout has one working set and
400 kg volume; the previews are deterministic fixture answers.

Recipes fail if their queued model responses were not consumed. A model-backed write recipe must
assert its actual backend receipt as well as its UI result.

## Performance and cleanup

The cold-start probe records process-start and rendered-ready-frame times on the device, after
the fixture routines are loaded. The rig separately verifies `Push A` through accessibility
and records that slower host-side selector time. The default run fails at 3000ms or longer, or on
an ANR/fatal exception. `--baseline` records an over-budget baseline without claiming performance
acceptance. Keep baseline and final APKs, use identical emulator configuration and fixtures, and
reserve a quiet host window for both measurements.

A ten-second method-sampling trace of the open workout, `dumpsys cpuinfo` and the scanned Android
runtime log accompany the PNGs. The runtime log is preserved even when the final ANR/fatal check fails.
`--profile-seconds` accepts 1–60 seconds. Traces contain thread CPU clocks; `dumpsys cpuinfo` can
include a preceding system interval and should not substitute for trace analysis. After profiling
stops, the rig waits for a nonempty complete trace to remain unchanged across two reads. Empty,
partial or continuously changing output fails at the bounded deadline instead of being accepted.

`--acceptance-pause-seconds 600` retains the isolated stack after capture for manual acceptance.
The script prints its device and local database, saves allowlisted events, then stops its processes
and drops its database. Normal completion, errors, Ctrl-C and SIGTERM run the same cleanup. A
failed run preserves its manifest, logs and any completed captures for inspection.

`capture-recipes/this-workout.json` uses `this-workout-fixture.json` for the approved 03.4
four-set management state, an end-to-start removal ground and 320 × 640 dp / 200% text.
The fixture's performed/planned lines use the shared equipment units; the reserved task 45
Hide workout and Notification off rows are absent. The held removal ground is cancelled in
`after` so the large-text capture retains all four rows. Six Dark/Daylight API 37 captures are
verified; released removal, handle reorder and retained movement drafts have separate native
action/readback evidence. Capture cleanup waits for the saved workout receipt.

Retire a capture AVD only after verifying its emulator process has stopped. Keep the APK,
screenshots, XML, traces, logs, events and manifest; removing only the retired `avd/` directory
recovers its mutable userdata space without removing acceptance evidence.
