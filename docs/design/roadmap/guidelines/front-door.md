# Front door — the signed-in landing

How windmill.works greets its own users. Only the nav's right cluster and the hero's CTA
row swap; the marketing content is identical signed in and signed out.

> **Principle: the seat, not a greeting.** No "Welcome back", no name in the nav, no
> auto-redirect — the avatar and the swapped verbs are the acknowledgment, and the page
> stays a page.

## 1. The four states

| State | Nav right cluster | Hero CTA row |
|---|---|---|
| Signed out | ghost **Log in** · primary **Start your tree** | **Start your tree** · **Try the live demo** |
| Link sent | chip **"Link sent — check your email"** · primary Start your tree | unchanged |
| Signed in · trees | primary **My trees** · seat (28px initial avatar) | primary **Resume {newest}** · ghost **My trees** + fact line |
| Signed in · none | primary **Start your tree** · seat | unchanged |

**Fact line** under the CTAs (trees > 0 only): kind dot · "{tree} · n/m done · last tended
{recency}" — kind dot hue from the tree's root kind, count in mono. Resume's label
truncates the name at ~18ch.

## 2. What the first click does

- **Resume {tree} → the tree, directly.** Camera restored to where you left it; the
  What's-next panel greets per its own rules (`whats-next.md`).
- **My trees → `windmill.works/trees`** = the app on your newest tree with the
  TreeSwitcher already unfolded, never an interstitial page. Camera at fit, Next panel
  holds (never under an open menu).
- **The seat → the account menu:** identity · sync status · My trees (count) · Account
  settings · Sign out (instant, no confirmation).

## 3. The half-open door — link sent

- "Log in" swaps to a neutral chip, **"Link sent — check your email"**, gold breathing
  dot, same slot and size class. Clicking reopens the wait dialog. It expires with the
  link (15 min) and returns to "Log in" — no error, no nagging.
- When the link lands in another tab, this tab wakes itself (`auth.md` §3): the chip
  resolves into the seat with the wake beat (480ms soft).
- "Start your tree" stays available throughout.

## 4. Never

"Welcome back" copy · a landing tree list or dashboard · auto-redirect · any change to the
signed-out page.

## 5. Phone

The seat, the "Resume {newest}" CTA and the link-sent chip sit in the **action lane**
(`mobile.md` §5) — bottom 300px, ≥44px targets. The nav collapses to wordmark + seat; no
hamburger, because there are only two destinations. Magic-link entry obeys the keyboard
contract (`mobile.md` §7): the email field anchors above the keyboard with a Done bar.

## 6. Ownership map

| Concern | Owner |
|---|---|
| Link lifecycle, wait dialog, claiming | `auth.md` |
| The panel Resume lands on | `whats-next.md` |
| State logic, CTA swap, click map, link-sent chip | **this doc** |
