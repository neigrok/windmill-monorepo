# Windmill Playable demo — first-run & fork (F4)

The canonical spec for `windmill.works/demo`: the hosted playable tree a stranger
meets first, the one coached beat, and the Fork that makes it theirs. The
surface is X5's hosted share page (`responsive.md`) of the **Learn to sail**
specimen tree; motion cites `motion-language.md` (#4, #14); the fork door is
X4's one door. Live specimens: `explorations/playable-demo.html`.

> **Principle: the demo is the product, hosted — not a video, not a tour.**
> One chip, one guided beat, one door. What you learn here is what you keep
> after forking.

---

## 1. The stage

- **Where:** `windmill.works/demo` full-viewport; the marketing hero embeds the
  same surface as a full-bleed band (arrival cascade and all — the proof
  breathes behind the headline). "Try the demo" links land on /demo.
- **Chrome = X5's five pieces verbatim** (kind rule, plaque, wordmark chip,
  CTA seat, recenter + scrims). Plaque byline: "**Windmill demo** · 6/17
  done". F4 adds exactly one element — the coach chip — and it's temporary.
- **Staged save:** 6/17 done, staged so **one move matters** — "Rig the mast"
  sits available with both children dim, the only step whose completion
  visibly opens two paths.
- **Load replays the arrival** (#14 — #3's constants, no toast: toasts speak
  to actors, visitors watch the tree grow).
- **Interaction is complete-only:** pan, zoom, select, mark done. Buds, ports
  and drag never mount — the grammar taught is the one that transfers.
- **State is session-local (decided):** every visitor gets the same staged
  6/17; a return visit resets it, so the coached step is always ready.

## 2. The coach chip

- **The pulse is the spotlight.** The target node pulses ×2 in its own kind
  colour (motion §2 — the attention beat that already exists) while the chip
  mounts beside it, fade + rise 280ms. The tree stays fully lit and fully
  interactive. **Never a scrim with a hole** — the overlay exists for modals
  only; the tree is never behind glass.
- **Mount timing:** arrival settles → **800ms idle**; waits for pointer quiet
  (a coach that interrupts exploring has already failed). Camera eases first
  only if the target is outside the 80% safe frame; chip mounts at 90% settle;
  pulse starts with the chip.
- **Anatomy:** StepPanel-grade card (same radius, same shadow), arrow tab
  pointing at the node, one sentence, one button, one quiet ✕.
- **Copy, the whole script:** "This step is ready — mark it done." Button:
  "Mark it done". No welcome, no step 1-of-N, no product name.
- **A pointer, not a second path:** the chip's button does exactly what
  clicking the node does; clicking the node directly also completes the beat.
- **Phone (decided):** the chip docks as the peek sheet's header row (X5 sheet
  grammar), same copy, same once-ever rule.

## 3. Conduct — never twice, never nagging

| Event | Result |
|---|---|
| ✕ or esc | Chip fades (150ms). **Never returns** — not on reload, not on revisit. |
| User completes any step first | Counts as the guided beat — chip never mounts. Doing beats being told. |
| Guided unlock fires | Chip retires at pointer-down. The ceremony needs no chaperone. |
| Fork | Coach state travels with the account — an owned tree never coaches. |
| Return visit, no fork | Demo replays arrival; coach stays gone (`wm-coach-done`, local + account). |
| Signed-in, owns trees | Never eligible. The chip is for strangers only. |
| F1·F2 plaque coach-mark | Never on the demo (decided) — one coach per surface. |

**One chip, ever, per human.** The demo teaches one thing — *done opens
doors* — and the unlock cascade teaches it better than any second tip could.

## 4. First-run choreography

```
land (#14, no toast)  →  800ms idle  →  chip + pulse ×2
  →  click runs #4 verbatim: full bloom → travels → children wake
     → frontier pulse → toast "Step unlocked: Rig the mast · 2 steps opened"
  →  +120ms after the toast settles: the Fork CTA echoes once
```

The invite is a **handoff, not a second coach**: the CTA — sitting in the
ControlBar's seat all along — takes the same pulse waveform once. Attention
flows node → toast → button, one line of light. Skip paths at every beat; the
user is never herded.

## 5. The fork — one semantic (decided)

- **The door** is X4's one door, docked above the CTA, canvas alive behind.
  Copy states the deal first — X5 §7 verbatim: *"Forking plants a copy of all
  17 steps in your gallery — progress cleared, yours to grow."* Signed out:
  the email field is the whole form (magic link; the fork waits server-side).
  Signed in: one button.
- **Every fork clears progress.** X5 §7 is the only fork semantic: structure,
  names, kinds, descriptions copy; progress resets. The demo unlock was the
  pitch, not luggage — the fresh copy hands the first move back to you.
- **The beat, in order:**
  1. **Chrome trade** (one 280ms beat): wordmark, Fork CTA and scrims fade out
     while the ControlBar fades up into the same seat the CTA held — read-only
     clothes off, editing clothes on, no navigation.
  2. **Re-plant:** the old state fades and the arrival cascade replays on your
     fresh copy — #14 *with* the toast this time, because now you're the
     actor: "Forked — 17 steps planted."
  3. Plaque byline lands on "**yours** · 0/17 done".
- **Demo → owned inventory:** editing grammar full (buds, ports, drag, panel);
  wordmark + scrims gone; coach never again; progress cleared.

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
| Unlock toast | "Step unlocked: Rig the mast · 2 steps opened" |
| Fork CTA | "Fork this tree" |
| Door | "Make it yours" / "Forking plants a copy of all 17 steps in your gallery — progress cleared, yours to grow." |
| Door actions | signed in: "Fork into my tree" · signed out: "Email me a link" |
| Fork toast | "Forked — 17 steps planted" |

## 8. Constants — copy into the build

```
STAGE     /demo + landing hero embed · sail tree · staged 6/17 · complete-only
COACH     mount: settle + 800ms idle · pulse ×2 kind-hued · once ever (wm-coach-done)
UNLOCK    ceremony #4 verbatim · CTA echo +120ms after toast settles
FORK      X4 one door · progress clears (X5 §7) · chrome trade 280ms
          re-plant = #14 with toast · byline → "yours · 0/17 done"
NEVER     scrim spotlights · a second tip · a modal · the chip twice
```

## 9. Ownership map

| Concern | Owner |
|---|---|
| Beat physics (#4, #14), pulse waveform, ceilings | `motion-language.md` |
| Hosted-page chrome, sheet, fork-clears-progress rule | `responsive.md` (X5) |
| The one door, magic link | X4 (`explorations/account-sync-chrome.html`) |
| Starter quests the demo links to after fork | `starter-quests.md` (F5) |
| Demo staging, coach conduct, choreography, chrome trade | **this doc** |
