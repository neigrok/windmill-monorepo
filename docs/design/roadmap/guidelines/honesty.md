# Honesty moments — when the app can't save

Capability loss: expired sessions and read-only visitors. The fix is never a warning wall
— it is telling the truth in existing chrome. Session rules themselves are `auth.md` §6's.

> **Principle: read-only is the remedy only when the tree was never yours. For owners,
> honesty is persistence.** Work never leaves the device.

## 1. Two different truths

| Case | Response |
|---|---|
| **Your tree, sign-in lapsed** | **No downgrade.** Editing continues, saves go local. Seat → ghost (280ms cross-fade); chip persists: **"Signed out — saved on this device"**. Path back: seat menu → the one door → plain sync (gold "Syncing your trees…" → olive "Synced" → silence). |
| **A tree that isn't yours** (expired share, revoked invite) | **True downgrade** into the read-only form: one 280ms opacity wave retires all edit chrome; the canvas never moves. Edits are banked on-device, counted, named in the notice. Path forward: **"Fork this tree"** — banked edits ride into the copy. |

- **Detection:** every write, plus a session check on tab refocus; the first rejected write
  triggers. One silent retry separates a network blip from capability loss. The lie-window
  edits are kept, never discarded.
- **Register:** neutral, never danger. Brick stays reserved for deletion; the notice is a
  plain card with one terracotta verb.

## 2. The downgrade wave (visitor)

- One wave, **opacity only**, 280ms `--ease-standard` — toolbar verbs, field borders,
  add-rows, handles fade together; field text flattens in place. Nothing slides, nothing
  shakes.
- **Waits for your hands:** mid-keystroke or mid-drag it holds for blur / 400ms idle. The
  in-flight edit banks with the rest.
- End state = the read-only page (desktop: canvas + StepPanel sans editing, ControlBar
  zoom + fit; phone: rule / plaque / wordmark / Fork pill).

## 3. The notice

Bottom-center card, `wm-fade-in-up`, never a modal: **the fact** ("This tree belongs to
Maren K.") · **where the work is** ("Your 3 edits are safe on this device — fork to keep
building on your own copy.") · **one verb** ([Fork this tree]) · quiet out ("Maybe later") ·
tiny "This yours? Sign in." Dismiss → persistent chip "Read-only · N edits kept here". One
card per cause per session; esc free; focus never stolen.

Fork semantics: structure copies (banked edits are structure), progress resets, then the
arrival cascade and "Forked — N steps planted."

Phone: the same copy as a bottom sheet in the fork door's home, CTA ≥44px; dismissing
settles into the standard hosted page.

## 4. The way home

The 28px **wordmark chip, top-right, on every read-only surface, every breakpoint**, links
to windmill.works — a real link (same tab, standard hover + focus ring). The editor never
carries it; the registry is home there.

## 5. Copy

Say: "Signed out — saved on this device" · "Your sign-in expired. Everything's still here —
sign in to keep syncing." · "This tree belongs to {owner}." · "Your N edits are safe on this
device — fork to keep building on your own copy." · "Read-only · N edits kept here" ·
"Forked — N steps planted."

Never: "Warning" · "Log in to continue" · "Your changes could not be saved" · "Unsaved
changes will be lost" · "You don't have permission" · any modal, any red, any countdown.

## 6. Ownership map

| Concern | Owner |
|---|---|
| Session rules, lapse strings, one door, claim beat | `auth.md` |
| Read-only end states, fork semantics, phone chrome | `responsive.md` |
| Wave physics, idle coalesce, reduced motion | `motion-language.md` |
| Detection, the wave, the bank, the notice, the way home | **this doc** |
