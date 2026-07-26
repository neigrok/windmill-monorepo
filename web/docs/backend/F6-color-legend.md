# Backend tasks — F6 Custom color legend

The frontend (branch `f6-color-legend`) ships the legend UI + editor and persists it
**client-side** in `LegendStore` (localStorage), the same interim pattern as F1 progress
(`ProgressStore`) and F13 workspaces (`WorkspaceStore`). These tasks make the legend
**authoritative on the backend** so it syncs across devices and collaborators, like the
tree structure already does.

Spec: `explorations/color-legend.html` (F6) in the Claude Design project.

## Data model

Each tree owns an **ordered list of kinds**:

```
Kind { id: string, hue: Hue, label: string, description: string }
Hue  = terracotta | olive | gold | brick | sky | plum
```

- `hue` is **unique per kind** — at most 6 kinds per tree (the palette is the whole gamut).
- `label` ≤ 24 chars, sentence-case, one or two words; `""` = unlabeled (UI shows the hue's
  own name in a quiet voice). `description` ≤ 80 chars, plain text, optional.
- A node's existing `color` field **is** its kind — it holds the `hue`. The legend names and
  orders those hues; there is no separate node→kind foreign key to add.
- **Order matters**: legend order = generation priority (the first kind is the fallback, see
  the generation contract below).

## Tasks

1. **Persist + serve the legend.** Store the ordered `kinds` per tree; include a `kinds` array
   in the `GET /v1/trees/:id` payload. When absent (legacy trees), the client derives an
   unlabeled legend from the hues actually in use — the backend may do the same on read, or
   return `[]` and let the client derive.

2. **Seed defaults on tree creation.** A new tree is born with three kinds, in order:
   `Build` (terracotta), `Learn` (olive), `Milestone` (gold), with descriptions
   "Things you make" / "Things you figure out" / "Moments that matter". Never seed all six.

3. **Legend collab ops** — add to the op log + broadcast + server-driven undo, exactly like the
   node/edge ops (`CreateNode`, `SetNodeColor`, …):
   - `RenameKind { id, label }`
   - `DescribeKind { id, description }`
   - `AddKind { id, hue }` — reject if `hue` already taken or already 6 kinds.
   - `RemoveKind { id }` — **reject if any node uses its hue** (in-use kinds can't be removed).
   - `ReorderKinds { order: [id, …] }`
   - `RecolorKind { id, hue }` — **atomic**: swap the kind's hue to the new (free) hue AND
     repaint every node whose `color` was the old hue to the new hue, in one op/undo step.
     (Alternatively the client can send N × `SetNodeColor` + a legend op, but a single atomic
     op keeps the op log clean and undo one-step — preferred.)

4. **Fork copies the legend verbatim.** When a tree is forked, copy its `kinds` (labels,
   descriptions, order, hues) unchanged — the meaning travels with the colors.

5. **Validation** (server-authoritative): hue uniqueness; ≤6 kinds; `RemoveKind` blocked while
   in use; label/description length caps.

## Forward (not this milestone — the legend is the contract these fill against)

- **F17 generation composer** and **F3 paste-import**: the generator receives the **ordered
  kinds** (label, description, hue name) as its sorting brief. Generators **never** add, rename,
  or recolor kinds. Unplaceable steps take the **first** kind. Editing the legend later never
  re-kinds existing steps. Keep `description` available to the LLM — it's the sorting brief.

## Related interim client stores that also want backend homes

- F1 durable **progress** → `ProgressStore` (localStorage). Backend decision on record:
  multi-tree registry + per-user progress live in the backend.
- F13 node **workspaces** (sub-tasks / note / links) → `WorkspaceStore` (localStorage).

These three (progress, workspace, legend) share the same shape: client persists locally today;
the backend should own them per tree/user and sync via the collab op log.
