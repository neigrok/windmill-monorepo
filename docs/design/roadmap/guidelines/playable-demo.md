# Windmill Playable demo — first-run & fork

The spec for `windmill.works/demo`: the hosted playable tree a stranger meets first, the one coached
beat, and the Fork that makes it theirs. The surface is the hosted share page (`responsive.md`)
carrying the **Learn to sail** quest; motion cites `motion-language.md` (#4, #14).

> The demo is the product, hosted — not a video, not a tour. One chip, one guided beat, one door.

---

## 1. The stage

- **Where:** `windmill.works/demo` full-viewport; the marketing hero embeds the same surface as a
  full-bleed band, arrival cascade and all. "Try the demo" links land on /demo.
- **Chrome** is `responsive.md` §2's five pieces verbatim. Plaque byline: "**Windmill demo** · 6/17
  done". The demo adds exactly one element — the coach chip — and it's temporary.
- **Staged save:** 6/17 done, staged so one move matters — "Rig the boat yourself" sits available with both
  children dim, the only step whose completion visibly opens two paths.
- **Load replays the arrival** (#14 — #3's constants, no toast: visitors watch, they don't act).
- **Interaction is complete-only:** pan, zoom, select, mark done. Buds, ports and drag never mount.
- **State is session-local:** every visitor gets the same staged 6/17; a return visit resets it, so
  the coached step is always ready.

## 2. The coach chip

- **The pulse is the spotlight.** The target node pulses ×2 in its own kind colour (motion §2) while
  the chip mounts beside it, fade + rise 280ms. The tree stays fully lit and interactive. Never a
  scrim with a hole — the overlay exists for modals only.
- **Mount timing:** arrival settles → 800ms idle, waiting for pointer quiet. Camera eases first only
  if the target is outside the 80% safe frame; chip mounts at 90% settle; pulse starts with the chip.
- **Anatomy:** StepPanel-grade card (same radius, same shadow), arrow tab pointing at the node, one
  sentence, one button, one quiet ✕.
- **Copy** is one sentence and one button (§7). No welcome, no step 1-of-N, no product name.
- **A pointer, not a second path:** the chip's button does what clicking the node does; clicking the
  node directly also completes the beat.
- **Phone:** the chip docks as the peek sheet's header row, same copy, same once-ever rule.

## 3. Conduct — never twice, never nagging

| Event | Result |
|---|---|
| ✕ or esc | Chip fades (150ms). Never returns — not on reload, not on revisit. |
| User completes any step first | Counts as the guided beat — chip never mounts. |
| Guided unlock fires | Chip retires at pointer-down. |
| Fork | Coach state travels with the account — an owned tree never coaches. |
| Return visit, no fork | Demo replays arrival; coach stays gone (`wm-coach-done`, local + account). |
| Signed-in, owns trees | Never eligible. The chip is for strangers only. |
| Plaque coach-mark | Never on the demo — one coach per surface. |

One chip, ever, per human. The demo teaches one thing — done opens doors — and the unlock cascade
teaches it better than a second tip could.

## 4. First-run choreography

```
land (#14, no toast)  →  800ms idle  →  chip + pulse ×2
  →  click runs #4 verbatim: full bloom → travels → children wake
     → frontier pulse → unlock toast (§7)
  →  +120ms after the toast settles: the Fork CTA echoes once
```

The invite is a handoff, not a second coach: the CTA, sitting in the ControlBar's seat all along,
takes the same pulse waveform once. Attention flows node → toast → button. Skip paths at every beat.

## 5. The fork

- **The door** docks above the CTA, canvas alive behind, and states the deal before asking for
  anything (§7, `responsive.md` §7 verbatim). Signed out: the email field is the whole form. Signed
  in: one button.
- **Every fork clears progress.** Structure, names, kinds and descriptions copy; progress resets.
- **The beat, in order:**
  1. **Chrome trade** (one 280ms beat): wordmark, Fork CTA and scrims fade out while the ControlBar
     fades up into the same seat the CTA held — no navigation.
  2. **Re-plant:** the old state fades and the arrival cascade replays on the fresh copy — #14 *with*
     the toast, because now you're the actor: "Forked — 17 steps planted."
  3. Plaque byline lands on "**yours** · 0/17 done".
- **Demo → owned inventory:** full editing grammar (buds, ports, drag, panel); wordmark + scrims
  gone; coach never again; progress cleared.

## 6. Reduced motion

| Beat | Fallback |
|---|---|
| arrival / re-plant cascade | one simultaneous 280ms cross-fade, no stagger |
| coach pulse | static kind-glow ring for 2.4s (frozen mid-pulse); arrow still points |
| chip mount | fade only, no rise |
| unlock (#4) | per motion §5 (travel skipped, edges cross-fade with targets) |
| CTA echo | skipped — the toast alone carries the invite |
| chrome trade | already opacity-only; unchanged |

## 7. Copy — every string

| Where | String |
|---|---|
| Plaque byline | "Windmill demo · 6/17 done" → "yours · 0/17 done" |
| Coach | "This step is ready — mark it done." / button "Mark it done" |
| Unlock toast | "Step unlocked: Rig the boat yourself · 2 steps opened" |
| Fork CTA | "Fork this tree" |
| Door | "Make it yours" / "Forking plants a copy of all 17 steps in your gallery — progress cleared, yours to grow." |
| Door actions | signed in: "Fork into my tree" · signed out: "Email me a link" |
| Fork toast | "Forked — 17 steps planted" |

## 8. Constants — copy into the build

```
STAGE     /demo + landing hero embed · sail tree · staged 6/17 · complete-only
COACH     mount: settle + 800ms idle · pulse ×2 kind-hued · once ever (wm-coach-done)
UNLOCK    ceremony #4 verbatim · CTA echo +120ms after toast settles
FORK      one door · progress clears · chrome trade 280ms
          re-plant = #14 with toast · byline → "yours · 0/17 done"
NEVER     scrim spotlights · a second tip · a modal · the chip twice
```

## 9. Ownership map

| Concern | Owner |
|---|---|
| Beat physics (#4, #14), pulse waveform, ceilings | `motion-language.md` |
| Hosted-page chrome, sheet, fork-clears-progress rule | `responsive.md` |
| Starter quests the demo links to after fork | `starter-quests.md` |
| Demo staging, coach conduct, choreography, chrome trade | this doc |
