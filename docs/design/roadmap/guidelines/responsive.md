# Windmill Responsive — read-only & mobile

The spec for every surface a non-editor meets: the hosted share page (`windmill.works/t/…`), the
public gallery, and their tablet and desktop read-only forms. Editing a **stranger's** tree is
absent, not disabled, below desktop — the editor chrome never mounts, nothing is grayed out. **Your
own** tree is editable on phone and tablet too (§13).

Motion physics come from `motion-language.md`; this doc places beats, never redefines them.
`mobile.md` owns the phone's two view models (tree = portrait, list = workbench) and the input layer
under them. This doc is canon for the canvas view and its chrome. Identity pieces (kind rule,
plaque, readout) are shared with the share cards, so a share image and its live page are the same
object.

> The tree is the page. A visitor lands inside the artifact, not inside product furniture. Chrome
> floats on the canvas, yields to the finger, and is selection-gated. Each page has exactly one
> verb: **Fork**.

---

## 1. Breakpoints

| Width | Layout |
|---|---|
| **390–743** | Phone. StepPanel docks to the bottom edge as a sheet; Fork pill bottom-center; Share in the action lane's right slot for owners (`mobile.md` §10); plaque top-left; wordmark top-right; gallery one column. |
| **744–1023** | Tablet. Selection detail is a 320px floating panel, right side; Fork pill bottom-left; fork door becomes a centered Dialog; gallery two-up. |
| **≥1024** | Desktop read-only. The app canvas + docked StepPanel with editing chrome absent; ControlBar keeps zoom + fit only; Fork sits where Share sits for owners. |

Breakpoints are width-driven; orientation never changes rules. Below 390 the plaque caps at 60vw;
nothing else changes.

## 2. Hosted page chrome (phone) — five pieces

| Piece | Spec |
|---|---|
| **Kind rule** | 4px, full-width, top. Dominant kind of the tree's done nodes. The only place page chrome takes color. |
| **Plaque** | Card, radius 16, ≤236px, top-left under the status bar: kind dot + title (display 17) · mono readout + 96px gradient bar · author 11. A label, not a menu — nothing tappable. |
| **Wordmark chip** | 30px pill, top-right, "Windmill" display-bold 13, always terracotta. The only brand exit. |
| **Fork CTA** | 50px terracotta pill, bottom-center, 18px above the home bar. Press 0.97. Hidden while a sheet or door is up (150ms fade + 10px sink). |
| **Recenter chip** | 36px pill, bottom-right. Exists only after the tree's bounds leave the 80% safe frame for 400ms (150ms fade in). The only programmatic zoom-out. |

Soft scrims (canvas color → transparent, 64px top / 108px bottom) keep status bar and CTA legible
over panned fruit. **z-order:** canvas < scrims < rule < plaque/wordmark < CTA/recenter < sheet <
door < status bar.

At rest chrome covers ≈13% of the screen and ≈0% mid-pan. No toolbars, no tab bar, no hamburger.

## 3. The sheet — StepPanel re-docked

Per-node detail keeps exactly one home, docked to the bottom edge instead of the right side.

- **Content, in order:** grabber · kind dot + name + state chip · one-line description · branch
  readout · (locked: reason row) · Needs · Unlocks. The state chip is the node's treatment applied to
  a pill — done = kind-tinted fill + date, ready = kind ring on white, locked = sunken neutral + lock.
- **Snap points:** peek 216px · expanded ≤62% of viewport (grabber drag or tap). The canvas never
  fully disappears; there is no full-screen detail view.
- **Open beat:** sheet rises 280ms `--ease-soft`, selection ring fades 150ms, camera eases the node
  into the visible band (§5) — all three start together.
- **Retarget, don't reopen:** tapping another node swaps content in place (150ms cross-fade) and
  re-aims the camera.
- **Dismiss:** swipe down or tap the canvas. No × — the canvas is the close button. The camera never
  snaps back.
- **No verbs inside.** Read-only detail has no buttons, not even Fork. One verb per page, on the
  canvas.
- **Locked steps explain themselves** ("Finish *Docking* to unlock") in a sunken neutral row — never
  brick, never alarming.

## 4. Touch grammar

- **One finger pans** — 1:1, direct, soft-clamped 80px past the tree's bounds. No rubber-band bounce;
  the world just gets heavier.
- **Pinch zooms** 0.5×–2.5×, anchored between the fingers.
- **Double-tap steps** 1×↔1.6× at the tap point (camera ease, 480ms).
- **Tap node** = select · **tap canvas** = deselect · chrome never pans the canvas.
- **Long-press: nothing** on a stranger's tree — reserved, and the OS callout is suppressed
  (`-webkit-touch-callout:none`). On your own tree it enters multi-select (§13). Full gesture
  registry: `mobile.md` §3.
- **Hover doesn't exist** here: tap is select and the sheet is the tooltip grown up.
- **Floors:** node hit disc ≥44px regardless of visual size (visual 20–34px); all chrome ≥44px; node
  labels ≥11px. The disc is capped at half the nearest-neighbour distance so targets never overlap;
  where that cap falls under 44px a tap **zooms** instead of selecting, and the escape hatch is the
  list, where precision is a property of rows (`mobile.md` §9).

Direct manipulation (drag, pinch) is exempt from the motion ceilings — the finger is the easing.

## 5. Camera & chrome motion

- **Constants are the motion doc's:** 480/600/720ms on `--ease-soft`, one curve for pan+zoom,
  retarget the live tween, any input cancels instantly.
- **Select makes room:** the node eases into the band above the sheet (phone) or beside the panel
  (tablet); it moves only if outside the safe frame.
- **Safe frame** is 80% of the *visible* canvas — viewport minus sheet/panel.
- **Labels declutter:** node names hide below 0.8× zoom (150ms fade).
- **Chrome yields:** plaque, wordmark and CTA sit at 35% opacity while the finger is down; restore
  ~200ms after release.

## 6. Ceremonies on read-only surfaces

- **First visit replays the arrival cascade** (320ms ring cadence, ±60ms seeded jitter, ≤2400ms
  budget) with **no toast**: toasts speak to actors; visitors watch the tree grow.
- **Navigation is not a ceremony.** Gallery card → hosted page: the card's canvas cross-fades into
  the full canvas while plaque and CTA fade in (150ms). No arrival replay.
- **Fork is a ceremony** (§7): the cascade replays on your copy, with the toast.

## 7. Fork — the page's one verb

- **The door replaces the sheet** — same bottom-edge home, 280ms rise. Copy states what forking does
  before asking for anything: "Forking plants a copy of all 17 steps in your gallery — progress
  cleared, yours to grow."
- **One door:** signed out, email → magic link, and the fork waits server-side behind the link.
  Signed in, instant.
- **What copies:** structure, names, kinds, descriptions. **What resets:** progress. Your root wakes
  as the first available step; the crown waits to be earned.
- **Lineage is quiet and permanent:** "forked from Maren K." on your plaque and your gallery card.
- **Ceremony:** arrival cascade on your copy + toast "Forked — 17 steps planted."
- **The glyph:** the CTA wears the upright fork (one trunk splitting in two).

## 8. Gallery

- **The card:** kind rule · real tree render · kind dot + title · mono readout + gradient bar ·
  author · updated. Finished trees wear the crown next to their name.
- **One column <744, two-up ≥744** (cards ≥320px). Never smaller: below the 240px acid floor the
  silhouette dies.
- **Fork is a persistent button below 1024** — there is no hover (`mobile.md` §10 · `gallery.md`).
  The in-product public surface is `/browse` and keeps this grid.
- **Order chips, not tabs:** Popular · New · Finished. One scroll, re-sorted. Search is a quiet icon
  until asked for.
- **Thumbs are real renders at the share crop** — the same frame recipe as the OG image, so a tree
  looks identical in a tweet, in the gallery, and on its own page.
- **Forked trees carry lineage** in the author row.
- **No vanity numbers** (forks, views, likes). Cards show progress and recency only.

## 9. Tablet (744–1023)

Same page, one change: the sheet stands up.

- **Panel:** 320px wide · top 104 (clear of the wordmark) · right 16 · max-height 70% · radius 20 ·
  shadow-md · inner scroll. Sheet content unchanged, minus the grabber. Selection-gated.
- **Fork pill bottom-left** (20/26 from edges) so verb and panel never share a corner. **Recenter**
  bottom-right; while the panel is open its right offset becomes panel + 28.
- **Fork door becomes a Dialog** — centered 420px card, same copy, same one-door flow, same overlay
  token.
- **Camera makes room horizontally:** safe frame = canvas minus panel.
- Gallery two-up; touch grammar, reduced motion and floors identical to phone.

## 10. Reduced motion

| Beat | Fallback |
|---|---|
| arrival cascade | one simultaneous 280ms cross-fade — no stagger, no scale |
| camera ease (make-room, recenter, double-tap) | snap + 150ms fade-through |
| sheet / panel / door | opacity only, no rise |
| travel · pulse | skipped |
| crown | frozen at mid-amplitude (α .28 — a standard halo) |
| drag · pinch | exempt — finger-driven motion isn't animation |
| renderer | `uMotion = 0` freezes every periodic waveform; DOM chrome collapses to 150ms alpha ramps |

## 11. Constants — copy into the build

```
RULE      4px top, dominant kind
PLAQUE    r16 · ≤236px (≤60vw below 390) · title 17 · readout mono 12 + 96px bar
CTA       50px pill · bottom-center 18px above home bar (tablet: bottom-left 20/26)
RECENTER  36px pill · gated: bounds outside 80% safe frame ≥400ms
SHEET     peek 216 · expand ≤62% viewport · rise 280ms ease-soft
PANEL     320w · top 104 · right 16 · ≤70% tall · r20   (744–1023)
ZOOM      0.5×–2.5× pinch · double-tap 1↔1.6 @480ms · labels hide <0.8×
YIELD     chrome to 35% while panning · restore +200ms · all chrome fades 150ms
FLOORS    hit ≥44px · chrome ≥44px · labels ≥11px
GALLERY   1-col <744 · 2-up ≥744 (cards ≥320px) · chips: Popular · New · Finished
```

## 12. Ownership map

| Concern | Owner |
|---|---|
| Beat physics, easings, ceilings, reduced-motion principle | `motion-language.md` |
| Node tiers/kinds/forms, renderer contract | `tree-layout-contract.md` |
| Phone view models, gestures, undo, precision | `mobile.md` |
| Placement of all of the above on read-only surfaces | this doc |

## 13. Touch editing — the owner's tree

On your own tree, phone and tablet get the full build grammar; a stranger's tree stays the read-only
page above. No second editor — the desktop grammar degrades to the finger.

- **Ownership gates editing, not a mode.** No "edit" toggle; the same ownership check as the verb
  rail.
- **The sheet is the workbench.** Tap a step → the sheet grows a verb rail (Mark done · Add step ·
  Connect), a rename-in-place title, a recolor swatch row, and an isolated Delete that states its
  cost.
- **Add** = a rail button plants a bud one ring out, auto-selected, keyboard up.
- **Connect** = tap-then-tap aim mode: eligible steps pulse, cycles fade, tap the target; a direction
  toggle (`unlocks →` / `← needs`). No 8px port drag. Aim keeps pan + pinch and offers "Fit eligible"
  (`mobile.md` §3).
- **Multi-select** = long-press to enter, tap to toggle, a bottom-docked bulk bar (recolor swatches +
  Delete N). The set wears the grouped bark treatment. A "Select steps" row in the sheet is the
  visible door, and a canvas tap never clears a non-empty set.
- **Undo is first-class** — a finger has no ⌘Z, so every edit drops a 4s undo snackbar (6s on
  delete), offset from the last touch point and inert for 250ms; the session history lives in the
  Activity sheet as "Undo this" rows (`mobile.md` §8).
- **Check-off is one tap** — in the list the fruit is the control (swipe-right accelerates); on the
  canvas the peek's state chip is the toggle (`mobile.md` §6).
- **Rename, the paste well and the Tend bar** obey `mobile.md` §7's keyboard contract.
- **Tablet (744–1023):** the sheet stands up into the right-side panel (§9); aim + bulk bar dock to
  that column. ≥1024 hands back to desktop editing.
- **Reduced motion:** sheet fades in place, aim uses static rings, travel → 280ms fade.
