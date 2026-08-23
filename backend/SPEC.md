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
  registers: label, icon, color, order, position, status, description, links); edges are an
  `ElementSet` per `(from, to)`.
- `TreeDiagnostics::assess` — a pure report over a loose graph: `cycles`, `dangling`,
  `selfEdges`, `smells`, `maskedWork` (tombstoned parents with present children). `clean()` is
  true when cycles, dangling and self-edges are all empty. Smell thresholds: label > 256 bytes,
  in-degree > 4.
- `SkillTree` — the validated projection, constructible only from a clean graph. Indexes ranks,
  ancestry and the render model.
- `Legend` — up to 6 kinds per tree, one per hue.

Derived read models:

- `UnlockRules::derive(nodes|tree, progress) → map<NodeId, NodeState>` where `NodeState ∈
  {locked, available, active, complete}`. It reads only nodes and prerequisites, so it also runs
  over a graph `SkillTree` would refuse: a prerequisite naming no node locks its dependant, and a
  cycle locks every member.
- `TrunkTree` — elects one trunk parent per node (same-kind parents win, then shallowest, then
  smallest id) and derives branch root, trunk depth, leaf weight, and `EdgeKind ∈ {trunk,
  in_branch, cross_branch}`.
- `TreeHealth::assess(SkillTree) → Health {nodeCount, edgeCount, crossBranch, redundant,
  avgInDegree, score}`.

`NodeColor ∈ {terracotta, olive, gold, brick, sky, plum}`.

The server never computes layout and never renders. Positions are authored nudges it stores and
serves; geometry is entirely client-side.

### Progress

Private, per user, per tree — outside the lattice and outside the op log. A `Progress` holds a
`ProgressMark {status, at, markedAt}` per node plus the projected `completed` / `inProgress` /
`cleared` sets; `record` is the only way in, so the sets cannot drift from the registers.
`ProgressStatus ∈ {none, active, complete}`; **`none` is a value, not a row delete**, so a clear
converges across devices and a stale mark cannot resurrect it. `markedAt` is the server clock at
the moment the mark was recorded and is the only instant a reader may date a step by; the HLC
beside it orders writes and is never served back as a time.

## Convergence

All traffic flows through the server. No offline peer-to-peer merge, no version-vector partition
handling — one convergent lattice per tree with the room as sequencer.

- **LWW register** (`Lww<T>`) — highest HLC wins. HLC text is `physicalMs:counter:actor`; the
  empty string is unset.
- **Element set** (`ElementSet`) — add-biased: present iff added and no strictly-later remove
  cancelled it. A tie between add and remove favours add.
- **Join** — `LooseGraph::join(GraphState)` folds a partial state entry by entry, field by field.
  Absence at every granularity (missing entry, missing field, unset stamp) means "no information",
  so a join only ever adds. Commutative, associative, idempotent.

### Subgraph frames

Clients author `Subgraph` frames, not commands. A frame is a partial, stamped slice of one
tree's lattice: `{treeId, frameId, actor, intent, title?, graph, legend, gestures[], coverage?}`.

`SubgraphIntent`:

| Intent | Meaning |
| --- | --- |
| `live` | one gesture, sent now |
| `flush` | a coalesced offline session |
| `delta` | anti-entropy against a stated vector — the only intent carrying `coverage` |
| `graft` | state joined for its own sake (files, imports, device handoff); never advances coverage |

A `VersionVector` is the greatest stamp seen per actor, keyed by actor string. `frontier(graph,
legend)` folds a full state into one; `deltaBetween(graph, legend, since)` returns the slice a
peer at `since` lacks, with covered fields masked back to "no information", carrying the sender's
full frontier as coverage.

`TreeRoom::joinSubgraph` dedupes on `frameId`, folds the frame's stamps into the room clock,
joins graph + legend + title, assigns the next `seq`, logs a headline deed, and broadcasts the
frame verbatim. Duplicates return no seq.

### Commands

`Command` is the server-and-agent-side write path (MCP, tending, imports); it rides the same op
log, undo and broadcast machinery, and `TreeRoom::applyCommand` emits its writes as one subgraph.

`RenameNode` · `SetNodeColor` · `RepositionNode` · `CreateNode` · `AnnotateNode` · `AddEdge` ·
`RemoveEdge` · `ReconnectEdge` · `DeleteNode` · `TransitiveReduction` · `PruneDangling` ·
`RenameKind` · `DescribeKind` · `AddKind` · `RemoveKind` · `ReorderKinds` · `RecolorKind`.

- `DeleteNode` is a plain tombstone. The record and every field survive so the node can be
  resurrected; its edges stay in the document and are filtered from the derived DAG view. A child
  that loses its only live parent becomes a root — visible as `maskedWork`, never re-tethered.
- `TransitiveReduction` drops transitively-implied edges; `PruneDangling` drops self-edges and
  edges touching an absent node. Both are computed server-side against the current state and
  applied as one op, one undo step.
- `RecolorKind` is atomic: it swaps a kind's hue and repaints every node wearing the old hue.
- `validate(graph, legend, command)` runs at the edge. Graph commands are always admissible.
  Legend commands may be refused — hue uniqueness, ≤6 kinds, no in-use removal, length caps are
  all locally decidable on the authoritative state.

### Bounds

Declared once in `domain/Command.h` and published as `maxLength` by the MCP surface.

| Bound | Value |
| --- | --- |
| id length | 128 bytes |
| node label | 200 bytes |
| icon token | 64 bytes |
| node description | 4000 bytes |
| links per node | 32 (label 200 B, url 2048 B) |
| present nodes per tree | 10000 |
| present edges per tree | 20000 |
| tree title | 200 chars |
| legend kinds | 6 (label 24 B, description 80 B) |

`validate()` judges a single command; `admit()` judges arrivals that mint no command — a posted
document, an MCP graft, a client lattice frame. `admit` returns `Admission{verdict ∈ {tooLarge,
malformed}, reason}`; an HTTP door answers 413 for `tooLarge` and 400 for `malformed`. Caps are
asked against what the graph would **hold** once the arrival lands, joined not estimated.

The redundant-edge pass (`redundantEdges`, and `TreeHealth`'s `redundant`) walks a transitive
closure whose cost is a sum of squared degrees. `withinReachabilityBudget(nodes, edges)` bounds
nodes, edges and their product; over budget the pass is skipped and reports nothing.

## Runtime

One `TreeRoom` per open tree holds the lattice, the legend, the title register, the room clock and
the head `seq`, and runs under a single strand — one thread mutates it at a time. `RoomRegistry`
opens rooms on demand, hands out `strandFor(treeId)`, persists (`persist`) and evicts idle ones.

Rules:

- Never hold a room's strand across a Postgres call.
- `accessOf(treeId)` answers authorization from the stored row; ask it **before** `open()`, which
  drags the whole lattice off disk and pins it.
- Persist before acking, so an ack attests durability.
- The room clock mints a unique `(ms, counter)` per write, so writes to one tree are totally
  ordered and the actor tiebreak is moot.
- Sparse persistence: `dirtyState()` exports only entries dirtied since `markClean()`. `replay()`
  flips the room to all-dirty.

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

Structural edits have no REST endpoint — they ride the socket. Inbound models are suffixed
`Request`, outbound `Response`.

A tree id is `t_` plus 16 lowercase hex characters (`wellFormedTreeId`); a client-supplied id
(claim-create, fork) must match byte for byte.

`/v1/gallery` and `/gallery` are anonymous-allowed; a session only adds the two facts a row wears
about its reader and never changes which trees are listed. `/v1/compose` is anonymous-allowed
(the birth canvas has no account) behind a rate limit. The reminders pause POST carries no
credential — only the secret from the recipient's own mail — and answers 204 either way. The admin
sweep is closed unless `REMINDERS_ADMIN_TOKEN` is set.

## WebSocket surface

`products/roadmap/adapters/ws/`. One socket, JSON frames, `t` names the frame type. The
credential is presented at the upgrade; every write re-proves the session, throttled to one lookup
a minute, and a revoked session narrows to a guest in place. Visibility is re-asked per frame.

Client → server: `ping` · `subscribe {treeId, vector}` · `subgraph` (a serialized `Subgraph`) ·
`progress {treeId, frameId, marks[{node, status, at}]}` · `presence {treeId, …}`.

Server → client: `pong` · a `delta` subgraph carrying `seq` (the subscribe answer) · `progress`
(intent `graft` on subscribe, echo otherwise) · `subgraphAck {treeId, frameId, seq?}` ·
`progressAck` · `skew {treeId, frameId, serverNow}` · `reject {treeId, code, reason}` ·
`presence` · `peer`.

Reject codes are a stable wire contract — branch on `code`, never on `reason`:
`no-such-tree` · `server-error` · `sign-in-required` · `tree-too-large` · `bad-frame`.

Limits and rules:

- Frame rate: 50/sec sustained per connection, burst 100. A flooding connection's frames are
  dropped before parse.
- Skew clamp: a frame stamped past `now + 5 min` is refused whole (a `skew` frame), title register
  included — a runaway stamp must not own a name for years. Both lanes apply it.
- A progress frame carries at most 2000 marks; a mark missing node, status or stamp refuses the
  whole frame.
- Progress is refused whole or applied whole, joins no op log, and echoes only to the same
  account's other sessions — never to collaborators.
- Presence is ephemeral, never persisted, flushed on a 50 ms timer (latest-wins per actor).
- Drogon does not wrap WS callbacks: an exception escaping the frame handler aborts the process.
  Decode failures are refused by code, never by throw.

## Persistence

PostgreSQL; `db/schema.sql` is the one file, applied in order and idempotent.

| Table | Holds |
| --- | --- |
| `trees` | title (LWW: `title_hlc` plus the `title_ms`/`title_counter` numeric split), `owner_id`, `visibility`, `head_seq`, `forked_from`, `deleted_at`, and the legacy `document` jsonb |
| `tree_nodes` | one row per node: `created_hlc`/`deleted_hlc` plus each register and its `_hlc`, and `present` |
| `tree_edges` | one row per `(from_id, to_id)`: `added_hlc`, `removed_hlc` |
| `tree_kinds` | one row per legend kind: hue, label, description, rank, each with its stamp |
| `tree_ops` | append-only log — `(tree_id, seq)` pk, `unique (tree_id, op_id)` for idempotency |
| `node_progress` | per-user private overlay — status, `hlc`, `stamp_ms`, `stamp_counter` |
| `tree_og_images` / `tree_og_videos` | the share card PNG and loop, inline `bytea`, one row per tree |

Rules:

- The lattice is entry-grow-only. A save upserts only the rows it touched and deletes nothing; a
  delete is a tombstone stamp. Stamps are canonical HLC text and are never compared in SQL —
  `present` is computed by the writer for read-side projections.
- `trees.document` is the legacy whole-tree blob, read as a fallback for trees whose rows are not
  yet backfilled. Nothing new should depend on it.
- `tree_ops` is history: the activity feed projects it, and nothing replays it to reconstruct
  state. It scales with edits, not nodes.
- The og-image and og-video rows carry no FK to `trees`: they are addressed by tree id and read
  behind the tree's own visibility gate, so a stray row is simply unreachable.

Indexes that exist because their query runs on every render: `trees_owner` (the registry list),
`trees_forked_from` (fork lineage, asked once per share page and once per gallery card),
`trees_public` (the listed slice of a mostly-private table).

## Open items

- Cyclic layout: the client must break back-edges for layout only, lay out the resulting DAG, and
  draw the removed back-edges in the error style.
- Inert-edge accumulation — a tombstoned node's edges are retained for resurrection, so the
  lattice needs a compaction pass beyond the undo horizon.
- `label` is LWW, so a concurrent rename drops the loser.
- `RepositionNode` is high-frequency; log the final position of a drag, not every frame.
- Whether a fork tracks its source's later changes is undecided.
