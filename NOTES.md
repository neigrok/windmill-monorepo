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
  `POST /v1/trees` and MCP `create_tree`. `fromQuest` → 501 until the quest catalog (`/v1/quests`,
  F5) exists. Lesson: a documented contract "living in the frontend docs" is not the same as a
  handler existing — a registered sibling route turns the omission from a 404 into a louder 405.
- **Registry reads bypass the rooms on purpose.** Existing tree reads go through the live room to
  reflect unsaved edits; a glanceable list of many owned trees reads straight from the repository
  instead — opening a room per listed tree would thrash the hot editor caches, and `updatedAt` is
  defined off the persisted stamp, so an unsaved in-flight edit legitimately shouldn't move a row.
- **Delete is a soft-delete with no room eviction (v1 limit).** `deleted_at` + the
  `deleted_at IS NULL` filter on every read is the authority; `save`'s upsert never clears it, so
  no resurrection. But a room already resident in memory (any process) stays editable until it
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
  http only: compare scheme+host+path, port-agnostic (`withoutLoopbackPort`); https stays exact — the
  open-redirect defense is untouched. Surfaced when the MCP endpoint moved to `windmill.works` and the
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
