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
    WindmillGym/       the training log (the room the open session belongs to)
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

**What the device holds, it holds per account.** Journal's page cache is one file per seat
(`windmill-journal-pages-<userId>.json`, `-anon.json` for the writing done signed out), and gym's
shelf and queue are one set of rows per seat inside their two files. A store is opened for one seat
and cannot read another's, which is what keeps a handed-over phone from showing — and re-uploading —
the last person's journal or replaying their workout into the next account (audit MOBILE-1,
MOBILE-3, fixed 2026-08-22). One thing crosses: anonymous work follows the person who signs in,
which is the claim. What the files held before that date belongs to **the seat the device was
holding when it upgraded** — a phone with a session in the Keychain was being used by that person,
so their pages and their workout carry on under their own name and a mid-workout upgrade is whole.
A phone holding no session cannot say whose that work is (signed out now is not "nobody wrote
this"), so it is quarantined instead: journal's in `windmill-journal-pages-unclaimed.json`, gym's
under a shelf key no seat can name. Nothing reaches either, and no screen yet offers them back.

**All three products are shipping as rooms in this app.** Journal and gym are built. Roadmap is
mounted and renders one honest line about where it works today plus a door to it — not a mock
screen, and not a "coming soon" that counts nobody's interest. When its native room lands it
replaces that line and nothing else in the shell changes.

**Gym is here because the phone is the only device that can own an open session.** The web mirrors
and backfills; workout mode, the ladder, the keypad, the rest clock and the offline queue all need a
device that is with you, awake and able to log in a basement with no signal
(`backend/products/gym/ARCHITECTURE.md` §11). The room is anonymous-first: sessions, routines and
finished history live on the device before there is an account (`LocalLog`), and signing in claims
them — movements, then routines, then sessions oldest first, each replayed start → sets → finish
with `joinOpenSession: false`. **The catalog ships in the app** (`DeviceCatalog.seeded`, the same 64
rows as `backend/db/schema.sql`) because signed out there is no catalog read to make: without them a
fresh install opened the picker onto "the catalog didn't load", which made the anonymous room a
promise it could not keep on the one launch that matters.

**Nothing starts by itself — including on the first arrival.** The first-run auto-start
(`GymRoom.openTheFirstOne`, §J22's exception) is retired as of the 2026-08-13 routine-first update:
first-open testing named "why is a session already running" as a blocker, and the rule is absolute
now — a session begins only when the lifter opens a routine and taps *Start workout*, or taps *Just
start logging*. Home is the **Routines** list (the tabs are Routines · The log · Ask), and on a
fresh install its empty state carries the onboarding weight instead: "No routines yet", **Build a
routine** as the primary, *Just start logging* as the second path. Every start still goes through
the same `TrainingStore.start`, so the local shelf and the claim replay know the session like any
other; the once-per-install flag's stored key (`windmill.gym.firstSessionOpened`) lingers harmlessly
on devices that set it, read by nothing.

The queue is the room's load-bearing part: sets are kept on the device under their own client-minted
ids and replayed until the log takes them, and the refusals are told apart by their machine `code`,
never by their sentence (`SetQueue.swift`'s `Verdict`): a spent id means re-mint and send again, a
finished session and a workout the log no longer holds mean that set can never land and the room
says so, and every other 400/409 is terminal in the log's own words. **A launch with no signal is
not a sign-out** (`Auth.swift`, 2026-08-16): the platform keeps the last-known user beside the
session secret, `restore()` answers an *unverified* signed-in seat when the log cannot be reached,
the gym room connects under it off the device copies it holds (`AccountCopy` for the program and
the picker's last lines, `DeviceCatalog` for names, `LocalLog` for settings), and the seat is asked
again on every return to the foreground; the rooms key their connect on `Account.seat` — (user,
verified) — so the restore that finally reaches the log reconnects them. Only a definitive 401 ends
a session. Signed in with no signal, **Start composes the workout on the device** from the routine
the store holds — under the id and instant the attempt wore, so the claim's start is a replay the
log answers with its own row should the first have landed — and the claim lands it on the retry
cadence; nobody in a basement is told "the log didn't answer". On connect the queue's owed sets go
out before the claim's first start and again after it, because a start settles the log's stale open
session exactly as a read does.

**Sign in with Apple is the primary door** (one tap, no address to type), with the emailed six-digit
code beside it rather than behind it: email is the only door that keeps one account across phone and
browser, and a magic link pasted from the web is still how a Hide My Email account folds into the
account that person already has (`AUTH.md`'s link door). Apple is gated off until it is configured —
see `docs/IOS_APPLE_SIGNIN.md`.

## Universal links — the repo half is done, the domain half is yours

The app signs in by an emailed six-digit **code** (`door: "app"` on `POST /v1/auth/magic-link`), so
sign-in no longer depends on the emailed link at all — the old failure where tapping the link opened
Safari, signed you in over there and burned the paste field's credential is gone with the paste step
itself. The magic link still exists (the web's door, old emails, a link requested cross-surface), it
is `https://windmill.works/#/auth?token=<secret>` (`backend/platform/application/AuthService.cpp`),
and a tap on it should someday open **this app**. Everything a build can contribute is written:

- `project.yml` declares `com.apple.developer.associated-domains` = `applinks:windmill.works`.
- `Shell.swift`'s `onOpenURL` hands the URL to `AuthStore.arrived(from:)`, which verifies the token
  and adopts the session. A URL with no token is ignored; a refusal opens the door with the sentence
  already in it, so a link that wakes a closed app and fails is never a launch that did nothing.
- `MagicLink.token(in:)` already reads the token out of the **fragment**, which is where it lives —
  the same function the door's field uses for a pasted link, so both roads end in one parser.

**It does nothing until the domain says so, and that part is not in this repo.** iOS only routes a
link to an app when the site serves an association file naming that app, signed by a real team:

1. **A paid Apple Developer team** (`docs/IOS_APPLE_SIGNIN.md` step 1) with **Associated Domains**
   ticked on the `works.windmill.app` App ID. A free personal team cannot use this capability — which
   also means that from now on, signing for a real device needs the paid team. Simulator and CI
   builds are unaffected: signing is off there, so the entitlement is never applied.
2. **`https://windmill.works/.well-known/apple-app-site-association`**, served as
   `Content-Type: application/json`, over HTTPS, with **no redirect** and no auth. Not committed here
   because `apps/ios` does not own the web origin; it belongs beside the site's other static files.

   ```json
   {
     "applinks": {
       "details": [
         {
           "appIDs": ["TEAMID.works.windmill.app"],
           "components": [
             { "/": "/", "#": "/auth?token=*",
               "comment": "the magic link and nothing else — every other URL on this domain has no matching component, so it stays in the browser. Note Apple's globs treat ? as a single-character wildcard, so this also matches /authXtoken=…, which is not a route." }
           ]
         }
       ]
     }
   }
   ```

   The token is in the fragment, so the claim has to be a `#` component. A path claim would have to be
   `"/": "/"` — the whole site — and the app would start swallowing the gallery, shared trees and the
   pricing page.
3. **Then flip `WMUniversalLinksEnabled` to true in `project.yml`.** Since the code door shipped,
   no code reads the flag — the door asks for a code and gives no instruction about the link — so it
   stands as the declared truth of whether the domain half exists, kept so the wave that makes a
   tapped link come home has one switch to flip and one place to look.

Unverified until all three hold: the routing itself. The token parser and the arrival handling are
covered by `WindmillPlatformTests`; whether iOS hands us the URL cannot be tested without the file
on the domain and a signed build.

## The shell — hub + capsule

Built to the resolved design now on the Shell page of the Windmill · Design System Figma file
(`qoOwNbWOYE1GFi0yR5uGY2`) — formerly `SuperappShell.dc.html`, "S1 hub + S3 capsule". The contract, which is why `Shell.swift` stays small:

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
- **A door says what it needs before it is chosen.** One of the three rooms does not open straight
  onto work — roadmap's canvas is on the web — so its card carries that fact under the product's own
  sentence (`ProductModule.caveat`, read off `presence` for a room that is really elsewhere; a room
  that is here with a wall in it would say so in `EntryDoor.caveat`, so no sentence is written
  twice). Nil is the good case, and journal and gym both have none: both rooms are anonymous-first,
  and gym's log lives on the device until signing in claims it.
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
Gym's card is on its opening picker and it is the only account verb in that room; signed in it opens
the connect page instead, because what the agent still needs then is the grant and not a sign-in.

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
- **Universal links are wired but not live.** See the section below: everything in the repo is done
  and `WMUniversalLinksEnabled` is false until the domain half exists.
- **Gym's settings have no seam to hang from.** The design reaches them from You: a product registers
  a settings *section* and the shell composes it, exactly as `web/src/products/gym/routes.js`
  registers `GymSettingsSection`. `ProductModule` has no such slot — `room`, `hubLine`, `entry`,
  `holdings`, and nothing about settings — and the shell is not a product's territory, so gym's own
  rows are reached from a quiet row at the foot of home (Routines) instead. The screen is the one
  the section would show; when the seam lands, the row on home goes.
- **Choosing `lb` changes nothing this app draws.** The setting is real and account-level, and gym
  stores kilograms under either answer — but the ladder and the keypad here are kilogram
  instruments, and a pound numeral over buttons that step in kilos would not add up. The row
  says so in the row rather than moving and quietly doing nothing.
- **The rest timer has no alarm the phone is asleep for.** The clock is computed from the set's own
  instant, so it is right whenever it is looked at; the chime is scheduled in-process, iOS suspends a
  backgrounded app, and a chime that arrived minutes late is dropped rather than played. This product
  sends no notifications, so there is nothing to promise instead — and the settings row says it.
- **Gym's CSV export and the connected-log grant are doors to the web.** The export is a file this
  app has nowhere to put yet, and the grant state is an entitlements read this client does not have —
  the same gap the plan meter has. Both rows open the web page that owns them rather than naming a
  state nobody checked.
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
- **The account verb reaches the door through You.** `ShellActions` lends a room three moves —
  `openYou`, `openSwitcher`, `goHome` — and none of them is "open the sign-in door". Gym's "Build my
  routine" therefore opens You, where the door is one row away, rather than the door itself the way
  §J23 draws it. The room is behind the sheet either way, so the resume is right; it is one tap
  longer than the design. A `ShellActions.openDoor` would close it, and the shell is not a product's
  territory.
- **Gym's two assembly gestures are built but not driven.** Drag-to-reorder and swipe-to-drop on the
  session list (§A screen 2) are a `List` with `onMove` and `swipeActions`; what a drag and a swipe
  DO is covered by tests against the store, and the screen has been read on a simulator, but no
  synthetic touch is available here so the gestures themselves have never been performed. Same
  standing as the edge-swipe below.
- **The edge-swipe home gesture is unverified.** It is hand-rolled (bound to the leading 20pt)
  because each app hides the navigation bar to own its chrome, which is exactly what disables the
  system's interactive pop. Synthetic touches are not available here, so it has been built but not
  driven; the capsule's switcher carries a Home row regardless.
- **The quarantined pages and workouts have no door.** What a pre-2026-08-22 device file held is
  attributed to the session the device was still holding at the upgrade; on a phone holding none, it
  is quarantined (journal: `windmill-journal-pages-unclaimed.json`; gym: a shelf and queue key no
  seat can name). Nobody may be handed it without saying so out loud in front of a list of days and
  word counts — the web asks in settings · Your journal — and this app has no journal settings
  surface to ask from, so for now it is kept and unreachable. Quarantined beats delivered to a
  stranger; the door is the follow-up.
- **The device's files are not excluded from backup.** They carry the default data protection class
  (complete-until-first-user-authentication — the same accessibility the Keychain session uses), so
  at rest they are no weaker than the credential. They do ride an iCloud or iTunes backup, which an
  unencrypted local backup would put on a laptop in the clear. Excluding them would cost the one copy
  of anonymous and unsent work on a device restore, so it is an owner's call rather than a silent one.
