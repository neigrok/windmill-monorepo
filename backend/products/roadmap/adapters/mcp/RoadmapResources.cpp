#include "products/roadmap/adapters/mcp/RoadmapResources.h"

namespace wm {

namespace {

constexpr char kQuickstart[] = R"(# Windmill quickstart

A Windmill roadmap is an RPG-style skill tree: nodes are skills or milestones, and an edge is a
prerequisite. Six things agents get wrong; each is true of this server.

## 1. Which way an edge points

`roadmap_connect(from, to)` means `from` must be complete before `to` is unlocked. The edge points from
the requirement to the thing it unlocks — prerequisite first. `roadmap_create_node`'s `prerequisites` is
the same direction: every id in it unlocks the new node. Edge tools name their endpoints by role,
not by handle: `from`/`to`, and `oldFrom`/`oldTo`/`newFrom`/`newTo` — two node handles in one
call cannot share one name, and which is which is the whole meaning.

## 2. Handles

The law: **`id` is the id you PROPOSE for a new thing; `<thing>Id` is the handle to one that
already exists.** Legacy single-item tools accept the aliases described below; batch tools use
only their published field names.

- `treeId` — the roadmap, on every tree-scoped tool. `roadmap_list_trees` discovers it.
- `nodeId` — a node that EXISTS, on every tool that edits or marks one. (The older `id` spelling
  is still accepted by legacy single-node tools and carries `deprecated` in their schemas.)
- `id` — the id PROPOSED for a new thing: `roadmap_create_node`, `roadmap_add_kind`, `roadmap_import_subgraph`'s
  `nodes[].id` and `kinds[].id`. Omit it on `roadmap_create_node` and one is minted from the label.
  `roadmap_create_node` refuses `nodeId` and `roadmap_add_kind` refuses `kindId`, rather than guess which you meant.
- Legend kinds still publish `id` for the kind that exists — all six `*_kind` tools spell it alike
  — but `kindId` is accepted there too.

## 3. Structure and admission

Cycles and detached nodes are accepted and surfaced as diagnostics. The bulk roadmap_change_edges tool
requires existing endpoints for additions; legacy roadmap_connect can also create dangling edges.
`roadmap_get_diagnostics` is where you find them. Applied structural edits answer two things about them:
`diagnosticsClean` is a property of the WHOLE tree — a `false` may be dirt that was already there
— and `introducedDiagnostics` is what YOUR edit broke, the errors the tree holds now and did not
hold a moment before, named endpoint by endpoint. An innocent edit on a dirty tree answers
`{"diagnosticsClean": false, "introducedDiagnostics": []}`, so you never have to ask twice. Admission also checks malformed arguments, permissions, revision preconditions, and batch limits.
Other refusals include: the legend (hues are unique per kind, at most 6 kinds, and a kind nodes still
wear cannot be removed — `roadmap_import_subgraph` is held to the same rule), the per-tree capacity
(10000 nodes, 20000 edges), and `roadmap_delete_node` when an id names no present node — the whole call,
every missing id named, nothing applied.

## 4. `roadmap_set_progress` is advisory, `status` is yours, and `state` is derived for you

Marking a node complete whose prerequisites are unmet still records the mark and answers
`prerequisitesMet: false` — it never fails. When that inversion is meant, send `outOfOrder: true`
with the completion: the word is kept on the mark and the receipt answers `acknowledged: true`
beside it, so `prerequisitesMet: false` alone always means an inversion nobody acknowledged. What
it does refuse is an id the tree does not hold, so no orphan rows are born. Progress is
per-caller and private; structure is shared.

The same word means the same thing on every read: ask `roadmap_get_tree` or `roadmap_find_nodes` for the `status`
field and each node answers YOUR mark — `active`, `complete` or `none`, always present, never
omitted. The document's own authored baseline (what a reader sees before their own marks) is a
different fact under a different name, `seedStatus`, and it is what `roadmap_import_subgraph`'s
`nodes[].seedStatus` carries. Copy a tree with `seedStatus`; carry your own marks in `progress[]`.

The unlock cascade is a third fact, and the tree derives it so you never have to: ask for the
`state` field and each node answers `locked`, `available`, `active` or `complete`, computed from
its prerequisites and your marks — the same rule the app paints from. The read every client wants
after it plants is the frontier, and it is one call: `roadmap_find_nodes {state: "available"}` answers
what you can work on right now. With no account behind the call the cascade runs over no marks:
roots available, the rest locked.

## 5. Ask for less

`roadmap_get_tree`, `roadmap_get_nodes`, `roadmap_find_nodes` and `roadmap_get_progress` take `fields`; `roadmap_get_tree` also takes `kindFields`.
Ask for `["id","label"]` when you only need an index to pick edit targets — the default already
omits `description`, `links`, `position`, `icon`, both status fields and `state`. To skim a
tree's notes ask for `summary` — each description's opening 200 characters (Unicode code points),
cut at a word and ellipsized when cut — and for `description` only when you need one node's whole
text: on an annotated tree a page of full descriptions runs past most clients' result ceiling. Ask
for `kind` to get the legend kind id a node's color refers to, joined for you. `roadmap_get_tree` and `roadmap_find_nodes`
page: `limit` (default 200, max 1000) and the `nextCursor` they hand back. To see every edge at
once, `roadmap_get_tree {includeEdges: true}` adds a top-level `edges` array of the whole tree's live
edges beside the page — the same list on every page, so ask once.

`roadmap_find_nodes`' `query` is a case-insensitive substring over a node's **id, label and description**,
answered best first: an exact id, then an id prefix, then a label hit, then an id substring, then
a description-only hit. For exact ids, use `roadmap_get_nodes {nodeIds: [...]}`: 1–200 unique ids, returned
in requested order, with explicit `missingNodeIds`. Its complete result is bounded to 262144 bytes;
request fewer ids or lighter fields if refused. It never silently truncates the selection.

## 6. Author in bulk

Use `roadmap_patch_nodes` to change 1–200 existing nodes while preserving omitted fields. Each update
names `nodeId` and at least one of `label`, `icon`, `description`, `color`, `position`, or `links`.
Descriptions and links replace their values; this tool does not append. Use `roadmap_change_edges` for
1–500 combined `add`/`remove` pairs. Duplicate pairs and add/remove overlap are refused; additions
need existing endpoints, and removing an absent edge is a no-op. Both tools validate the whole
batch before mutation, accept `dryRun`, and accept `expectedSeq` from a read to reject a stale
edit. An exact retry makes no new structural op when every requested value already stands.

`roadmap_import_subgraph` grafts a whole `{nodes[], kinds[]}` slice as ONE structural op, upserting by id.
An optional `progress[]` (max 1000) is a separate atomic overlay phase after the graph commit.
Inspect `graphApplied`, `progressApplied`, and any `progressError`/`progressSkipped`: the graph may
be applied even if requested progress could not be fully applied. `dryRun` previews the graph and
changes neither phase. A re-sent node's fields are replaced, but its
`prerequisites` are UNIONED with the edges it already has unless you pass
`prerequisiteMode: "replace"` — a merge reports what it left standing in `keptEdges`. To delete in
the same batch, list ids in `tombstone` — that needs the roadmap:delete grant, and your own marks
on those nodes are cleared after the graft, as `roadmap_prune` clears an orphan's. It does not touch the
tree's title. Prefer it to N× `roadmap_create_node` + `roadmap_connect` + `roadmap_delete_node`.

## Limits worth knowing

A node's `description` is capped at 16000 characters, its `label` at 200, its `icon` at 64, its
`links` at 32 (url ≤ 2048). A kind's `label` is capped at 24 and its `description` at 80. Every cap
counts Unicode code points — a CJK character or an emoji is one. `roadmap_annotate_node`'s
`appendDescription` adds to the end of a body instead of replacing it, and the cap is held against
the body the node would then hold. A cap refusal names every field over its cap and by how much
(`description would be 17181 characters, 1181 over the 16000 cap`), so one retry fits. Every
failure names the tool, the argument, what you sent and what is legal — read it before retrying.
)";

}  // namespace

std::string roadmapInstructions() {
  return "Help the user build a balanced graph connecting the important aspects of their goals. "
         "Cover relevant foundations, practice and outcomes without forcing equal branches or adding filler. "
         "Make dependencies reflect what actually needs to come first. Give each node a short human title "
         "and a concise, friendly description naming the activity or outcome and why it matters. Every "
         "description must make sense on its own: include its subject and necessary context rather than "
         "relying on another node, a vague reference or this conversation. Check the graph as a whole for "
         "missing aspects, duplicated work, conflicting expectations and unrealistic scope.\n\n"
         "Roadmaps are RPG-style skill trees: nodes are skills/milestones, and a prerequisite edge "
         "points from a required node to the node it unlocks. Use get_tree and get_diagnostics to "
         "inspect, and get_nodes for an ordered selection of known ids. Prefer patch_nodes for edits "
         "that preserve omitted fields, change_edges for edge batches, and import_subgraph for a new "
         "or replacement graph slice. Use expectedSeq and dryRun on patches or edge batches when "
         "a revision check or preview is needed. Use set_progress to mark a node "
         "active or complete. Cycles and detached nodes are accepted and surfaced by "
         "get_diagnostics, not refused.";
}

std::vector<McpResource> roadmapResources() {
  return {{"windmill://quickstart", "quickstart", "Windmill quickstart",
           "Edge direction, handles, validation, batch workflows, and read projections — the "
           "handful of things agents get backwards.",
           "text/markdown", kQuickstart}};
}

}
