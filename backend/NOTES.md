# Windmill Backend — running notes

A chronological build log: what was done, and the lessons worth carrying. It is not a
contract — `AUTH.md`, `AUTHZ.md`, `db/schema.sql` and `RUNNING.md` are, and the sections
below defer to them rather than restating them.

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

## Auth — passwordless magic links (X6)

Implemented the whole auth layer per the design system's `guidelines/auth.md`: one door
keyed by email, 15-minute single-use links, 90-day rolling sessions, Resend for delivery.
Contract + wiring in `AUTH.md`. All 91 unit cases + an 8-check end-to-end (real Postgres)
pass; the full project (server + mcp) builds green.

- **The design doc overrode the SPEC, not the other way round.** `SPEC §10` said email +
  password + Argon2; `auth.md` says "passwords never exist". The newer, more specific
  document won — `users` lost `password_hash`/`handle`, and `SPEC §10` now carries a
  supersession banner pointing at `AUTH.md`. When two sources disagree, the one closest to
  the decision (and the one the operator handed us a key for) is the source of truth.
- **Auth is thin domain, honest about it.** The temptation was to manufacture domain logic;
  the honest shape is a small `domain/Auth` (email parsing, verdict, expiry math, rate
  predicate, value types) with the *mechanisms* — randomness, hashing, SQL, HTTP, SMTP — all
  at the edge behind ports (`TokenGenerator`, `AuthRepository`, `EmailSender`, `Clock`).
  `AuthService` reads as a fail-fast pipeline with zero policy of its own. Don't inflate a
  layer to look busy.
- **The single-use guarantee lives at the row, not the read.** First cut did `findLink`
  (check consumed) then `consumeLink` (void) — a TOCTOU race where two concurrent verifies
  both mint a session. The fix is the atomic `UPDATE ... WHERE consumed_ms IS NULL` *reporting
  whether it won* (`affected_rows == 1`); the service only proceeds when it did. Any
  "check-then-act" on a shared row wants the act to be the check.
- **Credentialed CORS must be an allowlist, never a reflection.** Echoing any `Origin` +
  `Allow-Credentials: true` (needed for the cookie) turns every site into a trusted origin —
  a login-CSRF gift. The allowlist is built from `WINDMILL_APP_URL` (+ `WINDMILL_ALLOWED_ORIGINS`);
  unlisted origins simply get no grant. Cookie is HttpOnly + SameSite=Lax, `Secure`/`Domain`
  following the deployment.
- **Parallelized with a workflow, kept the core coherent.** Authored the headers + domain +
  service + tests myself (the coherence backbone), then fanned out the four boundary adapters
  (crypto/postgres/http/email) + a Resend-API research stage + an adversarial security review
  across a workflow. The review caught both the race and the CORS hole. Interfaces are the
  synchronization points; distinct files per agent means zero conflicts.
- **The one unverifiable edge: the Resend template subject.** Sending with a template, the
  payload's `subject` overrides the template's default and is *required only if the template
  has none*. We deliberately omit it so the `magic-link` template owns its subject — the
  operator must give that template a default subject. Flagged in `AUTH.md`; the 502 body
  reveals it on the first real send if missed.
- **Tree registry (list + delete), one Action behind two edges.** `GET /v1/trees` +
  `DELETE /v1/trees/:id`, and the same over MCP (`list_trees` / `delete_tree`). Because HTTP and
  MCP need the identical orchestration, it lives once in `application/TreeRegistry` (load owned
  trees + progress overlays → domain, or load + owner-check → soft-delete); the two adapters are
  thin translators. The pure per-row math (`total`/`done`/`dominantKind`) is `domain/TreeSummary`,
  unit-tested with no Drogon. Each repo owns its own table — `TreeRepository::listOwnedBy` reads
  `trees`, `ProgressRepository::overlaysFor` reads `node_progress` — and the *domain* owns the two
  rules that can't live in SQL: recency = `max(structural, caller's last progress mark)`, and the
  ordering (SQL can't sort a computed key). `dominantKind` is computed over the raw projected
  `TreeData`, never `SkillTree`, so an invalid loose graph (cycle/dangling) still summarizes.
- **`POST /v1/trees` (create) completes the trio — the 405 was the tell.** The frontend's birth
  canvas plants via `POST /v1/trees {blank,title}` → `200 {treeId}`, but this backend only ever
  created trees via `PUT /v1/trees/{id}` (client-chosen id); create was assumed to "already exist"
  per the frontend contract. Adding `GET /v1/trees` registered the path, so the missing POST flipped
  404→405 and surfaced the gap. Create lives in the same `TreeRegistry` Action (mints a `t_…` id via
  the CSPRNG `TokenGenerator`, seeds the default legend, inserts owner-set), exposed as
  `POST /v1/trees` and MCP `create_tree`. (A `fromQuest` → 501 seam guarded the route until F5
  landed the quest catalog as client-shipped static content — quest plants are ordinary full-body
  creates, so the seam is gone and `/v1/quests` will never be built.)
  Lesson: a documented contract "living in the frontend docs" is not the same as a
  handler existing — a registered sibling route turns the omission from a 404 into a louder 405.
- **Registry reads bypass the rooms on purpose.** Existing tree reads go through the live room to
  reflect unsaved edits; a glanceable list of many owned trees reads straight from the repository
  instead — opening a room per listed tree would thrash the hot editor caches, and `updatedAt` is
  defined off the persisted stamp, so an unsaved in-flight edit legitimately shouldn't move a row.
- **Delete is a soft-delete with no room eviction (v1 limit).** `deleted_at` + the
  `deleted_at IS NULL` filter on every read is the authority; `save`'s upsert never clears it, so
  the ROW never comes back. "So no resurrection" is what this line used to say, and it was wrong —
  the row not coming back is not the tree not coming back. Because the id stays spoken for by the
  primary key while `load` is blind to it, a create under a retired id used to answer the same
  `409 id-taken` as a stranger's — and the web claim answers a stranger by re-planting the local
  tree under a FRESH id. A deleted roadmap therefore returned on every claim pass, wearing a new id
  each time, so deleting it again never helped. `Creation::retired` / `409 id-retired` now names the
  owner's own retired id (`TreeRegistry::create`, `retiredOwner`), and the claim lets that tree go.
  The lesson worth keeping: a delete is only as durable as the WEAKEST reader of it, and the client
  that re-creates on conflict is a reader. But a room already resident in memory (any process) stays editable until it
  idle-evicts, persisting to an invisible row. Acceptable for now; a later refinement can evict the
  local room on delete. Also added `DELETE` to the CORS preflight `Allow-Methods` — the shared
  choke point advertises the whole verb set, so a missing verb silently fails the browser's
  real request.
- **MCP folded into `windmill_server` (one RoomRegistry per tree).** The standalone
  `windmill_mcp_http` process was a *second* authority for every tree: its own `RoomRegistry` over the
  shared Postgres, a `NullPresenceBus`, and `seq` minted from its own in-memory `++head_`. So an agent's
  edits advanced the MCP process's room while the API process kept serving its pinned room (stale reads),
  and — worse — the two minted colliding seqs against `tree_ops`' `primary key (tree_id, seq)`: the
  moment the web edited an MCP-touched tree (or vice-versa) the INSERT hit the PK and threw. SPEC §11's
  "one writer per tree" was broken by the process split. Fix: mount the Streamable-HTTP endpoint +
  `RoadmapTools` inside `main.cpp`, sharing the server's `RoomRegistry`/`ProgressService`/`TreeRegistry`/
  `OAuthService` and its real `WsPresenceBus` — MCP edits now run through the same room (one head/seq) and
  fan out live to socket subscribers. `RoadmapTools` reuses the existing `SystemClock`; the resource
  audience stays `WINDMILL_MCP_PUBLIC_URL` (DOMAIN_MCP) so existing OAuth connections are unaffected; the
  API CORS preflight/post-handling skip `/mcp`, which keeps its own MCP-header preflight + `Mcp-Session-Id`
  expose. Deploy: `DOMAIN_MCP` proxies to `server:8080`, the `mcp` compose service is retired
  (`windmill_mcp_http` still builds for local/standalone). Verified end-to-end: MCP `create_node` then
  `GET /v1/trees/:id` in one process reflects the write. The op-log PK meant no durable corruption — the
  collisions were rejected, not written — which is why a server reload heals a stale room.
- **Still open (scale-out): single-authority breaks again across >1 server replica.** The fix restores one
  room per tree only while a single `windmill_server` runs; two replicas behind a load balancer reintroduce
  the same collision. Durable fix: DB-authoritative `seq` (a per-tree sequence / advisory-locked
  `max(seq)+1`, never a cached `head_`) + a real cross-process bus (Redis/NATS) behind `PresenceBus` so
  resident rooms replay remote ops (dedup by the existing `unique (tree_id, op_id)`), plus sticky per-tree
  routing. Guardrail worth adding first: make `TreeRoom::submit` persist-then-apply (or roll back the
  `merge`/`++head_` when `append` throws) and treat a seq conflict as "I'm behind → replay + retry",
  turning today's hard error into self-healing.
- **Single origin: collapse the api./mcp. subdomains into the app host, path-routed.** A private,
  frontend-facing API doesn't need its own hostname. Caddy now serves the SPA at `$DOMAIN_APP` and
  path-routes `/v1`, `/mcp`, `/oauth` and the OAuth well-knowns to windmill_server on the same origin —
  so app↔API is same-origin and the cross-origin CORS machinery in `main.cpp` becomes vestigial (kept
  for now; trim once the transitional alias is gone). `WINDMILL_API_URL` (OAuth issuer + default MCP
  resource audience) moves to the app origin; the `mcp.` subdomain is retired (MCP lives at `/mcp`).
  Staged so nothing flag-days: `$DOMAIN_API` is kept as an alias to the same server until the frontend
  build is flipped to a same-origin base and redeployed, then it too can be retired (DNS + Caddy block).
  Frontend side: `VITE_API_BASE_URL=""` (same-origin relative fetch), and `CollabClient` derives the
  `ws(s)://` socket URL from `window.location` when the base is empty.
- **Deploy bug this surfaced: single-file Caddyfile bind mount + scp = stale config.** scp replaces
  `~/windmill/Caddyfile` with a NEW inode; a running caddy container (bind-mounted to the old inode)
  never sees it, and neither `docker compose restart` nor `caddy reload` helps — only recreating the
  container re-binds the file. `up -d` left caddy unchanged, so the first routing change (retiring the
  mcp upstream) produced a Cloudflare 502 (origin unreachable for that host) while the app/api hosts
  kept working. Fix: `docker compose up -d --force-recreate --no-deps caddy` every deploy. Diagnosed
  from the 502 being a CF error page (no `via: Caddy` header) vs the working host's `via: 1.1 Caddy`.
- **OAuth: allow any port on loopback redirect URIs (RFC 8252 §7.3).** `redirectRegistered` did a
  strict exact match, but native/MCP clients (Claude included) bind a fresh ephemeral
  `http://localhost:<port>/callback` each flow — so a client registered once and then reused with a new
  port got `400 invalid client_id or redirect_uri` at `/oauth/authorize`. Relax the match for loopback
  http only: compare scheme+host+path, port-agnostic; https stays exact — the open-redirect defense is
  untouched. (The mechanism changed on 2026-08-22 and the name `withoutLoopbackPort` is gone: the
  string scan it did read `http://127.0.0.1:80@evil.com/callback` as loopback, so redirect URIs are
  PARSED now — `parseRedirect` in `platform/domain/OAuth.cpp` — and the port-agnostic rule applies
  only when both sides are genuinely loopback. The RFC 8252 behaviour described here is unchanged.) Surfaced when the MCP endpoint moved to `windmill.works` and the
  MCP client's cached client (registered against an old ephemeral port) no longer matched.
- **Progress now broadcasts live to the author's own sessions (WS).** A progress change was recorded
  but never pushed over the socket — a browser only saw an MCP (or other-tab) progress change on
  reload, which read as "the DAG doesn't update live." Added
  `PresenceBus::broadcastProgress(tree, user, node, status)`: `WsPresenceBus` now remembers each
  connection's account (`subscribe(tree, conn, user)`) and fans a `{t:"progress"}` frame only to that
  user's *own* connections — never collaborators (progress is a private overlay). Both write paths call
  it: the WS `progress` handler and the MCP `set_progress` (RoadmapTools gains a `PresenceBus&`).
  Frontend: `CollabClient.onProgress` + `SkillTreeView` applies the frame through the same
  `handleSetState` a local mark takes (idempotent — skips the ceremony when already in that state).
  Not yet symmetric: the browser still doesn't *send* progress to the server (localStorage only), so a
  browser→server progress-write path is a separate follow-up (today only MCP/WS writes reach the DB).

## Graph sync — Step 1 landed (the lattice primitive, dark)

Canonical spec: `GRAPH_SYNC_DESIGN.md`. This step added the pure domain core with no wire
changes: `LooseGraph::join(GraphState)` / `Legend::join(LegendState)` (fold a partial state
field-by-field through the existing `Lww`/`ElementSet` merges), `domain/Subgraph.{h,cpp}`
(the `Subgraph` envelope, `VersionVector`, `frontier`, `deltaBetween`), and `HlcClock` +
the shared `toString`/`parseHlc` stamp codec in `Ids.h` (`PgOpLog` now shares it instead of
its own copy). Proven by C++ property tests + `test/golden` (a language-neutral corpus,
`node test/golden/run.mjs`). Observations worth acting on when we build the next steps:

- **`LooseGraph(const GraphState&)` (replace) is now nearly redundant with `join`.** Joining
  a *full* state into an empty graph yields the same result as the replace-constructor
  (every field stamp dominates `Hlc{}`), the only difference being replace assigns registers
  directly while join uses `merge`. When the reconnect path stops doing destructive replace
  (design §6), audit whether the replace-constructor still earns its place or should inline
  as `LooseGraph g; g.join(state);`. Leaving it for now — several call sites and a hair
  faster on the hot load path.
- **Frontier/delta recompute from `exportState()` — O(state) each call.** Fine at the
  10k/20k caps and correct as the reference, but when `TreeRoom` gains `joinSubgraph`, keep a
  running `VersionVector` updated per join (design §6 "frontier maintained incrementally")
  rather than re-scanning, and persist it in the same txn as the document snapshot.
- **Title is not in the lattice yet.** `Subgraph.title` is an `optional<Lww<string>>`
  placeholder; today the tree title is a plain `title_` string on `TreeRoom`. When the wire
  goes subgraph, promote title to a real LWW register (top-level in `GraphState`, or a tree
  header) so a concurrent rename converges like every other field. `deltaBetween` leaves it
  null until then.
- **`deltaBetween` works on serialized `GraphState`/`LegendState`, not the live graph** — so
  the Subgraph feature stays decoupled from `LooseGraph` internals (no include cycle, clean
  DAG). The cost is an `exportState()` before a delta; acceptable, and the incremental
  frontier above removes it from the hot path.

## Graph sync — Step 2 landed (server clock epoch)

The fake `Hlc{++tick_, 0, user}` in `Collab` and MCP's hand-rolled monotone clock (its own
`lastMs_`/`counter_`/`stampMutex_`) are both gone. Every server-minted write now stamps from
**one wall-clock `HlcClock` per tree, owned by `TreeRoom`** (`nextStamp(nowMs)`, actor
`"srv"`), fed wall time via the existing `Clock` port. The room `observe`s every stamp it
loads (document frontier in the ctor + each replayed op-log op), so a fresh mint is always
ahead of anything persisted — restart-safe. WS and MCP finally live in one comparable HLC
domain; before this, MCP stamped real epoch-ms and WS stamped tiny logical ticks, so an
agent's edits always sorted after every socket edit (a latent cross-writer LWW bug). Notes:

- **The clock lives in the room, not the adapters, on purpose.** The per-tree strand already
  serializes all mutations, so the room's `HlcClock` needs no mutex — minting happens under
  the strand. This deleted MCP's `stampMutex_` and Collab's atomic `tick_` outright: minting
  moved *inside* the strand at all three sites (command, progress, undo). Net less code.
- **Actor is `"srv"`, one identity for all server-minted stamps.** Authorship stays in
  `AppliedOp.actor` (the activity feed) — the HLC actor only breaks LWW ties and keys the
  version vector, so a single stable server identity is correct. A multi-instance deploy must
  qualify it per instance (`srv#<region>`); noted for when we scale past one process.
- **Undo opIds now derive from the stamp** (`"undo-"+actor+"-"+toString(hlc)`) instead of the
  retired `tick_` counter — unique because the clock is monotone.
- **Progress shares the tree clock too.** The private overlay's LWW stamp now comes from
  `room.nextStamp`; Step 7 reworks progress into its own mini-lattice, at which point revisit
  whether it should carry its own per-user clock instead of borrowing the tree's.
- **Client stamps arrive in Step 3.** The receive rule (`observe`) is already wired on every
  inbound path, so when clients start stamping their own writes, the server clock stays ahead
  with no further change.

## Graph sync — Step 3 in progress (lattice-is-truth cutover): backend rungs 3.1–3.2 landed

The cutover is being done as a tested ladder, because the backend is unit-testable in C++ but
the frontend rewrite is not (no JS test framework) and is best verified by driving the app.

- **3.1 — `SubgraphJson` wire codec (done, tested).** `adapters/json/SubgraphJson.{h,cpp}`:
  `toJson(Subgraph)` / `subgraphFromJson` — the one envelope (t/v/treeId/frameId/actor/intent/
  nodes/edges/kinds/gestures/title/coverage). Reuses TreeJson's GraphState/LegendState
  encoders (wire == document format). Also retired TreeJson's **third** copy of the stamp
  codec onto the shared `Ids.h` `toString`/`parseHlc` (PgOpLog did the same in Step 1). New
  `windmill_adapters_tests` target; 6 round-trip cases incl. masked-delta and coverage.
- **3.2 — `TreeRoom::joinSubgraph` + `broadcastSubgraph` port (done, tested).** The room's
  permanent join entry point: dedupe on frameId, fold the frame's stamps into the clock
  (receive rule for client stamps), `graph_.join` + `legend_.join`, `++head_`, broadcast
  verbatim. **No inverse** — undo is client-owned in the subgraph model. `PresenceBus` gained
  `broadcastSubgraph` (WsPresenceBus serializes via SubgraphJson + seq to all subscribers,
  echo included; the two NullPresenceBus + FakeBus updated). 3 room tests (fold+seq+broadcast,
  frameId dedupe, client-stamp observe).

Deliberately deferred within Step 3 (the app-breaking / not-unit-testable rungs):

- **3.3 — Collab wire cutover.** Replace `cmd`/`op`/`ack`/`subscribe-snapshot` with
  `subgraph`/`subgraphAck`/`caughtUp`; skew clamp (whole-frame `skew` nack); subscribe emits
  state as a subgraph; route MCP through `joinSubgraph` (server-origin materialize). This
  breaks the current frontend (still sends `cmd`) until 3.4 — so it lands with 3.4.
- **3.4 — Frontend `sync/` package.** `lattice.js` (TreeLattice + HlcClock + VersionVector +
  codec mirroring SubgraphJson, checked against `test/golden`), `materialize.js` (gestures →
  stamped writes; retires `edits.js` transforms + `applyRemoteOp`), `SyncSession.js` (dispatch
  seam). The largest regression surface; verify by driving the app.
- **3.5 — Delete the old wire.** Remove `cmd`/`op`/`submit`-as-wire, server undo for WS,
  Command-as-wire — once the frontend is on subgraphs.

- **`joinSubgraph` doesn't touch the op log yet, on purpose.** Durability is covered by the
  document snapshot; long-reconnect is covered by `deltaSince` off the lattice (design §6
  Case B needs no op log). The op-log/activity-feed integration for subgraph frames (and
  retiring the command-based `AppliedOp`) is its own rung, sequenced with 3.3/3.5.

## Graph sync — Step 3 COMPLETE (lattice-is-truth cutover): the wire is subgraph end to end

The single-command `cmd`/`op` wire is gone; every edit is a subgraph joined into a lattice.
**Verified by driving the running app** (server + Postgres + vite, real session cookie): HTTP
load → WS subscribe → state-as-subgraph → the client `TreeLattice` builds and renders; an app
`dispatch` → materialize → local join → subgraph frame → server `joinSubgraph` → seq +
verbatim broadcast (a monitor peer saw the app's UUID-framed edit); a fresh reload reconciled
both nodes from the room; client-owned undo/redo tombstoned and resurrected through the wire.
All C++ suites + golden + lattice-vs-golden green.

- **3.3 Collab wire.** `subscribe` ships the whole state as one graft subgraph (client joins
  it — idempotent, so an HTTP-preloaded client just absorbs the gap); `subgraphFrame` handles
  a client-stamped frame: **skew clamp** (a frame past now+5min → whole-frame `skew` nack,
  non-lossy), `joinSubgraph`, `subgraphAck`. No legend/cap refusals (diagnostics now, §2) —
  only auth + ownership reject. `cmd`/`undo`/`redo` handlers deleted. `HttpApi::getTree` gained
  a stamped `state` subgraph for lattice bootstrap.
- **3.3 MCP through join.** `TreeRoom::applyCommand(command, nowMs, actor)` — server-origin
  materialize: stamp from the room clock, apply, log for the activity feed, **broadcast the
  writes it produced as one subgraph** via `deltaBetween(after, frontier-before)`. So an
  agent's edit reaches every socket the same way a browser's does. RecolorKind's fan-out and
  every compound edit ride one atomic frame for free. frameId is minted from the (unique)
  stamp — server-origin edits never retry.
- **3.4 Frontend `sync/`.** `lattice.js` (`TreeLattice` + `HlcClock` + codec, corpus-verified),
  `materialize.js` (15 gestures → stamped writes; the splice/fan-out/reduction logic moved
  here off `edits.js`), `SyncSession.js` (dispatch seam + client-owned undo journal +
  `seed()` for the local-only perf tree). `SkillTreeView`: ~15 `send` sites collapsed onto
  `dispatch`, `applyRemoteOp`'s switch replaced by one `onTreeChanged` that both local and
  remote flow through; client actor is a fresh `r_<nonce>` per tab.
- **3.5 Deletions.** `persistence/CollabClient.js` and `editing/edits.js` deleted.

Honest gaps left for later rungs (noted, not blocking the cutover):

- **`toRenderModel` needed a position for every node**, but a lattice-projected node can have
  none (an agent's MCP-created node, a collaborator's create). `syncStructure` now seats an
  uncovered node just below its first placed parent (or origin) so the render never crashes;
  a proper **re-layout on structural change** is the real fix (a refinement).
- **WS structural edits don't hit the op log** (joinSubgraph skips it), so the activity feed
  won't show live client structural edits yet (MCP still does via applyCommand). Op-log
  rework for subgraph frames is its own rung.
- **`TreeRoom::submit` / `invert` / `UndoService` are now dead code** (nothing on the wire uses
  them) but kept so their tests stay green; delete in a focused cleanup rung.
- **Persistence is still the every-25-frames snapshot cadence** — edits between snapshots live
  in-memory + broadcast, but a restart before a snapshot loses them. Step 4 (durable offline /
  IndexedDB) + a tighter persist cadence close this.

## Graph sync — Step 4 COMPLETE (durable offline / IndexedDB)

"Author on the train, flush at the station, survive crash and reload." **Verified by driving
the app**: an edit made offline persists to IndexedDB, the server never sees it (phase gate),
it survives a page reload (renders from IndexedDB), and flushes on reconnect — the outbox
drains to empty. The plan was first hardened by a 5-agent adversarial red-team (see the design
memory); it found FOUR fatal issues the naive plan would have shipped, all now fixed + driven:

- **Seq-gap coverage-poison (fatal).** Folding every server frame's stamps into the coverage
  vector without a dense-seq check lets a dropped broadcast make the vector claim stamps the
  client never got → silent permanent divergence. Fix (driven): a live frame joins only when
  `seq === lastSeq+1`; a gap or malformed frame drops the frame and forces a resubscribe (the
  graft is the resync). Verified: a `seq = lastSeq+2` frame is dropped, not joined, no advance.
- **Coverage advances via graft + own-ack only, never live frames, and is NEVER persisted.**
  `ackedServerVector` is in-memory; it is REPLACED by the graft frontier on every subscribe
  (so anything a restarted server lost becomes uncovered and re-flushes) and joined by the
  in-flight frontier of one of our own frames on its `subgraphAck`. The persisted value is just
  `{frame, lastSeq}` — no vector on disk means no stale claim can outlive its content. This also
  means the client never trusts an ack for coverage, so a server that loses <N frames self-heals
  on reconnect.
- **Multi-tab clobber (fatal).** A blind whole-blob IndexedDB put lets one tab erase another
  tab's durable offline edit. Fix (driven): `SyncStore.save` is a read-JOIN-put in ONE raw-
  callback transaction (the join runs synchronously inside `get.onsuccess` — never `await`
  between get and put, which would split the transaction). Verified: two SyncStore instances
  writing disjoint edits to one record → the record keeps BOTH.
- **Ungated live sends + ack-not-durable.** dispatch now sends only in the `live` phase (entered
  after the graft is joined+persisted and the flush is handed off), so the server acquires each
  actor's stamps as a prefix. Backend companion (one line): `Collab.cpp` subgraph handler now
  persists BEFORE the ack (dropped the `% kSnapshotEvery` gate) so an ack attests durability.

New/changed files: `sync/lattice.js` (VersionVector, frontier, deltaSince, two-phase join
returning the frame frontier, title on all surfaces), `sync/SyncStore.js` (new — IndexedDB
read-join-put), `sync/SyncSession.js` (phases, inFlight, seq-gap, graft-replace-vector, flush,
coalesced receive-save, skew re-flush, backoff, at-risk), `SkillTreeView.jsx` (`session.start()`,
retired `TreeStore` for structure), `Collab.cpp` (persist-before-ack). Backend suites + golden
+ lattice-vs-golden all green.

Deferred (noted, not blocking): golden-corpus vectors for title/delta round-trip (node smoke
tests cover it for now); the backend still emits `"0:0:"` for masked delta fields where the
frontend omits — semantically equivalent (both parse to unset, join no-op), a minor wire-bloat
cleanup; per-record IndexedDB granularity (whole-blob is correct until the O(state) save cost
meets real frequency); undo stacks don't survive reload.

## Graph sync — Step 5 COMPLETE (two-way anti-entropy)

The subscribe response is now a **delta**, not the full state-as-graft: the client sends its
coverage vector, the server replies with `deltaBetween(state, clientVector)` carrying the
server frontier as coverage. Reconnect is O(delta), not O(state); combined with the Step-4
client→server flush (already a delta), anti-entropy is two-way. **Verified by driving** (raw
WS): a fresh client (empty vector) gets the full state; a caught-up client gets an **empty**
delta; a client one edit behind gets **just that one node**. The app-side confirmed too: the
`SyncSession` subscribes with `ackedServerVector.toJSON()`, `receiveState` adopts the delta's
`coverage` (or the join frontier for a bare graft), and an in-session reconnect returns an
empty delta with a drained outbox.

- **Backend:** `Collab::subscribe(conn, treeId, frame)` reads `frame["vector"]` (parsed by the
  new `SubgraphJson::versionVectorFromJson`) and always sends `deltaBetween(exportState,
  exportLegend, clientVector)` as one `intent:"delta"` frame + `seq`. The full-state graft on
  subscribe is gone; the HTTP `getTree` still ships a bare graft for the first paint.
- **Frontend:** the wire version-vector format is now the full stamp `"ms:counter:actor"` (so
  the server's `parseHlc` reads it); `receiveGraft` → `receiveState` adopts `frame.coverage`.
- +2 adapter tests (`subscribe_delta_against_a_caught_up_vector_is_empty`, `…_empty_vector_is_
  the_whole_state`). Backend 138/8/31, golden 25, all green.

The vector is deliberately still NOT persisted (Step-4 hardening), so a fresh **page load**
sends an empty vector and gets a full-state delta (redundant with the IndexedDB frame it
already holds, but correct); only **in-session reconnects** (the network-blip / offline-then-
back case) get the O(delta) win. Persisting the vector for reload-deltas is a future
optimization now that persist-before-ack makes it safe — deferred, not needed. Chunking the
server-side delta for a very long-offline client (a `caughtUp{coverage}` terminator so
coverage is adopted only after the last chunk) is the other deferred refinement.

## Graph sync — Step 6 core landed (stewardship): masked-live-work repair

The "keep more, lose less" guarantee, made real and recoverable. When a delete races a
concurrent build — the phone deletes a node while the laptop builds children under it offline
— the merge keeps everything, but the children are only *masked* under the tombstone. Step 6
detects and repairs that:

- **Detection.** `LooseGraph::isTombstoned(id)` (a node created-then-deleted, fields intact,
  vs a never-seen id) + `TreeDiagnostics.maskedWork` = tombstoned parents that still have
  present children (a present edge from a tombstoned `from` to a present `to`). It rides the
  existing dangling-edge scan; also serialized so MCP/HTTP `get_diagnostics` reports it. Mirror
  on the client: `TreeLattice.maskedWork()` → `{id, label, children}` (O(E+V)).
- **Repair.** A new `ResurrectNode` gesture re-adds *only* the life (a fresh `life.add`), so
  the tombstoned node's preserved fields come back untouched and, by the receive rule, the
  fresh stamp dominates the tombstone. The child's inert edge goes live again — the subtree
  re-connects. Undo of a resurrect re-tombstones (the generic inverse handles it).
- **UX.** `onTreeChanged` surfaces it once per change as a toast — "N steps kept under a
  deleted node" — with a one-click **Restore** that dispatches `ResurrectNode` for each masked
  parent. **Verified by driving**: a concurrent remote tombstone (through the real receive
  path, so the clock observes it) produced the toast + Restore button; Restore resurrected the
  parent with its label intact and re-connected the child, clearing the signal.

Backend +2 diagnostics tests (140), all suites + golden green. Deferred within Step 6 (noted,
lower-frequency than masked-work): the deterministic legend-breach projection (>6 kinds / dup
hues from concurrent offline AddKind → order by (rank, createdAt, id), first six active);
surfacing `durabilityAtRisk` (storage-pressure hint); grouped offline-session activity-feed
entries; node/edge cap advisories.

## Graph sync — Step 7 core landed (private overlays): the progress-clear bug fixed

`node_progress` is now a proper per-user LWW register. Two bugs fixed in `PgProgressRepository`:

- **A clear was a row DELETE**, so it carried no stamp — a stale mark arriving after it (out of
  order) would resurrect the node, and the clear never converged. Now `status='none'` is a
  stamped value like any other; the row is never deleted. `load()` already treats a `none` row
  as neither completed nor in-progress, so no read change was needed.
- **The upsert was unconditional** (`ON CONFLICT DO UPDATE` with no guard) — not LWW at all: a
  lower-stamped write clobbered a higher-stamped one. Now it is `… WHERE (EXCLUDED.stamp_ms,
  EXCLUDED.stamp_counter) > (node_progress.stamp_ms, node_progress.stamp_counter)`. Two new
  `bigint` columns hold the HLC split; the room clock (Step 2) mints a unique `(ms, counter)`
  per write to a tree, so that pair totally orders every write and the actor tiebreak is moot.

**Verified**: a direct SQL run — a stale clear (stamp 50) left the node `complete` (rejected),
a newer clear (stamp 200) stored `none` (kept, not deleted); and the full C++ path through the
running server — a WS `complete` then `none` left the DB row `status='none'`, `stamp_ms` from
the room clock. The live cross-device path already converged (Step-3 `broadcastProgress` fans a
`none` to the user's other sessions, which `applyRemoteProgress` applies + caches).

Deferred — the **full progress mini-lattice** (the design's Step-7 completion): stamped,
offline-durable progress with a reconnect catch-up and no localStorage shadow. Doing a half
version (make the frontend server-authoritative on reload) would trade "authed reload gets
cross-device clears" for "authed offline marks lost on reload" — neither is right without the
stamped client-side lattice. The data layer is now correct (the hard part); the client overlay
gets the same TreeLattice treatment as its own follow-up. Workspaces off localStorage ride the
same future change.

## Graph sync — Step 8 core landed (device-to-device): the .windmill file

Pure transport reuse — no new protocol, just the subgraph graft envelope in a file (frontend
only; the backend was untouched). `SyncSession.exportGraft()` = the whole lattice as one
`.windmill` document (`{format, v, treeId, title, exportedAt, frame: lattice.toFrame()}`);
tombstones ride the frame, so **even deletions travel by AirDrop / QR / disk**. Import splits
two ways on the file's `treeId`:

- **Same tree** → `lattice.join(frame)` verbatim (a device catching up): state-only, never
  advances coverage, so the merged content flushes to the server on the next sync. Idempotent
  re-import of one's own export is a no-op.
- **Different tree** → a **subtree gift**: every present node is remapped to a fresh `gift-<id>`
  and re-authored through `dispatch(CreateNode/AddEdge)` with the LOCAL clock, so foreign stamps
  from another tree's clock space never enter this tree's coverage. (Kind/color mapping is the
  noted refinement — imported hues render but aren't reconciled against the local legend yet.)

UI: Export/Import icon buttons on the ControlBar (demo tree only) — Export downloads the file,
Import opens a file picker. **Verified by driving**: export carried a tombstoned node; same-tree
re-import was an idempotent merge; a cross-tree gift created two remapped nodes with labels +
edge preserved, restamped by the client's actor (confirmed in the DB — `r_<local>`, not the
donor's `r_donor`), synced to the server, and the donor's foreign stamp never entered coverage.

Backend suites + golden unchanged/green. Deferred — the other Step-8 transport, **WebRTC live
sync** (paired same-account devices, server as signaling only; the identical subscribe/delta/ack
exchange over a data channel, no seq travelling). And export quarantine while a lattice holds
over-clamp stamps.

## Graph sync — Cleanup: the command-broadcast path retired

With `joinSubgraph` the sole write path (§2), the whole old command-broadcast half became dead
weight and is now gone — the room speaks in subgraphs, and no simpler shadow API survives beside
it to tempt a caller back onto the wrong plane:

- **`TreeRoom`**: dropped `submit(Incoming)`, the `Incoming`/`Applied` structs, and command
  op-id dedup (the frame-id dedup on `joinSubgraph` replaces it). `applyCommand(cmd, nowMs,
  actor)` — the MCP/server-origin stamp-apply-log-broadcast path — is the only imperative entry.
- **`Command`**: removed `invert` (undo is client-owned now, a journal of inverse *gestures*, not
  a server round-trip).
- **`UndoService`** + its test: deleted whole; Collab, infra, CMake no longer wire it.
- **`PresenceBus::broadcastOp`** + `WsPresenceBus`/`FakeBus`/both `NullPresenceBus` overrides +
  `CommandJson::opFrame`: the op never rode the wire as its own frame once the subgraph delta
  became the broadcast unit. `PresenceBus` no longer needs `ports/Op.h`; `CommandJson` no longer
  needs it either (its kind/payload still serve the op log — the durable activity feed, not sync).

`AppliedOp` stays: `applyCommand` still logs one, and `OpLog`/`ActivityFeed` read it for the feed.
That's the clean seam — the op log is a **record of what happened**, the subgraph is the **unit of
convergence**; cleanup collapsed the two paths that used to blur them. Domain suite dropped 140→127
(the retired code's own tests); adapters 8, mcp 31, golden 25 all green.

## Graph sync — Activity feed: browser edits now hit the op log (feed = projection over the lattice)

The op log had gone feed-only (undo is client-owned, reconnect-replay rides the lattice delta), yet
only the MCP/agent path — which holds a real `Command` — was logging. Browser edits arrive as pure
subgraph frames (the design's invariant: **only lattice effects cross a replica boundary, never
commands**), so they were invisible in the feed. Fixed by making the feed a *read-side projection
over the lattice*, the same principle applied to reads that the sync spine applies to writes:

- **`domain/Command.h` — `headline(GraphState, LegendState) -> optional<Command>`**: the coarse
  inverse of `merge()`, read off which lattice fields a frame sets. Salience order puts the root
  deed first — a node's own life (create/delete) over the legend deeds (a kind recolor) over the
  node fields those fan out to, over edges — so a delete-with-edge-splice reads as "removed X", a
  recolor-kind-with-repaint as "recolored a kind", never as their leaf effects. A position-only or
  empty frame is a nudge, not a deed → nullopt.
- **`TreeRoom::joinSubgraph(incoming, actor)`**: after the join, logs the headline as one `AppliedOp`
  at the seq the frame just took, keyed on the frameId (so a re-gossip can't double-count) and
  attributed to the authenticated `actor` (Collab passes `principal.user`). The existing rich
  C++ feed renderer is reused **verbatim** — endpoint-label lookup and cross-branch detection and
  all — so there is exactly one place feed phrasing lives, and no second copy drifts in JS.

**Zero client changes, zero wire changes** — the server derives the headline from the effects it
already receives. Chosen over carrying a client-composed summary string (a trust surface + a second
renderer) after an unbiased architecture review; the scaffolded `Subgraph.gestures` field stays
available as a future *semantic tag* (tidy-vs-unlink) that only disambiguates verb choice.

**Verified by driving** (freshly built server + PG, a seeded WS session, a raw `/v1/socket` client):
a live create frame → feed `"added Feed Drive Node"`; a **reposition-only** frame took its wire seq
but logged nothing (the seq-2 gap in `tree_ops` proves the nudge guard — a drag can't spam the feed);
a second create → `"added Second"`; an edge frame → `"linked Feed Drive Node → Second"` with **both
endpoint labels resolved by the shared renderer**. DB `tree_ops` carried seqs 1/3/4, kinds
CreateNode/CreateNode/AddEdge, actor = the real user uuid. Demo tree restored afterward.

Domain 127→135 (+5 `headline` unit tests across the field-presence cases + priority, +3 room tests:
logs-headline / reposition-only-logs-nothing / edge-logs-a-link / dedup-never-double-logs); adapters
8, mcp 31, golden 25 all green.

**Deferred:** offline-flush frames log one *coarse* headline (many coalesced gestures → the salient
one), acceptable for a social feed; per-gesture offline fidelity would need the gesture-boundary
sidecar. And `displayActor` still resolves only "dev"/"u<n>" — a real user's uuid shows as the tree
itself, so the feed needs a name-resolution pass (pre-existing, unrelated to this rung).
