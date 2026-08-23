# Windmill Honesty moments — when the app can't save

The canonical spec for capability loss: expired sessions and read-only
visitors. Graduated from `explorations/honesty-moments.html` (its ★ verdict).
The fix is never a warning wall — it is telling the truth in existing
chrome. Owner-lapse session rules are `auth.md` §6's; this doc designs the
moments. Live specimens: `explorations/honesty-moments.html`.

> **Principle: read-only is the remedy only when the tree was never yours.
> For owners, honesty is persistence.** Work never leaves the device.

---

## 1. Two different truths

| Case | Response |
|---|---|
| **Your tree, sign-in lapsed** | **No downgrade.** Editing continues, saves go local (X6 §6). Seat → ghost (280ms cross-fade); chip persists: **"Signed out — saved on this device"**. Path back: seat menu → the one door → plain sync (gold "Syncing your trees…" → olive "Synced" → silence). |
| **A tree that isn't yours** (expired share, revoked invite) | **True downgrade** into X5's read-only form: one 280ms opacity wave retires all edit chrome; the canvas never moves. Edits are banked on-device, counted, named in the notice. Path forward: **"Fork this tree"** — banked edits ride into the copy. |

**Detection:** every write + a session check on tab refocus; first rejected
write triggers. One silent retry separates a network blip (X3's offline
chip) from capability loss. The lie-window edits are kept, never discarded.

**Register:** neutral, never danger. Brick stays reserved (X6: deletion
only); the notice is a plain card with one terracotta verb.

## 2. The downgrade wave (visitor)

- One wave, **opacity only**, 280ms `--ease-standard` — toolbar verbs, field
  borders, add-rows, handles fade together; field text flattens in place.
  Downward changes are silent (X1): nothing slides, nothing shakes.
- **Waits for your hands:** mid-keystroke/drag it holds for blur / 400ms
  idle. The in-flight edit banks with the rest.
- End state = X5's read-only page (desktop: canvas + StepPanel sans editing,
  ControlBar zoom+fit; phone: rule/plaque/wordmark/Fork pill).

## 3. The notice

Bottom-center card (X4's conflict-card home), `wm-fade-in-up`, never a modal:
**the fact** ("This tree belongs to Maren K.") · **where the work is**
("Your 3 edits are safe on this device — fork to keep building on your own
copy.") · **one verb** ([Fork this tree]) · quiet out ("Maybe later") ·
tiny "This yours? Sign in." Dismiss → persistent chip "Read-only · N edits
kept here". One card per cause per session; esc free; focus never stolen.
Fork = X5 §7 semantics (structure copies — banked edits are structure;
progress resets) + arrival cascade + "Forked — N steps planted."

Phone: the same copy as a bottom sheet in the fork door's home (X5 §7),
CTA ≥44px; dismissing settles into the standard hosted page.

## 4. The way home

The 28px **wordmark chip, top-right, on every read-only surface, every
breakpoint**, links to windmill.works — a real link (same tab, standard
hover + focus ring). Extends X5 §2's phone rule to tablet + desktop
read-only. The editor never carries it (the registry is home there).

## 5. Copy — say / never say

Say: "Signed out — saved on this device" · "Your sign-in expired.
Everything's still here — sign in to keep syncing." · "This tree belongs to
{owner}." · "Your N edits are safe on this device — fork to keep building
on your own copy." · "Read-only · N edits kept here" · "Forked — N steps
planted."

Never: "Warning" · "Log in to continue" · "Your changes could not be
saved" · "Unsaved changes will be lost" · "You don't have permission" ·
any modal, any red, any countdown.

## 6. Constants — copy into the build

```
DETECT    every write + tab refocus · first rejected write · one silent retry (offline = X3)
OWNER     no downgrade · seat → ghost 280ms · chip persists · re-auth = one door → plain sync
VISITOR   280ms opacity wave → X5 read-only form · waits for blur/400ms idle · canvas never moves
BANK      post-loss edits stay on device, counted · ride into the fork · re-auth syncs them instead
NOTICE    bottom-center card · fact + where + one verb + quiet out · dismiss → chip · 1/cause/session
HOME      wordmark chip 28px top-right on every read-only surface → windmill.works · never in the editor
NEVER     modal · red/"Warning" · toast-only truth · focus theft · login redirect · losing device edits
```

## 7. Ownership map

| Concern | Owner |
|---|---|
| Session rules, lapse strings, one door, claim beat | `auth.md` (X6) |
| Chip grammar, the seat, the card home | X4 (`account-sync-chrome`) |
| Read-only end states, fork semantics, phone chrome | `responsive.md` (X5) |
| Wave physics, idle coalesce, reduced motion | `motion-language.md` (X1) |
| Offline & queued sync | X3 (`empty-loading-states`) |
| Detection, the wave, the bank, notice, the way home | **this doc** |
