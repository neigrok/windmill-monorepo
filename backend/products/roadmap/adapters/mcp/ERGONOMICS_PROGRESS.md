# MCP ergonomics — build log

Executing the friction backlog. The nine items this file opens with came from
`backend/mcp-changes-graft.txt` (closed, kept as history); every awkward case found since goes
to the live ledger at the repo root, `mcp-changes.txt`. Each phase builds + tests + stages.

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

### Landed — the error contract, the node handle, and a quickstart resource

- **One home for refusals** — `ToolArgs.{h,cpp}`: `requireString` / `requireOneOf` /
  `requireNumber` / `requireObjects` / `optionalLinks` / `requireHandle`, each answering
  nullopt or the whole sentence, so a tool's contract reads as a fail-fast pipeline.
  `prepareEdit` in RoadmapTools states what every edit tool requires — the one place that
  contract is written down — and runs BEFORE `commandFromJson`, which stays a bare yes/no
  because `PgOpLog` replays through it.
- **The tool name is stamped once**, by `callTool`, on whatever `dispatch` refused with — which
  puts the tool on every message but is NOT what makes a message good. A stamp on a sentence that
  names nothing (`add_kind: that hue already belongs to another kind`) is still a sentence that
  names nothing, so the domain's own refusals were rewritten where the fact lives
  (`domain/Command.cpp`): `hue "sky" already belongs to kind "build"`. The same wrapper catches
  `std::exception`: a JSON-encoded object in `nodes[]` used to throw out of jsoncpp and kill the
  whole HTTP request with no status and no message.
- **`nodeId` is the node handle** on annotate/rename/set_node_color/move/delete/set_progress
  (and `progress[].nodeId`), with `id` kept as a silent alias (declared `deprecated`, since
  `additionalProperties: false` would otherwise have a strict client reject it). `id` now means
  only "the id I propose for a new node" — `create_node` refuses `nodeId` and says why.
- **Caps are published**: `maxLength` on every capped string (description 4000, label 200, icon
  64, ids 128, link url 2048, kind label 24 / description 80) and `maxItems` on `links` — a client
  can only pre-validate what the schema states, which was the whole 4000-character complaint.
- **`windmill://quickstart`** as an MCP resource (`resources/list` + `resources/read`, capability
  declared at `initialize`): edge direction, the handle law, never-refused, `set_progress` is
  advisory, the read projections, the caps. A test pins every tool it names against the catalog.

### Observations (structure / perf)

- **A message is a wire format.** Pinning error text in a test felt heavy until the first
  refactor: the assertions caught two messages that had quietly grown a second tool name and one
  that named an argument the schema does not publish. Errors deserve the same fixity as payloads.
- **jsoncpp's mutable `operator[]` CREATES what it probes.** `prepareEdit` reads through a const
  reference for exactly this reason — a create_node that merely asked whether `x` was present
  would otherwise have grown a position of {0,0} on every call. Any future validator that takes a
  mutable `Json::Value&` needs the same discipline.
- **Validation belongs where the vocabulary is published.** `kHues` / `kStatuses` now feed both
  the schema's `enum` and the check that refuses against it, so a legal set stated in one place
  cannot drift from the one enforced. The legend's caps went the same way: `kMaxKindLabelLength`
  (24) and `kMaxKindDescriptionLength` (80) live in `domain/Command.h:29-30` beside the node
  caps, and `domain/Command.cpp` refuses against those constants rather than a private copy.
- **`import_subgraph` grafts without the domain's `validate()`**, so it was the one authoring path
  where a 10MB description or an empty node id would have landed. Its item checks are now the only
  thing standing there — worth remembering if a second bulk path ever appears.

### The fix pass — what two adversarial reviews found by executing it

Tests: domain 302, adapters 201, mcp 80 — green locally and under the CI toolchain
(`docker build --target build`, gcc-11/Ubuntu Release, ctest 3/3).

- **A throw is not a refusal.** `resources/read` with `uri: []` terminated the stdio server —
  jsoncpp throws on `asString()` of a container, and nothing above `main` catches. Every string
  leaf the engine reads is now type-checked before it is read; two pre-existing siblings
  (`method` as an object, `tools/call` with an array `name`) went the same way.
- **Null is the third state a validator forgets.** `ToolArgs` reads a null as "not given";
  `commandFromJson` reads presence with `isMember`. Between them, `links: null` DESTROYED a
  node's links and `x: null, y: null` pinned a node at the origin. One loop in `prepareEdit`
  erases null members before the decode, so the payload now says what this layer believes it
  says — a fix that covers every future `isMember` in that decoder, not just the two we found.
- **A flag that admits strings is a flag that lies.** `dryRun: "yes"` performed a real import.
  The schema published `boolean`; the check accepted a string and treated everything but
  `"true"` as go-ahead. A preview is a promise not to write.
- **The domain owns the fact, so the domain owns the sentence.** Seven refusals reached agents as
  a tool name stapled to a sentence that named nothing (`add_kind: that hue already belongs to
  another kind`) while `legend.ownerOf(hue)` sat right there. Rewriting them in
  `domain/Command.cpp` — `hue "sky" already belongs to kind "build"` — cannot drift from the rule
  it describes, and fixes the REST path for free. Stamping was never the fix.
- **An oracle test that enumerates reads only proves reads.** Every write tool answered "this tree
  belongs to another account" for a private tree the caller cannot read, versus "no such tree" for
  an absent one — telling a stranger which private ids are real, on the surface `tree-visibility`
  shipped a byte-identical-denial promise for. The test now enumerates all 20 writes; that gap is
  why it survived.
- **Bytes vs codepoints, still deferred.** Every cap counts bytes while its message and its
  published `maxLength` say characters; they diverge only for non-ASCII. Both halves are now in
  one place (`domain/Command.h`), which is what a fix would need.

### Landed — reads that answer the question asked

The last wave made every *refusal* name the thing; this one makes every *answer* do it. All three
defects came from live use against production, not from reading the code.

- **`status` is served, and it is yours.** A declared `fields` value that silently returned
  nothing is the worst of the three possible answers — a caller cannot tell "this node has no
  status" from "this server does not serve that field". It now answers the caller's own progress
  overlay in `set_progress`'s own vocabulary (`active`/`complete`/`none`), on `get_tree` and
  `find_nodes` alike, **for every node** — an omitted key on an unmarked node would recreate the
  ambiguity it fixes. The overlay is read ONCE per call and only when `status` is asked for, so a
  200-node page pays one query, and the default projections are unchanged.
- **…and the document's baseline is a second fact under a second name.** `status` used to project
  `NodeSpec::status`, the inert authoring seed a demo/staged tree carries and every reader sees
  before their own marks. Two facts under one word would have converted into each other on a
  read-then-import round trip — a private mark published into a shared document, silently — so the
  seed is now `seedStatus` on both sides of the surface (a `fields` value; `import_subgraph`'s
  `nodes[].seedStatus`), and an imported node carrying `status` is refused by name.
- **`query` matches the id, and an exact id outranks a fuzzy hit.** Searching for a node by the
  handle you edit it by used to find everything except that node — and, worse, returned somebody
  else's node whose description merely mentioned the string, with `count: 1`. Matching and ranking
  are the same question, so both live in `selectNodes`: id + label + description, answered best
  first (exact id → id prefix → label → id substring → description-only), ties keeping the tree's
  order. Only the matches are sorted, never the tree, and the order is deterministic — which is
  what keeps a `cursor` minted on one page valid on the next.
- **`diagnosticsClean` is now attributable.** Every edit also answers `introducedDiagnostics`: the
  errors present after it that the tree did not hold before, named endpoint by endpoint
  (`dangling edge "a" -> "ghost"`, `cycle among "a", "b"`, `self-edge on "a"`), capped at five with
  a count and a pointer to `get_diagnostics`. Both keys always, `[]` for an innocent edit.

### Observations (structure / perf)

- **A before/after bracket beat the clever local rule.** The contract proposed deriving
  attribution from the command's own endpoints — cheap, and unsound: `delete_node` dangles every
  edge incident to a node it never names, and a graft touches everything at once. Because the room
  holds the tree's strand for the whole of an edit, `diagnose()` on each side of `applyCommand`
  brackets exactly one write, so the difference IS the edit's doing — no command taxonomy, no
  shape left out, and the honest version turned out shorter than the clever one. The cost is one
  extra O(V+E) pass per edit; if that ever bites, the fix is an incremental diagnostics model in
  the room, not a per-command rule.
- **A word that means two things is a bug waiting for a round trip.** `status` was the caller's
  mark on the write side and the document's seed on the read side. Nothing failed — a copy loop
  would just have quietly turned one into the other. The fix that mattered was naming the second
  fact (`seedStatus`), not serving the first.
- **Ranking belongs with matching.** Splitting them would have left the domain deciding *whether*
  a node matches and the adapter deciding *why* — and "why" is what a rank is. `selectNodes` now
  answers both, and `find_nodes` stayed a one-line call.
- **`find_nodes`' pagination survived ranking for one reason only:** the cursor names a node, not
  an offset, and the order is a pure function of (tree, filter). Any future rank fed by something
  outside that pair (recency, a per-caller signal) would break resume, and would need the cursor
  to carry the rank with it.
