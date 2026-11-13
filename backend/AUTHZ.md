# Authz — enforcing the session on the data plane

`AUTH.md` gives identity (a session behind a cookie or bearer). This is enforcement: how that
session gates the tree, WebSocket and MCP surfaces.

## The model

Visibility-gated read, owner-only write, per-user progress. The two predicates are `canRead` and
`canWrite` in `products/roadmap/domain/Access.h`, and every surface calls those and no parallel copy.

- **Reads** (`GET` tree/progress/diagnostics/activity, WS `subscribe`/presence, MCP `get_tree`) gate
  on `canRead`: a `private` tree is its owner's alone, an `unlisted` or `public` one is readable by
  anyone holding the id. A denial is byte-identical to an absent tree, so no id can be probed for
  existence. `GET …/progress` serves the **owner's** overlay to every reader, under the same gate:
  the stored marks to a caller `canWrite` admits, and to every other reader the owner's derived
  completion (`readerView`, `products/roadmap/domain/OpenedTrees.h`), as the gallery counts it.
  A read is not the whole tree for everyone: the tree a node `opens` goes only to a caller
  `canWrite` admits, because a tree id is the read capability of an unlisted tree. Every other
  reader — a stranger, a signed-out caller, a revoked session — receives `readerView`
  (`products/roadmap/domain/Subgraph.h`), the nodes without their pointers, from `GET` tree, the WS
  subscribe delta and every live frame. The MCP reads answer it, as `opens: {treeId, title, state}`,
  to that same caller alone and only for a tree of theirs that stands; an MCP write that sets one is
  refused unless its target stands and is the caller's, in the same words for an absent tree and
  someone else's, so the refusal confirms no id. What a pointer comes to follows the same line: for
  a caller `canWrite` admits, a node that opens a tree of theirs is complete when that tree is, in
  MCP `state`, the registry counts and the `opens` object of `GET` tree; for every other reader the
  node is an ordinary one whose state follows their own mark, the `opens` key is absent, and the
  opened trees are not read for that state; the writer's own read of them is made after the tree's
  strand is released, so no other read of the tree waits on it. A progress mark follows the same
  line: only a caller `canWrite` admits is refused a mark on a node that opens a tree of theirs,
  and the opened trees are read only for that caller; every other reader's mark on that node is
  recorded and answered byte for byte as on a node that opens nothing. The owner's overlay is the
  one thing such a reader is shown of a pointer: a step that opens a tree of the owner's reads
  `complete` while that tree is complete for the owner and has no row otherwise, whatever mark it
  holds, so a step that opens a tree that is not complete reads as a step nobody marked. That answer
  follows the owner's trees in one budgeted read made after the tree's strand is released, and names
  and counts no opened tree. A row made complete by its tree is the step's stored mark when that
  says complete under a stamp; else its time is the later of the latest stamped mark in what
  completed the tree and the stamp the pointer was set under, so it never predates the pointer and
  never takes the time of a mark stored without a stamp. What the gallery's counts and a card's time
  and place take from the owner's marks, they take from these rows alone. What the overlay does say,
  as known limits: a reader who can also read the opened tree can match a row's time to that tree's
  latest mark, and so tell which step opens it; a row's time changes when the opened tree changes,
  with no edit to this tree, and several steps can share one time; while an owner's follow is
  degraded — the read failed or ran past its budget, the five minutes after either, or the gallery's
  cap cut it short — every step of theirs that holds a pointer reads unmarked, valid pointer or not,
  where a marked step with no pointer keeps its row; a reply for a tree that holds a pointer
  waits on that read, which a reply for a tree without one does not make; and a removal's deletes
  reach readers as live frames: one who can read the removed tree, or two of the trees whose steps
  opened it, sees those trees' delete frames, each stamped by the server, arrive within a
  millisecond of the removal, and so can tell which steps opened it. Each such frame alone is the
  frame an owner's own `delete_node` with `prune` sends. Beyond these, no state, count, key,
  refusal or frame a reader is sent says a node opens a tree. A tend neither reads nor sets the pointer: it runs
  as the owner on labels that may be someone else's words, so `ScopedToolHost` offers it no `opens`
  argument and no `opens` field, and refuses a call
  that names either; and no call it can make brings a pointer back, because a node an import
  revives from a delete opens only the tree that batch names (`graftState`), and a run's batch
  names none. The `state` it reads is the owner's.
  What is wrong with a tree's pointers follows the same line. `treeLoops` and `danglingPointers`
  (`SPEC.md`, Model, `PointerDiagnostics`) carry tree ids, titles and the stored pointer text, so
  MCP `get_diagnostics` and `GET …/diagnostics` answer them only to a caller `canWrite` admits,
  from a read made after the tree's strand is released. Every other reader is answered the graph's
  diagnostics alone, in the bytes a tree without pointers answers, with no read of another tree:
  no key, id, title or timing says the tree holds a pointer. An MCP receipt names a loop of trees
  only to the owner who just set the pointer that closed it. A tend is answered neither key and
  follows no pointer: `ScopedToolHost` withholds `includePointers` from its catalog and sends it
  as `false` on every call, and it has no `opens` argument to set.
  `guides` (`SPEC.md`, Model) follows the same line. The trees above a tree are the caller's own:
  they are read only for a caller `canWrite` admits, after the tree's strand is released, and each
  must stand and belong to that caller, so someone else's tree that points at this one — the socket
  and `PUT` admit any pointer text — is above it for nobody, and the read is keyed on the caller's
  own trees, so its cost does not grow with what another account points at a tree. Every other
  reader of `GET …/guides` and of MCP `get_tree` is answered the tree's own guide alone, `yours:
  false`, with no read of the trees above: no key, id, title or timing says a tree of the owner's
  opens this one. A tend is answered no `guides` and reads no tree above the tended one:
  `ScopedToolHost` withholds `includeGuides` from its catalog and sends it as `false` on every call,
  so a run reads the tended tree's own guide and no other tree's id, title or words.
  The registry list and a tree's removal follow the same line. A row's `openers` (`GET /v1/trees`,
  `SPEC.md`) names only the caller's own standing trees, judged from the trees the list already
  holds, so a pointer another account plants at the tree is never counted. A removal deletes the
  steps that open the tree from the owner's own trees alone: its read is keyed on the caller's own
  trees and answers none for a tree that is not theirs, so a refused delete edits nothing, and only
  the owner's reply names trees, theirs alone. Someone else's step that points at the tree stays
  theirs, leading nowhere.
- **Document writes** (`PUT`, WS `subgraph`, structural MCP tools) require
  a session (anonymous → `401`) and gate on `canWrite`, which is ownership and nothing else. **A tree
  is born owned** — the owner is written by the same insert that creates the row (create, fork, `PUT`
  of an absent id) — so there is no instant at which a row exists without one. **An unowned tree is
  nobody's to write**: the seeded demo tree (`t_9e407a96b5330ebe`, `owner_id NULL`, `public`) is
  world-readable and editable by no one. Every write path runs `canRead` first, so a refusal never
  confirms that a private id names something; a readable tree the caller does not own answers `403`.
- **Forks** require read access to the source and create a new tree owned by the recipient; they do
  not require write access to the source.
- **Progress marks** (WS `progress`, an MCP `status` row) are not document writes and are not
  owner-gated. They gate on `canRead` alone, and each caller writes only their own per-user overlay
  (`node_progress` is keyed by `user_id`). Any signed-in reader may mark any tree they can read — the
  demo included — and nobody's marks are visible in anyone else's overlay. The `canRead` gate is
  there so a mark cannot confirm which node ids a private tree holds. One mark is not recorded: the
  tree's writer's on a node that opens a tree of theirs, which is complete when that tree is
  (`SPEC.md`, Model). A tend marks as the owner and is refused the same way, in a sentence that
  names the node and no tree.

`owner_id` is written by exactly two statements, the `INSERT` in `create` and the `INSERT` in `fork`
(`products/roadmap/adapters/postgres/PgTreeRepository.cpp`). There is no `UPDATE` of that column
anywhere, so a row with `owner_id IS NULL` is unwritable through every surface and can be repaired
only by hand in SQL.

## Per surface

`AuthService::authenticate(secret) -> std::optional<User>` resolves a cookie or bearer to a user and
rolls the session. Every surface reuses it, and none trusts a client-supplied user or actor id.

### REST

The caller is resolved per request. `TreeApi::callerOf` delegates to `wm::callerOf(req, auth)`
(`platform/adapters/http/Caller.h`), which reads the `wm_session` cookie, falls back to
`Authorization: Bearer`, and hands the secret to `AuthService::authenticate`.

Reads gate on `canRead` and answer a denial as a `404` byte-identical to absence. Writes require an
authenticated caller (`401` for anonymous) and then gate on `canWrite`. Progress writes carry the
resolved caller into `node_progress`. The fixed `dev` actor survives only as the default
`WINDMILL_MCP_USER` of the two standalone MCP binaries and as `main.cpp`'s MCP fallback.

`StoredTree` (`products/roadmap/ports/TreeRepository.h`) carries `owner` and `visibility` up to the
room, so the authz decision reads loaded facts instead of issuing a second query.

### WebSocket (`/v1/socket`)

The upgrade is authenticated, not each frame. `Collab::onOpen` reads the cookie, falls back to a
bearer, and stores a `Principal` (`products/roadmap/adapters/ws/PresenceHub.h`) in the connection
context.

- A failed authentication does not reject the upgrade. The connection joins as a read-only guest
  (`u<N>`, `authenticated = false`), because a public tree has to be watchable by a stranger.
- A stated `Origin` must be allow-listed or the upgrade is closed before a frame is read — the same
  set `main.cpp` composes for CORS, handed to `Collab` through `RoadmapDeps`. A client that sends no
  `Origin` is untouched: only a browser sends one.
- The `Principal` keeps the session's digest, never the secret, plus `checkedAtMs`. A socket outlives
  the request that opened it, so both writers and readers re-prove the session (throttled to one
  lookup a minute) and a revocation reaches a connection opened before it.

**Read authorization is re-decided, not granted once.** `Collab::reachOf` is the single verdict —
`canRead`, then `canWrite`, against the tree's *current* access facts, answering nothing, the
reader's view or the whole frame — and four things run it: `subscribe`; every
fan-out on `WsPresenceBus` (a refused connection is dropped from that tree and told "no such tree");
`RoomRegistry::setVisibility` and `RoomRegistry::retire`, so a share flip and a deletion land on the
event; and `Collab::reproveReaders`, a 15 s sweep over every open subscription, which is the only
road for the two revocations no event carries — a session revoked on a tree nobody is editing, and
presence, since `PresenceHub::flush` fans cursors and selections straight to its roster at 20 Hz and
never touches the bus.

**`reachOf` never goes to the database.** A fan-out runs it under the tree's strand, and re-proving N
sessions there costs one serial lookup per subscriber per minute with the strand held. The re-proof
(`stillAuthorized`) therefore runs in exactly two places, both off every strand: on `subscribe`'s own
thread, and on the sweeper's. `Principal::authenticated` and `checkedAtMs` are `std::atomic` because
of that sweeper.

`subscribe`, the write frame, the progress mark, `TreeApi::readRoom` and both `ForkService` entries
(`fork`, and `describe`, the unauthenticated magic-link invite) decide on `RoomRegistry::accessOf` —
the stored `owner` + `visibility` row — **before** `open()` builds a room: a caller about to be
refused must not be the reason a whole lattice is loaded, since with a bounded room table that load
evicts a room somebody is using.

The real `UserId` is the op `actor`, the `undoKey` and `progressUser_`, so undo and progress are
per-user. It does not go on the wire: presence frames carry a per-room seat id (`p<N>`,
`PresenceHub::Member::seat`) instead of `users.id`, because presence fans out to every co-viewer on
any public or unlisted tree. The display name is still shown.

### MCP-HTTP (`/mcp`)

`McpHttpEndpoint::handlePost` refuses a request whose `Origin` is not allow-listed before anything
else runs. `McpHttpEndpoint::resolveCaller` then takes the `Bearer` and tries, in order: an OAuth 2.1
access token bound to this resource, a personal MCP API key (`mcp_keys`, digest at rest), then the
shared `WINDMILL_MCP_TOKEN`. Each credential answers with its own grant, so a read-only token stays
read-only for the rest of the request. No match is a `401` carrying the
`WWW-Authenticate: Bearer resource_metadata=…` challenge the MCP Authorization spec requires. With
no auth wired at all (local, stdio, tests) the default caller is used.

Tool gating is the same predicate as REST: `RoadmapTools` runs `canRead` on every read tool and
`canRead` then `canWrite` on every mutating one.

The rate limiter sits in front of all of it. It is a `registerSyncAdvice`, not a Drogon filter,
because a pre-routing advice that returns a response binds to the observer overload and is silently
dropped. The sync join point runs ahead of routing, so the order is rate-limit → authenticate →
authorize → handler.

`WINDMILL_MCP_TOKEN` is an optional shared bearer fallback. The production composition root always
wires OAuth and personal MCP keys, so an empty shared token still requires one of those credentials.

## Still open

- **Rolling-session write amplification.** `AuthService::revalidate` calls `refreshSession` — a DB
  write — on every authenticated call, with no TTL throttle. That is a write per read. Roll only when
  a session is near its expiry.
- **MCP read tools open the room before the access check.** `RoadmapTools::withRoom` builds the room,
  then the lambda runs `canRead`; threading the caller into `withRoom` is its own change.
- **No CI guard against a published port.** Nothing in `.github/workflows/` fails if `db`, `server` or
  `embedder` gains a `ports:` mapping or `network_mode: host`. Only `caddy` publishes ports
  (`deploy/docker-compose.yml`), and only convention keeps it that way.
- **The tenancy model.** Per-user only, or orgs + roles? `orgs`, `org_members` and `trees.org_id`
  exist in `db/schema.sql` as a reservation and no code reads or writes any of them. The answer
  decides whether the check stays `caller == owner_id` or becomes a membership lookup.

## Rules that do not expire

- Never read the acting user or actor from the request body or a client field — always from the
  server-resolved session. The WS `cmd` frame carries no actor; keep it that way.
- The `wm_session` cookie is `SameSite=Lax`, which blocks cross-site POST. Don't loosen it to `None`
  without CSRF tokens.
