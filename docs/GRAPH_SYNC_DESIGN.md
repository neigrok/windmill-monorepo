# Graph Sync — the Subgraph Framework

Status: design, approved direction. Pre-production, so this is written as the **target
architecture**, not a compatibility-preserving migration. We delete the old wire; we do
not bridge it.

> **Largely built; the paths below are pre-monorepo (checked 2026-08-05).** Read
> `src/skilltree/sync/` as `web/src/products/roadmap/sync/` — which exists, with
> `lattice.js`, `materialize.js`, `SyncStore.js` and `SyncSession.js` in it — and
> `test/domain/SubgraphTest.cpp` as `backend/test/products/roadmap/domain/SubgraphTest.cpp`.
> The shared golden corpus is `backend/test/golden/`. This document is kept for the design
> argument, not as a status record; `backend/NOTES.md`'s nine "Graph sync — Step N" sections
> are what actually landed, in order.

This document is the single source of truth for how a Windmill tree stays consistent
across the frontend, the backend, and — later — offline devices that edit while
disconnected and reconcile afterward.

---

## 0. The one idea

> **A subgraph is a partial, stamped, self-describing slice of a tree's lattice, and the
> only sync operation is `join`.**

Everything that moves between replicas is a subgraph being joined into a lattice:

| Scenario | What it is |
|---|---|
| A live edit | a one-gesture subgraph, sent immediately |
| An offline session, flushed | one coalesced subgraph, however many gestures |
| A reconnect catch-up | a delta subgraph computed against your version vector |
| A fresh device booting | the full-state subgraph |
| A `.windmill` file / AirDrop / QR handoff | a graft subgraph |

One envelope. One codec. One apply path (`join`). On every replica — the server's
`LooseGraph`+`Legend`, the browser's `TreeLattice`, a future native peer. Nodes, edges,
legend, and title ride it today; a future element kind (annotations, groups) is one more
keyed section of stamped records obeying the same two register laws — no new merge rule,
no new transport.

The reason this is achievable rather than aspirational: **Windmill already persists
exactly this shape.** `GraphState` + `LegendState` are lossless, stamped, tombstone-
carrying DTOs, and the Postgres `document` column already stores them (not projected
`TreeData` — the schema comment is stale, see `PgTreeRepository.cpp:32`). We are putting
the format Windmill already saves onto the wire, and adding the one primitive it lacks.

---

## 1. What exists today (the honest baseline)

The backend is already a real op-based CRDT. The frontend is not a CRDT at all.

**Backend — the convergent core is real and small (`domain/Crdt.h`, ~40 lines):**
- `Lww<T>` — a register that overwrites only on a strictly-greater HLC.
- `ElementSet` — add-biased life: `present() = addedAt.isSet() && !(removedAt > addedAt)`.
  An add tying a concurrent remove **wins**. This *is* "keep more, lose less", already
  implemented and persisted.
- `LooseGraph` = `map<NodeId, NodeRecord>` (an `ElementSet` life + five `Lww` fields) plus
  `map<Edge, ElementSet>`. Edge life is independent of node life; an edge survives its
  endpoints and is merely masked at read time (`liveEdges()`).
- `GraphState`/`LegendState` = the lossless stamped snapshot; `LooseGraph(GraphState)`
  reconstructs it; `exportState()` serializes it.

**The four gaps that block the vision:**
1. **No `join` primitive.** `LooseGraph(GraphState)` and `Legend(LegendState)` are
   constructors that *replace* (`nodes_[id] = record`). Merging a *partial* state does not
   exist anywhere. This is the single biggest missing piece; the per-field code in
   `Crdt.h` already does the right thing — it just isn't wired to state entries.
2. **The wire is one command per frame.** `{t:"cmd", kind, payload}` → server assigns
   `Seq`+HLC → `{t:"op", …}`. No atomic multi-object frame. Your motivating example
   already bites: a node delete fans out into `DeleteNode` + N separate `AddEdge` frames,
   observable mid-flight by peers (`SkillTreeView.jsx:487`).
3. **HLC is server-minted** as a fake Lamport tick (`Hlc{++tick_, 0, user}`,
   `Collab.cpp:159`), counter always 0, no wall clock. A client cannot author a causally
   meaningful edit offline.
4. **The frontend has no CRDT.** It optimistically mutates plain `TreeData` and
   *re-implements* every merge as a stamp-less `TreeData→TreeData` transform
   (`applyRemoteOp`, `SkillTreeView.jsx:323`; `edits.js`). No durable offline queue.

**Where convergence stops today, and why it's the crux:** command-level replay is *not* a
CRDT. `TransitiveReduction`, `RecolorKind`'s fan-out, `CreateNode`'s conditional parent
edge, and `AddKind`'s rank all read current state at apply time (`Command.cpp:19-50`).
Only their *materialized field-level effects* commute; replaying the *commands* in a
different order diverges. Any correct design must neutralize these — see §4.

---

## 2. The lattice and its guarantees

A tree's state is a finite product of independent registers:

```
Node   := ElementSet life  ×  Lww<label> × Lww<icon> × Lww<color> × Lww<position> × Lww<status>
Edge   := ElementSet
Kind   := ElementSet life  ×  Lww<hue> × Lww<label> × Lww<description> × Lww<rank>
Title  := Lww<string>
Tree   := Map<NodeId,Node> × Map<Edge,Edge> × Map<KindId,Kind> × Title
```

`join(local, incoming)` is defined pointwise and *only* pointwise: `life.add(createdAt)`,
`life.remove(deletedAt)`, then `Lww::merge(value, at)` per field. Unseen ids materialize
as latent records through the existing `operator[]` path, so no closure rule is needed for
correctness. A keyed map of semilattices with absent-entry-as-⊥ is a semilattice, and
padding a partial with ⊥ is join-neutral — **so joining a partial subgraph is joining a
full state**: commutative, associative, idempotent.

**The one precondition: no two distinct writes ever share a stamp.** `Lww`'s tie branch
keeps the incumbent, so a stamp collision between distinct writes would make merge
order-dependent. We make uniqueness true by construction (§3, multi-tab clause).

### "Keep more, lose less", stated honestly

The naive reading — "an add always beats a concurrent remove" — is *not* the real
guarantee under client wall clocks, and we should not pretend it is. Exact HLC ties
essentially never occur across replicas, so a genuine concurrent add-vs-remove resolves by
whichever stamp reads later. The add-bias is a tie-breaking footnote.

The guarantee we actually keep is **structural, and stronger than a coin-flip on the
clock**:

1. **A remove destroys nothing.** A tombstoned node keeps every field value; edges survive
   endpoint deletion (masked by `liveEdges()`); concurrent field edits on a deleted node
   land as latent writes; **any later re-add resurrects everything**, because the HLC
   receive rule (fold observed stamps before ticking) guarantees a re-add minted *after
   seeing* a tombstone dominates it.
2. **Deletion is only ever an explicit stamped tombstone** — never "delete by omission".
   Absence, at every granularity (section / entry / field), means *no information*.
3. So the phone-deletes-a-node-while-the-laptop-builds-five-children-under-it-offline heal
   leaves the laptop's hour of work **latent and fully resurrectable**, not gone.

Where algebra can't decide intent (two concurrent renames keep one label; a delete truly
races a build), we make the loss **visible and reversible** rather than silent: a new
`TreeDiagnostics` finding flags tombstones whose subtree shows substantial concurrent
activity ("masked live work"), and the UI offers one-click resurrection (a fresh re-add,
which by the receive rule dominates the tombstone). Keep-more is enforced by algebra where
the algebra can, and by a visible repair affordance where it can't. This is the honest
shape of the product principle.

---

## 3. Clocks: client-stamped HLC, server keeps time honest

**Clients mint stamps. The server is the well-connected, time-checking peer, not the clock
authority.**

- **Client clock** — one `HlcClock` per `TreeLattice` instance:
  `tick() = (max(wallMs, lastSeenMs), counter, actor)`, and `observe(stamp)` folds every
  remote stamp seen (excluding the `Hlc{}` sentinel) so a re-add always dominates a
  tombstone it has seen.
- **Actor = `userId#replicaNonce`**, nonce minted fresh at every `TreeLattice` boot (tab
  open, reload). Two tabs are two replicas; distinct actors never tie; there is **no
  persisted clock watermark** to share or corrupt. This is what makes the uniqueness
  precondition true even with five tabs open on the same account.
- **Server clock** — the fake `++tick_` is replaced by the same `HlcClock` fed wall time
  through the existing `Clock` port, with the receive rule on every inbound stamp. The
  server is still the *origin* for edits that have no lattice of their own: **MCP tool
  calls** and any server-authored change. Because all legacy persisted stamps have tiny
  `physicalMs` (they were logical ticks), every real wall-clock stamp dominates them —
  monotone and truthful, no data rewrite.
- **Skew clamp, never restamp.** The server refuses any frame whose max stamp exceeds
  `now + 5min` — whole-frame, transport-level, pre-join, with `{t:"skew", serverNow}`. The
  sender keeps its lattice intact, folds `serverNow` into its clock so *new* writes are
  clean, and retries. Since real time monotonically overtakes any finite skew, a mildly
  skewed flush is merely *delayed*, never rewritten. **Stamps are immutable from the moment
  they are minted** — this is the rule that makes the whole system safe.

**Seq stays, demoted from truth to tempo.** The server still mints a dense per-tree `Seq`
under the room strand (`TreeRoom`, unchanged). Seq orders broadcasts and the activity feed,
drives cheap `since()` tail replay, and detects live-plane gaps. **Seq is never a merge
input** — replicas applying the same frames in any order reach the same lattice point.
Convergence belongs entirely to the HLC lattice. Two indices, one truth.

---

## 4. Gestures materialize to writes at the origin (the crux)

The rule that dissolves the "commands don't commute" problem:

> **Every compound gesture is materialized to stamped field-writes at the origin, at the
> moment the user acts, against the state the user was looking at. Commands never cross a
> replica boundary — only lattice effects do.**

- delete-with-splice → the tombstone write **plus** the concrete re-tether edge writes, in
  one frame.
- `RecolorKind` → the kind's hue write **plus** the N `color` writes for nodes wearing the
  old hue, in one frame.
- `TransitiveReduction` → the concrete edge-remove writes.
- `CreateNode` → the node writes **plus** the parent-edge write.
- `AddKind` → the kind writes including a concrete `rank` value (ties broken
  deterministically by the ordering projection, below).

Whoever authors is the origin: the browser for user gestures, the server for MCP tools.
This collapses a whole class of bugs — the delete-then-N-edges race, the concurrent-recolor
divergence — into ordinary, commutative lattice writes. It also makes the delete/recolor
gesture **wire-atomic**, which it is not today.

`Command` survives, but changes role: it is now the **gesture descriptor** (the vocabulary
of what a user did — used for the activity feed, animation, and undo grouping), not the
unit of convergence. `merge(command)` becomes `materialize(gesture, lattice) → { writes,
inverseWrites }`, the single home of gesture semantics on each side.

**Legend caps become diagnosis, not refusal.** Nothing on a sync path is ever refused for
content — merge-everything-diagnose-separately now covers the legend too. Enforcement moves
to three places that cannot cause divergence: (a) mint-side pre-flight — the client hides
the "add kind" affordance when six already exist locally; (b) post-join diagnostics —
`diagnose()` reports kind overflow, hue duplicates, cap overages; (c) a **deterministic
display projection** for a breached state — kinds ordered by `(rank, createdAt, id)`, first
six active, hue duplicates resolved to earliest `createdAt` — rendered bit-identically on
both sides and covered by shared golden vectors. The only hard refusals anywhere are
transport-edge and content-free: the frame byte cap (DoS) and the skew clamp — both
whole-frame, pre-join, and non-lossy (sender keeps everything and retries).

---

## 5. The wire contract

One envelope, identical as a WebSocket frame, HTTP body, op-log payload, and `.windmill`
file:

```json
{
  "t": "subgraph",
  "v": 1,
  "treeId": "t_9362d9bc883e0a1e",
  "frameId": "f_01HZXK7Q...",           // client-minted idempotency key = op_id
  "actor": "u_42#r_8f31c2",
  "intent": "live",                      // live | flush | delta | graft
  "gestures": [                          // descriptive: feed / animation / undo grouping
    { "id": "g_7", "kind": "deleteNode", "label": "Shaders" }
  ],
  "nodes": [
    { "id": "n_shaders",
      "createdAt": "1770000000123:0:u_42#r_8f31c2",
      "deletedAt": "1770000108551:0:u_42#r_8f31c2",
      "label":    { "v": "Shaders", "at": "1770000000123:1:u_42#r_8f31c2" },
      "color":    { "v": "moss",    "at": "1770000000123:3:u_42#r_8f31c2" } }
  ],
  "edges": [ { "from": "n_gl", "to": "n_child", "addedAt": "1770000108551:1:u_42#r_8f31c2" } ],
  "kinds": [],
  "title": null,
  "coverage": null                       // non-null ONLY on intent:"delta" (see §6)
}
```

Rules, all load-bearing:

- Stamps use the existing `"physicalMs:counter:actor"` text encoding. **`Hlc{}` is encoded
  by omitting the field.** An absent entry / field / section contributes nothing to a join.
- `intent`: `live` = one gesture now; `flush` = a coalesced offline session (chunked over a
  shared `flushId` if over the byte cap); `delta` = anti-entropy payload, the *only* intent
  allowed to carry a `coverage` vector; `graft` = state-only (files, imports, gifts).
- `frameId` stores as `op_id` under the existing `UNIQUE(tree_id, op_id)`.
- **No frame can delete by omission** — deletion is always an explicit stamped tombstone.

Companion frames:

- `{t:"subgraphAck", treeId, frameId, seq, vector}` — the server's authoritative post-join
  frontier. A duplicate `frameId` **re-acks with the original seq** (no head bump), fixing
  today's duplicate-silence and the `head_` desync.
- `{t:"subscribe", treeId, lastSeq, vector}` and `{t:"caughtUp", head, vector}`.
- Server broadcast = the sender's frame **byte-identical plus `seq`**. The server never
  re-stamps or re-materializes a client's content; echoes are joined (idempotent no-op),
  never suppressed — so drift cannot hide behind a `sent`-set.

MCP tools and the HTTP bootstrap ride the same envelope: `GET /trees/{id}/state` →
stamped-state response; `POST /trees/{id}/subgraph` → a subgraph request. The stamped state
finally crosses the wire, which is what lets a fresh device or an agent bootstrap.

---

## 6. Reconnect and anti-entropy

**The coverage rule (the heart of correctness).** A replica's version vector — per-actor
max `(physicalMs, counter)` — advances through exactly two channels:

1. A **delta frame** the counterparty computed against the vector *you sent it* this
   exchange.
2. An **ack vector** for content the counterparty durably joined.

Everything else — live frames, third-party flushes, grafts, files — joins state **without
touching coverage**. A receiver that drops any portion of a frame (unknown section, apply
failure) must not adopt its coverage or advance `lastSeq` past it.

This single rule kills the whole "vector poisoning" family of silent-divergence bugs,
including the sharpest one the panel raised: *a live broadcast is dropped app-side, the next
frame from the same author advances the receiver's vector past the dropped stamp, and every
future anti-entropy exchange treats the hole as covered.* Under our rule, live frames move
only `lastSeq`, never the vector; and because `Seq` is **dense**, the dropped frame is
detectable — the next broadcast arrives with `seq ≠ lastSeq+1`, triggering a `since()` tail
or a delta. There is no path on which coverage outruns content.

**Reconnect, in order:**

- **Short gap** (`0 < lastSeq ≤ head`, tail retained): per-frame `since()` replay exactly
  as today (subgraph rows replay as joins — order-safe, gap-tolerant, duplicate-safe),
  terminated by `caughtUp`. Then the client flushes `deltaSince(ackedServerVector)`. This
  is why we keep dense seq: the common short reconnect stays O(gap), not O(state).
- **Long gap / fresh device / fork with empty log:** the server computes
  `deltaSince(clientVector)` **from the document/lattice alone** (no log-to-genesis
  assumption) and ships one `intent:"delta"` frame with coverage. This retires the
  collapsed, stamp-stripped snapshot — the last destructive path in the system.
- **Upstream:** the client flushes its pending delta; the server joins under the strand as
  one seq'd row.

Two rounds and both frontiers are equal — textbook anti-entropy, correct under arbitrary
interleaving with live traffic. The tree's frontier is maintained incrementally in
`TreeRoom` and persisted **in the same transaction** as the document snapshot.

**The lattice is the outbox.** Offline, there is no separate queue to bound, corrupt, or
lose. The pending payload is *derived*: `lattice.deltaSince(ackedServerVector)`. A whole
offline session flushes as one frame, routing around the 50-frames/s limiter and the 10k
`since()` cap. Crash between flush and ack: re-derive, re-send the same `frameId`, durable
dedup re-acks. Idempotent by two independent layers.

---

## 7. Device-to-device (the future, for free)

Convergence needs only `(exchange vectors → compute delta → join)`, and every replica
implements all three. So D2D is a *transport addition*, not a second sync system:

- **Paired live sync** (WebRTC data channel, server does signaling only): the identical
  subscribe/delta/ack exchange. No seq travels — seq stays the server-peer's bookkeeping.
- **Sneakernet** (`.windmill` file, QR): the same envelope with `intent:"graft"`,
  **state-only**, never advancing the importer's vector (poison-proof; the harmless cost is
  over-send on the next server exchange). Tombstones travel, so even deletions sync by
  AirDrop.
- **Subtree gift / cross-tree import:** a graft whose entries are **restamped as fresh local
  authorship at import** (foreign stamps must never enter a different tree's coverage
  space), with node-id remap and a kind-mapping step (color-is-kind, so imported colors are
  consciously mapped).
- Importers apply the same 5-minute clamp locally; the server remains the sole durability
  gate and write-authority; progress never travels D2D; export is refused while a lattice
  holds over-clamp stamps (export quarantine).

The server ends as the best-connected, only-durable, seq-minting peer — demoted for
convergence, irreplaceable for everything else.

---

## 8. Concrete changes

### Backend (no new top-level directory; the hexagonal grammar already has homes)

- `domain/Ids.h` — add `HlcClock` beside `Hlc` (`tick`, `observe`, sentinel-excluding);
  move the `"ms:counter:actor"` parse/encode here so wire and persistence share one impl.
- `domain/Subgraph.h/.cpp` — the feature's one domain file (abstraction + all its data
  structures): `Subgraph{treeId, frameId, actor, intent, optional<Lww<string>> title,
  GraphState graph, LegendState legend, vector<Gesture> gestures, optional<VersionVector>
  coverage}`; `VersionVector{marks; covers; observe; join}`; `Gesture`; free
  `deltaBetween(const LooseGraph&, const Legend&, const VersionVector&)`.
- `domain/LooseGraph.h/.cpp` — `void join(const GraphState&)` beside the replace-constructor
  (~30 lines, pointwise merges through `operator[]`); `GraphState deltaSince(const
  VersionVector&) const`; `VersionVector frontier() const`, maintained incrementally.
- `domain/Legend.h/.cpp` — the same trio, plus the deterministic breached-state projection.
- `domain/Command.h/.cpp` — `merge()` becomes `materialize()` returning a
  `vector<FieldWrite>` (grouped in `Command.h`); used by the server-origin path (MCP).
- `application/TreeRoom.h/.cpp` — `joinSubgraph(const IncomingSubgraph&)` beside `submit()`,
  inheriting the skeleton: dedupe `frameId` (dup → re-ack original seq, **no head bump**) →
  `graph_.join` + `legend_.join` → `++head_` → append one subgraph row → broadcast →
  `diagnose()` (extended with legend breaches, cap overages, masked-live-work). DTOs grouped
  in `TreeRoom.h` beside `Incoming`.
- `adapters/ws/Collab.h/.cpp` — wall-clock `HlcClock` replaces `++tick_`; receive rule;
  skew clamp; `subgraph`/`subgraphAck`/`caughtUp` frames; subscribe gains `{vector}`; frame
  byte cap + permessage-deflate.
- `adapters/json/SubgraphJson.h/.cpp` — the envelope codec beside `TreeJson`, reusing its
  entry encoders verbatim (wire = document format); omit-when-unset lives here only.
- `adapters/postgres` — one method appending the subgraph row + document snapshot +
  `trees.frontier jsonb` in **a single transaction** (closing today's uncoordinated pair);
  flush joins force an immediate snapshot so `since()` windows never hold a monster row;
  `op_id` doubles as `frameId` — no dedup schema change.
- `adapters/http` — `GET /trees/{id}/state` → `SubgraphStateResponse`;
  `POST /trees/{id}/subgraph` accepting `SubgraphRequest`.
- `adapters/mcp` — RoadmapTools route through the server-origin materializer; each tool call
  becomes one gesture-framed subgraph through `joinSubgraph`.
- Progress (later): `PgProgressRepository` stops hard-DELETE on clear — status becomes a
  stamped LWW value including `none`; a per-user progress mini-lattice syncs on its own
  private channel, never entering the shared document.
- `test/domain/SubgraphTest.cpp` + LooseGraph/Legend extensions: property tests (join
  commuted / reassociated / duplicated), add-beats-concurrent-remove through round trips,
  tombstone+edit coexistence, `deltaSince∘join` closure — plus the **shared golden-vector
  corpus** (JSON fixtures executed by *both* the C++ and JS suites: HLC compare, tie rules,
  sentinel handling, join outcomes, legend projection). This corpus is load-bearing.

### Frontend (one new feature package)

- `src/skilltree/sync/` — owns convergence, its serialization, and its transport:
  - `lattice.js` — abstraction + data structures: `Hlc`, `HlcClock`, `lwwMerge`/
    `elementSet` (identical add-bias predicate), `VersionVector`, and `class TreeLattice`
    (per-field-stamped records; `constructor(subgraph)`, `apply(writes)`, `join(subgraph)`,
    `deltaSince(vector)`, `frontier()`, `toTreeData()` with `liveEdges` masking → feeds the
    untouched strict-`SkillTree` → `makeRenderable` pipeline). Wire codec lives here.
  - `materialize.js` — the single place gesture semantics execute: each of the 15 gestures
    → stamped writes + inverse writes, grouped under one `gestureId`. **`edits.js`'s
    TreeData transforms retire into this file**, not beside it — one encoding of splice/
    fan-out/tidy in the whole frontend.
  - `SyncStore.js` — IndexedDB behind the injectable-storage constructor: per-record
    **join-writes** (read-join-put in one IDB transaction — racy tabs can only *add*
    information), plus `{ackedServerVector, lastSeq, gestureJournal}`. Content persists
    before any vector/lastSeq that claims it (crash errs toward over-send). Calls
    `navigator.storage.persist()`; surfaces non-persistent storage honestly.
  - `SyncSession.js` — the pipeline: connect → subscribe → drain tail / join delta →
    caughtUp → flush → live; exponential backoff; exposes `dispatch(gesture)` and
    `onTreeChanged` as the only seam `SkillTreeView` talks to. `CollabClient` inlines here.
- `SkillTreeView.jsx` — the ~15 commit-then-send call sites collapse onto
  `syncSession.dispatch(gesture)`; `applyRemoteOp`'s 13-kind switch is replaced by
  `lattice.join(frame)` → `editor.commit(lattice.toTreeData())` through the **untouched**
  `syncStructure` seam. Live frames and reconciliation deltas become one code path. This is
  the largest regression surface — deliberately staged (§9).
- `model/looseGraph.js` → **`renderableGraph.js`** (rename only; resolves the collision with
  the backend `LooseGraph` — this file is render coercion, unchanged role).
- `sync/lattice.test.js` mirrors the backend property tests and runs the same golden corpus.

---

## 9. Build order

Not a compatibility migration (we're pre-production) — a **dependency order**, each step
independently valuable and de-risking the next.

- **1 — Lattice primitive (dark).** `join` / `deltaSince` / `frontier` on
  `LooseGraph`+`Legend`, `Subgraph` + codec, `VersionVector` / `HlcClock`, property tests +
  golden corpus, transactional append+snapshot, truthful duplicate re-acks. Frontend:
  `renderableGraph.js` rename; `lattice.js` lands with tests, unused. *Standalone win:
  fork/import stops being destructive. The join is proven before it carries weight.*
- **2 — Server clock epoch.** Wall-clock `HlcClock` replaces `++tick_` for all server-minted
  stamps (WS, MCP); receive rule on inbound; `trees.frontier` maintained transactionally.
  *One HLC domain before two writers exist.*
- **3 — Lattice is truth, wire goes subgraph.** `dispatch` seam; `TreeData` becomes a
  projection; `edits.js` transforms retire; client-stamped `live` frames upstream (skew
  clamp active); verbatim broadcast; echo-as-join; client-owned undo journal; gesture-
  grouped activity. Delete-with-splice and recolor become wire-atomic. **Delete the old
  `cmd`/`op` wire.** *The big cutover.*
- **4 — Durable offline, one device.** `SyncStore` on IndexedDB (join-writes, write-ordering
  rule), reconnect/backoff, subscribe `{lastSeq, vector}`, derived-delta flush +
  `subgraphAck`/`caughtUp`, seq-gap detection. *Author on the train, flush at the station,
  survive crash and reload.*
- **5 — Anti-entropy both ways.** Server delta path replaces the collapsed-snapshot
  fallback; two-way exchange on subscribe; chunked flush; vector pruning. *Multi-device
  same-account offline converges; the last destructive path dies.*
- **6 — Stewardship.** Legend repair UX over the deterministic projection; masked-live-work
  resurrection prompts; cap advisories; storage-pressure surfacing; grouped offline-session
  feed entries. *Scheduled immediately after step 5 — it's a launch dependency of
  multi-device, not a nice-to-have.*
- **7 — Private overlays.** Progress: tombstoned stamped status (no hard-DELETE), per-user
  mini-lattice channel; workspaces off localStorage the same way.
- **8 — Device-to-device.** `.windmill` graft export/import (restamp-on-cross-tree, local
  clamp, export quarantine), WebRTC behind `SyncSession`, per-peer vector memory. *Pure
  transport reuse of step 1's protocol.*

Because we are pre-production, an optional **shadow assertion** (dev-mode diff of
`lattice.toTreeData()` against editor state on every commit) is a cheap debugging aid during
step 3 — worth wiring, not worth a whole phase.

---

## 10. Risks and rulings

1. **Two implementations of one algebra (C++/JS).** The permanent tax of any offline
   design. *Ruling:* the golden corpus is a release gate in both CIs; the JS surface is
   deliberately minimal (registers, join, delta, projection — no command logic); any corpus
   change requires both suites green in one PR.
2. **Wall-clock arbitration replaces server-order arbitration.** A fast-within-clamp clock
   wins LWW races for up to 5 minutes. *Ruling:* accepted and disclosed; inherent to offline
   LWW; bounded by clamp + receive rule; keep-more protected structurally (§2), not by
   clocks.
3. **Keep-more UX erosion on delete-vs-build races.** Convergent but potentially surprising.
   *Ruling:* masked-live-work diagnostic + one-click resurrection ships in step 6, treated as
   a launch dependency of step 5.
4. **Legend/caps loosen from refusal to diagnosis.** A joined tree can transiently show 7
   kinds. *Ruling:* accepted product decision; the deterministic projection guarantees both
   sides render identically until a human repairs it.
5. **Frontend migration mass** (`SkillTreeView`, undo, echo). *Ruling:* the largest surface;
   the optional shadow assertion in step 3 buys evidence.
6. **IndexedDB eviction** can silently demote durability. *Ruling:* `storage.persist()`, an
   explicit unsynced-changes indicator, flush-early; never claim durability the browser
   didn't grant.
7. **Big flush payloads.** *Ruling:* chunked flush over `flushId`, forced snapshot at each
   flush seq, lazy activity rendering.
8. **Vector growth** (one actor entry per tab-boot). *Ruling:* server prunes entries
   dominated by the snapshot frontier at every ack; over-send is absorbed by join. A
   frontier index is the escape hatch, not a prerequisite.
9. **Tombstone accumulation / distributed GC.** *Ruling:* deferred; trees are capped at
   10k/20k and tombstones are already permanent in the persisted model; revisit on
   measurement.

**Open questions (with recommendations):**
- *Repair authority for legend breaches* — any online device of the owner account prompts;
  repairs are ordinary stamped writes, so double-repair converges harmlessly.
- *Offline legend authoring* — allow renames/recolors offline; gate *adding* a kind offline
  until step 6's repair UX ships, then open it.

---

## 11. Why this is the beautiful shape

One noun (`Subgraph`) where nouns live. One verb (`join`) implementing every sync scenario.
One codec shared with persistence. One gesture-semantics encoding per side. Coverage as a
typed wire capability instead of a bookkeeping accident. A server whose elegant seq
discipline survives intact — demoted from truth to tempo. The convergence argument never
grows beyond the forty lines of `Crdt.h` that already guard every persisted tree; we are
not adding a CRDT, we are finishing the one that is already here and giving the frontend its
missing half.

---

## 12. The private lane — progress joins the lattice

Everything above describes the **shared** lane: one document, many collaborators, one
broadcast. Progress never got onto it. It rides the same socket but not the same law — the
server mints its stamp on arrival, so a mark made offline has no stamp at all until it
lands, and "did the server already hear this?" cannot be asked of the mark itself. The
answer was a diff: the client compared its local marks against a freshly-read server
overlay and pushed what was missing, with a localStorage copy standing in as the queue.
That worked, and it produced two bugs in one afternoon — a resurrection rule written in
prose instead of falling out of a merge, and a local copy that lagged the server it had
just synced with.

**Progress becomes a second lattice in the same document, private to one account.** Not a
new mechanism: the same registers, the same clock, the same outbox law, the same `join`.

- **One LWW register per node**, value `complete | active | none`, stamped. `none` is a
  *value*, not a deletion — so a clear is an ordinary write and the tombstone is free. This
  is what makes "cleared on another device" converge on its own, with no `cleared` array
  and no known-set diff.
- **One clock for both lanes.** The session's `HlcClock` stamps a progress write exactly as
  it stamps a structural one, so the two stay comparable — which the server already assumed
  (`progress shares the tree's clock so its LWW stays comparable`), it just minted the stamp
  at the wrong end. The §3 skew clamp applies unchanged.
- **The outbox is derived, not kept.** Pending progress is `deltaSince(ackedProgressVector)`,
  the §6 law verbatim. There is no queue to lose, and an offline mark flushes on reconnect
  because it is uncovered, not because someone diffed it.
- **Two lanes, one socket, never one frame.** A progress register must never enter a
  subgraph frame and a subgraph must never carry an overlay: they are separate frame types,
  and the server echoes progress only to the *same account's* other sessions. Collapsing
  them would publish one user's progress to every collaborator on the tree — the whole
  reason the overlay is a separate resource (§1 of SPEC).

### Stamps order; the server dates

An HLC's `physicalMs` is the **writing device's** clock. The skew clamp bounds it from
above (`now + 5min`) and nothing bounds it from below — a phone a week behind mints a
week-old stamp that orders perfectly and *reads* as a lie. So every row also carries
`markedAt`: the instant the **server** recorded the mark, on its own clock, and the only
value any surface is allowed to display. The HLC decides what wins; `markedAt` decides what
a human is told. A device-local clock can support an omission, never an assertion.

### What this deletes

The known-set diff, the reconcile-on-graft, the claim-time push, the `server: true/false`
flag, the load-time precedence merge, the write-back, and `ProgressStore` itself — the
overlay persists in the same blob as the structure, so the account hand-off has one place
to wipe instead of two.

### Migration

`node_progress` already stores `hlc`/`stamp_ms`/`stamp_counter` and its upsert already
applies a strictly-later stamp — it has been a LWW register store all along. Legacy rows
carry server-minted stamps with real wall time, so a client stamp neither dominates nor is
dominated by accident: it is the same monotone-overtake argument as §3's legacy ticks. No
data rewrite.
