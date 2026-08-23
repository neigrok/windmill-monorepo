# Windmill What's next — the panel for the return visit

The canonical spec for the Next up surface: up to three ready steps, one tap
from the work. Graduated from `explorations/whats-next-panel.html` (its ★
verdict). It lives in the **event-log dock** — home, summon grammar, and
row↔fruit linkage are inherited from `event-log.md`, never reinvented; camera
and glow physics are `motion-language.md`'s. The weekly reminder email (X7)
deep-links here. Live specimens: `explorations/whats-next-panel.html`.

> **Principle: the return visit must land on an offer of work, not an
> impressive picture.** The panel points; the canvas is where work happens.

---

## 1. The dock, shared — Next up leads, Activity follows

- **One dock, two tenants, stacked:** NEXT UP (≤3 featured + expander) on
  top, ACTIVITY below with its day separators. One scroll, zero reflow;
  pin / `a` / esc grammar carries over from the event log unchanged.
- **The chip tells the top story** — *amends event-log §1's label:*
  **"Next · N"** (N = ready count) with the unseen-activity dot riding
  along; at 0 ready it falls back to "Activity · N".
- Selecting any fruit still swaps the whole dock to step details (event-log
  A′ rules); ×/esc/canvas returns to the stack. The dock has no blank state.

## 2. Rows & what earns a feature

- **Row = the fruit at its canvas treatment** (ready = white disc + kind
  ring) · name in body-bold · one line of consequence in step counts only:
  "unlocks 2 more steps" (a leaf says nothing). Hover locates: node +
  branches light, rest dims ~30%. A hover-revealed → is the fly affordance.
- **Cap: three.** Rank: most steps unlocked → longest ready → spread (max 2
  per kind). Deterministic, stable within a session; "+N more ready" expands
  the full list in place. The count pill carries the truth.
- Never: streaks, XP, badges, percent bars, idle-guilt timestamps.

## 3. Tap = fly + select

Camera ease 600ms `--ease-soft` (480 short · 720 cap, safe-frame rule) →
terracotta focus ring → **select at 90% settle** → the dock swaps to the
step's workspace. You arrive ready to act. (Activity rows keep their old
rule — they only point.)

## 4. When it shows on open

- **Auto-opens on a return visit:** first open in ≥12h, ≥1 ready step, tree
  ≥12 steps (smaller trees: chip only). ≤1/day; closing is remembered for
  the session. Both thresholds are tunable constants.
- **The reminder email deep link (`?panel=next`) always opens it.**
- Enters only after the camera fit settles; if a welcome-back recap plays
  (`explorations/ceremony-moments.html`), the panel is the recap's landing.
- Focus never moves on an auto-open — only on user summon.
- Never mounts: visitor read-only pages (X5 — their verb is Fork), the bud
  canvas (X3), mid-edit (waits for 400ms idle).

## 5. The two empty states — never a dead end

- **All done:** crown fruit + "Every step is done." + mono "N/N · fully
  grown" + quiet links *Add a step · Plant a new tree*. Celebration belongs
  to the canvas crown and the milestone toast — not here.
- **Nothing unlocked yet** (all remaining steps wait on work in progress):
  the panel features the **blockers** — ember rows, "unlocks N more steps",
  same tap. A true zero never renders (a lone bud doesn't mount the dock).

## 6. Phone

X5's sheet at peek 216: grabber · NEXT UP · featured rows; expanded adds the
expander + Activity (segmented **Next · Activity** — Activity has no phone
toolbar to be summoned from, and its rows carry "Undo this", X8 §8). Tap
retargets to step detail in place (150ms). **Owner check-off from the phone
sheet: settled — the peek's state chip is the toggle** (X8 §6).

## 7. Constants — copy into the build

```
DOCK      event-log overlay, right edge · NEXT UP head, ACTIVITY tail · zero reflow · pin/`a`/esc inherited
CHIP      "Next · N" (ready count) · unseen-activity dot · 0 ready → "Activity · N"
FEATURED  ≤3 · unlocks desc → longest ready → ≤2 per kind · stable in-session · "+N more ready" expands in place
ROW       fruit at canvas treatment · body-bold name · "unlocks N more steps" · hover = locate (rest 30%)
TAP       camera 600ms ease-soft → focus ring → select @90% → dock swaps to workspace
OPEN      return ≥12h + ≥1 ready + tree ≥12 steps · ≤1/day · after settle (after recap) · email link always
EMPTY     done → crown + counts + add/plant · none ready → ember blockers, same tap
PHONE     X5 sheet at peek 216 · tap retargets in place
NEVER     a modal · visitor pages · bud canvas · twice a session · focus-steal · streaks/XP/badges
```

## 8. Ownership map

| Concern | Owner |
|---|---|
| Beat physics (camera, glow, yield) | `motion-language.md` (X1) |
| Dock home, overlay/pin, linkage, arrivals | `event-log.md` |
| Sheet grammar, touch, floors | `responsive.md` (X5) |
| Step workspace content | editing spec v2 · F13 |
| Reminder email + deep link | `email.md` (X7) |
| Featured logic, open rules, empty states, chip label | **this doc** |
