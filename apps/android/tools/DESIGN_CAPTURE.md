# Android design captures

`design_capture.py` owns an isolated Postgres database, local backend, local model and mail fixtures, and a
fresh Pixel 8 emulator directory. It never clears or replaces an existing emulator. It builds a
debug APK with an explicit local origin, verifies the generated `WM_API_BASE_URL` before installation,
and preserves that APK with its SHA-256, source revision and dirty status in the manifest.

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
through the MCP and sync doors, then signs the native app into that fixture account. A separate
empty installation captures signed-out states. Each appearance starts with clean app data;
transient recipes run after the Dark/Daylight switch.

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

`tap` and `wait` match exact accessibility text or description. Other steps are `text`, `key`
(Android key name) and `swipe` (`[fromX, fromY, toX, toY, durationMs]`). Canonical board IDs such as
`02.7`, `15a`, `27g` and `A4`, and filename
slugs are validated. Choose a body-state selector, not the navigation label. Two matching fresh
accessibility trees establish settlement. Recipes may opt into `resend_countdown: true`, which
normalizes only the bounded `Resend in 1s` through `Resend in 30s` label for that comparison; the
native timer remains visible in the screenshot.
Other clock and live-notification recipes need a layout-specific readiness condition.

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

Each `responses` entry is one Anthropic response's content blocks. Text and `tool_use` blocks work
in JSON and streaming responses. `$routine0` is replaced with the first fixture routine's id.
Recipes fail if their queued model responses were not consumed. A model-backed write recipe must
assert its actual backend receipt as well as its UI result.

## Performance and cleanup

The cold-start probe records process-start and rendered-ready-frame times on the device, after
the three fixture routines are loaded. The rig separately verifies `Push A` through accessibility
and records that slower host-side selector time. The default run fails at 3000ms or longer, or on
an ANR/fatal exception. `--baseline` records an over-budget baseline without claiming performance
acceptance. Keep baseline and final APKs, use identical emulator configuration and fixtures, and
reserve a quiet host window for both measurements.

A ten-second method-sampling trace of the open workout, `dumpsys cpuinfo` and the scanned Android
runtime log accompany the PNGs. The runtime log is preserved even when the final ANR/fatal check fails.
`--profile-seconds` accepts 1–60 seconds. Traces contain thread CPU clocks; `dumpsys cpuinfo` can
include a preceding system interval and should not substitute for trace analysis.

`--acceptance-pause-seconds 600` retains the isolated stack after capture for manual acceptance.
The script prints its device and local database, saves allowlisted events, then stops its processes
and drops its database. Normal completion, errors, Ctrl-C and SIGTERM run the same cleanup. A
failed run preserves its manifest, logs and any completed captures for inspection.
