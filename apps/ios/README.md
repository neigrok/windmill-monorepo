# Windmill iOS

One SwiftUI app for journal and gym, with a roadmap link to the web. Product libraries depend on
`WindmillPlatform`; the app composes them under one account.

## Layout

```
project.yml          the app target, declared (XcodeGen). Windmill.xcodeproj is GENERATED, not committed
App/
  WindmillApp.swift  the composition root — the only file that knows all three products exist
  CrashReports.swift  dedicated iOS Sentry configuration and privacy scrub
  Assets.xcassets    the app icon — web/public/brand-mark.svg on the cream ground, 1024pt, opaque
Tests/App/           app integration tests, including crash report routing and privacy
WindmillKit/         the Swift package: everything that isn't the app bundle
  Sources/
    WindmillPlatform/  account · wire · session · the ProductModule seam · tokens · shell chrome
    WindmillJournal/   the night canvas
    WindmillRoadmap/   mounted, not built here — says where it does live
    WindmillGym/       the training log
  Tests/               mirrors Sources/
```

Each product depends on `WindmillPlatform`, never on another product (`STRUCTURE.md`). Enforced by
the compiler: the dependency does not exist in `Package.swift`.

## Build

```sh
brew install xcodegen                 # once
cd apps/ios && xcodegen generate      # after any change to project.yml
open Windmill.xcodeproj
```

From the command line (what CI runs):

```sh
xcodebuild build -project Windmill.xcodeproj -scheme Windmill \
  -destination 'platform=iOS Simulator,name=iPhone 17'

# the package's own scheme, run without changing the caller's directory
(cd WindmillKit && xcodebuild test -scheme WindmillKit-Package \
  -destination 'platform=iOS Simulator,name=iPhone 17')

# the UI tests (UITests/), which need a booted simulator and drive real touches
xcodebuild test -project Windmill.xcodeproj -scheme Windmill \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

- `swift build` does not work: the package is iOS-only (`platforms: [.iOS(.v17)]`) and the UI uses
  modifiers no other platform has. Build and test against a simulator.
- If `xcodebuild` reports it needs Xcode, point the toolchain at it for the run:
  `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild …`.
- `WMApiBaseURL` in `project.yml` is empty, meaning the production host. Set it to
  `http://localhost:8088` for the local backend; the ATS local-networking exception is declared.
- The `WindmillGym` ladder suite reads `packages/api-contract/gym-ladder.json` out of the checkout,
  so the whole monorepo must be present.

## Crash reports

The app uses Sentry Cocoa with the dedicated iOS project's `IOS_SENTRY_DSN` build setting.
Release builds require it; Debug builds without it send no crash reports. It never reads the
backend's `SENTRY_DSN`. CI reads the `IOS_SENTRY_DSN` repository secret only on trusted runs.

```sh
xcodebuild build -project Windmill.xcodeproj -scheme Windmill -configuration Release \
  -destination 'platform=iOS Simulator,name=iPhone 17' IOS_SENTRY_DSN="$IOS_SENTRY_DSN"

xcodebuild test -project Windmill.xcodeproj -scheme Windmill \
  -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:WindmillCrashReportTests
```

Crash reports retain exception types and stacks, release/build and device diagnostics. Exception
messages, mechanism descriptions/data, user identity, request data, breadcrumbs, extras and custom contexts are
removed before delivery. Memory introspection, screenshots, view hierarchies, network tracking,
replay, performance tracing and automatic session tracking are disabled. The Sentry dependency
lives in the app bundle; product libraries do not depend on it.

Neither CI nor the release workflow uploads dSYMs to Sentry. Production crash frames require the
matching release dSYMs to be uploaded to the iOS Sentry project before they can be fully symbolicated.

## Release

`.github/workflows/ios-release.yml` archives a signed Release build and uploads it to App Store
Connect. It runs when iOS CI passes on a push to `main`, building the commit CI tested, and it can be
run by hand:

```sh
gh workflow run ios-release.yml
```

A processed build appears in TestFlight, where the internal testing group can install it. Its build
number is the release workflow's run number; its version is `MARKETING_VERSION` in `project.yml`,
bumped by hand. Signing is automatic, driven by an App Store Connect API key: the workflow passes the
team, turns signing on and supplies `IOS_SENTRY_DSN` on the `xcodebuild` command line, so
`project.yml` never names a team. It reads the `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`,
`ASC_KEY_P8_BASE64` and `IOS_SENTRY_DSN` repository secrets. The app declares
`ITSAppUsesNonExemptEncryption` false, so a build needs no export-compliance answer.

## Product and storage boundaries

Journal owns the daily canvas; gym owns workout entry, routines, the log and Coach. Roadmap opens
its web surface. Product UI rules live in [design canon](../../docs/design/readme.md); gym's shared
data rules live in [its backend architecture](../../backend/products/gym/ARCHITECTURE.md).

Manual writing and training work signed out. Device storage is keyed by account, with a separate
anonymous store. Journal uses versioned page files; gym uses a shelf, set queue and bodyweight
store. Anonymous work is claimed on sign-in. A store for one account cannot read another's data.
Legacy files without an account are attributed to the stored session or quarantined.

A launch without a network keeps the last-known account unverified. Rooms reconnect on
`Account.seat` (user and verification state), and the platform reverifies on foreground. Only a
confirmed 401 signs out. Offline workout starts keep their original id and timestamp for replay;
sets drain before and after session claims. Queue refusals use machine codes, never sentence text.

Gym's `TrainingStore.start` owns every workout start. The finish sheet appears after persistence;
dismissing it writes nothing. Workout elapsed and time since the latest set derive from saved
timestamps and freeze at finish. Routine targets and live rack entry have separate validation
bands. The device catalogue supplies stable movement ids before an authenticated catalogue read.

Coach requires an account. Questions, request ids, attachment ids and partial replies persist
under that account; retries retain identity. Stop preserves partial text and completed actions.
The native picker accepts one image, normalizes it to JPEG within 4096 pixels per edge and 5 MiB,
and retains a private copy through upload retries. Retained images use authenticated storage.

Email sign-in uses a six-digit code; pasted web magic links are also accepted. Sign in with Apple
is gated by configuration. See [Apple setup](../../backend/AUTH.md#apple-sign-in-activation) and
[account linking](../../backend/AUTH.md).

## Shell

`ProductModule` supplies the room, hub line, entry wording and device holdings. The shell owns the
hub, capsule, account seat and appearance; products own their navigation and palettes. A room with
`hostsTopChrome` seats `CapsuleButton` and `YouSeat` in its own toolbar. Other rooms receive the
shell's safe-area inset. `roomChrome` supplies the skin; `roomDepth` reserves the home edge gesture
for the root, leaving deeper navigation to the product.

The hub renders registry priority from the bottom and gives running work the lowest seat. Launch
restores the last room. The first-use question and house introduction are device-local, once-only
state in `FirstRun.swift`. Appearance applies both `preferredColorScheme` to the window and an
environment override to the rooms; adaptive platform tokens supply their colours.

## Universal links

The repo half is written; the domain half is not in this repo, so a tapped link does not reach the
app. `project.yml` declares `com.apple.developer.associated-domains` = `applinks:windmill.works`;
`Shell.swift`'s `onOpenURL` hands the URL to `AuthStore.arrived(from:)`, which verifies the token
and adopts the session (a URL with no token is ignored, a refusal opens the door with the sentence
in it); `MagicLink.token(in:)` reads the token out of the **fragment**, the same function the door's
paste field uses. The link is `https://windmill.works/#/auth?token=<secret>`
(`backend/platform/application/AuthService.cpp`).

What the domain needs:

1. **A paid Apple Developer team** ([Apple team configuration](../../backend/AUTH.md#apple-sign-in-activation)) with **Associated Domains**
   ticked on the `works.windmill.app` App ID. A free personal team cannot use this capability, so
   signing for a real device needs the paid team. Simulator and CI builds are unaffected — signing
   is off there, so the entitlement is never applied.
2. **`https://windmill.works/.well-known/apple-app-site-association`**, served as
   `Content-Type: application/json`, over HTTPS, with no redirect and no auth. It belongs beside the
   site's other static files.

   ```json
   { "applinks": { "details": [
       { "appIDs": ["TEAMID.works.windmill.app"],
         "components": [ { "/": "/", "#": "/auth?token=*" } ] } ] } }
   ```

   The token is in the fragment, so the claim has to be a `#` component. A path claim would have to
   be `"/": "/"` — the whole site — and the app would swallow the gallery, shared trees and pricing.
   Apple's globs treat `?` as a single-character wildcard, so this also matches `/authXtoken=…`.
3. **Flip `WMUniversalLinksEnabled` to true in `project.yml`.** No code reads the flag; it is the
   declared truth of whether the domain half exists.

`WindmillPlatformTests` covers the token parser and the arrival handling. The routing itself cannot
be tested without the file on the domain and a signed build.

## Known gaps

- **The day marker does not pin.** SwiftUI pins `LazyVStack` section headers to the scroll view's
  bounds, which include the status bar, so a pinned marker parks behind the clock. Markers are
  inline; the fix is a top anchor or a `List`-backed canvas.
- **Journal search, voice, echoes, nudges and the week are not here.**
- **Sign in with Apple is off** (`WMAppleSignInEnabled`), and **universal links are not live**.
- **`ProductModule` has no settings slot** (`room`, `hubLine`, `entry`, `holdings`), so gym's
  settings hang off a row at the foot of Routines rather than from You.
- **`ShellActions` cannot open the sign-in door** (`openYou`, `openSwitcher`, `goHome` only), so
  Gym's `Sign in first` opens You — one tap longer than the design.
- **Choosing `lb` changes nothing this app draws.** The setting is account-level and gym stores
  kilograms either way, but the ladder and keypad here are kilogram instruments. The row says so.
- **Workout clocks count up.** The logger shows elapsed workout time and time since the latest
  retained set, or since start before the first set. They derive from persisted timestamps,
  including offline sets, and freeze at finish. This product sends no rest notifications and carries
  the settings document’s `restSeconds` and `restSound` through untouched.
- **The connected-log grant is made and ended on the web** — `Connect a tool` and
  `Manage connections` are browser doors; the screen itself reads the grants and keys and draws
  the state (`docs/design/gym/briefs/19-connected-log.md`).
- **No launch asset.**
- **The plan meter in You and the hub's summary line are not drawn** — no entitlements call, and two
  of three products have no phone-side state to report.
- Native gesture acceptance is incomplete. `UITests/` covers shell edge navigation, set deletion,
  movement paging and log-row long press; routine reorder, jump-sheet drop and refusal dismissal
  still need direct acceptance.
- **Dynamic Type coverage is partial.** Routine list names and metadata, workout clocks and the
  contextual Coach ceiling use scalable type. The workout clock pair wraps vertically when needed.
  Other gym text still uses fixed point sizes, including the routine editor, so the room remains
  mixed at accessibility sizes.
- The gym tab bar uses the system selected state; selection contrast and accessibility need native
  acceptance. Product tint stays on the room rather than the entire `TabView`.
- **Quarantined pages and workouts have no door.** A device file written before per-seat storage is
  attributed to the session the device was holding; a phone holding none quarantines them (journal:
  `windmill-journal-pages-v2-unclaimed.json`; gym: a shelf and queue key no seat can name). Releasing
  them takes a human with an account, and this app has no journal settings surface to ask from.
- **The device's files are not excluded from backup.** They carry the default data protection class
  (complete-until-first-user-authentication, the same accessibility as the Keychain session), so at
  rest they are no weaker than the credential — but they ride an iCloud or iTunes backup.
