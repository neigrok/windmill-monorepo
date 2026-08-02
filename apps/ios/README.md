# Windmill iOS

One Swift superapp for the whole brand. `journal`, `roadmap` and `gym` are module libraries mounted
by a single app over a shared `WindmillPlatform` — the native mirror of `web/` (shell +
design-system + products). One sign-in, one subscription. Modules stay independently mountable, so
any product can later graduate into its own focused app.

## Layout

```
project.yml          the app target, declared (XcodeGen). Windmill.xcodeproj is GENERATED, not committed
App/
  WindmillApp.swift  the composition root — the only file that knows all three products exist
WindmillKit/         the Swift package: everything that isn't the app bundle
  Sources/
    WindmillPlatform/  account · wire · session · the ProductModule seam · tokens · shell chrome
    WindmillJournal/   the night canvas (the room that is actually built for a phone)
    WindmillRoadmap/   mounted, not built here — says where it does live
    WindmillGym/       mounted, not built here — carries the weight ladder
  Tests/               mirrors Sources/
```

Each product depends on `WindmillPlatform`, never on another product — the same one-directional
rule the backend and web follow (`STRUCTURE.md`). Here it is enforced by the compiler rather than by
convention: the dependency simply does not exist in `Package.swift`.

## Build

The project file is generated, so the first step is always the same:

```sh
brew install xcodegen                 # once
cd apps/ios && xcodegen generate      # after any change to project.yml
open Windmill.xcodeproj
```

From the command line (this is what CI runs):

```sh
xcodebuild build -project Windmill.xcodeproj -scheme Windmill \
  -destination 'platform=iOS Simulator,name=iPhone 17'

# from apps/ios/WindmillKit — the package's own scheme, not one of the project's
cd WindmillKit && xcodebuild test -scheme WindmillKit-Package \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

**`swift build` does not work here, and that is deliberate.** The package is iOS-only: the UI uses
modifiers that exist on no other platform, and making it also compile for a Mac it will never run on
would cost a scatter of `#if os(iOS)` through the view code and buy nothing. Everything builds and
tests against a simulator instead — which has the side benefit of being the thing we actually ship.

If `xcodebuild` reports it needs Xcode, point the toolchain at it for the run:
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild …`.

## What is real

**Journal is a working room.** The canvas is the native statement of
`web/src/products/journal/Canvas.jsx` and follows the same canon: one continuous scroll, oldest at
the top, today at the bottom, restore (never animate) to the bottom on open, a gap drawn as a gap,
mood and energy optional always, and exactly one thing that moves on its own — today's ember.

**Writing works before there is an account.** Auth canon is "claiming, not gating": every write
lands on the device first and is marked owed; the network is what happens next, or later, or on
sign-in. Signing in *claims* what is already there (additive, per page, by HLC stamp). Offline says
`offline · saved here`; signed out says `saved on this device`.

**Roadmap and gym are mounted but not built for the phone.** They render one honest line about where
they do live and a door to it — not a mock screen, and not a "coming soon" that counts nobody's
interest.

## Known gaps (wave 2)

- **The day marker does not pin.** Canon §4 wants it sticky on phone. SwiftUI pins `LazyVStack`
  section headers to the scroll view's bounds, which include the status bar, so a pinned marker
  parks behind the clock. Markers are inline for now; the fix is a real top anchor (canon §11 already
  describes the pinned chip anchoring to an app header) or a `List`-backed canvas.
- **Search, voice, echoes, nudges and the week are not here.** Canon puts all of them beside the
  canvas or one tap away; the canvas is the load-bearing half and shipped first.
- **Sign in with Apple is off.** `WMAppleSignInEnabled` in `project.yml` gates it, and it stays false
  until there is a paid team, the capability, and the four server env vars — absent, never
  present-and-broken. The code path and the relay-address link door are written and waiting.
- **The magic link is completed by pasting it.** The emailed link opens the *web* app; until the app
  claims `windmill.works` links with an associated domain, pasting is the honest finish. The same
  field keeps working once universal links land.
- **No app icon or launch asset yet.**
