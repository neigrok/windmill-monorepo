# Backend notes — roadmap sync and its neighbours

Rules that are not obvious from a single file, and the open items. The contracts live
elsewhere and win where they disagree: `AUTH.md`, `AUTHZ.md`, `db/schema.sql`,
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
- The backend seeds the default legend only on genuine tree creation. A PUT without kinds to
  an existing tree preserves its legend, and an old tree returns `kinds: []` for the client
  to derive.
- Fork snapshots the source room's current graph + legend under the new id with
  `forked_from` provenance and a fresh op log.

## Read models and diagnostics

- `SkillTree` / `TrunkTree` / `TreeHealth` assume a valid DAG. Gate on
  `TreeDiagnostics::assess(graph).clean()`; an unclean graph never reaches them.
- Reach for `SkillTree` only when you need ranks / ancestry / trunk. For anything a loose
  graph can answer (a node's live prerequisites, present ids, edges) pass that in and stay
  validity-agnostic — progress must never block on graph validity.
- Cycle detection is **iterative** Tarjan, so a 20k-node graph cannot blow the stack.
- Layout and ranks are client-only; the server does not compute them.
- `maskedWork` (tombstoned parents with present children) rides the dangling-edge scan and is
  the repair signal behind `ResurrectNode`.

## Progress overlays

- `node_progress` is a per-user LWW register. A clear is `status='none'` **with a stamp** —
  never a row delete, or an out-of-order stale mark resurrects the node.
- The upsert is guarded: `WHERE (EXCLUDED.stamp_ms, EXCLUDED.stamp_counter) >
  (node_progress.stamp_ms, node_progress.stamp_counter)`. The room clock mints a unique
  `(ms, counter)` per tree, so that pair totally orders every write.
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

- **Scale-out breaks single-authority.** Two `windmill_server` replicas reintroduce the seq
  collision. Needs DB-authoritative `seq` (per-tree sequence or advisory-locked `max(seq)+1`,
  never a cached `head_`), a cross-process bus behind `PresenceBus` so resident rooms replay
  remote ops (dedup via `unique (tree_id, op_id)`), and sticky per-tree routing. A cheaper
  guardrail first: make the write persist-then-apply and treat a seq conflict as "behind →
  replay + retry". The same deploy must qualify the HLC actor per instance (`srv#<region>`).
- `TreeRoom::appliedOpIds_` grows unbounded in memory; `tree_ops`' `unique (tree_id, op_id)`
  is the durable backstop. Wants a windowed dedupe.
- `ActivityFeed::displayActor` resolves only `dev` and `u<n>`; a real user uuid renders as the
  tree itself. Needs a name-resolution pass.
- An offline flush logs one coarse headline for many coalesced gestures.
- Progress is not yet a client-side lattice: no stamped, offline-durable overlay with
  reconnect catch-up. The data layer is correct; the client overlay still shadows in
  localStorage.
- Golden-corpus vectors do not cover the title / delta round-trip.
- WebRTC device-to-device sync (server as signaling only, the same subscribe/delta/ack
  exchange over a data channel) is unbuilt; the `.windmill` graft file is the only
  device-to-device transport.
- Imported `.windmill` hues are not reconciled against the local legend.
