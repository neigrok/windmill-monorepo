# Windmill Paste-to-tree — import

The spec for turning pasted text into a planted tree: the door, the composer, the parse grammar and
the arrival. Motion physics come from `motion-language.md` — the arrival is ceremony #3, cited
verbatim, and this doc adds no motion of its own.

> Paste is import, not generation. Deterministic, visible, never a wall. The wow is the bloom, not
> the parser — and the door adds zero chrome at rest.

---

## 1. The door

- Both roads to a new tree run through the single-bud canvas; paste adds a handle, never a surface.
  The second line of the birth hint carries it (§5).
- **Raw ⌘V** anywhere on the new-tree canvas opens the composer already filled and parsed. Typing
  still just names the bud; the two inputs never compete.
- **File drop** (.md/.txt onto the canvas) is the same door — composer prefilled, grammar identical.
- **Append mode:** ⌘V on an existing tree opens the same composer in append mode — parsed lines
  graft under the current selection, or the root when nothing is selected. Grammar verbatim.
- **Never:** a "New tree" dialog with tabs, or an always-docked import panel.
- The LLM composer is a different door; this parser stays deterministic.

## 2. The composer

- **Seat:** the per-node StepPanel dock, borrowed while there are no nodes, at StepPanel width. The
  canvas stays visible; the bud dims but never leaves. Phone/tablet: rides the sheet (peek = readout
  + Plant, expand = the well) under `mobile.md` §7's keyboard contract — the well anchors to
  `visualViewport`, chrome yields, and a Done bar sits above the keys.
- **Anatomy, top to bottom:** title "Paste a plan" + quiet ✕ · plain text well (body font, no
  toolbar; the placeholder *is* the format spec) · legend row · readout + **Plant**.
- **The gutter is the parse, line by line:** `◉` root · `├` branch · `·` step · `✓` arrives done ·
  `¶` kept as a note. Appears only after text does; live on every keystroke. The preview is the
  confirmation — there is no separate confirm step.
- **Ghost skeleton:** grows beside the text as you type — dashed buds on dormant edges, kind-tinted
  by branch, structural only; the first real glow is earned at Plant. Updates are feedback-class:
  150ms fades, ~40ms stagger, no ceremony. `[x]` ghosts render filled.
- **Legend row:** current kinds as read-only chips + "Edit legend", visible at author time.
- **Footer:** live readout · imperfect chip in quiet gold (a count, not a scold) · Plant (**⌘↵**; ↵
  alone is a newline). **esc** closes back to the bud, clipboard kept. Plant is disabled only when
  empty. No red ever — brick is for danger. Strings in §5.

## 3. The grammar — 8 rules

| You paste | It becomes |
|---|---|
| `# Heading` / first line | The root — and the tree's name. No heading? The composer asks for one word, nothing else. |
| indent (2sp / tab / nested list) | Prerequisite of the nearest shallower line. Depth is dependency. |
| `- [x] done thing` | Arrives complete. `[ ]` and bare bullets are plain steps. |
| `1. 2. 3.` flat list | A chain — each unlocks the next. Numbers promise order. |
| `•` flat bullets | A fan off the root — parallel, all available. Bullets don't promise order. |
| `## second heading` | A branch. A name matching an existing kind (case-insensitive) binds to that kind; otherwise branches take starter kinds in order. Steps inherit their branch. |
| anything else | A note on the nearest step — URLs, asides, half sentences. Nothing is ever dropped. |
| weird indent jump (+3) | Clamps to the nearest real ancestor. Duplicate names get " (2)". |

Parsing cannot fail — worst case is one root and a pile of notes, still a tree, still plantable.
Deterministic: same text → same tree → same seeded jitter. Nothing auto-corrects silently — every
liberty (clamped indent, noted line, renamed duplicate) is visible in the gutter before Plant exists
to press.

## 4. The arrival — ceremony #3

1. **0ms — Plant.** Composer chrome fades in 150ms (chrome speed, not ceremony speed); the camera
   begins its 600ms fit. The bud you were looking at *is* the seed — no cut, no swap.
2. **90% settle** — the root wakes, takes the crown, the breath starts.
3. **Rings enter on the 320ms cadence**, ±60ms seeded jitter, edges fading in with their ring —
   already in their final places: structure emerges, never scrambles.
4. **`[x]` steps wake directly into their complete rest** — halo at rest values, no blossom
   overshoot.
5. **Toast speaks last** (+120ms), the planted line in §5.

Budget per motion §3: structural beats ≤2400ms; over ~150 steps the cadence floors at 160ms and
outer rings join the final beat. Pointer-down at any moment fast-forwards everything in 150ms.

**Reduced motion:** the ghost preview needs no fallback (already ≤150ms opacity). The arrival maps
per motion §5: camera snaps with a 150ms fade-through, one simultaneous 280ms cross-fade (no
stagger, no scale), crown frozen at mid-breath, toast fades without rising.

## 5. Copy — every string

| Where | String |
|---|---|
| Handle | "or **paste a plan** — ⌘V anywhere" |
| Composer title | "Paste a plan" |
| Placeholder | "Paste anything — a to-do list, an outline, markdown checkboxes." |
| Readout | "13 steps · 3 branches · 2 already done" |
| Imperfect chip | "2 lines → notes" |
| Primary | "Plant" (⌘↵) |
| Toast | "Roadmap planted · 13 steps · 2 already done" |
| Missing root | "Give it a name to plant" (inline, under the well) |

One metaphor word per string ("plant"), sentence case, numbers only where they earn it.

## 6. Constants — copy into the build

```
DOOR       birth-hint line 2 + raw ⌘V + file drop  ·  append mode on existing trees
COMPOSER   StepPanel seat + width · esc → bud (clipboard kept) · ⌘↵ Plant
           Plant disabled only when empty · imperfect = gold chip, never blocks
GUTTER     ◉ ├ · ✓ ¶ · live per keystroke · ghost fades 150ms, stagger ~40ms
GRAMMAR    8 rules · deterministic · nothing dropped · dupes "(2)" · clamp to ancestor
ARRIVAL    ceremony #3 (motion §7) · [x] → complete rest · toast +120ms
BIG PASTE  cadence floor 160ms · outer rings join the final beat
```

## 7. Ownership map

| Concern | Owner |
|---|---|
| Beat physics, cadence, budget, reduced motion | `motion-language.md` |
| Composer's phone seat | `responsive.md` §3 (sheet grammar) |
| The door, the grammar, composer content, arrival staging | this doc |
