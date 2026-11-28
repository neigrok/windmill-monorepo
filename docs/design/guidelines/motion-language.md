# Motion language — the beats (X1)

Canon for every animated moment in Windmill. Ceremonies compose these five beats and never
invent new motion. Tokens: `tokens/motion.css`.

The tree breathes, it doesn't flash. Motion celebrates growth only — downward state changes
are silent.

Tier names follow the component vocabulary (`SkillNode`): **locked · available · complete**.
The renderer maps them to unavailable, available and complete.

---

## 0. Two classes of motion

| Class | What | Rule |
|---|---|---|
| **Feedback** | hover scale 1.06 (280ms `--ease-soft`), press 0.97, selection-chrome fades (150ms), tooltip | Runs immediately, always. Never queued, never blocked by a ceremony. |
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

- **wake** (`locked → available`): **ignite** — fill/ring cross-fade dim→lit, 280ms
  `--ease-standard` — plus scale 1→**1.02**→1 over 480ms `--ease-soft`. No halo (available
  nodes have none at rest).
- **full bloom** (`→ complete`): ignite as above; **blossom** starts **+80ms**: halo swells
  from 0 to overshoot (radius ×1.25, α .40) at 55%, settles to rest (×1.0, α .28) over 480ms
  `--ease-soft`; scale 1→**1.045**→1 on the same curve. Total footprint **560ms**.
- One bloom per node per ceremony; a re-trigger mid-flight coalesces, never restarts.
- **Downward changes** (`complete → available`, un-done, delete): plain 280ms dim on
  `--ease-standard`. No blossom, no beat, no toast (except delete-undo).
- **Entrances reuse the wake shape**: an element arriving on the canvas fades in and
  scale-settles to its *resting* tier treatment.
- DOM approximation: `wm-bloom` (560ms `--ease-soft`), in `tokens/motion.css`; `wm-blossom` for a
  complete step blooming again from its resting halo; `wm-wake` for a lit step's wake.

### travel — light runs along a trunk edge

- A bright head (2× edge width) with a ~24px fading tail runs parent→child along the bezier;
  the edge **wakes behind the head** (dormant→lit stroke).
- **Solo**: speed **540 world-px/s**, duration clamped **[180, 420]ms**, position on
  `--ease-standard`. **In cascades**: duration locks to the cadence (320ms) so arrivals land
  on the beat.
- **Handoff**: the target's ignite starts at **85%** of the arc — arrival *is* ignition.
- **Departures**: solo travels leave when the source's ignite completes (+280ms). In cascades
  they overlap it (**+40ms**, travel locked to 280ms) so rings land on the 320ms grid.
- **≤3 heads per source.** 4+ children: skip the heads — edges fade lit together (280ms) and
  the children share one bloom beat.

### camera ease — settle to a target

- Pan + zoom on **one** curve, `--ease-soft`. Duration: **480ms** (≤ half a viewport),
  **600ms** default, **720ms** cap — never longer, never chained. A new target retargets the
  live tween (no restart jerk).
- Moves only if the target sits outside the central **80% safe frame**.
- Dependent beats start at **90%** settle.
- Any user input (drag / wheel / pinch / key-nav) cancels it instantly.

### toast — quiet status

- Enter: `wm-fade-in-up` (fade + rise 8px), 280ms `--ease-soft`. Hold **4000ms** (6000ms with
  an action like Undo). Exit: fade, 280ms `--ease-standard`.
- **Last beat**: enters **+120ms** after the final structural beat settles. One toast per
  ceremony — it summarizes ("Add plants done · 2 up next").
- One at a time; a newer toast **replaces** (150ms cross-fade), never stacks.

### crown / pulse — the breath

- **Crown** (root only): emphasized halo (radius ×1.35 + thin satellite ring at r+8px) that
  **breathes**: α .22↔.34, radius ±2px, period **2400ms** `--ease-glow`, infinite. The only
  infinite halo loop on the canvas. Other complete nodes wear a **static** halo (α .28).
- **Pulse** (finite attention beat): the same waveform at double-time — **1200ms/cycle × 2
  cycles, decaying** (peaks α .42/+3px, then .34/+1.5px), then rest. Marks the newly-available
  frontier after a ceremony. DOM: `wm-pulse-echo` (2400ms, once); `wm-pulse-frontier` on a step with
  no resting halo.
- **Shared phase**: all oscillating halos lock to one global clock.
- **Arrived card** (Board, DOM): a step card that just became up next, or was just created in
  Locked, wakes (fade, scale 1→1.02→1, 480ms `--ease-soft`) while its brand edge and
  `--kind-terracotta-glow` settle to rest over the pulse's two cycles (2400ms `--ease-glow`).
  The glow stays inside the 8px gutter its column and neighbours give it: **3px ring + 8px blur**
  at each peak, **1px ring + 4px blur** at the dip between them.

## 3. Cascade & stagger rules

- Cascade unit = **depth ring**. Ring N+1 ignites **one beat (320ms, `--duration-beat`) after
  ring N**; travels span the gap so arrival = ignition.
- Within a ring, per-node **seeded jitter ±60ms** (deterministic, from the node seed); the
  ring still lands on the beat.
- **Budget**: structural beats (camera, travel, bloom, toast-enter) fit in **≤2400ms**
  first-ignite→last-settle. Too deep? Compress cadence to a floor of **160ms**; still over →
  remaining outer rings join the final beat.
- Pulse afterglow and toast hold are **exempt** from the budget.

## 4. The calm ceiling

- **One ceremony at a time.** Later events queue and **coalesce** into one combined ceremony
  (one toast that sums them).
- **≤24 nodes tweening concurrently.** A wider ring drops the blossom overshoot and
  plain-cross-fades instead.
- **Exactly 1 infinite halo loop** in the scene: the crown. Every other node animation is finite. On
  a public page it runs only in the picture under the pointer (§8).
- **Motion yields to interaction**: pointer-down / wheel / pinch / key-nav fast-forwards every
  running ceremony beat to its end state via a **150ms** fade. Toasts survive. Feedback motion
  never waits.
- **While editing** (drag in progress, panel typing): ceremonies don't start — changes apply
  silently, coalesce, and celebrate once after **400ms idle**.

## 5. Reduced motion (`uMotion = 0`)

Colour/opacity cross-fades ≤280ms **stay**; anything spatial (scale, translate, zoom, travel)
**snaps or skips**; loops **freeze at mid-amplitude**. The renderer freezes all periodic
waveforms via the `uMotion` uniform; the JS timeline collapses to endpoint keyframes with
150ms alpha ramps.

| Beat | Fallback |
|---|---|
| bloom (both) | 150ms colour/opacity cross-fade to end state; halo appears at rest values; no scale |
| travel | **skip**; edge cross-fades lit (150ms) in sync with the target's fade |
| camera ease | snap + 150ms fade-through; zero spatial interpolation |
| toast | opacity fades only, no rise |
| crown | frozen at mid-amplitude (α .28 — exactly a standard halo) |
| pulse ×2 | **skip** entirely |
| Arrived card | 150ms fade-in; no scale, no glow |
| cascade | one simultaneous 280ms cross-fade, no stagger |
| feedback: hover/press scale | skip scale; keep ring/colour change + tooltip |
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

Easings (`tokens/motion.css`): `--ease-soft cubic-bezier(0.16,1,0.3,1)` ·
`--ease-standard cubic-bezier(0.4,0,0.2,1)` · `--ease-glow cubic-bezier(0.45,0,0.15,1)`.

## 7. The ceremonies

| Ceremony | Sentence used |
|---|---|
| **#3 paste arrival** | camera fit → root wakes + crown ignites → rings enter on the cadence (wake per ring, dormant edges fade in with their ring) → toast ("Roadmap planted · N steps") |
| **#4 first unlock** | camera (only if off-frame) → complete full-bloom → travels → children wake → pulse ×2 on frontier → toast |
| **#9 unlock ceremony** | the full sentence; may add flourish only within the ceilings above |
| **milestone share offer** | ceremony #9 verbatim; the finished limb (a root-child's whole subtree) shares one pulse ×2, and any Share action opens the public-link dialog (`brand-foundations.md`, "Publishing"); no image or video is exported |
| **welcome-back recap** | on reopen with unseen completions (≥12h): camera fit → the unseen completions re-bloom in real order on the cadence, travels waking edges → frontier pulse ×2 → the Next panel enters (no toast) |

Owning specs refine content (copy, targets), never the physics: durations, easings, ceilings
and reduced-motion mappings come from here.

## 8. Pictures on public pages

A product picture on the front page or a product landing borrows its room's motion and invents none:
a part its room does not move stays still, and so does every labelled button a picture draws (Apply,
Turn this down, Complete, Fork this tree, Go to page, Add movement).

- **At rest** a picture is still, and nothing moves before the picture has drawn.
- **Under the pointer.** A picture answers a mouse or a pen on a device whose primary pointer hovers;
  a finger never leaves anything lit or moving. A part gives its room's feedback (§0) at the room's
  values. It takes no press, no focus and no cursor of its own, and it never shows a state, number or
  word the picture does not already show.
- **Arrival.** When that pointer is on a picture that is at least 60% in view, or that covers at least
  60% of the view's height, a picture that has a beat plays it: a tree's open steps pulse ×2, the
  unlock picture plays ceremony #4 from the state it draws back to the same state, and Gym's
  remembered weight lifts its ink. The other pictures have no beat. A beat plays again only after it
  has ended and the pointer has been away for 2400ms.
- **While the pointer stays** a picture runs its room's one loop: a tree's crown breathes, a hovered
  path card's crown breathes, a page's caret blinks; Journal's echo keeps its light. When the pointer
  leaves, the tree's crown plays its breath to the end of the cycle and stops, a path card's crown
  ends with its card's hover, the caret returns solid at once, and the echo's light settles.
- **Without hover**, on a phone, a picture with a beat plays it once per page load, after it has
  stayed that much in view for 400ms, one picture at a time down the page. There Journal's echo light
  is a beat too: it kindles, holds and settles once. Taps do nothing and no loop runs.
- **Calm ceiling.** Only the picture under the pointer starts motion. One the pointer has just left
  finishes its beat and its breath and starts nothing new. On a phone one beat plays at a time.
- **Reduced motion** follows §5: colour and opacity changes stay, scale, travel, breath and pulse do
  not, and a room's own reduced-motion rule wins where it has one.

The frame that carries this is `web/src/shell/marketing/pictureMotion.js`; each room's picture sheet
under `web/src/products/<room>/marketing/` holds its own responses.
