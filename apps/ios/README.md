# Windmill iOS

One SwiftUI app for journal and gym, with a roadmap link to the web. Product libraries depend on
`WindmillPlatform`; the app composes them under one account.

## Layout

| Path | Responsibility |
|---|---|
| `project.yml` | XcodeGen app/test configuration; `Windmill.xcodeproj` is generated. |
| `App/` | App composition, assets and dedicated Sentry configuration/privacy filtering. |
| `Tests/App/`, `UITests/` | App integration tests and simulator UI tests. |
| `WindmillKit/Sources/WindmillPlatform/` | Account, transport, session, product interface, tokens and shell. |
| `WindmillKit/Sources/WindmillJournal/` | Journal's daily canvas. |
| `WindmillKit/Sources/WindmillGym/` | Training log, routines and Coach. |
| `WindmillKit/Sources/WindmillRoadmap/` | Link to the web product. |
| `WindmillKit/Tests/` | Package tests, mirroring Sources. |

`Package.swift` enforces product dependencies on platform, never on another product.
See [repository structure](../../STRUCTURE.md) and [design canon](../../docs/design/readme.md).

## Build and test

```sh
brew install xcodegen
cd apps/ios
xcodegen generate       # repeat after project.yml changes
open Windmill.xcodeproj
```

Choose an installed iPhone simulator (`xcrun simctl list devices available`). For example:

```sh
xcodebuild build -project Windmill.xcodeproj -scheme Windmill \
  -destination 'platform=iOS Simulator,name=iPhone 17'

(cd WindmillKit && xcodebuild test -scheme WindmillKit-Package \
  -destination 'platform=iOS Simulator,name=iPhone 17')

# App tests, including UITests on a booted simulator
xcodebuild test -project Windmill.xcodeproj -scheme Windmill \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

The package targets iOS 17+; use a simulator instead of `swift build`. Set
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` if the selected toolchain cannot find
Xcode. Keep the full monorepo: gym tests read `packages/api-contract/gym-ladder.json` directly.
`WMApiBaseURL` in `project.yml` defaults to production; `http://localhost:8088` uses the local
backend with the declared ATS local-networking exception.

[CI](../../.github/workflows/ios.yml) chooses an available iPhone simulator, builds the app,
runs crash-report tests and tests WindmillKit. The full UI suite requires a separate run.

## Crash reports and releases

The app bundle owns Sentry Cocoa; product packages do not depend on it. `IOS_SENTRY_DSN` targets
the dedicated iOS project and is required for Release. Debug without it sends no crash reports;
CI supplies the repository secret only on trusted runs.

```sh
xcodebuild build -project Windmill.xcodeproj -scheme Windmill -configuration Release \
  -destination 'platform=iOS Simulator,name=iPhone 17' IOS_SENTRY_DSN="$IOS_SENTRY_DSN"

xcodebuild test -project Windmill.xcodeproj -scheme Windmill \
  -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:WindmillCrashReportTests
```

Reports retain exception types/stacks and release/build/device diagnostics. Messages, mechanism
data, identity, requests, breadcrumbs, extras and custom contexts are removed. Memory inspection,
screenshots, view hierarchies, network tracking, replay, tracing and automatic session tracking
are disabled. Neither CI nor release uploads dSYMs; upload matching release dSYMs to the iOS
Sentry project for symbolication.

[iOS release](../../.github/workflows/ios-release.yml) archives the main-push commit that passed
CI and uploads it to App Store Connect. Manual dispatch: `gh workflow run ios-release.yml`.
Build number is the release workflow run number; bump `MARKETING_VERSION` in `project.yml` by
hand. Automatic signing uses repository secrets `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`,
`ASC_KEY_P8_BASE64` and `IOS_SENTRY_DSN`. TestFlight availability requires successful signing,
upload and App Store Connect processing.

## Product, account and storage boundaries

Manual writing and training work signed out. Journal uses versioned page files; gym uses a shelf,
set queue and bodyweight store. Each is keyed by account with a separate anonymous store.
Anonymous work is claimed on verified sign-in. Legacy files are attributed to the stored session
or quarantined. Unverified accounts keep their own local room; only confirmed 401 responses sign
out. Foreground retries verification, and rooms reconnect on account/verification changes.

Gym's `TrainingStore.start` owns all workout starts. Offline starts retain their ids and timestamps;
sets drain before and after claims. Queue refusals use machine codes. The finish sheet appears
after persistence and its dismissal writes nothing. Workout clocks use saved timestamps and freeze
at finish. Live rack entry and routine targets have separate validation bands. Bundled movement
ids let signed-out workouts use the backend catalogue's identities.

Coach persists account-scoped questions, request/attachment ids and partial replies. Retries retain
identity; Stop preserves partial text and completed actions. The native picker retains one image,
normalized to JPEG within 4096 pixels per edge and 5 MiB, through upload retries. Retained images
use authenticated storage. See [gym data rules](../../backend/products/gym/ARCHITECTURE.md) and
[Coach's conversation contract](../../docs/gym-coach-contract.md).

Email sign-in accepts a six-digit code or pasted magic link. Apple sign-in is configuration-gated;
see [activation](../../backend/AUTH.md#apple-sign-in-activation) and
[account linking](../../backend/AUTH.md).

## Shell

`ProductModule` supplies room, hub line, entry wording and device holdings. The shell owns the hub,
capsule, account and appearance; products own navigation and palettes. `hostsTopChrome` places
`CapsuleButton` and `YouSeat` inside the product toolbar; other rooms receive a safe-area inset.
`roomDepth` reserves the home edge gesture for a root view. Launch restores the last room; first-use
state is device-local in `FirstRun.swift`. Appearance supplies both window and room overrides.

## Universal links

The app declares `applinks:windmill.works` and routes `onOpenURL` through `AuthStore.arrived`.
`MagicLink.token(in:)` reads the fragment of `https://windmill.works/#/auth?token=<secret>`.
`WMUniversalLinksEnabled` is false; the repository contains no domain association file.

Activation requires a paid Apple Developer team with Associated Domains enabled for
`works.windmill.app`, plus `https://windmill.works/.well-known/apple-app-site-association`, served
as JSON over HTTPS without redirects or authentication:

```json
{ "applinks": { "details": [
    { "appIDs": ["TEAMID.works.windmill.app"],
      "components": [ { "/": "/", "#": "/auth?token=*" } ] } ] } }
```

Keep the fragment condition: a root-path-only claim would also open unrelated site links in the
app. The `?` glob matches any single character. After deployment, set `WMUniversalLinksEnabled`
true in `project.yml`; it records configuration state and is not read by app code. Token parsing
and arrival handling have package tests; routing needs a signed build and deployed association.

## Known gaps

- Journal lacks search, voice, Echoes, nudges and week view. Day markers are inline; pinning them
  to the current scroll bounds places them behind the status bar.
- Apple sign-in and universal-link activation are disabled in `project.yml`.
- `ProductModule` has no settings slot, so gym settings live under Routines. `ShellActions` cannot
  open sign-in directly; Coach's sign-in action opens You first. The plan meter and hub summaries
  are incomplete, and there is no launch asset.
- Gym renders kilograms even when the account prefers lb. Clocks count up; there are no rest
  notifications. Settings preserve server `restSeconds` and `restSound` without using them.
- Connected-log grants are created/revoked on web; iOS displays connection state and web links.
- Native gesture acceptance remains incomplete for routine reorder, jump-sheet drop and refusal
  dismissal. Dynamic Type support is partial; the routine editor still uses fixed sizes. Tab
  selection contrast and accessibility require native acceptance.
- Quarantined pages and workouts have no recovery UI. Device files use default data protection
  and remain included in iCloud/iTunes backup.
