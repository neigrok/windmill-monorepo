# Motion language — the beats (X1)

The shared vocabulary for animated moments in Windmill. The production roadmap timings below
follow `CeremonyDirector.js`, `NodeBatch.js`, `ConnectorBatch.js`, and `Camera2D.js`. DOM motion
tokens live in `web/src/styles/tokens/motion.css`; their specimen timings are identified separately.

Motion celebrates growth. Downward state changes are silent. The production WebGL roadmap
uses static resting status rings; only feedback and finite ceremonies animate its nodes.

Tier names here are **locked · available · active (the ember) · complete**. The renderer maps
them to indices 0–3 through `nodeTier` in `web/src/products/roadmap/theme.js`.

---

## 0. Two classes of motion

| Class | What | Rule |
|---|---|---|
| **Feedback** | hover scale 1.06 over 280ms, press 0.97 over 120ms, selection-chrome fades (150ms) | Runs immediately. Never queued or blocked by a ceremony. Shader scale feedback uses a cubic smoothstep. |
| **Ceremony** | the five beats below, composed | Schedulable, one at a time, yields to interaction (§4). |

## 1. The sentence

The five beats describe a growth event. A completed source blooms before its outgoing travel;
each reached child blooms at handoff. Camera motion can precede the event, with pulse and toast
following the structural beats:

```
camera ease  →  travel  →  bloom  →  pulse  →  toast
   (settle)     (carry)    (ignite)  (point)   (speak)
```

## 2. The beats

### bloom — a node ignites (tier rises)

Production WebGL starts fill, scale, and event halo from the same ignition stamp:

- **Fill/ring:** dim-to-lit interpolation lasts 280ms by default and uses cubic smoothstep.
  Available, active, and complete share the lit fill; their status rings distinguish them.
- **Scale:** a sine-shaped rise and return lasts **620ms**. Peaks are **1.05** for an available
  wake, **1.02** for active, and **1.10** for complete.
- **Halo:** every stamped ignition can produce a finite 620ms halo, including an available wake.
  Its strength follows `0.45 × sin(πt)` and returns to zero. It has no delayed start or resting
  halo. The strength is a shader multiplier, not a final screen alpha.
- The director coalesces queued ceremonies. Directly stamping an ignition replaces that node's
  existing stamp.
- Ordinary downward state application does not schedule a growth ceremony.
- **DOM specimen:** `wm-bloom` uses a 560ms animation, peaks at scale 1.045, and settles to its
  static box shadow. That token does not define the GPU bloom duration or scale.

### travel — light follows a dependency

- A scheduled edge is temporarily visible with the 2px context stroke. Its finite head uses a
  10-world-unit core and approximately 24-world-unit trailing wake along the bezier; progress is
  linear in time through the curve parameter.
- Duration uses **400 world units/s**, clamped to **280–620ms**, unless the caller supplies a
  duration. Completion does not permanently brighten the resting edge. After travel, ordinary
  visibility and context determine whether the edge remains visible.
- Completion travels depart at **+280ms**; successive replay waves add **320ms** each. A reached
  child's ignition starts at **85%** of travel duration plus seeded jitter of up to ±60ms.
- Arrival travels start with their logical generation's scheduled beat and retain their own
  length-derived duration. There is no per-source head-count cap in the production renderer.

### camera ease — settle to a target

- Pan + zoom on **one** curve, `--ease-soft`. Duration: **480ms** (≤ half a viewport),
  **600ms** default, **720ms** cap — never longer, never chained. A new target retargets the
  live tween (no restart jerk).
- Automatic context glides can skip a target inside the **80% safe frame** when zoom need not
  change. Explicit Focus can force recentering.
- Dependent beats start at **90%** settle.
- Any user input (drag / wheel / pinch / key-nav) cancels it instantly.

### toast — quiet status

- Enter: `wm-fade-in-up` (fade + rise 8px), 280ms `--ease-soft`. Hold **4000ms** (6000ms with
  an action like Undo). Exit: fade, 280ms `--ease-standard`.
- **Last beat**: enters **+120ms** after the final structural beat settles. One toast per
  ceremony — it summarizes ("Step unlocked: Add plants · 2 more steps opened").
- One at a time; a newer toast **replaces** (150ms cross-fade), never stacks.

### status / pulse

- **Production WebGL status:** roots retain a quiet structural ring, active nodes a dashed ring,
  and complete nodes a static outer ring. None has a resting halo or infinite node animation.
- **Production pulse:** a finite cosine waveform runs **1400ms per cycle × 2**, for **2800ms**
  total. Its envelope decreases between the two cycles, then the halo disappears. Pulse begins
  after the director's final structural settle and does not wait for toast dismissal.
- **DOM specimens:** `wm-pulse-node` and `wm-ember` retain 2400ms periodic box-shadow treatments.
  `wm-pulse-echo` is a separate finite 2400ms token, and `wm-bloom` returns to a static shadow.
  These appearances require reconciliation with the production roadmap's resting rings.
- **Clock:** finite GPU effects read the shared scene clock and their own event start stamps.

## 3. Cascade & stagger rules

- The arrival plan groups nodes by logical depth, independent of wrapped visual rows. Beats start
  **320ms** apart with per-node seeded jitter of up to **±60ms**.
- For a deep arrival, cadence compresses to a **160ms** floor; later generations share the final
  beat. The **2400ms** budget limits scheduled generation starts, not the final bloom or toast.
  The last 620ms bloom and 120ms toast gap can extend beyond that budget.
- Arrivals above **400 nodes** use the director's immediate state path rather than staggered
  generation timers. Under normal motion, shader stamps can still produce finite node feedback;
  reduced motion suppresses that scale and halo.
- Completion replay uses its own 320ms wave offsets. Pulse afterglow and toast hold are separate
  from structural scheduling.

## 4. The calm ceiling

- **One ceremony at a time.** Later events queue and **coalesce** into one combined ceremony
  (one toast that sums them).
- Production does not enforce a separate 24-node tween cap. Large arrivals use the immediate
  path described above; shader event effects remain finite.
- **No infinite node loops in the production roadmap.** Standalone DOM crown and ember specimens
  retain their own periodic treatments; their visual reconciliation is tracked in the consistency ledger.
- **Motion yields to interaction:** pointer-down / wheel / pinch cancels remaining director
  timers and applies endpoint states with **150ms** fill/travel durations. With normal motion,
  stamped node scale and halo still follow the shader's 620ms window. Toasts survive.
- **While editing** (drag in progress, panel typing): ceremonies don't start — changes apply
  silently, coalesce, and celebrate once after **400ms idle**.

## 5. Reduced motion (`uMotion = 0`)

Production node fill transitions use **150ms**; scale, halo, and pulse are suppressed through
`uMotion`. The director applies all endpoint states together and skips spatial travel heads.
Camera movement snaps. Static status and selection treatments remain visible.

| Beat | Fallback |
|---|---|
| bloom | 150ms dim-to-lit transition; no event halo or scale |
| travel | no moving head; the context stroke can remain visible for its 150ms event interval |
| camera ease | snap; zero spatial interpolation |
| toast | opacity fades only, no rise |
| crown | production structural ring stays static |
| ember | production dashed ring stays static; DOM `wm-ember` uses its static shadow |
| pulse ×2 | **skip** entirely |
| cascade | simultaneous endpoint state application with 150ms node fill fades, no stagger |
| feedback: hover/press scale | skip scale; keep ring/colour feedback and caption emphasis |
| feedback: chrome fades (150ms opacity) | keep |

## 6. Production roadmap constants

```
IGNITE         280ms  cubic smoothstep; reduced motion 150ms
BLOOM_WINDOW   620ms  from ignition stamp; sine-shaped scale and halo
SCALE_PEAK     available 1.05 · active 1.02 · complete 1.10
TRAVEL_V       400 world units/s  clamp [280, 620]ms; depart +280ms
HANDOFF        0.85
CADENCE        320ms/ring  floor 160ms  jitter ±60ms seeded
CAMERA         600ms ease-soft (480 short · 720 cap)  DEPEND_AT 0.90  SAFE_FRAME 80%
TOAST          in 280 · hold 4000 (6000 w/ action) · out 280 · replace 150
PULSE          1400ms ×2, decaying; total 2800ms
ARRIVAL_START_BUDGET 2400ms    ARRIVAL_STAGGER_LIMIT 400 nodes
LOOP_MAX       0 (production node status)
YIELD          150ms      IDLE_COALESCE 400ms
```

Easings (`tokens/motion.css`): `--ease-soft cubic-bezier(0.16,1,0.3,1)` ·
`--ease-standard cubic-bezier(0.4,0,0.2,1)` · `--ease-glow cubic-bezier(0.45,0,0.15,1)`.

## 7. The ceremonies

| Ceremony | Sentence used |
|---|---|
| **#3 paste arrival** | camera fit → generation wakes and finite travels, or immediate state application above 400 nodes → toast ("Roadmap planted · N steps") |
| **#4 first unlock** | camera (only if off-frame) → complete full-bloom → travels → children wake → pulse ×2 on frontier → toast |
| **#9 unlock ceremony** | the full sentence; may add flourish only within the ceilings above |
| **milestone share offer** | ceremony #9 verbatim; the finished limb (a root-child's whole subtree) shares one pulse ×2, and any Share action opens the public-link dialog (`roadmap/guidelines/sharing.md`); no image or video is exported |
| **welcome-back recap** | on reopen with unseen completions (≥12h): camera fit → completions re-bloom with finite replay travels → frontier pulse ×2 → the Next panel enters (no toast) |

Owning specs refine content (copy, targets), never the physics: durations, easings, ceilings
and reduced-motion mappings come from here.
