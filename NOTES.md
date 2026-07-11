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
      Remaining Phase 2 polish:
        - reconnect replay ignores `lastSeq` (always sends full snapshot); wire
          `PgOpLog::since` for incremental catch-up.
        - room edits persist to `trees.document` only on evict — restart relies on
          tree_ops replay. Add a snapshot cadence (every N ops / T seconds).
        - coarse global mutex in Collab stands in for the per-tree strand.
        - presence relay implemented (broadcastRaw) but not yet exercised.
        - frontend still loads over HTTP (Phase 0); no live WS editing in the browser yet.
- [ ] Frontend save path (PUT) would need CORS preflight/OPTIONS fixed — Drogon's
      built-in OPTIONS handling currently reports only `OPTIONS` in allow-methods. Load
      (GET) is a simple request and works; revisit when the frontend writes over HTTP.

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
- **Persistence fidelity gap (temporary).** `RoomRegistry::evict` saves
  `TreeRoom::snapshot()` = `toTreeData()` (the present projection), and `open` reseeds a
  `LooseGraph` with a genesis HLC. This round-trips present nodes + live edges (cycles
  among present nodes survive), but **loses** tombstones, self-edges, and inert/dangling
  edges — so resurrection-after-reload won't revive a deleted node's edges. The real
  Postgres adapter must persist the full CRDT state (stamps + tombstones), not the
  projection. Fine for the pure/in-memory phase; flagged for the adapter phase.
