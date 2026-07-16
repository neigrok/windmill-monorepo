# MCP ergonomics — build log

Executing the friction backlog in `../../mcp-changes.txt`. Each phase builds + tests + stages.

## Plan → tool surface

- Node metadata: `description` + `links` on nodes — new CRDT fields, `create_node` gains them, new `annotate_node`.
- `create_node`: `prerequisites[]` replaces the single `parentId` (still accepted). *(item 2)*
- `add_kind`: inline `label` + `description`. *(item 3)*
- `import_subgraph`: bulk upsert of the `get_tree` shape as one `graft` frame — collisions reported, optional `progress`, `dryRun`. *(items 1, 4, 6, 7)*
- `set_progress`: bulk `updates[]`, order-safe advisory, rejects unknown nodeIds. *(items 5, 9, 8a)*
- `prune`: GC dangling edges + orphaned progress rows. *(item 8b)*

## Log

### Landed — all 9 friction items + node metadata

Tests: domain 142, mcp 40, adapters(json) 11 — all green.

- **Node metadata** — `description` (`Lww<string>`) + `links` (`Lww<vector<Link>>`) as two new
  per-field CRDT registers on `NodeRecord`/`NodeStateEntry`/`NodeSpec`. Threaded through the
  full lattice: `LooseGraph` seed/join/export, `Subgraph` frontier/mask/uncovered, both JSON
  codecs (document + persisted GraphState). `create_node` seeds them; `annotate_node` sets
  either independently. A `Link` is `{label, url}`; a bare url string also parses (ergonomic).
- **item 2 (`prerequisites[]`)** — `CreateNode.parent` (`optional<NodeId>`) → `prerequisites`
  (`vector<NodeId>`); `parentId` still accepted and folded in. One command, N edges.
- **item 3 (`add_kind` inline)** — `AddKind` gained `label` + `description`; merge seeds them.
- **items 1/4/6/7 (`import_subgraph`)** — rides the existing subgraph CRDT via a new
  `TreeRoom::importTree`: one dominating clock stamp → `SubgraphIntent::graft` → `joinSubgraph`.
  One op, one broadcast, upsert-by-id for free (the stamp dominates, so a collision overwrites).
  Collisions are reported; `dryRun` previews them (item 7); a carried `progress[]` reuses the
  batch path (items 5/6).
- **items 5/9/8a (`set_progress`)** — `ProgressService::setStatuses` writes the batch then
  judges every advisory against one committed read (order-safe, item 9). `applyProgressBatch`
  in the tool layer is shared by `set_progress` and import; it rejects unknown node ids (8a).
- **item 8b (`prune`)** — `PruneDangling` command (the GC twin of `TransitiveReduction`, built
  on a new `LooseGraph::danglingEdges()`), plus a per-user orphan-overlay sweep in the tool.

### Follow-up — node search

- **`find_nodes`** — read-only query: filter by `color`, by `kind` (resolved to its hue via the
  legend), and/or a case-insensitive `query` substring over label + description; criteria AND
  together, an empty filter lists all. Logic lives in a pure domain read-model
  `domain/NodeQuery` (`NodeFilter` + `selectNodes`), mirroring `TreeSummary`. Extracted
  `nodeToJson` in TreeJson so get_tree and find_nodes share one node wire shape.

### Follow-up — storage v2: per-entry rows, sparse saves

Problem: the whole tree lived in one `trees.document` jsonb, and `persist` ran after every
MCP edit — so one `connect` pushed the entire tree (descriptions up to 4KB per node) through
MVCC/TOAST/WAL. Fix, in layers:

- **Schema** — `tree_nodes` / `tree_edges` / `tree_kinds`, one row per CRDT entry, PK-led by
  `tree_id`. Stamps as canonical HLC text; `present` computed by the writer so SQL never
  compares stamps. `trees.document` is legacy, backfilled to rows lazily on first load.
- **Port** — `TreeRepository::save` semantics became "upsert this slice"; signature unchanged.
  Safe because the lattice is entry-grow-only: a delete is a tombstone stamp, so a save never
  needs to delete a row.
- **Room** — dirty tracking for free: `applyCommand` already computes its broadcast delta and
  `joinSubgraph` receives one, so both just record the touched ids. `dirtyState()` exports only
  those entries (current values — the room is the single authority); `replay()` flips all-dirty.
- **Registry** — `persist`/`evict` save the dirty slice, `markClean()` after; the caller's
  strand makes export→save→clean race-free.
- Result: an edit's write cost is O(entries touched), not O(tree). `list_trees` also stopped
  parsing whole documents — it reads `(node_id, color) WHERE present`, the only columns the
  summary needs.

### Observations (structure / perf)

- **The graft path is the right home for imports.** `importTree` is ~8 lines because the CRDT
  framework already convergently joins a stamped slice. Using one stamp for the whole frame
  makes upsert semantics fall out of LWW — no special collision code in the domain, only a
  read-side collision *report* at the edge. Worth remembering: bulk = graft, not a mega-command.
- **`applyProgressBatch` unified three call sites** (single set_progress, bulk set_progress,
  import-carried progress) behind one strand-held read + one order-safe write. The single form
  is now just a 1-element batch — the old bespoke `writeProgress` body is gone.
- **Per-field CRDT fan-out is the tax on adding a node field.** description/links touched 7
  enumeration sites (seed, join, state-ctor, export, frontier, maskNode, nodeUncovered) plus 4
  JSON spots. A `for-each-field` visitor over `NodeRecord` would collapse these to one list and
  make the next field a one-liner — a good future refactor if node fields keep growing.
- **`prune` counting reuses diagnostics** (`dangling + selfEdges`) instead of re-deriving, so the
  reported count and the `PruneDangling` removal set come from the same definition of "junk edge".
