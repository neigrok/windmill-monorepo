# Graph Sync — the Subgraph Framework

How a Windmill tree stays consistent across the browser, the backend, and a device that edits
while disconnected.

---

## 0. The one idea

> A subgraph is a partial, stamped, self-describing slice of a tree's lattice, and the only sync
> operation is `join`.

Everything that moves between replicas is a subgraph:

| Scenario | What it is |
|---|---|
| A live edit | a one-gesture subgraph, sent immediately |
| An offline session, flushed | one coalesced subgraph, however many gestures |
| A reconnect catch-up | a delta subgraph computed against a version vector |
| A fresh device booting | the full-state subgraph |
| An import or an HTTP bootstrap | a graft subgraph |

One envelope, one codec, one apply path. Nodes, edges, legend and title all ride it.

## 1. The convergent core

`backend/platform/domain/Crdt.h` is the whole algebra, in about forty lines:

- `Lww<T>` — a register that overwrites only on a strictly-greater HLC. A tie keeps the incumbent.
- `ElementSet` — add-biased life: `present() = addedAt.isSet() && !(removedAt > addedAt)`. An add
  tying a concurrent remove wins.
- `LooseGraph` = `map<NodeId, NodeRecord>` (an `ElementSet` life plus eight `Lww` fields) and
  `map<Edge, ElementSet>`. Edge life is independent of node life; an edge survives its endpoints
  and is masked at read time by `liveEdges()`.
- `GraphState` / `LegendState` — the lossless stamped snapshot. Persistence is one row per CRDT
  entry (`tree_nodes` and its siblings), stamps carried as canonical HLC text, so the wire format
  and the persistence format are the same shape. A save upserts only the rows it touched, and
  never deletes: the lattice is entry-grow-only.

## 2. The lattice and its guarantees

A tree's state is a finite product of independent registers:

```
Node   := ElementSet life  ×  Lww<label> × Lww<icon> × Lww<color> × Lww<order>
                           ×  Lww<position> × Lww<status> × Lww<description> × Lww<links>
Edge   := ElementSet
Kind   := ElementSet life  ×  Lww<hue> × Lww<label> × Lww<description> × Lww<rank>
Title  := Lww<string>
Tree   := Map<NodeId,Node> × Map<Edge,Edge> × Map<KindId,Kind> × Title
```

`join(local, incoming)` is defined pointwise and only pointwise: `life.add(createdAt)`,
`life.remove(deletedAt)`, then `Lww::merge(value, at)` per field. Unseen ids materialize as latent
records through `operator[]`, so no closure rule is needed. A keyed map of semilattices with
absent-entry-as-⊥ is a semilattice, and padding a partial with ⊥ is join-neutral — joining a
partial subgraph is joining a full state: commutative, associative, idempotent.

**No two distinct writes may share a stamp.** `Lww`'s tie branch keeps the incumbent, so a
collision between distinct writes makes merge order-dependent. Uniqueness is true by construction
via the per-replica actor (§3).

### Keep more, lose less

The add-bias is only a tie-break; exact HLC ties essentially never occur across replicas. The
guarantee that actually holds is structural:

1. A remove destroys nothing. A tombstoned node keeps every field value; edges survive endpoint
   deletion; concurrent field edits on a deleted node land as latent writes; a later re-add
   resurrects everything, because the HLC receive rule (fold observed stamps before ticking) makes
   a re-add minted after seeing a tombstone dominate it.
2. Deletion is only ever an explicit stamped tombstone — never delete-by-omission. Absence, at
   every granularity, means *no information*.

Where the algebra cannot decide intent, the loss is made visible rather than silent:
`TreeDiagnostics` reports `maskedWork` — a tombstoned node with live children hanging off it.

## 3. Clocks

Clients mint stamps. The server is the well-connected, time-checking peer, not the clock authority.

- **Client clock** — one `HlcClock` per `TreeLattice`: `tick() = (max(wallMs, lastSeenMs),
  counter, actor)`, with `observe(stamp)` folding every remote stamp seen, so a re-add always
  dominates a tombstone it has seen.
- **Actor = a fresh `r_<nonce>` per session**, minted at every `SyncSession` boot. Two tabs are two
  replicas; distinct actors never tie; there is no persisted clock watermark to corrupt.
- **Server clock** — the same `HlcClock` fed wall time, actor `srv` (`TreeRoom::kServerActor`),
  with the receive rule on every inbound stamp. The server is the origin for edits with no lattice
  of their own: MCP tool calls, renames, imports.
- **Skew clamp, never restamp.** The server refuses whole any frame whose max stamp exceeds
  `now + 5min`, answering `{t:"skew", serverNow}`. The sender keeps its lattice, folds `serverNow`
  into its clock so new writes are clean, and retries. **Stamps are immutable from the moment they
  are minted.**

**Seq is tempo, not truth.** The server mints a dense per-tree `Seq` under the room strand. Seq
orders broadcasts and the activity feed and detects live-plane gaps. Seq is never a merge input.

## 4. Gestures materialize at the origin

> Every compound gesture is materialized to stamped field-writes at the origin, at the moment the
> user acts, against the state the user was looking at. Commands never cross a replica boundary —
> only lattice effects do.

- delete-with-splice → the tombstone write plus the concrete re-tether edge writes, one frame.
- recolor a kind → the kind's hue write plus the N node `color` writes, one frame.
- transitive reduction → the concrete edge-remove writes.
- create node → the node writes plus the parent-edge write.
- add kind → the kind writes including a concrete `rank`.

Whoever authors is the origin: the browser for user gestures, the server for MCP tools and
imports. This is why the delete and recolor gestures are wire-atomic.

`Command` is the gesture descriptor — the vocabulary of what a user did, used for the activity
feed, animation and undo grouping — not the unit of convergence. On the server side
`merge(graph, legend, command, at)` turns a command into lattice writes, and
`TreeRoom::applyCommand` broadcasts the resulting `deltaBetween` footprint as one subgraph frame.

## 5. The wire contract

One envelope, identical as a WebSocket frame and as an HTTP body:

```json
{
  "t": "subgraph",
  "v": 1,
  "treeId": "t_9362d9bc883e0a1e",
  "frameId": "1f5b7a0e-2c44-4d1e-9a0b-6d2f1c8e4b77",
  "actor": "r_8f31c2",
  "intent": "live",
  "gestures": [ { "id": "g_7", "kind": "deleteNode", "label": "Shaders" } ],
  "nodes": [
    { "id": "n_shaders",
      "createdAt": "1770000000123:0:r_8f31c2",
      "deletedAt": "1770000108551:0:r_8f31c2",
      "label": "Shaders", "labelAt": "1770000000123:1:r_8f31c2",
      "color": "moss",    "colorAt": "1770000000123:3:r_8f31c2" }
  ],
  "edges": [ { "from": "n_gl", "to": "n_child", "addedAt": "1770000108551:1:r_8f31c2" } ],
  "kinds": [],
  "title": null,
  "coverage": null
}
```

Rules, all load-bearing:

- Every register rides as a flat value/stamp pair — `label`/`labelAt`, `hue`/`hueAt`, an entry's
  life as `createdAt`/`deletedAt` — never a nested object. `title` is the one exception, an
  object `{v, at}`, and `coverage` a map of actor to stamp.
- Stamps use the `"physicalMs:counter:actor"` text encoding (`toString`/`parseHlc` in
  `platform/domain/Ids.h`); the unset sentinel is `0:0:`. An absent section, entry or field
  contributes nothing to a join, so a sender may either omit unset fields or send the sentinel.
- `intent`: `live` = one gesture now; `flush` = a coalesced offline session; `delta` = an
  anti-entropy payload, the only intent allowed to carry `coverage`; `graft` = state joined for
  its own sake (imports, bootstrap), never advancing coverage.
- `frameId` stores as `op_id` under `unique (tree_id, op_id)`, which is the durable dedup. The op
  log holds one headline `Command` per frame for the activity feed, not the envelope; a
  position-only nudge logs nothing.
- No frame can delete by omission.

Companion frames:

- `{t:"subgraphAck", treeId, frameId, seq}` — sent after the room has persisted, so an ack attests
  durability. A duplicate `frameId` is skipped whole and acked without a `seq`.
- `{t:"subscribe", treeId, lastSeq, vector}` — answered with an `intent:"delta"` subgraph carrying
  the server's `seq` and its coverage.
- `{t:"reject", treeId, frameId, code, reason}` — codes are stable; the prose is for humans.
  `tree-too-large` is capacity, `not-yours`/`nobodys-tree` are ownership, `sign-in-required` is
  the seat, `no-such-tree` covers both absent and private-denied (the socket is no existence
  oracle), `bad-frame` is unreadable or past a per-field cap, `server-error` is infrastructure and
  never carries its detail. Any reject naming a `frameId` strands banked edits, because
  the outbox re-derives the same rejected delta forever.
- Server broadcast = the sender's frame plus `seq`. The server never re-stamps a client's content;
  echoes are joined (an idempotent no-op), never suppressed.

`GET /v1/trees/{id}` carries the stamped lattice as `state` (an `intent:"graft"` subgraph) beside
the projected `TreeData` for the first paint. That is how a fresh client bootstraps its
`TreeLattice`.

## 6. Reconnect and anti-entropy

**The coverage rule.** A replica's version vector — per-actor max `(physicalMs, counter)` —
advances through exactly two channels:

1. The `delta` frame answering a `subscribe`, which **replaces** coverage with the server's stated
   frontier.
2. An ack for a frame the client sent, which **joins** in the frontier that frame carried.

Everything else — live frames, echoed flushes, grafts — joins state without touching coverage. A
receiver that drops any portion of a frame must not adopt its coverage or advance `lastSeq` past
it. Coverage can therefore never outrun content.

Replacing coverage on subscribe (rather than joining it) is what heals a server restart: anything
the server no longer holds becomes uncovered and re-flushes.

**Reconnect:** the client sends `subscribe {lastSeq, vector}`; the server answers one
`intent:"delta"` frame computed with `deltaBetween` from the room's lattice alone — no op-log
replay to genesis. A fresh client sends an empty vector and gets the whole state. The client joins
it, re-baselines coverage and `lastSeq`, then flushes `deltaSince(ackedServerVector)` upstream.

**Live-plane gap detection:** a live frame joins only when `seq === lastSeq + 1`. A gap, an
out-of-order frame or a failed join forces a resubscribe — the delta is the only resync.

**The lattice is the outbox.** There is no separate queue to bound, corrupt or lose. The pending
payload is derived: `lattice.deltaSince(ackedServerVector)`. A whole offline session flushes as
one payload, chunked into independently valid subgraphs above 256KB (joins compose, so no `flushId`
ceremony; the title register rides the first chunk). Crash between flush and ack: re-derive, re-send the
same `frameId`, and the durable `op_id` dedup re-acks.

## 7. Offline durability

`SyncStore` keeps one IndexedDB record per tree: `{ frame, progress, lastSeq }` — both lanes and
the seq written together so a crash cannot tear them.

- The coverage vector is deliberately **not** persisted. It is rebuilt from the next server delta,
  which is a truer statement of coverage than any saved vector.
- `save` is a read-**join**-put inside a **single** transaction. Two tabs share the record; a blind
  put would clobber the other tab's unflushed offline edits, whereas joining means racy tabs can
  only add information. IndexedDB auto-commits the moment control returns to the event loop with
  no pending request, so the join must run synchronously inside `get.onsuccess` and issue the put
  before yielding — never `await get()` then `await put()`.
- Persist a write before sending it. A crash then over-sends, which join absorbs, rather than
  losing an edit no one has acked.
- A corrupt blob starts the lane empty rather than refusing to load.
- Call `navigator.storage.persist()` and surface non-persistent storage honestly. Never claim a
  durability the browser did not grant.

## 8. Admission and legend caps

Refusals are whole-frame, pre-join, and non-lossy — the sender keeps its lattice and retries, or is
told plainly: an unreadable or over-cap frame (`bad-frame`), the skew clamp, the readability and
ownership/seat gates, and `admit()`, which refuses a frame that would push the tree past its size
caps (10k nodes / 20k edges) with `tree-too-large`. A flooding connection's frames are dropped
before parse — 50 frames/sec sustained, 100 burst — and a progress frame carries at most 2000
marks.

Legend validity — hue uniqueness, at most six kinds, in-use removal, length caps — is enforced at
the edge by `validate()`, never inside `Legend`. `Legend::join` is an unconditional LWW merge, so a
joined tree can transiently hold seven kinds. Kinds sort by `(rank, id)`, a deterministic order
both sides reproduce.

`TreeDiagnostics::assess` reports cycles, dangling edges, self-edges, smells, and `maskedWork`. It
does not report legend breaches.

## 9. Where the code lives

**Backend** (`backend/`)

| Path | Holds |
|---|---|
| `platform/domain/Crdt.h` · `Ids.h` | `Lww`, `ElementSet`, `Hlc`, `HlcClock`, the stamp codec |
| `products/roadmap/domain/Subgraph.h/.cpp` | `Subgraph`, `VersionVector`, `Gesture`, `frontier()`, `deltaBetween()` |
| `products/roadmap/domain/LooseGraph.*` · `Legend.*` · `GraphState.h` | the lattice, `join`, `deltaSince`, export/import of stamped state |
| `products/roadmap/domain/Command.*` | gesture vocabulary, `merge()`, `validate()`, `admit()` |
| `products/roadmap/application/TreeRoom.*` | `joinSubgraph`, `applyCommand`, `rename`, `importTree`, dedupe, broadcast, `diagnose` |
| `products/roadmap/adapters/ws/Collab.*` | the frame types, skew clamp, rate limit, subscribe/delta |
| `products/roadmap/adapters/json/SubgraphJson.*` | the envelope codec |
| `products/roadmap/adapters/postgres/` | the op row, the per-entry lattice tables, `node_progress` |
| `test/products/roadmap/domain/SubgraphTest.cpp` · `LooseGraphTest.cpp` · `LegendTest.cpp` | the convergence property tests |

**Frontend** (`web/src/products/roadmap/`)

| Path | Holds |
|---|---|
| `sync/lattice.js` | `Hlc`, `HlcClock`, `VersionVector`, `TreeLattice` (`join`, `deltaSince`, `frontier`, `toTreeData`), the wire codec |
| `sync/materialize.js` | the one place gesture semantics execute: gesture → stamped writes + inverse writes |
| `sync/SyncStore.js` | the IndexedDB store (§7) |
| `sync/SyncSession.js` | connect → subscribe → join delta → flush → live; backoff; `dispatch(gesture)` and `onTreeChanged` are the only seam the view talks to |
| `sync/progressLattice.js` | the private lane's replica (§12) |
| `sync/refusals.js` | how a `reject` code is read |
| `model/renderableGraph.js` | render coercion — not the backend `LooseGraph` |

## 10. Standing rules

- Arbitration is by wall clock, not by server order: a fast-within-clamp clock wins LWW races for
  up to five minutes. Keep-more is protected structurally (§2), not by clocks.
- A legend repair is an ordinary stamped write, so a double repair converges harmlessly.
- Tombstones are permanent in the persisted model. Trees are capped at 10k nodes / 20k edges.
- Over-send is always safe: join is idempotent, so a replica that re-sends covered content costs
  bandwidth and nothing else.

## 11. The two implementations of one algebra

The C++ and JS lattices implement the same laws twice. The JS surface is deliberately minimal —
registers, join, delta, projection, no command logic.

`backend/test/golden/` holds language-neutral fixtures stating the primitive laws: `hlc.json`
(the total order and the `0:0:` unset sentinel), `element-set.json` (add-biased life),
`version-vector.json` (coverage). **Nothing that ships reads them.** `run.mjs` checks them against
its own restatement of the semantics, and no build or workflow runs it. Each lattice is exercised
by its own suite instead — the C++ `domain` ctest binary, and the web tests under
`web/test/products/roadmap/sync/`. `backend/test/golden/SCHEMA.md` records what turning the corpus
into a real cross-language pin would take.

## 12. The private lane — progress

Progress is a second lattice, private to one account. Same registers, same clock, same outbox
law, same `join`.

- **One LWW register per node**, value `complete | active | none`, stamped. `none` is a *value*,
  not a deletion — a clear is an ordinary write, so "cleared on another device" converges with no
  cleared-array and no known-set diff.
- **One clock for both lanes.** The session's `HlcClock` stamps a progress write exactly as it
  stamps a structural one, so the two stay comparable. The §3 skew clamp applies unchanged.
- **The outbox is derived**: pending progress is `deltaSince(ackedProgressVector)`. An offline
  mark flushes on reconnect because it is uncovered.
- **Two lanes, one socket, never one frame.** A progress register must never enter a subgraph
  frame and a subgraph must never carry an overlay. They are separate frame types (`progress`,
  `progressAck`), and the server echoes progress only to the *same account's* other sessions.
  Collapsing them would publish one user's progress to every collaborator on the tree.
- A `progress` frame with `intent:"graft"` is the subscribe reply and **replaces** coverage; an
  echo only folds in.

### Stamps order; the server dates

An HLC's `physicalMs` is the writing device's clock. The skew clamp bounds it from above and
nothing bounds it from below — a phone a week behind mints a week-old stamp that orders perfectly
and reads as a lie. So every row also carries `markedAt`: the instant the **server** recorded the
mark, on its own clock, and the only value any surface may display. The HLC decides what wins;
`markedAt` decides what a human is told. **A device-local clock can support an omission, never an
assertion.**

`node_progress` stores `hlc`/`stamp_ms`/`stamp_counter` and its upsert applies a strictly-later
stamp — it is a LWW register store.
