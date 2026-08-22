# Windmill Backend — Requirements & Architecture Spec

Status: draft v1 · Target: C++20 service · Scope: full platform · Collaboration: real-time

> **This is a founding design document, not a status record (banner added 2026-08-05).**
> It is kept for the model and the reasoning — the loose graph, the convergence argument,
> the command taxonomy, the collaboration crux — which still hold and are still worth
> reading. Do not read it for what is built, what the endpoints are, or where a file lives.
> It was written before accounts, before journal and gym, and before the monorepo split, so
> its paths predate it too: the frontend it calls `src/skilltree/` is
> `web/src/products/roadmap/`. §10 carries its own supersession banner.
>
> For the live answers: `db/schema.sql` (data model) · `AUTH.md` (authentication) ·
> `AUTHZ.md` (tree authorization) · `RUNNING.md` (endpoints, local run) ·
> `products/journal/ARCHITECTURE.md` and `products/gym/ARCHITECTURE.md` (the other two
> products, which this document does not know about) · `../STRUCTURE.md` (layout) ·
> `NOTES.md` and the dogfood tree `t_9362d9bc883e0a1e` (what shipped, in order).

The founding document for `windmill-backend` — the authoritative server behind the
Windmill skill-tree app. The frontend (`src/skilltree/`) is a hand-rolled WebGL2
roadmap editor that today runs entirely in the browser against a mock repository and
`localStorage`. This spec defines the backend that turns it into a multi-user,
real-time collaborative platform. Under concurrent editing it **trades hard invariants
for guaranteed convergence**: the graph may transiently become invalid (a cycle, a
detached node), and the server's job is to merge every edit and *surface* the damage
for a human to fix, rather than reject edits to keep the graph pristine.

---

## Table of contents

1. [Goals & non-goals](#1-goals--non-goals)
2. [The contract the frontend already defines](#2-the-contract-the-frontend-already-defines)
3. [Domain model: loose graph & diagnostics](#3-domain-model-loose-graph--diagnostics)
4. [System architecture](#4-system-architecture)
5. [The collaboration model (the crux)](#5-the-collaboration-model-the-crux)
6. [Command taxonomy](#6-command-taxonomy)
7. [API surface — REST](#7-api-surface--rest)
8. [API surface — WebSocket protocol](#8-api-surface--websocket-protocol)
9. [Persistence & data model](#9-persistence--data-model)
10. [Authentication & authorization](#10-authentication--authorization)
11. [C++ service structure](#11-c-service-structure)
12. [Non-functional requirements](#12-non-functional-requirements)
13. [Migration & rollout phases](#13-migration--rollout-phases)
14. [Open questions & risks](#14-open-questions--risks)

---

## 1. Goals & non-goals

### Goals

- **Replace `localStorage` with durable, multi-device persistence** for both authored
  trees and per-user progress.
- **Real-time collaboration:** several people edit one roadmap at once, see each
  other's cursors/selections, and **converge on a single consistent state**.
  Convergence is guaranteed; *validity* is not — a concurrent race can leave the graph
  with a cycle or a detached node. Such states are permitted, surfaced as diagnostics,
  and repaired by a human (§3, §5).
- **Be the authoritative merge point, not a gatekeeper.** The server assigns the total
  order, merges every command (nothing is rejected), and is the source of truth for
  *what the graph is* and *which invariants it currently violates*. The browser's
  `SkillTree` constructor is a courtesy check; legality is a computed diagnostic, not
  an admission gate.
- **Full platform:** accounts, orgs/teams, sharing & permissions, templates &
  forking, and an activity history — all resting on one append-only command log.
- **Keep the domain pure and portable.** The server's domain layer is a direct port
  of `src/skilltree/model/`, so there is exactly one definition of a valid tree.

### Non-goals

- **The server never computes layout.** Node positions are derived client-side; only
  explicit user *nudges* (`RepositionNode`) are authored data the server stores. (The
  non-goal held. Two details around it did not: the layout engine is synchronous and
  inline, never a worker, and the `applyNudges` model this cites was replaced by
  `sync/materialize.js`. `RepositionNode` and `position` do still exist as CRDT
  registers on both sides — carried on the wire, read by nothing on the render path.)
- **The server never renders.** No WebGL, no geometry, no icon atlas. It ships
  `TreeData` + `Progress` and relays commands; the scene is 100% client concern.
- **Not an offline-first CRDT database.** All traffic flows through a central server
  (the Google-Docs model); there is **no offline editing** and no peer-to-peer merge.
  We use op-based *convergent* commands over the central sequencer — the lightweight
  slice of CRDT a central server makes sufficient — not a full distributed CRDT with
  version vectors and partition tolerance (§5).

---

## 2. The contract the frontend already defines

The backend does not get to invent its data shapes — the frontend already published
them in `web/src/products/roadmap/model/ports.js`. The server must satisfy these ports —
read that file, not this table, which is a snapshot and has drifted before. The port also
declares `loadServerProgress` and `loadActivity`, which are not listed below.

| Frontend port | Method | Backend responsibility |
| --- | --- | --- |
| `TreeRepository` | `loadTree() → TreeData` | Serve authored tree: `{ id, title, nodes[] }` |
| `TreeRepository` | `loadProgress(treeData) → Progress` | Serve **this user's** `{ completed, inProgress, cleared, markedAt, server }` |
| `LayoutEngine` | `layout(tree) → Map<id,Vec2>` | **Stays client-side.** Not a backend concern |

`TreeData` / `NodeSpec` (the wire shape the server persists and emits):

```jsonc
// TreeData
{ "id": "windmill-roadmap", "title": "Product Roadmap", "nodes": [ /* NodeSpec[] */ ] }

// NodeSpec
{
  "id": "renderer",                 // stable, unique within a tree
  "label": "WebGL2 renderer",
  "icon": "zap",                    // lucide icon name (opaque to the server)
  "color": "sky",                   // kind ∈ terracotta|olive|gold|brick|sky|plum
  "prerequisites": ["product"],     // DAG parents — ids that must exist in this tree
  "position": { "x": 0, "y": 0 },   // optional manual nudge (authored, not derived)
  "status": "complete",            // authoring-time seed only; runtime status is per-user
  "meta": {}                        // optional opaque bag
}
```

Two properties of this contract drive the whole design:

1. **Authored tree and progress are different resources with different owners.**
   `TreeData` is shared and collaboratively edited; `Progress` is private, per-user,
   and never collaborative. They get different consistency models (§5).
2. **`prerequisites` *is* the edge set.** There is no separate edge list — an edge
   `A → B` exists iff `A ∈ B.prerequisites`. Every structural command is ultimately a
   mutation of some node's `prerequisites` (or of the node set), which the server
   models as a merge-friendly **set** (§5). Cycle-freedom is a cross-node property no
   single client can check alone — which is why, under concurrency, the server
   *detects* cycles rather than pretending clients can prevent them (§5).

The existing edit operations in `src/skilltree/editing/edits.js` are the **complete
menu of structural mutations** the server must understand — they become the command
set in §6, one-to-one.

---

## 3. Domain model: loose graph & diagnostics

Because concurrent edits are merged rather than rejected (§5), the authoritative state
is **not** guaranteed to be a valid DAG. The domain therefore has two layers:

- **`LooseGraph`** — the authoritative state: a set of nodes and a set of prerequisite
  edges that *permits* cycles, self-edges, and edges to absent nodes. Every command
  always applies to it.
- **`TreeDiagnostics`** — a pure function of the loose graph that reports how it
  currently departs from a valid tree. Computed, never stored, returned to clients to
  visualize and repair.

**`SkillTree` becomes a validated projection.** The strict entity ported from
`SkillTree.js` — the one that indexes ranks, ancestry, and the render model, and whose
constructor throws on a cycle — is constructible *only when diagnostics are clean*. A
healthy tree renders and computes unlock/trunk/health through `SkillTree`; an unhealthy
one renders through `LooseGraph` + the diagnostic overlay until a human fixes it.

**Diagnostics (soft — surfaced, never enforced):**

- **D1 · Duplicate ids** — two live nodes share an `id`. (Near-impossible: clients mint
  unique ids; a genuine collision merges field-wise, §5.)
- **D2 · Dangling / inert edges** — an edge references a node not currently present.
  Retained in the document (so add-wins resurrection re-materializes it) but filtered
  from the derived DAG view.
- **D3 · Cycles** — one or more strongly-connected components of size > 1. Reported
  with their member ids so the UI can ring them and offer an edge to cut.
- **D4 · Self-edge** — a node lists itself as a prerequisite.
- **D5 · Shape smells** — soft caps: label > 256 chars, in-degree > 4 (the tidiness
  smell), unknown `color`, empty `icon`, node count nearing `MAX_NODES` (default
  20,000). Warnings, not walls.

**Auto-repairs (safe, applied without asking):** duplicate edges collapse for free
(prerequisites are a *set*, §5); a self-edge and an inert edge are simply dropped from
the derived view. These change nothing a user would want kept.

**Derived read-models (functions of a *valid* tree; available once diagnostics are
clean):**

- `state ∈ {locked, available, active, complete}` — from `UnlockRules.derive(tree,
  progress)`. Availability is a pure function of prerequisites + a user's completed set.
- `trunk / branch / edgeKind` — from `TrunkTree`. Used for the activity feed and to
  classify an edge as `trunk | in-branch | cross-branch`.
- `health` — from `TreeHealth.assess`: node/edge counts, cross-branch coupling,
  redundant edges, a 0–100 tidiness score. Exposed read-only via the API (§7).

**Progress (per user, per tree) — private LWW overlay:**

- `active` (in-progress) and `complete` are mutually exclusive (one status per node).
- The overlay carries `markedAt` — node → epoch ms, the SERVER's clock at the moment it
  recorded the mark. It is the only instant that survives the device a mark was made on
  (a client stamps only its own marks), so it is what a reader dates a step by. The client
  HLC stored beside it orders writes and is never served back as a time.
- "complete only if all prerequisites are complete" is an **advisory** rule the client
  guards and the server records; it is not a hard reject (a cyclic region can make it
  unsatisfiable — exactly the kind of thing the user resolves via D3). Progress never
  blocks on collaborators.

The point: **the domain has exactly one place that decides "is this a valid tree" —
`TreeDiagnostics` — and it answers by *describing the damage*, not by refusing the
edit.**

---

## 4. System architecture

A layered, ports-and-adapters service. The dependency arrow points **inward**: the
domain knows nothing of Postgres, HTTP, or WebSockets. This mirrors the frontend's own
discipline (pure `model/`, messy details at the boundary).

```
                    ┌──────────────────────────────────────────────┐
   WSS / HTTPS  ───▶ │  adapters/  (the messy edges)                │
                    │    http/   REST controllers                  │
                    │    ws/     socket sessions, room routing      │
                    │    postgres/  libpqxx repositories            │
                    │    bus/    Redis|NATS pub/sub (cross-node)    │
                    └───────────────┬──────────────────────────────┘
                                    │ implements
                    ┌───────────────▼──────────────────────────────┐
                    │  ports/     abstract interfaces               │
                    │    OpLog, TreeRepository, ProgressRepo,       │
                    │    ShareRepo, PresenceBus, Clock, TokenIssuer │
                    └───────────────┬──────────────────────────────┘
                                    │ used by
                    ┌───────────────▼──────────────────────────────┐
                    │  application/   use-cases & orchestration     │
                    │    TreeRoom          (authoritative actor)    │
                    │    CommandService, ProgressService,           │
                    │    ShareService, TemplateService, AuthService │
                    └───────────────┬──────────────────────────────┘
                                    │ calls
                    ┌───────────────▼──────────────────────────────┐
                    │  domain/    pure C++ — port of src/skilltree  │
                    │    LooseGraph (authoritative, may be invalid) │
                    │    TreeDiagnostics (cycles, dangling, smells) │
                    │    SkillTree (validated projection),          │
                    │    UnlockRules, TrunkTree, TreeHealth,        │
                    │    Command (merge + invert)                   │
                    └──────────────────────────────────────────────┘
```

**The central runtime object is the `TreeRoom`.** For every tree currently being
viewed or edited, one in-memory `TreeRoom` holds the authoritative **`LooseGraph`
document**, the current `seq`, and the set of subscriber sessions. All commands for
that tree funnel through the room's single-threaded strand (§5, §11), which buys us —
for free — a total order and a single writer, so merges and the JSONB document update
never race. The room *merges* every command (it never rejects) and recomputes
diagnostics; validity is a read-model, not a gate. Rooms are the unit of concurrency,
sharding, and eviction.

**The document is the source of truth; the op log is history.** The room keeps the
authoritative state as a single JSONB **document** (`trees.document`), updated in place
under its strand — so an import or a bulk reorder is one row write, not thousands of
inserts. It also *appends* each merged command to `tree_ops`, a lightweight,
append-only log that powers the activity feed, per-user undo, and reconnect replay, but
is **not** replayed to reconstruct state. Loading a tree = read the document; catching
up a reconnecting client = ship the ops since its last `seq`, or the whole document if
it is too far behind.

---

## 5. The collaboration model (the crux)

The hard question is no longer "how do we *prevent* an invalid graph?" but **how do N
people edit one graph so their replicas always converge, edits are never silently lost,
and the rare invalid state is made visible rather than hidden?**

All traffic flows through a central server (the Google-Docs model); there is no offline
editing and no peer-to-peer merge. That single assumption is what lets us use the
*lightweight* slice of CRDT: **op-based convergent commands over a central sequencer.**
The `TreeRoom` strand provides a total order and reliable, once-only delivery for free
— the two things op-based CRDTs need — so each command only has to be
**commutative/idempotent** (so a client's optimistic apply and the server's order
converge without rollback) and carry an **HLC** tiebreaker for genuine scalar races. No
version vectors, no tombstone-GC ceremony, no partition handling. If offline is ever
required, this design graduates to a full CRDT without changing the command shapes.

We reject two extremes and keep the middle:

- **Reject-on-invalid — rejected.** Bouncing a structurally-fine edit because a
  collaborator concurrently made it illegal is jarring and forces the client to roll
  back an optimistic apply. We would rather accept the edit and *show* the problem.
- **Pure graph CRDT with cycle-breaking — rejected.** The only conflict-free resolution
  of a jointly-formed cycle is to silently drop an edge; a roadmap edge vanishing behind
  the user's back is the failure we most want to avoid.

**Chosen model: never reject; merge by conflict class; surface what merging couldn't
keep valid.**

### Class A — Content ops (scalar, LWW per field)

`RenameNode`, `SetNodeColor`, `RepositionNode`. Each target field is a
**last-writer-wins register** ordered by an HLC stamp `(physicalMs, counter, actorId)`.
Concurrent writes to the same field converge to the highest stamp; different fields
never interact. Clients apply locally and immediately. `RepositionNode` especially must
feel instant — the "loser" of a concurrent drag simply sees the node settle at the
winning coordinate.

### Class B — Structural ops (set-merged, add-wins, never rejected)

`CreateNode`, `DeleteNode`, `AddEdge`, `RemoveEdge`, `ReconnectEdge`,
`TransitiveReduction`. Topology is two CRDT sets:

- **Nodes** — an add-wins observed-remove set keyed by `id`. `CreateNode` adds;
  `DeleteNode` tombstones. A concurrent create-of-same-id merges field-wise; a
  concurrent create-vs-delete resolves **add-wins** (the node survives), matching the
  edge rule below.
- **Prerequisite edges** — an add-wins observed-remove set of `(from, to)` pairs.
  Because it is a *set*, a duplicate `AddEdge` is idempotent — **duplicate edges
  collapse for free**, no repair pass needed. On a concurrent add/remove of the same
  edge, **add-wins**: a resurrected edge is a visible, fixable diagnostic; a
  silently-dropped one is the failure we rejected.

The protocol has no reject branch:

```
 client                              TreeRoom (single strand)                others
   │  apply optimistically              │                                     │
   │  send {opId, cmd, hlc} ──────────▶ │                                     │
   │                                    │ merge into LooseGraph document       │
   │                                    │ seq := ++head ; append tree_ops      │
   │  ◀── ack {opId, seq} ──────────────┤  broadcast {seq, cmd} ─────────────▶│
   │  confirm opId                      │                    merge (converges) │
```

Because merges are commutative and the strand gives a total order, every replica lands
on the same `LooseGraph`. That graph *may* now contain a cycle or a detached node;
`TreeDiagnostics` (a pure function, recomputed client-side on every op) reports it and
the UI rings the offending nodes. **No time-of-check/time-of-use gap, because there is
no check to fail** — there is only merge and diagnose.

**`DeleteNode` is a plain tombstone — no server-computed splice.** The old design
re-tethered orphaned children to the deleted node's grandparents; we drop that.
Deleting a node removes it; its edges become *inert* (retained for add-wins
resurrection, filtered from the derived DAG view), so a child that loses its only live
parent simply surfaces as a new root. This removes a compound, order-sensitive op and
the "surprise re-tether" it caused — detachment is visible and directly fixable, which
is the whole philosophy.

**`TransitiveReduction` (one-click "Tidy") stays a server-computed bulk op.** It is a
semantics-preserving auto-repair: the room computes the redundant edges against the
current document and applies their removal as one op / one undo step, so all replicas
converge on the same reduction.

### Class C — Presence (ephemeral, best-effort)

Cursor (world coords), selection, viewport, display name/color, "editing node X".
Broadcast to subscribers, coalesced server-side, dropped on disconnect. Never
persisted, never in the op log.

### Sequencing, reconnect, convergence

- Each tree has a **monotonic `seq`** assigned by its room; every merged Class A/B op is
  stamped and broadcast with it.
- Clients track `lastSeq`. On reconnect they send it; the server replays `tree_ops`
  since that `seq`, or ships the whole document if the gap is too large.
- **Idempotency:** each op carries a client-generated `opId` (UUID); the server
  deduplicates on `(treeId, opId)`, so a retried command is merged at most once and a
  client recognizes the echo of its own optimistic op.
- **Delivery order is by `seq`; scalar *value* resolution is by HLC.** A late op with a
  lower HLC advances `seq` and history but does **not** overwrite a Class A field
  already holding a higher stamp — so delivery order and LWW never disagree.
- **Diagnostics are not transported** — they are a pure function of the document,
  recomputed by each client after applying ops (and by the server for the REST endpoint
  and the activity feed).

### Undo / redo — and why it can never be rejected

Undo issues the **inverse command as a fresh op**; the log stays append-only. Undo is
**per-user**: each user keeps a stack of the ops they authored and replays the inverse
of the most recent one. Because nothing is ever rejected, **undo always applies** — the
old worry of "your undo was refused because a collaborator built on it" is gone. If an
inverse happens to re-create a cycle, that is simply a visible diagnostic to resolve,
not a failure.

### No offline buffer

Editing requires the socket. The `localStorage` `TreeStore` is demoted to a warm-start
read cache (last-seen document for instant first paint), not a write queue — its
content-signature invalidation still detects "the base changed underneath me" and
triggers a fresh document fetch. While the socket is down, the editor is read-only until
it reconnects; unacked optimistic ops are re-sent from memory (deduped by `opId`).

---

## 6. Command taxonomy

Every command maps one-to-one to an existing `edits.js` transform (or a progress
mutation). `Class` picks the merge rule from §5. `Inverse` powers collaborative undo.
Nothing rejects — the `Merge rule` column says how concurrency converges, not how an
edit is admitted.

| Command | Class | Payload | Merge rule | Effect | Inverse |
| --- | --- | --- | --- | --- | --- |
| `RenameNode` | A | `id, label` | LWW `label` by HLC | set label | prior `label` |
| `SetNodeColor` | A | `id, color` | LWW `color` by HLC | set color | prior `color` |
| `RepositionNode` | A | `id, x, y` | LWW `position` by HLC | set position | prior `position` (or unset) |
| `CreateNode` | B | `id, label, icon, color, parentId?, x, y` | node-set add (add-wins) | add node; if `parentId`, add edge | `DeleteNode(id)` |
| `AddEdge` | B | `from, to` | edge-set add (add-wins, idempotent) | add `(from,to)` | `RemoveEdge(from,to)` |
| `RemoveEdge` | B | `from, to` | edge-set remove (add-wins on race) | drop `(from,to)` | `AddEdge(from,to)` |
| `ReconnectEdge` | B | `oldFrom, oldTo, newFrom, newTo` | remove then add | atomic edge swap | reconnect back |
| `DeleteNode` | B | `id` | node-set tombstone | remove node; its edges go inert | recreate node + its edges |
| `TransitiveReduction` | B | *(none — whole tree)* | server-computed removals | drop redundant edges | re-add removed edges |
| `SetNodeProgress` | Progress | `nodeId, status∈{active,complete,none}` | per-user LWW by HLC | overlay | prior status |
| `PresenceUpdate` | C | `cursor, selection, viewport` | — | broadcast only | — |

Notes:

- Nothing rejects. `AddEdge`/`ReconnectEdge` may *form* a cycle; that surfaces as
  diagnostic **D3** (§3), it is not refused. Duplicate `AddEdge` is idempotent (edges
  are a set), so duplicate edges never accumulate.
- `CreateNode`'s `parentId` is optional — a node may be created as a root.
- `DeleteNode` is a plain tombstone; there is **no** server-computed splice (§5). Its
  inverse recreates the node plus the edges that were incident to it, captured from the
  pre-delete document so undo is exact.
- `TransitiveReduction` is computed server-side against the current document and
  broadcast as the concrete set of removed edges — one intent, one `seq`, one undo step,
  so all replicas apply identical effects.
- `SetNodeProgress` is not part of the shared tree stream — it flows on the same socket
  but writes the private per-user progress overlay and only echoes to that user's other
  sessions (not to collaborators). `status: none` clears the node (removes the entry).

---

## 7. API surface — REST

REST covers everything that is not the live edit stream: auth, discovery, sharing,
templates, snapshots, progress, and read models. All bodies JSON; all mutating
requests authenticated (§10). Naming follows the frontend convention — inbound models
suffixed `Request`, outbound `Response`.

### Auth

```
POST   /v1/auth/register        {email, handle, password}          → {user, tokens}
POST   /v1/auth/login           {email, password}                  → {user, tokens}
POST   /v1/auth/refresh         {refreshToken}                     → {tokens}
POST   /v1/auth/logout          -                                  → 204
GET    /v1/me                   -                                  → {user, orgs[]}
```

### Trees

```
GET    /v1/trees                ?org=&mine=&shared=                → {trees[]}   (list w/ role)
POST   /v1/trees                {title, org?, fromTemplate?}       → {tree}      (creates empty or forks)
GET    /v1/trees/:id            -                                  → {seq, data}  (current document + its seq)
GET    /v1/trees/:id/progress   -                                  → Progress    (caller's overlay)
GET    /v1/trees/:id/diagnostics -                                 → {cycles[], dangling[], selfEdges[], smells[]}  (validity report)
GET    /v1/trees/:id/health     -                                  → {nodeCount, edgeCount, crossBranch, redundant, avgInDegree, score}
GET    /v1/trees/:id/activity   ?since=&limit=                     → {events[]}  (human-facing feed)
GET    /v1/trees/:id/ops        ?since=seq                         → {ops[]}     (raw op log, for replay/debug)
PUT    /v1/trees/:id            {title}                            → {tree}      (metadata only)
DELETE /v1/trees/:id            -                                  → 204         (owner only; soft-delete)
```

Structural/content edits do **not** have REST endpoints in the collaborative model —
they flow over the socket (§8) so every editor sees them live. A `PUT` full-tree
fallback exists only for Phase 0 (§13) before the socket lands.

### Sharing & orgs

```
GET    /v1/trees/:id/shares     -                                  → {shares[]}
POST   /v1/trees/:id/shares     {principal, principalId, role}     → {share}
DELETE /v1/trees/:id/shares/:sid -                                 → 204
POST   /v1/trees/:id/visibility {visibility∈private|org|public}    → {tree}
GET    /v1/orgs                 -                                  → {orgs[]}
POST   /v1/orgs                 {name, slug}                       → {org}
POST   /v1/orgs/:id/members     {userId, role}                     → {member}
DELETE /v1/orgs/:id/members/:uid -                                 → 204
```

### Templates

```
GET    /v1/templates            ?published=                        → {templates[]}
POST   /v1/templates            {treeId, title, description}       → {template}   (snapshot a tree)
POST   /v1/templates/:id/fork   {title, org?}                      → {tree}       (instantiate)
```

---

## 8. API surface — WebSocket protocol

One socket per tab, multiplexing all rooms the user has open. JSON frames (msgpack
negotiable for the hot path). The socket is the transport for Class A/B/C ops and
progress. Authentication: the JWT is presented at connect; per-room authorization
happens on `subscribe`.

**Client → server:**

```jsonc
{ "t": "subscribe",   "treeId": "…", "lastSeq": 812 }        // join room; server replays tail
{ "t": "unsubscribe", "treeId": "…" }
{ "t": "cmd",  "treeId": "…", "opId": "uuid",
  "kind": "AddEdge", "payload": { "from": "a", "to": "b" }, "hlc": "…" }
{ "t": "presence", "treeId": "…", "cursor": {"x":..,"y":..}, "selection": "nodeId", "viewport": {…} }
{ "t": "progress", "treeId": "…", "opId": "uuid", "nodeId": "…", "status": "complete", "hlc": "…" }
```

**Server → client:**

```jsonc
{ "t": "snapshot", "treeId": "…", "seq": 812, "data": { /* loose-graph document */ } }
{ "t": "op",     "treeId": "…", "seq": 813, "actor": "userId",
  "kind": "AddEdge", "payload": { "from": "a", "to": "b" }, "hlc": "…" }   // ordered, already merged
{ "t": "ack",    "treeId": "…", "opId": "uuid", "seq": 813 }               // your optimistic op confirmed + durable
{ "t": "presence", "treeId": "…", "actor": "userId", "cursor": {…}, "selection": "…" }
{ "t": "peer",   "treeId": "…", "event": "join|leave", "actor": "userId", "profile": {…} }
```

Ordering guarantees: within a tree, `op` frames are delivered in strictly increasing
`seq`; a client merges them in order and drops any it already has (by `opId` or `seq`).
Delivery order sequences the log, but a Class A field's *value* is resolved by its
`hlc` — a later-arriving op with a lower stamp does not overwrite a newer value. There
is no `reject` frame; a structurally-invalid result is reported by `TreeDiagnostics`,
which each client recomputes from the document. Presence frames are unordered and
coalesced (server emits at ≤ 20 Hz per subscriber, latest-wins per actor).

---

## 9. Persistence & data model

PostgreSQL. The authoritative state of each tree is a single JSONB **document**
(`trees.document`); an append-only `tree_ops` log is history (activity, undo, reconnect
replay), not the source of truth. Plus projections and platform tables.

```sql
-- identity & orgs
users        (id uuid pk, email citext unique, handle text unique,
              password_hash text, created_at timestamptz)
orgs         (id uuid pk, name text, slug text unique, created_at timestamptz)
org_members  (org_id uuid, user_id uuid, role text /* owner|admin|member */,
              primary key (org_id, user_id))

-- trees — the document IS the source of truth (loose-graph CRDT state)
trees        (id uuid pk, org_id uuid null, owner_id uuid,
              title text, visibility text /* private|org|public */,
              head_seq bigint, forked_from uuid null,
              document jsonb,                            -- authoritative loose-graph state
              deleted_at timestamptz null, created_at, updated_at)

-- the op log — append-only HISTORY (activity, undo, reconnect replay); not replayed for state
tree_ops     (tree_id uuid, seq bigint, actor_id uuid,
              op_id uuid, kind text, payload jsonb, hlc text, created_at timestamptz,
              primary key (tree_id, seq),
              unique (tree_id, op_id))                 -- idempotency

-- sharing (surrogate pk: principal_id is null for link shares, so it can't be in the pk)
tree_shares  (id uuid pk, tree_id uuid,
              principal text /* user|org|link */, principal_id uuid null,
              role text /* viewer|editor|admin */, token text null, created_at,
              unique (tree_id, principal, principal_id))

-- per-user progress — PRIVATE, per-user LWW, not in the document or the op log
node_progress (tree_id uuid, user_id uuid, node_id text,
              status text /* active|complete */, hlc text, updated_at timestamptz,
              primary key (tree_id, user_id, node_id))

-- platform
templates    (id uuid pk, source_tree uuid null, data jsonb, title text,
              description text, published_by uuid, created_at)
activity     (id bigserial pk, tree_id uuid, actor_id uuid, kind text,
              summary text, ref_seq bigint, created_at)   -- human-facing feed
```

Design notes:

- **`trees.document` is authoritative and always current.** Each merged command is one
  in-place `UPDATE ... SET document = …, head_seq = …`; an import or a bulk reorder is a
  *single* row write, never thousands of inserts or updates. There is no snapshot table
  to rebuild — the document is the snapshot. Its safety rests on the actor-per-room
  single writer (§4, §11): one strand owns the tree, so the read-modify-write needs no
  row-level optimistic locking.
- **`tree_ops` is append-only history**, scaling with *edits*, not nodes. It feeds the
  activity feed, per-user undo, and reconnect replay (`WHERE seq > lastSeq`), but is
  never replayed to reconstruct state; it can be compacted behind `head_seq` on a
  schedule (dropping only what is older than the undo horizon).
- **Positions live in the document**, carried by `RepositionNode` into `node.position`.
  The server stores the nudge; it never derives one.
- **Progress is outside both the document and the op log** — private per-user LWW state,
  not shared history. Mixing it in would leak one user's progress into another's view
  and pollute the activity feed.
- **`activity` is a projection**, derived from ops but denormalized (with `TrunkTree`
  context: "moved *renderer* into the *rendering* branch") so the feed renders without
  replaying the log.

---

## 10. Authentication & authorization

> **Superseded by the design system's `guidelines/auth.md` (X6) and implemented per
> `AUTH.md`.** Authentication is now **passwordless magic links** — "passwords never
> exist". The email+password/JWT sketch below is retained only for its authorization
> model (roles, enforcement points), which still holds. See `AUTH.md` for the live
> method set, endpoints, sessions, and schema.

**Authentication (historical sketch — replaced by magic links).** Email + password,
hashed with **Argon2id** (libsodium). On login issue a short-lived **JWT access token**
(~15 min) + a rotating **refresh token** (persisted, revocable). The WebSocket presents
the access token at connect. OAuth / SSO is a later addition behind the same
`TokenIssuer` port.

**Authorization.** A caller's **effective role** on a tree is the maximum of:

1. `owner` if `tree.owner_id == user`,
2. their `tree_shares` role (viewer/editor/admin), and
3. their org role mapped through `tree.org_id` (org admin ⇒ admin, member ⇒ viewer if
   `visibility ∈ {org, public}`), plus `public` visibility ⇒ viewer for anyone.

Role → capability matrix:

| Capability | viewer | editor | admin | owner |
| --- | :-: | :-: | :-: | :-: |
| Read tree, subscribe, presence | ✓ | ✓ | ✓ | ✓ |
| Read/write **own** progress | ✓ | ✓ | ✓ | ✓ |
| Class A/B commands (edit structure & content) |  | ✓ | ✓ | ✓ |
| Manage shares & visibility |  |  | ✓ | ✓ |
| Rename tree, publish template |  | ✓ | ✓ | ✓ |
| Delete / transfer tree |  |  |  | ✓ |

Enforcement points: REST controllers authorize per request; the room authorizes once
at `subscribe` and caches the role on the session, re-checking cheaply per `cmd` (a
role can be revoked mid-session, so the check is not skipped — it's a map lookup).
Every payload is validated at the transport boundary before it reaches the domain;
the domain then enforces the tree invariants (§3). Never trust a client-sent DAG.

---

## 11. C++ service structure

C++20. Directory layout reads like the architecture (§4) and honors the repo's
conventions: pure domain, messy details at the edges, constructors on entities, group
related types by kind, no single-caller indirection.

```
windmill-backend/
  SPEC.md                     ← this document
  CMakeLists.txt              ← CMake + vcpkg/Conan
  domain/                     pure C++ — no I/O, no framework. Port of src/skilltree/model/
    Ids.h                       strong types: TreeId, NodeId, UserId, Seq
    LooseGraph.{h,cpp}          authoritative node/edge sets; merges commands, may be invalid
    TreeDiagnostics.{h,cpp}     pure report: cycles, dangling, self-edges, smells
    SkillTree.{h,cpp}           validated projection of a clean graph (port of SkillTree.js)
    UnlockRules.{h,cpp}         derive NodeState (port of UnlockRules.js)
    TrunkTree.{h,cpp}           branch/trunk election (port of TrunkTree.js)
    TreeHealth.{h,cpp}          tidiness metrics (port of TreeHealth.js)
    Command.{h,cpp}             command variants + merge() + invert()
  ports/                      abstract interfaces (one header each or grouped)
    OpLog.h  TreeRepository.h  ProgressRepository.h  ShareRepository.h
    PresenceBus.h  Clock.h  TokenIssuer.h
  application/                use-cases; orchestrate domain + ports
    TreeRoom.{h,cpp}            authoritative in-memory actor (one strand per tree)
    RoomRegistry.{h,cpp}        load/evict rooms, shard by TreeId
    CommandService.{h,cpp}      merge → sequence → persist → broadcast
    ProgressService, ShareService, TemplateService, AuthService
  adapters/                   the boundary — the only place frameworks appear
    http/       REST controllers (Drogon or Beast)
    ws/         socket session, frame codec, room routing
    postgres/   libpqxx implementations of the ports
    bus/        Redis|NATS PresenceBus / cross-node event fanout
    auth/       jwt-cpp + libsodium adapters
  infra/                      bootstrap, config, logging, thread pool
    main.cpp
  test/                       mirrors the tree: test/domain/…, test/application/…
```

**Recommended libraries** (all behind ports, so swappable):

| Concern | Choice | Alternative |
| --- | --- | --- |
| HTTP + WS + coroutines | **Drogon** | Boost.Beast + custom router; uWebSockets (raw WS) |
| Postgres | **libpqxx** | Drogon ORM |
| JSON (boundary only) | **nlohmann/json** | simdjson for hot-path parse |
| Auth | **jwt-cpp** + **libsodium** (Argon2id) | — |
| Cross-node fanout | **Redis pub/sub** or **NATS** | in-process only (single node) |
| Build / deps | **CMake + vcpkg** | Conan |
| Tests | **Catch2** / GoogleTest | — |

**Concurrency model — actor per room.** Each `TreeRoom` runs on a dedicated **strand**
(`asio::strand` or a lock-free mailbox). All commands for a tree serialize through its
strand, which gives — with zero locks on the graph — a total order and always-consistent
merge state. `RoomRegistry` shards rooms across a worker pool by `TreeId`; idle rooms
persist their document and evict. This is the cleanest possible mapping of §5's
convergent-op serialization onto threads: the property "one writer per tree" is a
structural feature of the runtime, not a lock convention someone can forget — and it is
also what makes the single-row JSONB document safe to update in place (§9).

The domain speaks typed structs and strong ids, never JSON — parsing happens once at
the adapter boundary and the typed command travels inward. A sketch of the seam:

```cpp
// application/TreeRoom.h  — the authority for one tree
class TreeRoom {
public:
  TreeRoom(LooseGraph graph, Seq head, OpLog& ops, PresenceBus& bus);

  // Runs on the room strand. Merges the command into the loose-graph document
  // (never rejects), assigns the next seq, persists, and returns the op to broadcast.
  AppliedOp submit(const Command& cmd, const Actor& actor);

  // Pure report of how the current document departs from a valid tree.
  TreeDiagnostics diagnose() const;

private:
  LooseGraph graph_;      // authoritative; only this strand mutates it
  Seq        head_;
  OpLog&     ops_;
  PresenceBus& bus_;
};
```

---

## 12. Non-functional requirements

Targets mirror the frontend's own bar (60fps at 5,000+ nodes) so the server never
becomes the bottleneck a fast renderer is waiting on.

- **Scale of a tree:** correct up to `MAX_NODES` (default 20,000). The perf reference
  is the frontend's 5,000-node tree.
- **Load latency:** `GET /trees/:id` (read the `document`) p99 < 200 ms server-side
  for a 5,000-node tree; payload gzip/msgpack.
- **Edit latency:** command merge + persist + broadcast p99 < 30 ms in-region. The
  author sees their own optimistic apply at 0 ms; collaborators see the op within one
  RTT + 30 ms.
- **Presence throughput:** cursors update at up to ~60 Hz client-side but the server
  coalesces to ≤ 20 Hz per subscriber, latest-wins, deltas only.
- **Fanout / horizontal scale:** rooms are sharded by tree with **sticky routing**
  (consistent hash on `TreeId`) so a tree's authority — and its single JSONB writer —
  lives on exactly one instance; a Redis/NATS bus carries presence and cross-instance
  subscribe so any instance can serve any socket. The document is always current (no
  snapshot rebuild); compact `tree_ops` behind `head_seq` on a schedule.
- **Consistency guarantees:** structure/content = **per-tree total order via the
  sequencer, convergent merge** (add-wins sets + per-field LWW) — never rejected, so a
  transiently-invalid graph is *surfaced* (§3), not refused; progress = **per-user
  LWW**; presence = **best-effort**.
- **Durability:** an `ack` is sent only after the op is fsync-durable in `tree_ops`
  (and its effect folded into `trees.document`) — a confirmed edit survives a crash.
  Optimistic client state that never got an `ack` is re-sent from memory on reconnect
  (deduped by `opId`); there is no offline queue.
- **Security:** authz on every op; strict payload validation at the boundary; per-user
  and per-tree rate limits on commands; size caps (D5); full audit via the op log;
  TLS/WSS everywhere; refresh-token rotation + revocation.
- **Observability:** structured logs; per-room metrics (subscribers, cmd rate,
  diagnostic count, strand queue depth); op-log write lag; distributed tracing from
  socket frame through domain to Postgres.

---

## 13. Migration & rollout phases

The rule this section was built on held: each phase was independently shippable and left
the app working. The sequence did not. Real-time collaboration was built ahead of accounts,
journal and gym arrived as whole products the plan never contemplated, and sharing shipped
as per-tree visibility plus a public gallery rather than the per-user role matrix §10
sketches — there is no `tree_shares` table.

The per-phase status list that used to sit here is **deleted rather than corrected**, for
the reason in the banner at the top of this file: nothing was keeping it true, and a stale
✅ is read as fact. What shipped, and in what order, is `NOTES.md` and the dogfood tree
(`t_9362d9bc883e0a1e`); the endpoints that exist today are `RUNNING.md`; the tables that
exist today are `db/schema.sql`.

---

## 14. Open questions & risks

- **Cyclic layout — the largest line-item of this pivot.** `DagreLayoutEngine` and
  `RadialLayoutEngine` assume a DAG; a cyclic loose graph has no topological order or
  roots. The client's loose-graph render path must break back-edges *for layout only*
  (dagre's own acyclicer does this), lay out the resulting DAG, then draw the removed
  back-edges on top in the error style. New client work, and the biggest risk in the
  allow-invalid direction.
- **Diagnostics UX.** Showing a cycle/detachment and guiding the fix (which edge to cut)
  is now core UX, not an error path. Risk: users tolerate a *little* invalidity but not
  a graph that is often broken — measure how often real collaboration actually produces
  cycles before investing in elaborate repair affordances.
- **Detachment on delete.** Deleting a node detaches its children (they become roots)
  instead of re-tethering them to grandparents. Simpler and visible, but a user may
  expect the old auto-re-tether; surface the detachment in the delete toast (the UI
  already has one).
- **Inert-edge accumulation.** Add-wins retention means a tombstoned node's edges linger
  in the document so resurrection works. Needs a compaction pass that prunes edges whose
  endpoint has been tombstoned beyond the undo horizon, or the document grows unbounded.
- **LWW label vs. lost keystrokes.** `label` is LWW, so a concurrent rename silently
  drops the loser. Acceptable for short labels; revisit as an MV-Register (keep-both,
  surfaced for the user to reconcile) only if users actually complain.
- **Position churn on the log.** `RepositionNode` is high-frequency; even as LWW content
  it writes ops. Mitigation: debounce to the *final* position of a drag before logging
  (the frontend already fires `onNodeMoveEnd` once per drag — align the command to that).
- **Big-tree first paint.** The 20,000-node `document` is a large JSONB payload. If it
  bites, add server-side viewport/subtree pagination — but only if measured, since the
  renderer is built for the whole tree at once.
- **Template drift.** A forked tree diverges from its template; whether forks track
  upstream template updates is a product decision, deferred.
- **C++ operational maturity.** A hand-rolled C++ service is the stated learning goal,
  but carries more operational burden (memory safety, build/deploy, connection
  pooling) than a managed stack. The ports/adapters boundary keeps that burden at the
  edges and the domain testable in isolation — lean on it.

---

*This spec keeps the domain layer a faithful port of `src/skilltree/model/` so there is
one definition of a valid Windmill tree — but that definition is now a **diagnosis** the
server computes and the client visualizes, not a gate either one enforces. The server's
job is to merge every edit, keep replicas convergent, and describe the damage when
convergence and validity disagree. Everything else — transport, storage, real-time
fanout — is a swappable edge around that core.*
