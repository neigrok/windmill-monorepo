#include "adapters/mcp/Resources.h"

namespace wm {

namespace {

constexpr char kQuickstart[] = R"(# Windmill quickstart

A Windmill roadmap is an RPG-style skill tree: nodes are skills or milestones, and an edge is a
prerequisite. Six things agents get wrong; each is true of this server.

## 1. Which way an edge points

`connect(from, to)` means `from` must be complete before `to` is unlocked. The edge points from
the requirement to the thing it unlocks — prerequisite first. `create_node`'s `prerequisites` is
the same direction: every id in it unlocks the new node. Edge tools name their endpoints by role,
not by handle: `from`/`to`, and `oldFrom`/`oldTo`/`newFrom`/`newTo` — two node handles in one
call cannot share one name, and which is which is the whole meaning.

## 2. Handles

The law: **`id` is the id you PROPOSE for a new thing; `<thing>Id` is the handle to one that
already exists.** Whichever you guess, both are read.

- `treeId` — the roadmap, on every tree-scoped tool. `list_trees` discovers it.
- `nodeId` — a node that EXISTS, on every tool that edits or marks one. (The older `id` spelling
  is still accepted everywhere `nodeId` is, and carries `deprecated` in the schema.)
- `id` — the id PROPOSED for a new thing: `create_node`, `add_kind`, `import_subgraph`'s
  `nodes[].id` and `kinds[].id`. Omit it on `create_node` and one is minted from the label.
  `create_node` refuses `nodeId` and `add_kind` refuses `kindId`, rather than guess which you meant.
- Legend kinds still publish `id` for the kind that exists — all six `*_kind` tools spell it alike
  — but `kindId` is accepted there too.

## 3. Structure is never refused

A cycle, a detached node, an edge to an id that does not exist: all accepted, none rejected.
`get_diagnostics` is where you find them. Every edit answers `diagnosticsClean`, but that is a
property of the WHOLE tree, not of your edit — a `false` may be dirt that was already there, and
`get_diagnostics` is what tells you which. Two things do refuse: the legend (hues are unique per
kind, at most 6 kinds, and a kind nodes still wear cannot be removed — `import_subgraph` is held
to the same rule) and the per-tree capacity (10000 nodes, 20000 edges).

## 4. `set_progress` is advisory

Marking a node complete whose prerequisites are unmet still records the mark and answers
`prerequisitesMet: false` — it never fails. What it does refuse is an id the tree does not hold,
so no orphan rows are born. Progress is per-caller and private; structure is shared.

## 5. Ask for less

`get_tree`, `find_nodes` and `get_progress` take `fields`; `get_tree` also takes `kindFields`.
Ask for `["id","label"]` when you only need an index to pick edit targets — the default already
omits `description`, `links`, `position` and `icon`. Both node reads page: `limit` (default 200,
max 1000) and the `nextCursor` they hand back.

## 6. Author in bulk

`import_subgraph` grafts a whole `{nodes[], kinds[]}` slice as ONE op, upserting by id; a carried
`progress[]` is applied after it as ordinary overlay writes (and skipped entirely under `dryRun`,
which previews the collisions and changes nothing). It does not touch the tree's title. Prefer it
to N× `create_node` + `connect`.

## Limits worth knowing

A node's `description` is capped at 4000 characters, its `label` at 200, its `links` at 32
(url ≤ 2048). A kind's `label` is capped at 24 and its `description` at 80. Every failure names
the tool, the argument, what you sent and what is legal — read it before retrying.
)";

}  // namespace

const std::vector<McpResource>& resourceCatalog() {
  static const std::vector<McpResource> catalog{
      {"windmill://quickstart", "quickstart", "Windmill quickstart",
       "Edge direction, handle names, what is never refused, and the read projections — the "
       "handful of things agents get backwards.",
       "text/markdown", kQuickstart}};
  return catalog;
}

}
