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

**All three products are shipping as rooms in this app.** Journal is the one that is built. Roadmap
and gym are mounted and render one honest line about where they work today plus a door to it — not
a mock screen, and not a "coming soon" that counts nobody's interest. When their native rooms land
they replace that line and nothing else in the shell changes.

**Sign in with Apple is the primary door** (one tap, no address to type), with the emailed link
beside it rather than behind it: the link is the only way a Hide My Email account can reach the
account that person already has on the web, and the only door that keeps one account across phone
and browser. Apple is gated off until it is configured — see `docs/IOS_APPLE_SIGNIN.md`.

## The shell — hub + capsule

Built to the resolved design in the Design project (`templates/superapp-shell/SuperappShell.dc.html`,
"S1 hub + S3 capsule"). The contract, which is why `Shell.swift` stays small:

- **The shell owns** the hub and the order its cards take · the capsule (38pt, top-left, one lane
  every app reserves) · tap = switcher, edge-swipe right = home, nothing else · the You seat, last
  slot in every app's bar, past a hairline · You and Windmill One, always clay, One reachable only
  from You.
- **Each app owns** its nav bar, tabs and gestures below the capsule · its skin, including a dark
  default · its own settings · the one line it lends the hub.

Two rules do the work on the hub: the doors sit **low**, because the greeting can be out of reach
and the doors can't — so the registry is written most-important-first and rendered bottom-up, making
reach order the priority order. And **live work outranks planned work**, so a product whose
`hubLine` is `running` sinks below everything else, where the thumb is. That is the only rank change
the hub ever makes.

The capsule lane is reserved by the shell with a safe-area inset rather than an overlay: a lane the
shell reserves cannot be forgotten by an app. A room says what colour it is with `roomChrome(_:)` and
the shell dresses the capsule to match — the one thing a room tells the shell about its skin.

**Appearance** (You → Light · Dark · System) is the one place light-or-dark is chosen, for the whole
app: the hub, the switcher, You, Windmill One, every sheet **and every room**. A room owns its
palette — journal answers dark with its night canvas and light with warm parchment — but not the
choice, and no room carries a theme control of its own.

The shell states the scheme **twice**, and both are load-bearing: `preferredColorScheme` travels up
to the window (flipping the UIKit traits, and with them every adaptive token) but does not write
`\.colorScheme` back into the subtree that declared it. Only the environment override reaches the
rooms. Journal stayed night under Light until that was added. It needs no branch at any call site because the role tokens are
aliases onto an *adaptive* neutral ramp, the same structure `tokens/colors.css` uses under
`[data-theme="dark"]`: `surfaceCanvas` IS `neutral50`, in both skins.

## The journey

Built to `guidelines/superapp-shell.md` §9. **Cold launch → one question → straight into that app →
the first real thing → the house, once.**

- **The one question** is the first screen, once ever — not the hub, because a hub of three empty
  rooms is a chore list. Three doors in plain verbs, each in its product's skin, one skip.
- **Launch reopens the last room you stood in.** Going home clears it: the hub is where you chose to
  be, so the next launch honours that rather than dragging you back in.
- **The house fires on the first capsule tap after something real exists**, and never again. The
  board describes two triggers (its map says first capsule tap, its caption says first artifact);
  this makes both true at once and needs no polling or channel out of a room.
- **Signed-out You states what is at stake** — "on this device · Journal · 2 pages" — the honest
  version of a save-your-work nudge: it says it once, where someone came to look. Products holding
  nothing are absent rather than shown as zero.
- **Journal's one teaching card** appears after the first page is saved and retires forever when
  answered. It is the only card journal ever shows.

**Tending is the one account verb.** It needs an account (30/month free signed in, 300 on Windmill
One); there is no anonymous tending. That is not a wall — everything done by hand works signed out
forever, and journal's first run spends nothing. Roadmap's "Plant it" and Gym's "Build my routine"
open the door at that tap and resume after, exactly as `auth.md` §2 defines for Share and Connect.

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
- **The plan meter in You is still not drawn.** The board shows one; this client has no entitlements
  call, and a meter that invented a number is worse than the gap. It arrives when the data does.
- **The entry question orders by registry, the hub orders bottom-up.** The same three cards appear
  in opposite orders on two adjacent screens. The hub's reversal is canon (reach order = priority
  order); the entry question is read top-down as a question, so it keeps registry order. If that
  reads as arbitrary in someone's hands, the entry question is the one to change.
- **The hub's summary line and plan meter are absent.** The board shows a one-line digest under the
  date ("One step marked done. No entry yet. Push day still waiting.") and a plan meter in You. Two
  of three products have no phone-side state to report and this client has no entitlements call, so
  neither is drawn — a composed sentence that could only speak for journal, or a meter that invented
  a number, would both be worse than the gap.
- **The edge-swipe home gesture is unverified.** It is hand-rolled (bound to the leading 20pt)
  because each app hides the navigation bar to own its chrome, which is exactly what disables the
  system's interactive pop. Synthetic touches are not available here, so it has been built but not
  driven; the capsule's switcher carries a Home row regardless.
