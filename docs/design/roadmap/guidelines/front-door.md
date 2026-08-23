# Windmill Front door — the signed-in landing

The canonical spec for how windmill.works greets its own users. Graduated
from `explorations/signed-in-front-door.html` (its ★ verdict). The change is
surgical: **the nav's right cluster and the hero's CTA row are the only
things that swap** — the signed-out page stays byte-identical, and the
marketing content never changes (a signed-in user shares the same pitch
everyone sees). Live specimens: `explorations/signed-in-front-door.html`.

> **Principle: the seat, not a greeting.** No "Welcome back", no name in the
> nav, no auto-redirect — the avatar and the swapped verbs are the
> acknowledgment, and the page stays a page.

---

## 1. The four states

| State | Nav right cluster | Hero CTA row |
|---|---|---|
| Signed out | ghost **Log in** · primary **Start your tree** | **Start your tree** · **Try the live demo** |
| Link sent | chip **"Link sent — check your email"** · primary Start your tree | unchanged |
| Signed in · trees | primary **My trees** · seat (28px initial avatar) | primary **Resume {newest}** · ghost **My trees** + fact line |
| Signed in · none | primary **Start your tree** · seat | unchanged (nothing to resume, nothing pretends) |

- **Fact line** under the CTAs (trees>0 only): kind dot · "{tree} · n/m done ·
  last tended {recency}" — kind dot hue from the tree's root kind, count in
  mono. Resume's label truncates the name at ~18ch.
- The final CTA band may read "Plant another tree" signed-in (held for
  scroll data).

## 2. What the first click does

- **Resume {tree} → the tree, directly.** Camera restored to where you left
  it; the What's-next panel greets per its own open rules
  (`whats-next.md`) — the same landing the reminder email deep-links to.
- **My trees → `windmill.works/trees`** = the app on your newest tree with
  the TreeSwitcher already unfolded (F1·F2) — never an interstitial page.
  Arrival differs from Resume: camera at fit, Next panel holds (never under
  an open menu). If a "your library" page ever ships (reserved, X5 §8), the
  URL takes over and no button changes.
- **The seat → X4's menu** verbatim: identity · sync status · My trees
  (count) · Account settings · Sign out (instant, no confirmation).

## 3. The half-open door — link sent

- "Log in" swaps to a neutral chip, **"Link sent — check your email"**, gold
  breathing dot, same slot and size class. Clicking reopens X6's wait dialog
  (address, resend after 30s). It expires with the link (15 min) and quietly
  returns to "Log in" — no error, no nagging.
- When the link lands in another tab, this tab wakes itself (X6 §3): the
  chip resolves into the seat with the wake beat (480ms soft).
- "Start your tree" stays available throughout — waiting never blocks
  building (claiming covers it, X6 §4).

## 4. Constants — copy into the build

```
NAV       out: [ghost Log in][pri Start your tree] · sent: [chip][pri Start] · in+trees: [pri My trees][seat] · in+0: [pri Start][seat]
HERO      trees>0: pri "Resume {newest}" (~18ch) + ghost "My trees" + fact line (kind dot · n/m mono · recency)
CLICKS    Resume → tree (camera restored, Next panel per its rules) · My trees → /trees = switcher open · seat → X4 menu
CHIP      "Link sent — check your email" · gold dot · reopens wait dialog · expires with link · resolves to seat on landing
NEVER     "Welcome back" copy · a landing tree list/dashboard · auto-redirect · touching the signed-out page
```

## 5. Ownership map

| Concern | Owner |
|---|---|
| Seat + menu, wake beat | X4 (`account-sync-chrome`) |
| Link lifecycle, wait dialog, claiming | `auth.md` (X6) |
| TreeSwitcher, registry rows | F1·F2 (`progress-and-tree-registry`) + `explorations/rename-tree.html` |
| The panel Resume lands on | `whats-next.md` |
| State logic, CTA swap, click map, link-sent chip | **this doc** |

## Phone

The seat, the "Resume {newest}" CTA and the link-sent chip all sit in the
**action lane** (`mobile.md` §5) — bottom 300px, ≥44px targets. The nav collapses
to wordmark + seat; there is no hamburger, because there are only two
destinations. Magic-link entry obeys the keyboard contract (X8 §7): the email
field anchors above the keyboard with a Done bar, and nothing else moves.
