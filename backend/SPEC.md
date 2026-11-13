# Roadmap tree engine — spec

The collaboration engine behind the roadmap product: the loose-graph domain, the CRDT lattice
that syncs it, the HTTP and socket surfaces, and the tables underneath. Code lives in
`products/roadmap/`.

Other references: `AUTH.md` (sign-in) · `AUTHZ.md` (authorization) · `RUNNING.md` (local run) ·
`db/schema.sql` (schema) · `CLAUDE.md` (build, pool, CI).

## Model

A tree is a **loose graph**: a node set and a prerequisite-edge set that permits cycles,
self-edges and edges to absent nodes. Every write merges into it; graph writes are never
rejected for structure. Validity is a read model, not a gate.

- `LooseGraph` — the authoritative state. Nodes are `NodeRecord`s (an `ElementSet` life plus LWW
  registers: label, icon, color, order, position, status, description, links, opens); edges are an
  `ElementSet` per `(from, to)`.
- `opens` — a node's pointer at another tree: that tree's id, or empty for none. A document node
  carries it as `opens` and omits it when empty; a lattice entry carries `opens` and `opensAt`. The
  room, the socket and `PUT` hold a write to the id length and to nothing about its target, so a
  pointer may name a tree that is absent, deleted or someone else's. The MCP door is stricter: every
  non-empty `opens` a `create_node`, `update_nodes` or `import_subgraph` call carries must name a
  tree that stands and is the caller's (`TreeRepository::titlesOwnedBy`, one read for
  the whole call), or the call is refused with nothing written, in one sentence for a tree that is
  not there and for someone else's. That read is made before the tree's strand is taken, so an edit
  racing the target's removal can still set a pointer at it, which then points nowhere. A node may
  open the tree it is in. A tree id is the read capability of an unlisted tree, so only a caller who
  can write the tree receives the pointer: `readerView` (`domain/Subgraph.h`) is what every other
  reader gets from `GET /v1/trees/{id}` (`data` and `state`), the subscribe delta and a live frame —
  a document node without `opens`, a
  lattice entry with `opens` empty and `opensAt` unset, and no entry for a node the frame then says
  nothing about. MCP `get_tree`, `get_nodes` and `find_nodes` answer it when `fields` names `opens`,
  as `opens: {treeId, title, state}`, to a caller who can write the tree and only while the opened
  tree stands and is theirs; the key is omitted otherwise.
- `OpenedTrees` (`domain/OpenedTrees.h`) — an owner's standing trees under the owner's marks, judged
  once. A pointer is valid when its target stands and belongs to the owner of the tree the node is
  in. For a caller who can write the tree, a node with a valid pointer is complete exactly when the
  opened tree is complete for them, whatever its own prerequisites, as a mark made out of order is;
  until then it is locked or available by its prerequisites, and a mark stored on it is kept and
  ignored. A tree is complete for a reader when it holds at least one node and every node is
  complete: a node with a valid pointer by its tree, any other node by the reader's mark.
  Completeness is the least answer that satisfies this over all the owner's standing trees, one
  answer per owner whichever tree is being read: a tree on a loop is never complete, however long
  the loop, a chain of any length completes, and a tree reached along two ways is judged once. It is
  computed by one pass that walks each tree-to-tree pointer at most once. `completedAt` is the
  latest mark, by stamp, in what completed a tree: of the owner's complete marks on its nodes that
  follow no tree and, for each tree its nodes follow, of what completed that one. It is found in
  that same pass and carries the instant that mark was recorded; a mark a node holds beside a
  valid pointer completed nothing and is not among them, and a mark stored with no stamp (empty or
  `0:0:`) counts toward completion and never toward `completedAt`, which a tree completed by such
  marks alone does not have. `followed` gives a
  tree's completed set — marks on ordinary nodes, plus the nodes whose opened tree is complete —
  that `UnlockRules::derive` and `treeStats` are handed, so MCP `state`, the `state` filter, the
  registry counts (`GET /v1/trees`, `list_trees`) and reminder readiness agree. `openings` says
  what each pointer of a tree comes to: `missing` for one that is not valid, else the opened tree's
  title, whether it is complete and `done` of `total` (its present nodes, those complete for the
  reader); `leadingBackTo` names the trees whose pointers lead to a tree, at any distance. A node
  whose pointer is not valid is an ordinary node, and so is every node for a reader who cannot write
  the tree: their state follows their own mark, and nothing they receive says a node opens a tree.
  `diagnose` says what is wrong with a tree's pointers (`PointerDiagnostics`), each list in node id
  order. `treeLoops` holds one entry per node whose pointer leads back to the node's own tree, with
  a shortest way back: each tree on it with its title, the tree the node opens first and the node's
  own tree last — one entry, that tree, for a node that opens the tree it is in — and the smaller
  tree id wherever two ways are as short, so the way does not depend on the order the trees are
  visited in. `danglingPointers` holds one entry per node whose pointer is not empty and not valid,
  with the pointer as it is stored. A loop among other trees that does not lead back to the tree
  is not that tree's: it is reported when one of those trees is read. The answer is bounded where
  it is made: each list holds its first 50 nodes (`kMaxTreeLoops`, `kMaxDanglingPointers`) and
  counts the rest in `treeLoopsOmitted` and `danglingPointersOmitted`, and a way of more than 8
  trees (`kMaxLoopPath`) is cut to its first 8, so it does not end with the node's own tree, with
  `pathOmitted` counting the trees left off, that tree the last of them. What is past a cap is
  counted and never built. `waysBackTo` is the walk under it and under `leadingBackTo`: from the
  tree up its openers a level at a time, it reads each pointer between two standing trees at most
  once and leaves every tree that leads back its fewest pointers and the tree it steps to first,
  so `diagnose` costs the account's pointers plus the capped lists, whatever the tree holds.
  The raw mark (`status`, `get_progress`, and `GET …/progress` for a caller who can write the tree)
  stays the raw mark; every other reader of `GET …/progress`, and the gallery, are shown the
  owner's marks through `readerView`. `get_progress` answers the caller's own marks on the nodes the
  tree holds alone (`Progress::restrictedTo`): a mark on a deleted node stays stored, shows again on
  a revive, and still reaches the socket's overlay graft and, for a caller who can write the tree,
  `GET …/progress`, which serve the stored marks.
- `readerView` (`domain/OpenedTrees.h`) — an owner's stored marks on a tree as a caller who cannot
  write it is shown them: the owner's derived completion, and nothing of the trees its nodes open. A
  node with a valid pointer has a row only while the tree it opens is complete for the owner, by the
  completeness `followed` reads, and none otherwise, whatever mark it holds. That row is `complete`
  and never `outOfOrder`. It is the node's stored mark when that says complete under a stamp; else
  its time is the later of the opened tree's `completedAt`, with the instant that mark was
  recorded as `markedAt`, and the stamp the node's pointer was set under, with that stamp's own
  milliseconds as `markedAt`. So the time never predates the pointer and never comes from a mark
  with no stamp, and a twin whose same steps were marked by hand at those stamps answers the same
  bytes. Every other node's row is the stored one, so a step that opens a tree that is not complete
  reads as a step nobody marked. `OwnerProgress::shownToReaders` feeds it for the two doors that
  serve an owner's marks to such a caller, `GET /v1/trees/{id}/progress` and the gallery. The
  pointers, each with the stamp it was set under, come from the tree's room, or for the gallery
  from the listed documents. Each owner whose trees hold a pointer is followed in one `openedFrom`
  read under a 750 ms budget (`kReaderFollowBudget`) after the strand is released, and trees that
  hold no pointer make none. The gallery follows its owners in the order the wall shows their cards
  as far as it is known before their marks are — by forks, then the tree's own last edit, then
  tree id — and spends at most 1,500 ms on follows in all (`GalleryApi::kFollowCap`): an owner the
  cap cuts short or never reaches is shown unread for that view alone. When an owner's read fails or
  runs its whole budget, the door still answers, leaving out the row of every node of that owner's
  that holds a pointer, so no step is shown done that may not be, and every other owner is followed
  as ever. That owner then cools off: for five minutes (`kFollowCoolOff`) every door shows them
  unread at once without trying, and the first follow after it that answers ends it. The cool-offs
  live in the process's memory, keyed by owner, at most 1,024 of them (`kMaxCoolingOff`), the one
  begun first let go to make room.
- A node with a valid pointer takes no mark from a caller who can write the tree. The room hands
  that caller, and nobody else, the nodes that open a tree (`TreeRoom::pointersFor`); `following`
  names the ones whose pointer is valid, and `ProgressService::mark`, which both doors that write
  progress call, leaves a mark on one of them, `complete` or `none`, out of the write and answers it
  refused under the code `opens-a-tree`: MCP `update_nodes` and the `progress[]` of an
  `import_subgraph` say so (`adapters/mcp/README.md`), and a socket `progress` frame's ack lists it
  (WebSocket surface). The other marks of the call are recorded, and each `prerequisitesMet` is
  judged on the `followed` set, so a step behind such a node is met when the opened tree is
  complete, whatever mark the node holds. A mark such a node already held stays stored until the
  node is deleted, when it is cleared as every mark of the caller's on what a delete removes is. From
  a caller who cannot write the tree the same mark is an ordinary one: recorded, answered exactly as
  on a node that opens nothing, and judged on their own marks.
- The domain is fed two ways. A read of one tree (`get_tree`, `get_nodes`, `find_nodes`,
  `GET /v1/trees/{id}`) takes the tree from its live room, a progress write (`update_nodes`, the
  `progress[]` of an `import_subgraph`, a socket `progress` frame) only its nodes that open a tree,
  and each asks `TreeRepository::openedFrom(owner, opened)` for each tree it opens that stands and
  is the owner's and every such tree their pointers lead to: one statement over `trees`,
  `tree_nodes` and the owner's `node_progress` that reaches each tree once and answers, per tree and
  tree it opens, how many present nodes open it, how many of those the owner marked and the latest
  of those marks, beside the tree's title and its nodes that open none. Each reached tree's nodes
  are read through `tree_nodes_pkey`, and the owner's marks on it through an index that leads with
  both the tree and the reader (`node_progress_pkey`, or `node_progress_user_tree`, whichever the
  planner takes), so the cost follows the trees reached and the owner's marks on them, and not the
  size of the tables or other accounts' marks on the same trees. It is made once per reply, call or
  frame, after the tree's strand is released, and not at all for a read whose fields ask for neither
  `state` nor `opens`, for a write with no mark to judge, or for a tree that holds no pointer. On
  these doors a caller who cannot write the tree causes no such read; the two doors that show such a
  caller the owner's marks make it as `readerView` says. The tree's diagnostics (`get_diagnostics`,
  `GET /v1/trees/{id}/diagnostics`) make the same read for `OpenedTrees::diagnose`: once per reply,
  after the strand is released, for a caller who can write the tree and a tree that holds a pointer,
  and not for an MCP call that sends `includePointers: false`; under the strand they take the tree's
  pointers alone (`LooseGraph::pointers`). An MCP edit that changes the tree a node opens to a tree
  (`create_node`, `update_nodes` or `import_subgraph`) makes it once
  more, after the edit is saved and the strand is released, starting from the trees those nodes now
  open (`pointersSetSince`) and under a budget of its own, 750 ms, in place of the pool's statement
  limit: its receipt names in `introducedDiagnostics`, after the graph's errors and within that
  list's five lines, each of those nodes whose tree leads back, and a read that runs past the budget
  leaves the receipt `pointerDiagnosticsUnavailable: true`. No other edit makes that read: a dry
  run, an edit that only clears a pointer and one that re-sends the tree a node already opens among
  them. Where every tree of an owner is already loaded with its marks (`TreeRegistry::list`,
  `PgReminderRepository::readinessFor`), `openedAmong` (`domain/TreeSummary.h`) judges the account
  once in memory with no further read.
- `TreeDiagnostics::assess` — a pure report over a loose graph and its legend: `cycles`, `dangling`,
  `selfEdges`, `smells`, `maskedWork` (tombstoned parents with present children). `clean()` is
  true when cycles, dangling and self-edges are all empty. Smell kinds: `label-too-long`
  (> 256 bytes), `empty-icon` and `high-in-degree` (> 4), one line each for every node they cover;
  `unclaimed-hue`, one line per hue present nodes wear that no kind does, with that `hue`; each line
  the `count` of its nodes and the first ten of them (`CountedNodes`), so the smells stay a few short
  lines whatever the tree's size; and `empty-legend`, one line naming no node for a tree with nodes
  and no kind, in place of the hue lines. It reads one graph and its legend, and no pointer: a loop of
  trees and a dangling pointer (`PointerDiagnostics`) are reported beside it, as smells are, and
  change neither `clean()` nor what it gates — the `SkillTree` projection and a receipt's
  `diagnosticsClean`.
- `SkillTree` — the validated projection, constructible only from a clean graph; it throws
  `InvalidTree` on a duplicate id, a dangling prerequisite or a cycle. Indexes the DAG, the topo
  order, ancestry and the render model.
- `Legend` — up to 6 kinds per tree, one per hue, sorted by `rank` then id. A tree created with no
  kinds is seeded with three: build · learn · milestone. A PUT omitting kinds on an existing tree
  preserves its legend.
- `title` and `guide` — the tree's own LWW text registers, beside its graph and legend. The title
  names the tree. The guide is one plain-text note the owner writes on what the tree is and how to
  work it, for agents and for people; an empty guide, or one of only whitespace, is no guide, and a
  guide a fork copied from someone else's tree stays its author's words until the owner writes one.
  Nodes carry no part of it.
- `guides` (`domain/Guides.h`) — guides add: one tree holds the method, each tree worked under it
  adds what is particular to it, and none overrides another. A tree P is directly above a tree T
  when a present node of P holds a pointer at T and both stand and belong to one owner. Above is
  that relation followed upward within 8 pointers, each tree at its shortest distance, and a tree is
  never above itself, whatever loops exist. Only the reader's own trees count: for a caller who
  cannot write the tree being read, nothing is above it. `guidesFor` answers what a reading of a
  tree carries as `guides`, each entry `{treeId, title, text, yours}`: the guides of the trees
  above, farthest first and by tree id within one distance, then the tree's own guide last. A tree
  whose guide is empty is left out, the tree's own included; each tree appears once; and past 8
  entries the farthest are dropped, so the nearest trees and the tree's own guide keep their
  places. Where that cut falls inside one distance the smaller tree ids are kept, ids compared as
  bytes. `yours` says the reader owns that tree and wrote its current guide. The trees above come
  from `TreeRepository::guidedTreesAbove(owner, tree)`, which answers the 8 nearest that carry a
  guide by that same rule (`nearestGuided`), so a reply never loads a guide it cannot keep. It is
  one statement keyed on the owner's own standing trees: it reads the trees each of them opens
  through `tree_nodes_pointers_idx`, keeps the pointers at another of the owner's standing trees,
  walks those upward from the tree, a tree once per distance and no further than 8 levels, and
  reads the title and guide of the trees it keeps through `trees_pkey`. Its cost follows the
  owner's own trees and the pointers among them, whichever tree is read, and does not grow with
  the pointers other accounts plant at a tree. It is made once per reply that answers the guides
  above, after the tree's strand is released, and not at all for a caller who cannot write the
  tree, who is answered the tree's own guide alone.

Derived read models:

- `UnlockRules::derive(nodes|tree, progress) → map<NodeId, NodeState>` where `NodeState ∈
  {locked, available, complete}`. It reads only nodes and prerequisites, so it also runs
  over a graph `SkillTree` would refuse: a prerequisite naming no node locks its dependant, and a
  cycle locks every member. The completed set it is handed is the reader's marks, or for the
  tree's owner `OpenedTrees::followed`.
- `TrunkTree` — elects one trunk parent per node (same-kind parents win, then shallowest, then
  smallest id) and derives branch root, trunk depth, leaf weight, and `EdgeKind ∈ {trunk,
  in_branch, cross_branch}`.

`NodeColor ∈ {terracotta, olive, gold, brick, sky, plum}`.

The server never computes layout and never renders. Positions are authored nudges it stores and
serves; geometry is entirely client-side.

### Progress

Private, per user, per tree — outside the lattice and outside the op log. A `Progress` holds a
`ProgressMark {status, at, markedAt, outOfOrder}` per node plus the projected `completed` /
`cleared` sets; `record` is the only way in, so the sets cannot drift from the registers.
`ProgressStatus ∈ {none, complete}`; **`none` is a value, not a row delete**, so a clear
converges across devices and a stale mark cannot resurrect it. `markedAt` is the server clock at
the moment the mark was recorded and is the only instant a reader may date a step by; the HLC
beside it orders writes and is never served back as a time.

Compatibility inputs `active` and `inProgress` normalize to `none` in progress and authored seeds.

One status per node is structural. "Complete only when every prerequisite is complete" is
advisory: the mark is recorded either way and the outcome reports `prerequisitesMet` so a surface
can warn. It reads the completed set `UnlockRules::derive` is handed: the caller's marks, or for the
tree's writer `OpenedTrees::followed`. `outOfOrder` is the marker's word that the inversion was
meant; it is part of the status value under the same stamp, so a later mark on the node carries its
own word or none. Only an MCP mark sets it — an `update_nodes` row or an `import_subgraph` progress
row; a socket `progress` frame lands it false. Progress therefore never depends on the tree being a
valid DAG.

## Convergence

All traffic flows through the server: one convergent lattice per tree, with the room as sequencer.
Replicas never merge with each other.

- **LWW register** (`Lww<T>`) — highest HLC wins. HLC text is `physicalMs:counter:actor`; the
  unset sentinel is `0:0:`.
- **Element set** (`ElementSet`) — add-biased: present iff added and no strictly-later remove
  cancelled it. A tie between add and remove favours add.
- **Join** — `LooseGraph::join(GraphState)` folds a partial state entry by entry, field by field.
  Absence at every granularity (missing entry, missing field, unset stamp) means "no information",
  so a join only ever adds. Commutative, associative, idempotent.

### Subgraph frames

Clients author `Subgraph` frames, not commands. A frame is a partial, stamped slice of one
tree's lattice: `{treeId, frameId, actor, intent, title?, guide?, graph, legend, gestures[], coverage?}`.

`SubgraphIntent`:

| Intent | Meaning |
| --- | --- |
| `live` | one gesture, sent now |
| `flush` | a coalesced offline session |
| `delta` | anti-entropy against a stated vector — the only intent carrying `coverage` |
| `graft` | state joined for its own sake (files, imports, device handoff); never advances coverage |

A `VersionVector` is the greatest stamp seen per actor, keyed by actor string. `frontier(graph,
legend)` folds a full state into one, and `frontier(frame)` every stamp one frame carries, its title
and guide included; `deltaBetween(graph, legend, since)` returns the slice a peer at `since` lacks,
with covered fields masked back to "no information", carrying the sender's full frontier as
coverage. `TreeRoom::deltaSince(since)` adds the title and guide registers the peer does not cover.
A frame's `title` or `guide` is null or absent for no information, or `{v, at}` with a string `v` and a
set stamp `at`; any other shape makes the frame `bad-frame`, so no value is coerced or read as a clear.

`TreeRoom::joinSubgraph` dedupes on `frameId`, folds the frame's stamps into the room clock,
joins graph + legend + title + guide, assigns the next `seq`, queues a headline deed for the op log,
and broadcasts the frame to subscribers. A frame that sets only the title or the guide has no
headline deed, so it leaves no `tree_ops` row and no activity entry. Duplicates return no seq. A broadcast carries the room's `seq` and always
states `intent: live`, whatever intent the frame arrived with — echoing a `flush` would make every
subscriber treat it as a re-baselining graft.

### Commands

`Command` is the server-and-agent-side write path (MCP, tending, imports); it rides the same op
log, undo and broadcast machinery, and `TreeRoom::applyCommand` emits its writes as one subgraph.
`CreateNode` and `AnnotateNode` carry the tree a node `opens` as an optional: unset leaves the
pointer, set writes it, and `""` clears it. MCP `create_node` always sets it, `""` when the call
names no tree, so a created node opens the tree its call names and no other, on an id a deleted node
held too; a stored `CreateNode` row without the field replays as unset. An `import_subgraph` graft
(`graftState`) holds a node it brings back from a delete to the same rule: `opens` left out of the
batch is cleared there, where every other register left out keeps what the node held, and on a node
the tree holds a left-out `opens` stays as it stands. The activity feed projects
neither the pointer nor `AnnotateNode`.
`TreeRoom::applyCommands` lands several as one frame under one seq and queues them as one `Batch`
op, so replaying the log tail reproduces the whole edit; an empty list mints nothing.

A room never writes the op log itself: each write queues its row (`pendingOps`), and
`RoomRegistry::persist` — the step every write path takes before it answers — saves the lattice at
the room's head first and appends the queued rows after (`landPendingOps`). A crash between the
two leaves a lattice at `N` with no row at `N`: replay is a no-op and the feed misses one deed. A
row the lattice cannot back cannot be written. An append that fails is logged and never surfaced:
the lattice is durable, so the write answers as applied and the socket still acks; the rows stay
queued for the next persist, and `tree_ops` is unique on `(tree_id, op_id)`, so a row that
committed before its connection dropped lands once. Only a room closing — `evict` after its save,
`retire`, shutdown — drops queued rows, and the room's teardown logs
`N op rows for <tree> never landed`.

`RenameNode` · `SetNodeColor` · `RepositionNode` · `CreateNode` · `AnnotateNode` · `AddEdge` ·
`RemoveEdge` · `ReconnectEdge` · `DeleteNode` · `TransitiveReduction` · `PruneDangling` ·
`RenameKind` · `DescribeKind` · `AddKind` · `RemoveKind` · `ReorderKinds` · `RecolorKind`.

- `DeleteNode` is a plain tombstone. The record and every field survive so the node can be
  resurrected; its edges stay in the document and are filtered from the derived DAG view. A child
  that loses its only live parent becomes a root — visible as `maskedWork`, never re-tethered.
- `TransitiveReduction` and `PruneDangling` are written by nothing. A row of either that the log
  holds decodes and replays as nothing: a row is logged only after the lattice holding its effect is
  saved, so a replayed tail holds no such row. The Activity feed still tells a past
  `TransitiveReduction`.
- A `DescribeKind` without a description sets nothing: it replays as nothing and the feed skips it,
  alone or inside a `Batch` whose other members it tells.
- `RecolorKind` is atomic: it swaps a kind's hue and repaints every node wearing the old hue.
- `validate(graph, legend, command)` runs at the edge. A graph command is refused only for a
  malformed or over-cap field, or — `RenameNode` · `SetNodeColor` · `RepositionNode` ·
  `AnnotateNode` — an id no present node carries (`no node in this tree is named "x"`), so no
  edit plants a phantom. Legend commands may be refused — hue uniqueness, ≤6 kinds, no in-use
  removal, length caps are all locally decidable on the authoritative state.

### Bounds

Declared once in `domain/Command.h` and published as `maxLength` by the MCP surface. Every length
is counted in characters — Unicode code points, `codePointCount` — never bytes, and a refusal
names each field over its cap and by how much. Text that is not valid UTF-8 (an overlong form, a
surrogate, a code point past U+10FFFF, a lone or missing continuation byte) is refused at the same
door with `<field> is not valid UTF-8` — `isValidUtf8` runs before any cap is counted, on every
field including ids and edge endpoints, so a byte sequence Postgres would reject never reaches a
live room. A NUL, which a Postgres text value ends at, is refused the same way with `<field>
contains a NUL character`, so a room never holds text its row would cut short. The MCP surface adds two byte budgets on top: a `get_tree`/`find_nodes` page carrying
`description` ends at 4 MB of serialized nodes (the reply says `pageBytes` beside `nextCursor`),
and one `import_subgraph` call carries at most 6 MB of description text, under the 8 MB HTTP body limit.

| Bound | Value |
| --- | --- |
| id length | 128 characters |
| node `opens` | 128 characters (a tree id) |
| node label | 200 characters |
| icon token | 64 characters |
| node description | 16000 characters (an `AnnotateNode` append is held to the joined body) |
| links per node | 32 (label 200, url 2048 characters) |
| present nodes per tree | 10000 |
| present edges per tree | 20000 |
| tree title | 200 characters |
| tree guide | 5000 characters |
| legend kinds | 6 (label 24, description 80 characters) |

`validate()` judges a single command; `admit()` judges arrivals that mint no command — a posted
document, an MCP graft, a client lattice frame. `admit` returns `Admission{verdict ∈ {tooLarge,
malformed}, reason}`; an HTTP door answers 413 for `tooLarge` and 400 for `malformed`. Caps are
asked against what the graph would **hold** once the arrival lands, joined not estimated.

## Runtime

One `TreeRoom` per open tree holds the lattice, the legend, the title and guide registers, the room
clock and the head `seq`, and runs under a single strand — one thread mutates it at a time. `RoomRegistry`
opens rooms on demand, hands out `strandFor(treeId)`, persists (`persist`) and evicts idle ones.

Rules:

- Hold the tree's strand across mutation and persistence; `RoomRegistry::persist` releases its
  room-map mutex before database I/O. Never hold two strands at once: they are a fixed stripe array
  shared by unrelated tree ids.
- `accessOf(treeId)` answers authorization from the stored row; ask it **before** `open()`, which
  drags the whole lattice off disk and pins it.
- Persist before acking, so an ack attests durability. Within a persist the lattice is saved
  before the op rows are appended, so the log never runs ahead of the lattice. A save onto a row
  that is gone or soft-deleted writes nothing and `persist` answers false; the socket's `subgraph`
  frame, the guide and a live rename then answer as for an absent tree and retire the room.
- `open()` loads the stored lattice and then replays the op-log tail past the stored head, so the
  room reaches the true state and head and new writes never collide on `seq`. Under the save-then-
  land ordering that tail is empty; it is read for trees saved before the ordering held.
- The room clock mints a unique `(ms, counter)` per write, so writes to one tree are totally
  ordered and the actor tiebreak is moot. It observes loaded and replayed stamps before minting;
  `AppliedOp.actor` records authorship independently of the clock actor `srv`.
- Sparse persistence: `dirtyState()` exports only entries dirtied since `markClean()`. `replay()`
  flips the room to all-dirty.
- Tree content reads use the room; the registry list reads persisted rows without opening rooms.
  Forks snapshot the source room's graph, legend and guide, clear authored progress baselines, and
  start a fresh op log with `forked_from` provenance. A fork of the forker's own tree keeps every
  `opens` as it stands; a fork of anyone else's, or of nobody's, clears them all. Every present step
  is added to the fork afresh:
  a stamp from the source room's clock, one counter tick apart in creation order, so a step's
  creation stamp is when it joined this tree and sibling ties keep their order. The fork's title and
  guide take the first of those stamps, so a fresh subscriber's delta carries them beside the steps,
  and any later write of the new owner's outranks them. A copied guide with text the forker did not
  write — the source is someone else's or nobody's, or its own guide is still inherited — is marked
  inherited (`trees.guide_inherited`): its author's words, which MCP `get_tree` answers `yours: false`,
  until a guide of the new owner's lands over it through any door. A fork of the forker's own tree
  keeps its guide theirs. A save carrying the copy's own stamp leaves the mark; a restart reads it back.

## Authorization

Read: `canRead(caller, owner, visibility)` — `private` is owner-only; `unlisted` and `public` are
readable by anyone holding the id. `parseVisibility` fails closed to private. New trees are
private.

Write: `canWrite(caller, owner)` — a tree is its owner's to change and nobody else's. An unowned
tree is readable by the world and writable by no one. `WriteRefusal ∈ {notYours, nobodysTree}`;
clients branch on the code, humans read the sentence.

`unlisted` vs `public` is consent, not permission: `public` admits the tree to the gallery and
lets its share page be indexed.

Absent and private-denied answer identically on every surface — no existence leak.

## HTTP surface

Registered in `products/roadmap/routes.cpp`.

| Method | Path |
| --- | --- |
| POST · GET | `/v1/trees` |
| GET · PUT · PATCH · DELETE | `/v1/trees/{id}` |
| POST | `/v1/trees/{id}/fork` |
| GET | `/v1/trees/{id}/progress` |
| GET | `/v1/trees/{id}/guides` |
| GET | `/v1/trees/{id}/diagnostics` |
| GET | `/v1/trees/{id}/activity` |
| PUT | `/v1/trees/{id}/og-image` |
| PUT · GET | `/v1/trees/{id}/og-video` |
| POST | `/v1/trees/{id}/tend` |
| GET | `/v1/tend/{runId}` |
| GET | `/v1/tending` |
| GET · PATCH | `/v1/reminders` |
| POST | `/v1/reminders/pause` |
| POST | `/v1/reminders/unsubscribe` |
| POST | `/v1/admin/reminders/sweep` |
| POST | `/v1/compose` |
| GET | `/v1/gallery` |
| GET | `/gallery` |
| GET | `/t/{id}` |
| GET | `/og/{id}.png` |

Single edits have no REST endpoint — they ride the socket; `PUT /v1/trees/{id}` takes a whole
document and joins it as one write. A PUT that creates the tree stamps its steps at the moment of
creation, as `POST /v1/trees` does. A PUT into a standing tree replaces the stored row of every step
and edge it carries with the genesis stamp: those steps take the document's fields over any live edit
and read as unknown creation time. No client calls this door. Inbound models are suffixed `Request`, outbound `Response`.

`GET /v1/trees/{id}` answers `{seq, data, state, createdAt, visibility, mine}`. When the caller can
write the tree the body also carries `opens`, an object keyed by node id with one entry per node
that holds a pointer: `{treeId, title, state, done, total, loop}` for a valid one, `state` being
`"complete"` or `"open"` and `loop` true when the opened tree leads back to the tree being read, and
`{treeId, missing: true}` for one that is not valid (`OpenedTrees`, Model). It is computed on the
read, off the stored rows and after the tree's strand is released, and nothing pushes it; for any
other caller the key is absent. When the pointers cannot be followed the owner is answered
`503 opens-unavailable`, not the `404` of an absent tree. No other reader's answer depends on that
read, and for a tree that holds no pointer it is not made: `opens` is `{}`.

`GET /v1/trees/{id}/guides` answers `{guides}` (Model), an array of `{treeId, title, text, yours}`.
A caller who can write the tree is answered the guides of their trees above it, farthest first,
and the tree's own last, read off the stored rows after the tree's strand is released; when the
trees above cannot be read they are answered `503 guides-unavailable`. Any other caller who can
read the tree is answered its own guide alone when it has one, `yours: false`, and nothing is read
for them. An absent tree and one the caller may not read answer the `404` the tree route gives.
The tree route carries no guides and never makes that read.

`GET /v1/trees/{id}/diagnostics` answers the graph's diagnostics, `{cycles, dangling, selfEdges,
smells, maskedWork}` (`TreeDiagnostics`, Model), to every caller who can read the tree. A caller who
can write it is also answered `treeLoops`, an array of `{node, path: [{treeId, title}]}`, and
`danglingPointers`, an array of `{node, treeId}` (`PointerDiagnostics`, Model), read off the stored
rows after the tree's strand is released; both are `[]`, with nothing read, for a tree that holds no
pointer. When the pointers cannot be followed the owner is still answered `200` with the graph's
diagnostics, without those two keys and with `pointerDiagnosticsUnavailable: true`, a key that is
otherwise absent. Each list holds its first 50 nodes and a `path` its first 8 trees;
`treeLoopsOmitted`, `danglingPointersOmitted` and a loop's `pathOmitted` count what is left off and
are absent when that is nothing, and a path that is cut does not end with the tree being read
(`PointerDiagnostics`, Model). Any other caller is answered the graph's diagnostics alone, the same
bytes a tree without pointers answers, and nothing is read for them.

`PATCH /v1/trees/{id}` sets one register per call — `{visibility}`, `{guide}` or `{title}` — each the
owner's alone. A body naming more than one is refused `400`, and a body that is not one JSON object
`400 invalid json body`. A guide past 5000 characters, not valid UTF-8 or carrying a NUL is refused
`400` with the admission's sentence, and an empty one clears it, as one of only spaces, tabs and line
breaks does (stored as `""`); a real guide keeps its leading and trailing spaces. A title carrying a
NUL is refused `400` too. The guide's writes are this, the socket's `subgraph` frame and MCP
`update_tree`; a posted document (`POST`, `PUT`)
never sets it, and a tend is not offered `update_tree`. `GET /v1/trees/{id}` carries it as `data.guide` beside `data.title`, MCP `get_tree` as
`tree.guide: {text, yours}` on every page and no other MCP read at all, `yours` true when the caller
owns the tree and wrote its current guide. A fork copies it, marked inherited when it is someone
else's words (Runtime). The share page
and the gallery do not show it. `guides` (Model) is answered by `GET /v1/trees/{id}/guides` and by
MCP `get_tree` as `tree.guides` on the first page alone (a call without `cursor`), unless the call
sends `includeGuides: false`, which leaves the key out and makes no read. When the trees above
cannot be read, `get_tree` still answers: `tree.guides` holds the tree's own guide alone and
`tree.guidesAboveUnavailable` is `true`, a key that is otherwise absent. A tend's `get_tree`
carries `tree.guide` and no `guides`, and reads no tree above the tended one.

`POST /v1/trees/{id}/tend` runs only on a tree its caller can write, since the run writes as its
caller. A tree it cannot is a persisted refused run, answered `200` like every tend refusal and started
on no work: `no-such-tree` for an absent tree and a private one alike, `not-yours` or `nobodys-tree`
for one the caller may read.

A tree id is `t_` plus 16 lowercase hex characters (`wellFormedTreeId`); a client-supplied id
(claim-create, fork) must match byte for byte.

`POST /v1/trees` accepts initial `TreeData` plus an optional client-minted `id` and returns
`{treeId, existed}`. The initial steps share one stamp at the moment of creation; the legend takes
the genesis stamp, byte-equal to a device-born tree's. Retrying an owned existing ID returns `existed: true`. Another account's ID
returns `409 id-taken`; the caller's deleted ID returns `409 id-retired`. A client must not retry
that deleted tree under a fresh ID.

`GET /v1/trees` answers the caller's own standing trees, newest activity first, each row `{id, title,
total, done, createdAt, updatedAt, dominantKind?, openers}`. `openers` names the caller's other
standing trees with a present step whose pointer names the row's tree, `[{treeId, steps}]` in tree id
order, `steps` counting those steps; the tree's own pointers at itself go with it and are not among
them, and it is `[]` when nothing opens the tree. It is what a removal would take with the tree, and
it is judged from the trees the list already holds (`OpenedTrees::openersOf`), with no further read.
MCP `list_trees` answers the same rows without `openers`, each with its `url`.

`DELETE /v1/trees/{id}` removes a tree and, with it, the steps that open it in the caller's other
trees: an opened tree goes as a node does. First, with no strand held, the caller's standing trees
other than this one that hold a present step opening it are read in one statement
(`TreeRepository::treesOpening`, keyed on the caller's own trees and reading each one's steps through
`tree_nodes_pointers_idx`, so pointers other accounts plant at the tree are never read; for a tree
that is not the caller's it answers none). When that read fails nothing is removed and the delete is
refused `503` with code `cascade-unavailable`, which the caller may retry. Then, under the tree's
strand, the read gate, the owner check, the soft-delete and the room's retirement run in that order;
a step pointed at the tree between the read and the soft-delete is not among those read, and points
nowhere. Once that strand is released, each tree read, in tree id order and under its own strand
alone, has its steps that open the tree deleted as MCP `delete_node` with `prune: true` deletes nodes
(`NodeEdits::deleteNodes`): one op under one seq, broadcast to its open pages, the edges they dangle
removed with them and the caller's marks on them cleared, a closed tree opened for it and saved before
the next. The read and every tree's statements wait for a lock at most a second, and all of it ends
eight seconds after the read began (`StatementLimits`, `TreeRegistry::kCascadeLockWait` and
`kCascadeTime`), so a reply never waits on a stuck tree for longer. It answers `200` with what became of
those steps, per tree in tree id order:

- `removed: [{treeId, nodeIds}]`, always present: the steps were deleted and saved.
- `unsaved: [treeId]`, present only when it names a tree: the steps were deleted in the tree's room
  and sent to its open pages, and the save then failed. They are gone now, and the room's next save,
  which the next edit of that tree or the room's idle close makes, keeps them gone; should the server
  restart before it, they come back, without the caller's marks the delete cleared.
- `incomplete: [treeId]`, present only when it names a tree: nothing was deleted there — its room
  could not be opened, the marks not cleared, or the eight seconds ran out before it was reached — and
  the steps stay. Each points nowhere: it reads as an ordinary step, `get_diagnostics` lists it in
  `danglingPointers`, and the caller can clear its pointer or delete it by hand.

MCP `delete_tree` answers `{deleted, id, removed}`, with `unsaved` and `incomplete` on the same rule,
and refuses under `cascade-unavailable` with nothing removed as the REST door does. Each is answered to
the tree's owner alone and names only their trees; a refused delete edits nothing.

`GET /v1/trees/{id}/progress` answers the owner's overlay, `{marks: [{node, status, at, markedAt,
outOfOrder?}]}`, to anyone who can read the tree: the stored marks to a caller who can write it, whose
view derives completion again from the tree's `opens`, and `readerView` of them (Model) to every other
reader. It answers `200` whether or not the trees could be followed.

`/v1/gallery` and `/gallery` are anonymous-allowed; a session only adds the two facts a row wears
about its reader and never changes which trees are listed. A card's `done` counts the owner's marks
as `readerView` shows them, in at most one follow per owner whose listed trees hold a pointer
(Model, `readerView`), and its time (`updatedAt`) is the later of the tree's own last edit and the
latest `markedAt` among those rows, so a card's time and place on the wall come from what a reader is
shown and from no mark they are not. `/v1/compose` is anonymous-allowed (the birth canvas has no
account) behind a rate limit. The reminders pause POST carries no
credential — only the secret from the recipient's own mail — and answers 204 either way. The admin
sweep is closed unless `REMINDERS_ADMIN_TOKEN` is set.

## WebSocket surface

`products/roadmap/adapters/ws/`. One socket, JSON frames, `t` names the frame type. The
credential is presented at the upgrade; every write re-proves the session, throttled to one lookup
a minute, and a revoked session narrows to a guest in place. Visibility is re-asked per frame.

Client → server: `ping` · `subscribe {treeId, vector}` · `subgraph` (a serialized `Subgraph`) ·
`progress {treeId, frameId, marks[{node, status, at}]}` · `presence {treeId, …}`.

Server → client: `pong` · `subgraph` (intent `delta` carrying `seq` and `reach` as the subscribe
answer, with the title and guide registers when the vector does not cover their stamps; intent
`live` for a peer's broadcast, with no `reach`; either is the frame's `readerView` for a connection
that cannot write the tree, and the delta's `reach` is that same verdict: `writer` for a connection
that can, `reader` for any other) ·
`progress` (intent `graft` on subscribe, echo otherwise) ·
`subgraphAck {treeId, frameId, seq?}` · `progressAck {treeId, frameId, refused?}` ·
`skew {treeId, frameId, serverNow}` · `reject {treeId, code, reason, frameId?}` · `presence` ·
`peer`.

`progressAck.refused` is present only when the frame carried a mark that was refused: an array of
`{node, code}`, one per refused mark in the frame's order. The one code is `opens-a-tree` — the node
holds a valid pointer and the connection can write the tree, so the node is complete when the tree
it opens is and takes no mark (`OpenedTrees`, Model). It names the node and nothing of the opened
tree. A mark that lost to a later stored stamp is not refused and is not listed. The frame is not
rejected: its other marks are recorded, echoed and acknowledged.

Reject codes are a stable wire contract — branch on `code`, never on `reason`:
`no-such-tree` · `server-error` · `sign-in-required` · `tree-too-large` · `bad-frame` ·
`not-yours` · `nobodys-tree` (the last two from `writeRefusalFor`, on the write lane).

Limits and rules:

- Frame rate: 50/sec sustained per connection, burst 100. A flooding connection's frames are
  dropped before parse.
- Skew clamp: a frame stamped past `now + 5 min` is refused whole (a `skew` frame), title and guide
  registers included — a runaway stamp must not own a name or a guide for years. Both lanes apply it.
- A progress frame carries at most 2000 marks; a mark missing node, status or stamp refuses the
  whole frame.
- A progress frame is refused whole — a bad mark, a skewed stamp, a failed read gate — or applied
  per mark: each mark is its own last-writer-wins register, so the marks that landed are echoed and
  the ack names the ones `refused`. It joins no op log and echoes only to the same account's
  sessions — never to collaborators. The room is consulted under the tree's strand and the
  repositories are read and written after it is released.
- Presence is ephemeral, never persisted, flushed on a 50 ms timer (latest-wins per actor).
- Drogon does not wrap WS callbacks: an exception escaping the frame handler aborts the process.
  Decode failures are refused by code, never by throw.
- A frame whose text is not one whole JSON value — a break after a complete field, a lone
  surrogate, a second value after the first — is refused whole as `bad-frame`, carrying the
  `treeId` and `frameId` its readable head names; no part of it is applied.
- A guide register of only spaces, tabs and line breaks is refused as `bad-frame`: its sender
  stamped that text, so it cannot be stored as `""`, and a client sends `""` for no guide.
- A `subgraph` frame whose save fails is answered `server-error` with its `frameId`, and one whose
  tree's row went away under the live room `no-such-tree`.

## Persistence

PostgreSQL; `db/schema.sql` is the one file, applied in order and idempotent.

| Table | Holds |
| --- | --- |
| `trees` | title and guide (each LWW: `<register>_hlc` plus the `<register>_ms`/`<register>_counter` numeric split), `guide_inherited`, `owner_id`, `visibility`, `head_seq`, `forked_from`, `deleted_at`, `document` jsonb |
| `tree_nodes` | one row per node: `created_hlc`/`deleted_hlc` plus each register and its `_hlc`, and `present`; `tree_nodes_opens_idx` finds the present nodes that open a given tree, and `tree_nodes_pointers_idx` the trees a given tree's present nodes open, and whether they open a given one |
| `tree_edges` | one row per `(from_id, to_id)`: `added_hlc`, `removed_hlc` |
| `tree_kinds` | one row per legend kind: hue, label, description, rank, each with its stamp; `cross_branch_exempt` and `cross_branch_exempt_hlc` are neither read nor written, and stay so an earlier image can run on this database |
| `tree_ops` | append-only log — `(tree_id, seq)` pk, `unique (tree_id, op_id)` for idempotency |
| `node_progress` | per-user private overlay — status, `out_of_order`, `hlc`, `stamp_ms`, `stamp_counter` |
| `tree_og_images` / `tree_og_videos` | the share card PNG and loop, inline `bytea`, one row per tree |

Rules:

- The lattice is entry-grow-only. A save upserts only the rows it touched and deletes nothing; a
  delete is a tombstone stamp. Stamps are canonical HLC text and are never compared in SQL —
  `present` is computed by the writer for read-side projections.
- `trees.document` is the whole-tree jsonb blob, read only as a fallback for trees whose per-entry
  rows are not yet backfilled. Nothing new depends on it.
- `tree_ops` scales with edits, not nodes. `ActivityFeed` projects it, and `open()` replays its
  tail past the stored head to bring a room up to date.
- Tree deletion writes `deleted_at` and retires its room, then tombstones the steps of the owner's
  other trees that open it (HTTP surface, `DELETE /v1/trees/{id}`). Reads exclude deleted rows and
  save never clears the tombstone. Recreating the caller's own deleted ID returns
  `Creation::retired`, so a client can stop replaying it instead of reminting an ID.
- An erased account's trees are deleted outright, with their rows, ops and everyone's progress on
  them (`backend/AUTH.md`), and their rooms are retired once that commits. A save lands only on a row
  that stands: a room whose tree row is gone saves nothing and lands no op rows.
- Progress upserts compare numeric `(stamp_ms, stamp_counter)` strictly; a tie loses without
  consulting the actor. Clears retain a stamped `none` row.
- The og-image and og-video rows carry no FK to `trees`: they are addressed by tree id and read
  behind the tree's own visibility gate, so a stray row is simply unreachable.

Indexes that exist because their query runs on every render: `trees_owner` (the registry list),
`trees_forked_from` (fork lineage, asked once per share page and once per gallery card),
`trees_public` (the listed slice of a mostly-private table).

## Open items

- A tombstoned node's edges are retained for resurrection and nothing compacts them, so the
  lattice grows monotonically.
- `label` is LWW, so a concurrent rename drops the loser.
- A second server process can collide on `(tree_id, seq)`; room heads and presence are local and
  the server clock actor is not instance-qualified. Run one writer per database.
- `TreeRoom::appliedOpIds_` grows without a bound; `tree_ops` also enforces durable op-ID uniqueness.
- `ActivityFeed::displayActor` recognizes `dev` and guest IDs, but renders real user UUIDs as the
  tree itself. Offline flushes retain only one coarse headline for the coalesced gestures.

Cross-surface coverage and offline durability are specified in
[graph sync](../docs/GRAPH_SYNC_DESIGN.md). The
[golden corpus](test/golden/SCHEMA.md) does not yet test the real C++ and JavaScript implementations.
