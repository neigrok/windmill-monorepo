# Windmill What's next — the panel for the return visit

The spec for the Next up surface: up to three ready steps, one tap from the work. It lives in the
event-log dock — home, summon grammar, and row↔fruit linkage come from `event-log.md`; camera and
glow physics from `motion-language.md`. The weekly reminder email deep-links here.

> The return visit must land on an offer of work, not an impressive picture. The panel points; the
> canvas is where work happens.

---

## 1. The dock — Next up leads, Activity follows

- **One dock, two tenants, stacked:** NEXT UP (≤3 featured + expander) on top, ACTIVITY below with
  its day separators. One scroll, zero reflow; pin / `a` / esc grammar carries over from the event
  log unchanged.
- **The chip:** "Next · N" (N = ready count) with the unseen-activity dot; at 0 ready it falls back
  to "Activity · N".
- Selecting any fruit swaps the whole dock to step details; ×/esc/canvas returns to the stack. The
  dock has no blank state.

## 2. Rows & what earns a feature

- **Row = the fruit at its canvas treatment** (ready = white disc + kind ring) · name in body-bold ·
  one line of consequence in step counts only: "unlocks 2 more steps" (a leaf says nothing). Hover
  locates: node + branches light, rest dims ~30%. A hover-revealed → is the fly affordance.
- **Cap: three.** Rank: most steps unlocked → longest ready → spread (max 2 per kind). Deterministic,
  stable within a session; "+N more ready" expands the full list in place.
- Never: streaks, XP, badges, percent bars, idle-guilt timestamps.

## 3. Tap = fly + select

Camera ease 600ms `--ease-soft` (480 short · 720 cap, safe-frame rule) → terracotta focus ring →
select at 90% settle → the dock swaps to the step's workspace. Activity rows only point.

## 4. When it shows on open

- **Auto-opens on a return visit:** first open in ≥12h, ≥1 ready step, tree ≥12 steps (smaller trees:
  chip only). ≤1/day; closing is remembered for the session. Both thresholds are tunable constants.
- The reminder email deep link (`?panel=next`) always opens it.
- Enters only after the camera fit settles; if a welcome-back recap plays, the panel is its landing.
- Focus never moves on an auto-open — only on user summon.
- Never mounts: visitor read-only pages, the bud canvas, mid-edit (waits for 400ms idle).

## 5. The two empty states

- **All done:** crown fruit + "Every step is done." + mono "N/N · fully grown" + quiet links *Add a
  step · Plant a new tree*. Celebration belongs to the canvas crown and the milestone toast.
- **Nothing unlocked yet:** the panel features the blockers — ember rows, "unlocks N more steps",
  same tap. A true zero never renders; a lone bud doesn't mount the dock.

## 6. Phone

The sheet at peek 216: grabber · NEXT UP · featured rows; expanded adds the expander + Activity
(segmented **Next · Activity**, whose rows carry "Undo this", `mobile.md` §8). Tap retargets to step
detail in place (150ms). Owner check-off: the peek's state chip is the toggle (`mobile.md` §6).

## 7. Constants — copy into the build

```
DOCK      event-log overlay, right edge · NEXT UP head, ACTIVITY tail · zero reflow · pin/`a`/esc inherited
CHIP      "Next · N" (ready count) · unseen-activity dot · 0 ready → "Activity · N"
FEATURED  ≤3 · unlocks desc → longest ready → ≤2 per kind · stable in-session · "+N more ready" expands in place
ROW       fruit at canvas treatment · body-bold name · "unlocks N more steps" · hover = locate (rest 30%)
TAP       camera 600ms ease-soft → focus ring → select @90% → dock swaps to workspace
OPEN      return ≥12h + ≥1 ready + tree ≥12 steps · ≤1/day · after settle (after recap) · email link always
EMPTY     done → crown + counts + add/plant · none ready → ember blockers, same tap
PHONE     sheet at peek 216 · tap retargets in place
NEVER     a modal · visitor pages · bud canvas · twice a session · focus-steal · streaks/XP/badges
```

## 8. Ownership map

| Concern | Owner |
|---|---|
| Beat physics (camera, glow, yield) | `motion-language.md` |
| Dock home, overlay/pin, linkage, arrivals | `event-log.md` |
| Sheet grammar, touch, floors | `responsive.md` |
| Reminder email + deep link | `marketing/guidelines/email.md` |
| Featured logic, open rules, empty states, chip label | this doc |
