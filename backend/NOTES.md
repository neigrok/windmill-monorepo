# Backend notes — roadmap sync and its neighbours

Rules that are not obvious from a single file, and the open items. The contracts live
elsewhere and win where they disagree: `SPEC.md`, `AUTH.md`, `AUTHZ.md`, `db/schema.sql`,
`RUNNING.md`, `deploy/README.md`, `CLAUDE.md`.

## The sync spine

- The **subgraph frame is the unit of convergence**. Only lattice effects cross a replica
  boundary — never commands. `TreeRoom::joinSubgraph` is the client write path;
  `applyCommand` is the server-origin one (MCP), and it broadcasts the writes it produced
  as one subgraph so an agent's edit reaches sockets the same way a browser's does.
- The **op log is a record of what happened**, read only by `ActivityFeed`. `joinSubgraph`
  derives one `AppliedOp` per frame from `headline(GraphState, LegendState)` — the coarse
  inverse of `merge()`. A position-only or empty frame is a nudge, not a deed, and logs
  nothing. Feed phrasing lives in the C++ renderer only; never add a second copy in JS.
- **One writer per tree.** `RoomRegistry::strandFor` serializes HTTP reads, WS frames and
  MCP writes onto one strand. MCP is mounted inside `windmill_server` and shares that
  registry for this reason: a second process with its own `RoomRegistry` over the same
  Postgres mints colliding `seq` against `tree_ops`' `primary key (tree_id, seq)`.
- **Persist before the ack**, so an ack attests durability (`Collab.cpp`).
- **Tree reads go through the room** so unsaved edits are visible. The registry list reads
  straight from the repository — opening a room per listed tree thrashes the editor caches,
  and `updatedAt` is defined off the persisted stamp.
- Subscribe replies with `deltaBetween(state, clientVector)`, not the full state.
- A client-stamped frame past `now + 5min` is refused whole with a `skew` nack.
- Cursors and selections are ephemeral: they ride `PresenceHub` (coalesced to 20 Hz,
  latest-wins per actor), never `PresenceBus` and never the op log.

## Clock

- One `HlcClock` per `TreeRoom`, actor `"srv"`, minted under the strand — so it needs no
  mutex. Never mint a stamp outside the strand.
- The room `observe`s every stamp it loads (document frontier plus each replayed op), so a
  fresh mint is always ahead of anything persisted. Restart-safe.
- Authorship lives in `AppliedOp.actor`; the HLC actor only breaks LWW ties and keys the
  version vector.

## CRDT rules

- Nodes and edges are **add-biased LWW element-sets**: present iff `addedAt` is set and
  `addedAt >= removedAt` (ties → add wins).
- Scalar fields (label/color/position) are **LWW registers** keyed by HLC, `>` wins.
- **Delete is a node tombstone only.** Edges are never removed — they go inert and are
  filtered out of the derived DAG when an endpoint is absent, so resurrection revives them.
- The legend is a **sibling CRDT**, not part of `LooseGraph`. `TreeRoom` owns both;
  `RecolorKind` is the one command that spans them.
- `merge` is unconditional. Legend validity (hue uniqueness, `kMaxKinds`, no in-use removal,
  length caps in `domain/Command.h`) is enforced **at the write edge before admission**,
  never inside merge.
- The backend seeds the default legend only on genuine tree creation; a PUT without kinds to
  an existing tree preserves its legend, and the reply reflects the stored legend back.
- Fork snapshots the source room's current graph + legend under the new id with
  `forked_from` provenance and a fresh op log.

## Read models and diagnostics

- `SkillTree` / `TrunkTree` / `TreeHealth` assume a valid DAG. Gate on
  `TreeDiagnostics::assess(graph).clean()`; an unclean graph never reaches them.
- Reach for `SkillTree` only when you need topo order, ancestry or the trunk. For anything a loose
  graph can answer (a node's live prerequisites, present ids, edges) pass that in and stay
  validity-agnostic — progress must never block on graph validity.
- Cycle detection is **iterative** Tarjan, so a 20k-node graph cannot blow the stack.
- Layout and ranks are client-only; the server does not compute them.
- `maskedWork` (tombstoned parents with present children) rides the dangling-edge scan and is
  the repair signal behind `ResurrectNode`.

## Progress overlays

- `node_progress` is a per-user LWW register. A clear is `status='none'` **with a stamp** —
  never a row delete, or an out-of-order stale mark resurrects the node.
- The upsert lands only when `(EXCLUDED.stamp_ms, EXCLUDED.stamp_counter)` strictly beats the
  stored pair. The comparison is numeric only — a tie loses, and the actor is never consulted.
- A WS `progress` frame carries the marking replica's own stamps (skew-clamped like a subgraph
  frame, at most `kMaxMarksPerFrame` marks); MCP mints from the room clock instead.
- A progress change fans over the socket to the author's **own** connections only — it is a
  private overlay, never broadcast to collaborators.

## Delete is soft

- `deleted_at` plus a `deleted_at IS NULL` filter on every read; `save`'s upsert never clears
  it. The id stays spoken for by the primary key, so a create under the caller's **own**
  retired id must answer `Creation::retired`, not `taken` — a client that re-creates on
  conflict is a reader of the delete, and answering `taken` makes it re-plant under a fresh
  id forever.
- A room already resident in memory stays editable until it idle-evicts, writing to an
  invisible row.

## Postgres

- `trees.id`, `tree_ops.tree_id` and `node_progress.tree_id` are `text`, matching the domain's
  string ids.
- Auth's single-use guarantee lives at the row: `UPDATE … WHERE consumed_ms IS NULL` reporting
  `affected_rows == 1`. Any check-then-act on a shared row wants the act to be the check.

## Open items

- **Scale-out breaks single-authority.** A second `windmill_server` replica reintroduces the
  `seq` collision: `head_` is cached per room, `PresenceBus` is in-process, and the HLC actor
  `"srv"` is not qualified per instance.
- `TreeRoom::appliedOpIds_` grows unbounded in memory; `tree_ops`' `unique (tree_id, op_id)`
  is the durable backstop.
- `ActivityFeed::displayActor` resolves only `dev` and `u<n>`; a real user uuid renders as the
  tree itself.
- An offline flush logs one coarse headline for many coalesced gestures.
- `test/golden` covers hlc / element-set / version-vector, not the title / delta round-trip.
