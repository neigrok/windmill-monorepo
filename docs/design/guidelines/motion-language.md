# Windmill Motion Language — the beats (X1)

The canonical cheat-sheet for every animated moment in Windmill. The ceremonies —
**#3 paste arrival**, **#4 first unlock**, **#9 unlock ceremony**, **#14 share
artifact** — *cite this doc*: they compose these five beats and never invent new
motion. Live specimens: `explorations/motion-language.html`. Renderer companion:
`tree-layout-contract.md` (§7 is superseded by this doc where they disagree).
Tokens: `tokens/motion.css`.

> **Principle: the tree breathes, it doesn't flash.** If a beat feels busy, it's
> wrong. Motion celebrates *growth only* — downward state changes are silent.

> Tier names here are the component vocabulary (`SkillNode`): **locked ·
> available · active (the ember) · complete**. (The production shader's internal
> enum still says `unavailable/inprogress/activated` — same four tiers, mapped
> in `theme.js`.)

---

## 0. Two classes of motion

| Class | What | Rule |
|---|---|---|
| **Feedback** | hover scale 1.06 (280ms `--ease-soft`), press 0.97, selection-chrome fades (150ms, editing spec v2), tooltip | Runs immediately, always. Never queued, never blocked by a ceremony. |
| **Ceremony** | the five beats below, composed | Schedulable, one at a time, yields to interaction (§4). |

## 1. The sentence

Every ceremony is a subset of one sentence, in this order, never reordered:

```
camera ease  →  travel  →  bloom  →  pulse  →  toast
   (settle)     (carry)    (ignite)  (point)   (speak)
```

## 2. The beats

### bloom — a node ignites (tier rises)

Two intensities, by the tier the node *lands on*:

- **wake** (`locked → available`): **ignite** — fill/ring cross-fade
  dim→lit, 280ms `--ease-standard` — plus scale 1→**1.02**→1 over 480ms
  `--ease-soft`. No halo (available nodes have none at rest).
- **full bloom** (`→ complete`): ignite as above; **blossom** starts **+80ms**:
  halo swells from 0 to overshoot (radius ×1.25, α .40) at 55%, settles to rest
  (×1.0, α .28) over 480ms `--ease-soft`; scale 1→**1.045**→1 on the same curve.
  Total footprint **560ms**.
- One bloom per node per ceremony; a re-trigger mid-flight coalesces, never restarts.
- **Downward changes** (`complete → available`, un-done, delete): plain 280ms
  dim on `--ease-standard`. No blossom, no beat, no toast (except delete-undo).
- **Entrances reuse the wake shape**: an element arriving on the canvas (paste,
  new bud committed) fades in and scale-settles to its *resting* tier treatment.
- DOM approximation: `wm-bloom` (560ms `--ease-soft`), in `tokens/motion.css`.

### travel — light runs along a trunk edge

- A bright head (2× edge width) with a ~24px fading tail runs parent→child along
  the bezier; the edge **wakes behind the head** (dormant→lit stroke).
- **Solo**: speed **540 world-px/s**, duration clamped **[180, 420]ms**, position
  on `--ease-standard`. **In cascades**: duration locks to the cadence (320ms)
  so arrivals land on the beat.
- **Handoff**: the target's ignite starts at **85%** of the arc — arrival *is*
  ignition, no dead gap.
- **Departures**: solo travels leave when the source's ignite completes
  (+280ms). In cascades they overlap it (**+40ms**, travel locked to 280ms) so
  rings land on the 320ms grid. **≤3 heads per
  source**; 4+ children: skip the heads — edges fade lit together (280ms) and
  the children share one bloom beat.

### camera ease — settle to a target

- Pan + zoom on **one** curve, `--ease-soft`. Duration: **480ms** (≤ half a
  viewport), **600ms** default, **720ms** cap — never longer, never chained.
  A new target retargets the live tween (no restart jerk).
- Moves only if the target sits outside the central **80% safe frame**.
- Dependent beats start at **90%** settle.
- Any user input (drag / wheel / pinch / key-nav) cancels it instantly — the
  user always wins.

### toast — quiet status

- Enter: `wm-fade-in-up` (fade + rise 8px), 280ms `--ease-soft`. Hold **4000ms**
  (6000ms with an action like Undo). Exit: fade, 280ms `--ease-standard`.
- **Last beat**: enters **+120ms** after the final structural beat settles. One
  toast per ceremony — it summarizes ("Step unlocked: Add plants · 2 more steps opened").
- One at a time; a newer toast **replaces** (150ms cross-fade), never stacks.

### crown / pulse — the breath

- **Crown** (root only): emphasized halo (radius ×1.35 + thin satellite ring at
  r+8px) that **breathes**: α .22↔.34, radius ±2px, period **2400ms**
  `--ease-glow`, infinite. *The only infinite halo loop on the canvas.* Other
  complete nodes wear a **static** halo (α .28).
- **Ember** (active tier, from F1·F2): the in-progress breath — same 2400ms
  clock and phase, amplitude peaking *below* a resting halo, no ring offset
  (the halo is earned at complete). DOM: `wm-ember`. A wide field of embers
  freezes at mid-breath past a small concurrent cap (proposed 8 — F1·F2 open
  question); frozen face = `--glow-ember`.
- **Pulse** (finite attention beat): the same waveform at double-time —
  **1200ms/cycle × 2 cycles, decaying** (peaks α .42/+3px, then .34/+1.5px),
  then rest. Marks the newly-available frontier after a ceremony. DOM:
  `wm-pulse-echo` (2400ms, once).
- **Shared phase**: all oscillating halos lock to one global clock — the tree
  breathes as one organism (contract §9).

## 3. Cascade & stagger rules

- Cascade unit = **depth ring**. Ring N+1 ignites **one beat (320ms,
  `--duration-beat`) after ring N**; travels span the gap so arrival = ignition.
- Within a ring, per-node **seeded jitter ±60ms** (deterministic, from the node
  seed) — organic, not mechanical; the ring still lands on the beat.
- **Budget**: structural beats (camera, travel, bloom, toast-enter) fit in
  **≤2400ms** first-ignite→last-settle. Too deep? Compress cadence to a floor
  of **160ms**; still over → remaining outer rings join the final beat.
- Pulse afterglow and toast hold are **exempt** from the budget (low-amplitude tails).

## 4. The calm ceiling

- **One ceremony at a time.** Later events queue and **coalesce** into one
  combined ceremony (one toast that sums them).
- **≤24 nodes tweening concurrently.** A wider ring drops the blossom overshoot
  and plain-cross-fades instead.
- **Exactly 1 infinite halo loop** in the scene: the crown. The ember's
  low-amplitude breath (capped, shared clock) is the only other periodic
  motion; everything else is finite.
- **Motion yields to interaction**: pointer-down / wheel / pinch / key-nav
  fast-forwards every running ceremony beat to its end state via a **150ms**
  fade. Toasts survive. Feedback motion never waits.
- **While editing** (drag in progress, panel typing): ceremonies don't start —
  changes apply silently, coalesce, and celebrate once after **400ms idle**.

## 5. Reduced motion (`uMotion = 0`)

Principle: color/opacity cross-fades ≤280ms **stay**; anything spatial (scale,
translate, zoom, travel) **snaps or skips**; loops **freeze at mid-amplitude**.
The renderer freezes all periodic waveforms via the `uMotion` uniform; the JS
timeline collapses to endpoint keyframes with 150ms alpha ramps.

| Beat | Fallback |
|---|---|
| bloom (both) | 150ms color/opacity cross-fade to end state; halo appears at rest values; no scale |
| travel | **skip**; edge cross-fades lit (150ms) in sync with the target's fade |
| camera ease | snap + 150ms fade-through; zero spatial interpolation |
| toast | opacity fades only, no rise |
| crown | frozen at mid-amplitude (α .28 — i.e. exactly a standard halo) |
| ember | frozen at mid-breath (static face: `--glow-ember`) |
| pulse ×2 | **skip** entirely |
| cascade | one simultaneous 280ms cross-fade, no stagger |
| feedback: hover/press scale | skip scale; keep ring/color change + tooltip |
| feedback: chrome fades (150ms opacity) | keep |

## 6. Constants — copy into the renderer

```
IGNITE         280ms  ease-standard
BLOSSOM        480ms  ease-soft, starts +80ms      // full-bloom footprint 560ms
WAKE_SCALE     1.02      FULL_SCALE 1.045          // halo overshoot ×1.25 @ α .40
TRAVEL_V       540 wpx/s  clamp [180, 420]ms       // cascade: depart +40ms, dur 280ms
HANDOFF        0.85
CADENCE        320ms/ring  floor 160ms  jitter ±60ms seeded
CAMERA         600ms ease-soft (480 short · 720 cap)  DEPEND_AT 0.90  SAFE_FRAME 80%
TOAST          in 280 · hold 4000 (6000 w/ action) · out 280 · replace 150
PULSE          1200ms ×2, decaying (α .42 → .34)   CROWN 2400ms  α .22↔.34  r ±2px
CEREMONY_MAX   2400ms     TWEEN_MAX 24     LOOP_MAX 1 (the crown)
YIELD          150ms      IDLE_COALESCE 400ms
```

Easings (from `tokens/motion.css`): `--ease-soft cubic-bezier(0.16,1,0.3,1)` ·
`--ease-standard cubic-bezier(0.4,0,0.2,1)` · `--ease-glow cubic-bezier(0.45,0,0.15,1)`.

## 7. Where the beats are cited

| Ceremony | Sentence used |
|---|---|
| **#3 paste arrival** | camera fit → root wakes + crown ignites → rings enter on the cadence (wake per ring, dormant edges fade in with their ring) → toast ("Roadmap planted · N steps") |
| **#4 first unlock** | camera (only if off-frame) → complete full-bloom → travels → children wake → pulse ×2 on frontier → toast |
| **#9 unlock ceremony** | the full sentence; may add flourish only *within the ceilings above* |
| **#14 share artifact** | replays the arrival cascade verbatim — same constants, same identity |
| **milestone share offer** | ceremony #9 verbatim; the finished limb (a root-child's whole subtree — the milestone definition) shares one pulse ×2, and the ceremony's toast carries one action ("Share the moment" → X2's sheet, hold 6000ms, once per milestone ever). Spec: `explorations/ceremony-moments.html` |
| **welcome-back recap** | on reopen with unseen completions (≥12h): camera fit → the since-then completions re-bloom in real order on the cadence, travels waking edges → frontier pulse ×2 → the Next panel enters (no toast). ≤2400ms budget; any input fast-forwards. Spec: `explorations/ceremony-moments.html` |
| **#19 per-tree share video** | the #14 arrival cascade rasterized to a ~3s **muted loop** for feeds and the tree's landing hero: hold → exhale (opacity-only) → grow (root+crown ignite → rings bloom on the cadence, travels wake edges → frontier pulse ×2) → settle. Frame 0 == frame N (the grown tree) so it loops seamless; every transient is windowed to 0 at the cut. **Whole-tree grow, never a per-unlock clip.** Spec: `explorations/og-share-video.html` · `guidelines/og-share-video.md` |

Owning specs refine content (copy, targets), never the physics: durations,
easings, ceilings and reduced-motion mappings come from here.
