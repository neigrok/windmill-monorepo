# Windmill Backend — running notes

## For you: frontend contract drift (handle later)

`SPEC.md` §2 names `windmill-frontend/src/skilltree/model/ports.js` as "the contract",
but that JSDoc typedef has drifted from the code the app actually runs:

- **Colors.** `ports.js` `NodeColor` lists 5 (`terracotta|olive|gold|sky|brick`). The
  real set is 6 — `theme.js` `NODE_COLOR_NAMES` includes `plum`. SPEC (and this backend)
  follow `theme.js`.
- **`status` field.** `ports.js` `NodeSpec` omits `status`, but `mock/roadmapTree.js`
  nodes carry `status: 'complete'` (an authoring-time seed; runtime status is per-user
  via `Progress`). SPEC treats it as an optional authoring seed.

Action for the frontend: make `theme.js` `NODE_COLOR_NAMES` the single source of truth
for the color set and patch the `ports.js` typedef (add `plum`, add optional `status`).
The backend's `NodeColor` enum already uses the 6-color set; boundary JSON parsing will
map unknown color strings to a rejected/flagged value.

## Task log

- [x] SPEC.md v2: pivot to loose-graph + diagnostics, CRDT-lite convergent ops, JSONB
      document as source of truth (see git history / SPEC).
- [x] **Domain core**: Ids/Hlc, Tree types, LooseGraph (CRDT merge), Command
      (merge + invert), TreeDiagnostics (Tarjan). 18 tests green (`build/windmill_domain_tests`).
- [x] Domain: SkillTree validated projection + TrunkTree + UnlockRules + TreeHealth
      ports (faithful to the JS). 30 tests green total.
- [x] ports/ interfaces: OpLog, PresenceBus, TreeRepository, ProgressRepository, Clock
      (auth/share ports come with their phases).
- [x] application/TreeRoom: merge → seq → persist → broadcast; never rejects; idempotent
      by opId; diagnose(). 34 tests green total.
- [x] application/ RoomRegistry (load/evict), ProgressService (P1 advisory, P2
      structural), UndoService (per-user inverse stacks; undo never rejected).
      44 tests green total.
- [x] adapters/ Phase 0 (Drogon HTTP + libpqxx Postgres): schema, jsoncpp codec,
      Pg{Tree,Progress}Repository, HttpApi, infra/main.cpp, guarded CMake. **Built and
      verified end-to-end** against real Postgres: PUT/GET a document, GET progress, and
      a cyclic PUT accepted + reported by /diagnostics. See RUNNING.md.
      - Only blind-code fix needed: libpqxx 7 `result[i]` yields `row_ref`, not `row&`
        (used `auto`). Everything else (Drogon registerHandler arity, jsoncpp Int64,
        `libpqxx::pqxx` target) was correct.
      - Gotcha: Docker Desktop owns :8080 → run with `PORT=8088`.
- [x] Frontend wired (Phase 0 exit): `HttpTreeRepository` in windmill-frontend swaps in
      for `MockTreeRepository` on the demo dataset; browser loads the dogfood roadmap +
      progress from the backend (verified: GET tree/progress → 200, no console errors,
      scene renders). Needed backend additions: `NodeSpec.status` passthrough (opaque
      authoring seed, so the roadmap's statuses survive) and dev CORS in main.cpp.
- [x] Phase 2 core (built + verified live): CommandJson codec, PgOpLog (tree_ops
      append/since), WsPresenceBus (per-tree fanout), Collab coordinator, Drogon
      TreeSocket at `/v1/socket`, RoomRegistry wired into main. Verified with a raw-WS
      two-client test: subscribe→snapshot, cmd→merge→seq→persist→broadcast→ack, dup opId
      deduped, cycle-forming edge accepted, both clients see ops live.
- [x] Phase 2 edges tightened (verified through a real server restart):
        - **Snapshot + tail-replay load** (`RoomRegistry::open` → `TreeRoom::replay`):
          reopening a tree seeds from `trees.document` then replays the `tree_ops` tail
          to the true head. Fixes a latent bug — reopening from a lagging document left
          `head` behind the log, so the next op collided on the `(tree_id, seq)` PK.
        - **Reconnect replay** via `lastSeq`: `Collab::subscribe` ships only ops since
          the client's seq (no full snapshot) when it's caught up enough.
        - **Per-tree strand**: `Collab` now locks a per-tree mutex (one writer per tree,
          §11) instead of a global lock; `RoomRegistry` is internally thread-safe.
- [x] Reads go through rooms: `HttpApi` GET tree/diagnostics now open the room and
      return its live state (reflecting socket edits), and the per-tree strand moved to
      `RoomRegistry::strandFor` so HTTP reads and WS commands serialize together (fixes a
      latent read/write race). PUT evicts the room so the next open reloads the write.
      Verified: a socket-only `CreateNode` is visible on the next HTTP `GET`.
- [x] **Full-CRDT-state persistence**: `LooseGraph::exportState()`/`LooseGraph(GraphState)`
      serialize the complete state (per-field + element-set HLC stamps, tombstones, inert
      edges). `trees.document` now stores `GraphState` JSON, not the `toTreeData`
      projection, so reload is lossless. `status` became a first-class `LooseGraph` field
      (fixing the regression where routing GET through rooms dropped it). A **snapshot
      cadence** persists full state every 25 ops (`Collab` → `RoomRegistry::persist`), so
      op-log replay on open is bounded. Verified live: roadmap migrated (42/42 status
      restored), doc carries stamps, and 25 socket ops persisted `head_seq=25` with no
      eviction. Domain test proves a delete+resurrect survives a full-state round-trip.
      Note: the document format changed (TreeData → GraphState); old docs must be re-PUT
      to migrate (done for the roadmap; junk scratch trees left as-is).
      Remaining Phase 2 polish:
        - presence relay implemented (broadcastRaw) but not yet exercised.
        - frontend still loads over HTTP (Phase 0); no live WS editing in the browser yet.
- [ ] Frontend save path (PUT) would need CORS preflight/OPTIONS fixed — Drogon's
      built-in OPTIONS handling currently reports only `OPTIONS` in allow-methods. Load
      (GET) is a simple request and works; revisit when the frontend writes over HTTP.
- [x] **Progress write-path (Phase 2 edge)** — the "should work but doesn't" is closed.
      A `{t:'progress'}` socket frame now records the caller's private overlay and echoes
      to their *other* sessions (not collaborators, §6). Path: `Collab::progress` →
      `ProgressService` → `PgProgressRepository`, written as the fixed `dev` user (the same
      user HTTP `GET /progress` reads back), so a mark survives reload. **ProgressService
      was decoupled from `SkillTree`**: its advisory P1 check now takes the node's
      prerequisites (from `TreeRoom::prerequisitesOf` → `LooseGraph::nodeView`, live edges),
      so progress works on an unclean/cyclic graph — honoring §3 "progress never blocks on
      collaborators." Frontend: `CollabClient.sendProgress`/`onProgress`, `handleStart`/
      `handleMarkComplete` emit the frame, `applyRemoteProgress` folds echoes into the two
      id sets. **`HttpTreeRepository.loadProgress` now overlays server progress on the
      document's authoring seeds instead of replacing them** — so marking one node no longer
      wipes the ~47 seeded "deed" completions on reload. Verified: (1) raw two-client WS —
      write persists, echoes to the second session, sender excluded, `none` clears the row;
      (2) real Postgres row under `dev` + HTTP read-back matches; (3) in-browser, the real
      `loadProgress` overlaid a socket-written `presence→complete` (47→48) with `renderer`
      (a seed) still complete. 51/51 domain+app tests green.
      Note — the frontend gained a parallel `ProgressStore` (localStorage) in the same
      window; the two layers compose cleanly: `loadProgress` (seed + server overlay) is the
      baseline, the local store wins when present (same-origin tabs share it), and the
      server path is the cross-session backing + the live `onProgress` echo. Full
      cross-device coherence (a live echo persisting into another device's local store) is
      a Phase-1 reconciliation, not a Phase-0 need.

- [x] **Presence (Phase 2 edge, full-stack).** Class C presence (§5) landed as a
      self-contained `PresenceHub` (adapters/ws): each participant's latest cursor/selection
      is buffered and flushed to the tree's *other* participants at 20 Hz (one
      `getLoop()->runEvery(0.05)` timer, latest-wins per actor, deltas only — §12), so a
      60 Hz cursor stream costs ≤ 20 frames/sec per peer. Join/leave are announced as `peer`
      frames (with an assigned profile — one palette colour + "Guest N" per actor until
      accounts land) and the newcomer gets the current roster + live cursors replayed.
      `Collab` now routes `presence` → `hub.update`, `subscribe` → `hub.join`, close →
      `hub.leave` (replacing the raw relay). Frontend: `CollabClient.sendPresence`
      (trailing-throttled ~25 Hz) / `onPresence` / `onPeer`, and a **new isolated
      `presence/PresenceLayer.jsx`** — a DOM overlay that projects each peer's world cursor
      to screen on its own rAF loop (never through React) and forwards our pointer as world
      coords; `SkillTreeView` only mounts it + fills a `peersRef` from the frames.
      Verified: raw two-client WS — bidirectional peer join/leave, 30 rapid moves coalesced
      to ~4–5 frames at 20 Hz, latest cursor+selection carried; live browser tabs registered
      cursors on the server (send path). **Not yet visually confirmed:** remote-cursor
      *rendering* in a foreground tab — the local browser session was churning tabs and
      background tabs pause rAF, so the overlay's draw loop slept during automated checks
      (a test artifact, not a logic bug — worth a 30-sec two-tab glance to confirm).

- [x] **Activity feed (Phase 4).** `GET /v1/trees/:id/activity?since=&limit=` → `{events[]}`,
      a human feed projected from `tree_ops`. `application/ActivityFeed.{h,cpp}` is a **pure
      function** `activityFeed(current, ops, limit)`: it maps each op to a verb
      (added/renamed/recolored/removed/linked/unlinked/rerouted/tidied — position nudges
      dropped), denormalizes the subject's current label/kind, humanizes the actor
      ("You"/"Guest N"/tree), and — when the graph is clean — annotates a cross-branch edge
      via `TrunkTree.edgeKind` (§9). Each event ships a ready `summary` sentence so an
      un-updated UI still renders. The Action (`HttpApi::getActivity`) loads the room
      snapshot + `OpLog::since` and calls the projection — repos-in, domain-shapes, boundary
      serializes (CLAUDE.md's Action→domain→persist shape). Needed `AppliedOp.createdAtMs`
      (a real wall-clock stamp: the HLC's `physicalMs` is a tick counter, not time), which
      `PgOpLog::since` now reads from `created_at`. Verified live against the roadmap's 7
      ops (verbs/actors/timestamps, `since`/`limit` cursoring, 404/400) + 2 pure unit tests
      (53/53 green). The frontend `ActivityFeed` UI is ready to fetch this.

## CRDT semantics decisions (domain)

- **Nodes and edges are LWW-element-sets, add-biased.** Each element carries an
  `addedAt`/`removedAt` HLC; present iff `addedAt` set and `addedAt >= removedAt` (ties
  → add wins). This honours the "add-wins" call using only the HLC already on every op —
  no per-op tags or version vectors, which the central-server + no-offline model makes
  sufficient. Strict OR-Set add-wins (survive a *later* concurrent remove) is a future
  tightening if real usage needs it; noted, not built.
- **Scalar fields (label/color/position) are LWW registers** keyed by HLC (`>` wins).
- **Delete is a node tombstone only.** Edges are never removed by delete — they go inert
  (present in the set but filtered from the derived DAG view when an endpoint is absent),
  so undo-recreate revives them for free and add-wins resurrection works.

## Color legend (F6) — design decisions

- **The legend is a sibling CRDT, not folded into `LooseGraph`.** `domain/Legend.h`
  holds `Legend` (an add-biased element-set of kinds, each field an LWW register, plus a
  `rank` register for order) alongside the graph. `TreeRoom` owns both `graph_` and
  `legend_`; `merge`/`invert`/`validate` take *both*, because `RecolorKind` is the one
  command that spans them (swap a kind's hue **and** repaint every node wearing the old
  hue). Keeping `LooseGraph` pure (topology only) and `Legend` pure (the ordered kinds)
  earns each module one reason to exist; the coupling lives only in the command layer that
  already coordinates everything. `Lww`/`ElementSet` moved to `domain/Crdt.h` so both
  aggregates share the primitives without one depending on the other.
- **Legend commands are validated at the edge — a deliberate break from "never reject".**
  Graph validity (cycle-freedom) is a cross-client property no one can check alone, so the
  graph merges everything and *detects* problems in a read model. Legend invariants (hue
  unique, ≤6 kinds, no in-use removal, label ≤24 / description ≤80) are **locally decidable
  on the authoritative state**, so `validate(graph, legend, cmd)` runs at each write edge
  (`Collab::command`, MCP `applyEdit`) and refuses with a `reject` frame / tool error. The
  domain `merge` stays unconditional LWW — validity is enforced *before* admission, never
  inside merge — so server-driven undo/redo (trusted, replays inverses) bypasses it safely.
- **`RecolorKind` is atomic and cleanly self-inverting.** Because a free hue is never worn
  by a node (RemoveKind is blocked while in use, so hue↔kind stays 1:1), recoloring to a
  free hue repaints exactly the old-hue nodes, and the inverse is just `RecolorKind{id,
  oldHue}`. No compound repaint list, no orphan-node edge case. (RemoveKind's inverse *is*
  compound — AddKind + Rename + Describe + a full ReorderKinds — to restore the kind to its
  original slot; ranks are LWW doubles so the replayed reorder wins on a fresh HLC.)
- **Legacy trees return `kinds: []`; the client derives.** The backend seeds the three
  defaults only on genuine tree *creation* (first PUT of an id); a PUT without kinds to an
  existing tree preserves its legend. No server-side derive-on-read — spec permits `[]`,
  and it sidesteps the instability where deriving from node colors shifts as nodes get
  repainted. The client's `deriveLegend` already handles `[]`.
- **Fork copies the document verbatim.** `POST /v1/trees/:id/fork` snapshots the source
  room's *current* graph+legend (live edits folded in), writes them under the new id with
  `forked_from` provenance and a fresh op log (head 0). Because the legend lives inside the
  persisted document (`{nodes, edges, kinds}`), the meaning travels with the colors for
  free — any future copy path inherits this.

## Adapter caveats to verify after `brew install drogon libpqxx`

- **Unverified against a compiler.** The adapter code targets the libpqxx 7 / Drogon /
  jsoncpp APIs from memory. Likely fix-ups on first build: the libpqxx CMake target name
  (`libpqxx::pqxx` vs `pqxx`), Drogon `registerHandler` lambda arity, and jsoncpp
  `Json::Int64`. Build `windmill_server` and iterate.
- **Postgres id types.** `trees.id` / `tree_ops.tree_id` / `node_progress.tree_id` are
  `text`, matching the domain's string ids (slugs like "windmill-roadmap"), diverging
  from SPEC §9's `uuid`. Revisit when server-minted ids land with accounts.
- **Connection-per-request** in the Pg repositories — simple and correct, but add a pool
  before this is anything but a dogfood.
- **Phase 0 shortcuts:** no auth (a fixed `dev` user for progress); `owner_id` nullable;
  PUT keeps the existing `head_seq` (whole-document overwrite, not an op).

## Observations (structure / perf)

- The persisted JSONB **document** must carry full CRDT metadata (stamps + tombstones +
  inert edges), which is richer than the projected `TreeData` a client renders. Two
  serializations: full-state (persistence adapter) vs. present-projection (`toTreeData`).
  Keep the split at the adapter boundary; the domain holds the live CRDT only.
- Cycle detection runs iterative Tarjan (not recursive) so a 20k-node graph can't blow
  the stack.
- `SkillTree`/`TrunkTree`/`TreeHealth` are the *read-model* side and assume a valid DAG.
  The application seam is: `TreeDiagnostics::assess(graph).clean()` gates
  `SkillTree(graph.toTreeData(...))`. An unclean graph never reaches these ports.
- Deliberately did **not** port `SkillTree.toRenderModel`/ranks — layout + render are
  client-only (SPEC §1 non-goals). If a server feature ever needs ranks, add then.
- `NodeColor` is a strict enum, so "unknown color" is unrepresentable in the domain —
  it becomes a boundary (JSON-parse) validation, not a diagnostic smell.
- `TreeRoom` broadcasts the *intent* command (not an expanded effect delta). With
  ordered delivery + deterministic merge, replicas converge — and with the delete-splice
  gone, `TransitiveReduction` is the only computed op, and it's deterministic given the
  same seq-ordered graph. If non-determinism ever appears, switch to effect-broadcast.
- `TreeRoom::appliedOpIds_` grows unbounded in memory. Real system bounds it (the
  `tree_ops` unique(tree,op_id) is the durable backstop); add a windowed dedupe later.
- `TreeRoom::submit` returns `Applied{op, inverse}`: the inverse is computed against the
  pre-merge state and stacked by `UndoService`. Undo resubmits it as a fresh op with a
  later HLC, so it always wins (and always applies — never rejected).
- **Application services should lean on the loose graph, not the validated `SkillTree`,
  unless they genuinely need a DAG.** `ProgressService` used to take a whole `SkillTree`
  just to read one node's prerequisites for the advisory check — which also made it throw
  on a cyclic tree, contradicting §3 (progress must never block on graph validity). It now
  takes the node's live prerequisites directly (a `std::vector<NodeId>` the room derives
  from `LooseGraph::nodeView`). Rule of thumb for the seam: reach for `SkillTree` only when
  you need ranks/ancestry/trunk on a *clean* graph; for everything a loose graph can answer
  (a node's live prerequisites, present ids, edges), pass that in and stay validity-agnostic.
- **Presence is its own hub, not more `WsPresenceBus`.** Op fanout (the `PresenceBus`
  port) and Class C presence look similar — both fan frames to a tree's subscribers — but
  they differ in shape: ops are ordered/durable and broadcast immediately; presence is
  ephemeral, coalesced on a timer, and carries peer lifecycle. Folding presence into
  `WsPresenceBus` would give one class two clocks (immediate vs 20 Hz) and two state models.
  `PresenceHub` owns its own per-tree participant map so the bus stays a pure, immediate
  fan-out. The small duplication (both track conns per tree) is worth the single
  responsibility each keeps. The 20 Hz cadence is one `EventLoop::runEvery` timer draining
  every tree — coalescing lives at the transport edge, never in the domain.
- **One identity for one user across transports.** HTTP `getProgress` and the socket
  progress writer must agree on *who* the caller is or a mark never reads back. Today that
  is one injected `devUser`, shared by `HttpApi` and `Collab` from `main`. Phase 1 swaps
  the fixed id for the token's user at both seams — and the "echo to the same user's other
  sessions" broadcast (today: every other subscriber, since all are `dev`) narrows to
  connections whose session user matches the author's.
- **Persistence fidelity gap (temporary).** `RoomRegistry::evict` saves
  `TreeRoom::snapshot()` = `toTreeData()` (the present projection), and `open` reseeds a
  `LooseGraph` with a genesis HLC. This round-trips present nodes + live edges (cycles
  among present nodes survive), but **loses** tombstones, self-edges, and inert/dangling
  edges — so resurrection-after-reload won't revive a deleted node's edges. The real
  Postgres adapter must persist the full CRDT state (stamps + tombstones), not the
  projection. Fine for the pure/in-memory phase; flagged for the adapter phase.
