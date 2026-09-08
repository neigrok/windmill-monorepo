#include "products/roadmap/adapters/mcp/RoadmapResources.h"

namespace wm {

namespace {

constexpr char kQuickstart[] = R"(# Windmill roadmap quickstart

Tool schemas describe arguments and limits. These are the app-specific semantics.

## Edges and diagnostics

`roadmap_connect(from, to)` means `from` must be complete before `to` is unlocked: prerequisite first.
Cycles and detached nodes are accepted and reported by `roadmap_get_diagnostics`. In an edit receipt,
`diagnosticsClean` describes the whole graph; `introducedDiagnostics` identifies problems added by
that edit. Existing problems do not mean the edit caused them.

## Progress

Structure is shared; progress is private to the caller. `roadmap_set_progress` accepts completion
with unmet prerequisites and returns `prerequisitesMet: false`. Use `outOfOrder: true` when intended.

- `status` is your mark: `active`, `complete` or `none`.
- `seedStatus` is the document's authored baseline, carried when copying a graph.
- `state` is derived from prerequisites and your marks: `locked`, `available`, `active` or `complete`.

`roadmap_find_nodes {state: "available"}` finds the current frontier. Import personal marks through
`progress[]`, separately from node `seedStatus`.

## Reads and edits

Reads use lean projections: an omitted description is not an empty description. Request `fields`
for needed detail or `summary` for a short preview. `roadmap_get_nodes` returns exact ids in requested
order with explicit `missingNodeIds`; use `roadmap_get_tree` for broader context.

`roadmap_patch_nodes` preserves omitted fields and replaces supplied values, including descriptions
and links. `roadmap_annotate_node`'s append form repeats text when retried. `roadmap_change_edges`
requires existing endpoints for additions; removing an absent edge is a no-op. Both batch edit tools
support `expectedSeq` and `dryRun`.

`roadmap_import_subgraph` upserts a graph slice, replacing node fields. Prerequisites merge by default;
`prerequisiteMode: "replace"` removes omitted incoming edges. The graph commits in one structural
operation; optional progress commits in a separate atomic phase. Inspect `graphApplied`,
`progressApplied` and any `progressError`/`progressSkipped`: a graph can be applied even when progress
is incomplete. `dryRun` changes neither phase.
)";

}  // namespace

std::string roadmapInstructions() {
  return "Roadmap is a graph of skills and milestones. Cover the relevant aspects of the user's goals "
         "in a balanced way, with genuine prerequisites and no filler. Give each node a short title "
         "and a concise, friendly description explaining its activity and purpose on its own. Check "
         "the whole graph for gaps, duplicates, conflicts and unrealistic scope.";
}

std::vector<McpResource> roadmapResources() {
  return {{"windmill://quickstart", "quickstart", "Windmill quickstart",
           "Roadmap edge direction, progress, diagnostics, projections and batch semantics.",
           "text/markdown", kQuickstart}};
}

}
