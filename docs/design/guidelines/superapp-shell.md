# The superapp shell — hub + capsule (native)

The contract for the Windmill iOS shell: what the shell owns, what each app owns, and the two
gestures between them.

> Journal's own canon is `journal/journal.md`. Auth is `roadmap/guidelines/auth.md`. Pricing is
> `marketing/guidelines/pricing.md`. This file governs only the frame around them.

---

## 1. No tab bar

All three products ship as rooms in one app, and each brings its own internal navigation. The
switch between rooms costs one reserved seat, never a bottom bar — the bottom bar stays the
app's.

## 2. The shell owns

1. **The hub**, and the order its cards take (§3).
2. **The capsule** — 38pt, top-left, one lane every app reserves and none of them paints.
3. **Two gestures, and nothing else**: tap the capsule = the switcher; edge-swipe right = home.
4. **The You seat** — the last slot in every app's own bar, past a hairline, so it reads as the
   shell's and not the app's.
5. **You and Windmill One**, always clay whatever room you came from — and One is reachable
   **only** from You.

## 3. The hub — the front door

Cold launch lands here. A deep link skips it entirely.

- **Three living doors**, each in its own skin, each showing the one line that decides whether
  you go in. The skin tells you which room you are walking into.
- **The doors sit low, in thumb reach.** The greeting can be out of reach; the doors cannot.
  They stack from the bottom up, so **the reach order is the priority order**.
- **Live work outranks planned work.** A product with something running sinks to the *bottom*
  of the stack so its CTA lands under the thumb. This is the only rank change the hub makes.
- **No plan meter here.** Billing lives in You, and nowhere else.
- A fourth sibling is one more card here and one more row in the switcher. Nothing else moves.

**Each app lends the hub exactly one line** — an eyebrow, a headline, an optional meta, and
whether it is running. The shell never reaches into a product for state; it asks, and the
product answers. A product with no phone-side state yet says where it *does* work rather than
implying a room that opens onto nothing.

## 4. Inside an app — two reserved seats

**Top-left: the capsule.** Tap opens the switcher; edge-swipe right goes home. It wears a
**dot** when another app has something running — never a count, never a number.

**Bottom-right: You.** The last slot in the app's own bar, past a hairline — same right edge
whatever the app's chrome. Journal has no tabs, so its one bottom bar takes that seat; gym has
three tabs and takes it after them.

**The switcher** is a sheet: rooms sit **lowest** (the most-tapped thing under the thumb), Home
is the small line above them, and Windmill One is not in it at all. Each row carries the app's
own line, and the room you are in reads "you're here".

## 5. Each app owns

- Its nav bar, its tabs, and its gestures **below the capsule**.
- **Its palette** — terracotta on Tuscan earth, the candle on paper or dusk, iris on stone. The
  shell does not invent a room's colours; it only says *light or dark*, and the room maps that
  onto its own place.
- **Its own settings.** You lists them and walks you in; it never absorbs them. Per-app
  preferences never leak up into the shell's screens.
- The one line it lends the hub.

**A room reports its skin outward exactly once**, so the shell can dress the capsule it lays
over that room and nothing else. It must be a live value rather than a constant on the product:
journal's skin is night *or* day by the writer's choice. In the build this is `roomChrome(_:)`.
Everything else about a room's appearance stays inside the room.

## 6. You & Windmill One

**You** — profile, the plan row, appearance, the one nudge, doors into each app's settings,
connected tools, sessions and data, sign out. It mirrors the web settings home.

**Appearance is the one place light-or-dark is chosen, for the whole app.** Light · Dark ·
System, System by default. It sets the hub, the switcher, You, Windmill One, every sheet **and
every room**. A room still owns its *palette* — journal answers dark with its night canvas and
light with warm paper, gym answers with pietra or basalt — but it does not own the *choice*,
and no room carries a theme control of its own. "System" is not a third palette; it is the
absence of an override.

**State the scheme twice: once as the window's `preferredColorScheme`, once as an environment
override down the tree.** `preferredColorScheme` travels *up* to the window — it flips the
UIKit traits but does not write `\.colorScheme` back into the subtree that declared it, so a
room reading the environment would otherwise see the system's answer. Only the environment
override reaches the rooms.

No call site branches on the skin: the role tokens are aliases onto an *adaptive* neutral ramp,
exactly as `tokens/colors.css` re-authors the ramp under `[data-theme="dark"]` and lets every
role follow. `surfaceCanvas` IS `neutral50` in both skins.

**Windmill One** — the superapp's only paywall, and it sells **tending**, never a re-sold
default (`pricing.md`). Free is a real allowance, not a teaser. One plan across all three apps.

Both are **always clay**, whatever room you came from, and both are one tap away: the avatar on
the hub, or the You seat at the end of any app's bar.

## 7. Honesty rules for this frame

1. **Never a mock room.** A product with no native surface yet renders one true line about
   where it does work and a door to it — not a placeholder screen, and not a "coming soon".
2. **Never a number we don't have.** A plan meter, a digest line or a streak is drawn only when
   the data behind it is real.
3. **The dot is the only thing the capsule says.** Something is running elsewhere. It never
   carries a count, a badge, or an unread total.
4. **No walls.** Auth canon §2 governs the shell too: the app opens on the product, not on a
   sign-in screen, and signing in *claims* what is already there. The You seat is the only
   unprompted mention of sign-in in the whole app.

## 8. Held open

- **The daily digest** — a hub top card if it earns its place, never a fourth surface.
- **Quick capture** from a long-press on the capsule.
- **A fourth sibling** — one more hub card, one more switcher row.

## 9. The journey — how someone arrives

Full spec: `guidelines/superapp-flow.md`. The shape: **cold launch → one question → straight
into that app → the first real thing → the house, once.**

- **Nothing is gated.** No account wall, no splash pitch, no "save your work" nudge, no tour,
  no coach marks, no progress dots, no second onboarding screen, and no permission asked before
  the feature that needs it. Nothing counts how many times anyone declined anything.
- **The first screen is one question** — "What do you want to do first?" — three rooms in plain
  verbs, one skip. It runs once, ever. A deep link skips it entirely.
- **Onboarding is the real surface with its first move filled in.**
- **Launch reopens the last room you stood in**, not the hub.
- **The house sheet fires once**, after the first real thing exists.
- **Signing in is an adoption** of what is already there, offered from You, from share, and
  from a second device, and it resumes whatever you were doing. Never unprompted.
- **The one honest line** — "your stuff lives on this device" — is stated once, in You.

### 9a. Tending is the one account verb

**Tending requires an account.** Free is 30 a month for a signed-in account; Windmill One
raises it to 300. There is no anonymous tending — a tending is a server-side agent loop that
bills real tokens, the allowance is metered per account, and a device id is not an identity.

- Everything a person does **by hand** works signed out, forever — writing, planting steps,
  logging sets, editing, and every read. Journal's first run spends nothing.
- **Roadmap's "Plant it" and Gym's "Build my routine" are account verbs.** They open the door
  at the moment they are asked for and **resume after** — the pattern `auth.md` §2 defines for
  Share, Invite and Connect.
- Both first runs keep a no-account path: **"Start from a blank tree instead"** and **"Just log
  freely"** / a ready routine. Those are how the rooms work without the agent, not a downgrade.

## 10. Constants — copy into the build

```
FRONT DOOR  hub on cold launch · deep link skips it · doors low, stacked bottom-up
            reach order = priority order · running sinks to the bottom · no plan meter
CAPSULE     38pt · top-left · one reserved lane · tap = switcher · edge-swipe right = home
            dot when another app is running · never a count
YOU SEAT    last slot in every app's own bar, past a hairline · same right edge everywhere
SWITCHER    rooms lowest · Home above them · Windmill One never in it
SHARED      You and Windmill One always clay · One reachable only from You
APP OWNS    its bar, tabs, gestures below the capsule · its skin incl. dark default
            its own settings · the one line it lends the hub · its skin reported outward once
JOURNEY     one question once · first run IS the real surface · first real thing · house once
            launch reopens the LAST ROOM · claim is adoption, never unprompted
TENDING     needs an account · 30/mo free signed in · 300 on Windmill One · never anonymous
            it is an account verb: the door opens when asked for, and resumes after
```
