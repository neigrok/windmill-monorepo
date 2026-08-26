# Windmill iOS

One Swift superapp for the whole brand. `journal`, `roadmap` and `gym` are module libraries mounted
by a single app over a shared `WindmillPlatform` — the native mirror of `web/`. One sign-in, one
subscription.

## Layout

```
project.yml          the app target, declared (XcodeGen). Windmill.xcodeproj is GENERATED, not committed
App/
  WindmillApp.swift  the composition root — the only file that knows all three products exist
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

# from apps/ios/WindmillKit — the package's own scheme, not one of the project's
cd WindmillKit && xcodebuild test -scheme WindmillKit-Package \
  -destination 'platform=iOS Simulator,name=iPhone 17'

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

## The rooms

**Journal** follows the web canon: one continuous scroll, oldest at the top, today at the bottom,
restore (never animate) to the bottom on open, a gap drawn as a gap, mood and energy optional
always, and exactly one thing that moves on its own — today's ember.

**Roadmap** is mounted and renders one line about where it works today plus a door to it.

**Gym** owns the open session — workout mode, the ladder, the keypad, the rest clock and the
offline queue (`backend/products/gym/ARCHITECTURE.md` §11). The web mirrors and backfills.
The catalog ships in the app (`DeviceCatalog.seeded`, the same 64 rows as `backend/db/schema.sql`)
because signed out there is no catalog read to make.

Its containers are the platform's. A `TabView` carries Routines · The log · Coach, each tab holding
its own `NavigationStack` whose path the room owns (`GymRoom.paths`) — so a screen pushed in one tab
is that tab's, and a session opening or closing unwinds all three rather than leaving a stack
standing behind a live logger. Every root seats the capsule leading and the You seat trailing in its
own toolbar; the logger does too, with Finish beside the seat, because a live session replaces the
tabs. The finish is a `.sheet` over the session it just closed, presented only once the log answers
that the session is closed, so dismissing it leaves the lifter in the workout they finished. The
rack's keypad and ladder stay where they are, and the fix sheet raises that same keypad off its
weight numeral and its rep count, because a correction at the rack is one-handed too; the routine
target sheet is three typed fields (`TargetEntry`), whose bands are the routine's — sets 1–20,
reps 1–100 — and not the live logger's, which are `KeypadEntry`'s. Both keypads refuse in the same
four sentences; only the reps band differs.

An open line — a movement with no set target — says what that means in one sentence,
`You decide the numbers at the rack.`, drawn in the target sheet while the line is open and **once**
beneath any list of a routine's movements holding an open row — and while a target sheet stands over
that list, the SHEET owns the sentence and the list's copy steps aside, so one state is described
once. The word `open` in a row's target column is what says which rows they are. In the sheet the
sentence sits ABOVE the three fields,
beside `Never logged — these are your numbers.`: everything drawn under a field is that field's own
note. A list OF ROUTINES carries neither — it names movements and no targets, and the numbers are
read on the routine's own screen.

The movement picker opens on six and then hands over the whole catalogue. The six are this log's own
— the movements the most of its newest fifty sessions named (`PickerOptions.mostTrained`, counted off
`store.recent`), topped up in order from the shared opener list so a phone with no log still sees six
— and only a TYPED query is capped, at seven rows. The fifty-session window is cut once and held for
the life of the picker (`PickerOptions.window`, held in `@State`), so a claim or a poll landing
underneath cannot reshuffle the six under a thumb already reaching for one of them. The cut is made
on the first read that HELD something rather than on the first render: a picker opened in the moment
before the log answers has frozen nothing, and takes the answer that lands under it. The section is headed
`The six`; the catalogue under the gap needs no head of its own.

Rules that hold across the rooms:

- **Writing works before there is an account.** Every write lands on the device first and is marked
  owed; signing in *claims* what is there (additive, per page, by HLC stamp). Offline says `offline
  · saved here`; signed out says `saved on this device`.
- **Device storage is per seat.** Journal's page cache is one file per seat
  (`windmill-journal-pages-v2-u.<userId>.json`, `-v2-anon.json` signed out — the `v2` is the scale
  version, bumped when the shape of a stored page changes); gym's shelf, queue and weigh-ins
  (`windmill-gym-bodyweight.json`) are one set of rows per seat. A store opened for one seat cannot
  read another's. The one carry is anonymous work, which follows the person who signs in — the claim
  replays settings, movements, routines, sessions, then bodyweight last.
- **Nothing starts by itself.** A gym session begins only on *Start workout* or *Just start
  logging*. Home is the Routines list (tabs: Routines · The log · Coach); a fresh install offers
  **Build a routine** as the primary. Every start goes through `TrainingStore.start`.
- **Tell set-queue refusals apart by their machine `code`, never by their sentence**
  (`SetQueue.swift`'s `Verdict`): a spent id means re-mint and send again; a finished session and a
  workout the log no longer holds mean the set can never land; every other 400/409 is terminal in
  the log's own words.
- **A launch with no signal is not a sign-out.** The platform keeps the last-known user beside the
  session secret; `restore()` answers an *unverified* signed-in seat when the log cannot be reached,
  rooms connect under it off the device copies (`AccountCopy`, `DeviceCatalog`, `LocalLog`), and the
  seat is asked again on every foreground. Rooms key their connect on `Account.seat` — (user,
  verified). Only a definitive 401 ends a session.
- **Offline, Start composes the workout on the device** under the id and instant the attempt wore,
  so the claim's start is a replay. On connect the queue's owed sets go out before the claim's first
  start and again after it: a start settles the log's stale open session as a read does.

**Sign in with Apple is the primary door**, with the emailed six-digit code beside it. Email is the
only door that keeps one account across phone and browser, and a magic link pasted from the web is
how a Hide My Email account folds into an existing one (`backend/AUTH.md`). Apple is gated off
until it is configured — see `docs/IOS_APPLE_SIGNIN.md`.

## The shell — hub + capsule

Built to the Shell page of the Windmill · Design System Figma file (`qoOwNbWOYE1GFi0yR5uGY2`).

- **The shell owns** the hub and its card order · the capsule (38pt, top-left, one lane every app
  reserves) · tap = switcher, edge-swipe right = home at the room's root and nowhere deeper, nothing
  else · the You seat, last slot in
  every app's bar, past a hairline · You and Windmill One, always clay, One reachable only from You.
- **Each app owns** its nav bar, tabs and gestures below the capsule · its skin, including a dark
  default · its own settings · the one line it lends the hub.

Two rules order the hub: doors sit **low**, so the registry is written most-important-first and
rendered bottom-up, making reach order the priority order; and **live work outranks planned work**,
so a product whose `hubLine` is `running` sinks below everything else. That is the only rank change
the hub makes. The first-run entry question orders by registry, being read top-down as a question.

The capsule lane is reserved with a safe-area inset rather than an overlay, so an app cannot forget
it — unless the room declares `hostsTopChrome`, which says it draws a bar across the top itself and
seats `CapsuleButton` leading and `YouSeat` trailing in that bar's own toolbar. Gym does; journal and
roadmap do not. A room says what colour it is with `roomChrome(_:)` and the shell dresses the capsule
to match.

A room also says how deep it stands, with `roomDepth(_:)` — written once, at its root. The shell reads
it to decide what its leading edge means: home at 0, the room's own back below it, where the shell's
gesture is not attached at all. `UITests/RoomEdgeGestureUITests.swift` is what settles that on a
simulator, because only a real touch can.

**Appearance** (You → Light · Dark · System) is the one place light-or-dark is chosen, for the whole
app including every room. A room owns its palette but not the choice. The shell states the scheme
**twice** and both are load-bearing: `preferredColorScheme` travels up to the window (flipping the
UIKit traits and every adaptive token) but does not write `\.colorScheme` back into the subtree that
declared it — only the environment override reaches the rooms. No call site branches, because the
role tokens are aliases onto an *adaptive* neutral ramp, the same structure `tokens/colors.css` uses
under `[data-theme="dark"]`: `surfaceCanvas` IS `neutral50`, in both skins.

## The journey

Built to `docs/design/guidelines/superapp-shell.md` §9: cold launch → one question → straight into
that app → the first real thing → the house, once.

- **The one question** is the first screen, once ever: three doors in plain verbs, each in its
  product's skin, one skip.
- **A door says what it needs before it is chosen.** Roadmap's card carries that under its own
  sentence (`ProductModule.caveat`, read off `presence`); a room here with a wall in it says so in
  `EntryDoor.caveat`. Journal and gym have none.
- **Launch reopens the last room you stood in.** Going home clears it.
- **The house fires on the first capsule tap after something real exists**, and never again.
- **Signed-out You states what is at stake** — "on this device · Journal · 2 pages". Products
  holding nothing are absent rather than shown as zero.
- **Journal's one teaching card** appears after the first page is saved and retires when answered.

**Tending is the one account verb** (30/month free signed in, 300 on Windmill One); there is no
anonymous tending. Everything done by hand works signed out. Roadmap's "Plant it" and Gym's "Build
my routine" open the door at that tap and resume after
(`docs/design/roadmap/guidelines/auth.md` §2).

## Universal links

The repo half is written; the domain half is not in this repo, so a tapped link does not reach the
app. `project.yml` declares `com.apple.developer.associated-domains` = `applinks:windmill.works`;
`Shell.swift`'s `onOpenURL` hands the URL to `AuthStore.arrived(from:)`, which verifies the token
and adopts the session (a URL with no token is ignored, a refusal opens the door with the sentence
in it); `MagicLink.token(in:)` reads the token out of the **fragment**, the same function the door's
paste field uses. The link is `https://windmill.works/#/auth?token=<secret>`
(`backend/platform/application/AuthService.cpp`).

What the domain needs:

1. **A paid Apple Developer team** (`docs/IOS_APPLE_SIGNIN.md` step 1) with **Associated Domains**
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
  Gym's "Build my routine" opens You — one tap longer than the design.
- **Choosing `lb` changes nothing this app draws.** The setting is account-level and gym stores
  kilograms either way, but the ladder and keypad here are kilogram instruments. The row says so.
- **The rest timer has no alarm the phone is asleep for.** The clock is computed from the set's own
  instant so it is right whenever it is looked at; the chime is scheduled in-process, iOS suspends a
  backgrounded app, and a late chime is dropped. This product sends no notifications.
- **Gym's CSV export and the connected-log grant open the web** — a file this app has nowhere to
  put, and an entitlements read this client does not have.
- **No app icon or launch asset.**
- **The plan meter in You and the hub's summary line are not drawn** — no entitlements call, and two
  of three products have no phone-side state to report.
- **Gym's drag-to-reorder and swipe-to-drop are built but never performed.** No synthetic touch
  covers them yet; the edge-swipe home gesture, which used to sit in this list, is now driven by
  `WindmillUITests` on a simulator.
- **Dynamic Type does nothing in gym, so the room is MIXED at accessibility sizes.** Every size the
  room paints is a literal point value and does not move; the containers the platform paints do —
  the navigation bar, the tab bar, the keyboard, and `List` section headers and footers. At
  AccessibilityXXXL the routine editor is the visible case: `Movements` and its footer grow several
  times over while the name field beside them stays where it was. Photographed both ways through
  `UITests/RoomFramesUITests.swift`; the conversion to text styles is its own wave.
- **The gym tab bar's selected state is the system's, not the room's.** On iOS 26 the tab bar paints
  its own labels — measured #FFFFFF selected against #F6F3FA unselected, **1.10:1** — and ignores
  `.tint`, `UITabBarAppearance` and `unselectedItemTintColor` alike. What separates the selected tab
  there is the capsule the system draws behind it (#47444A on #262328, 1.62:1) and the filled symbol.
  The room applies no tint of its own to the `TabView`: `.tint` is an environment value, so one put
  there for the bar repaints every control in all three tabs and every sheet they raise, and it buys
  nothing on that OS. The room's `.tint(GymSkin.accent)` holds everywhere instead.
- **Quarantined pages and workouts have no door.** A device file written before per-seat storage is
  attributed to the session the device was holding; a phone holding none quarantines them (journal:
  `windmill-journal-pages-v2-unclaimed.json`; gym: a shelf and queue key no seat can name). Releasing
  them takes a human with an account, and this app has no journal settings surface to ask from.
- **The device's files are not excluded from backup.** They carry the default data protection class
  (complete-until-first-user-authentication, the same accessibility as the Keychain session), so at
  rest they are no weaker than the credential — but they ride an iCloud or iTunes backup.
