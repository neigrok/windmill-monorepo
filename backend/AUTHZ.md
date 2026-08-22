# Authz wiring — enforcing the session on the data plane

`AUTH.md` gave us **identity** (magic link → `wm_session`). This is the **enforcement** counterpart:
the session is now wired onto the tree / WebSocket / MCP surfaces.

## Status: implemented

Model — **visibility-gated read, owner-only write, per-user progress**. Three decisions, not one,
and the middle one is the narrowest:
- **Reads** (`GET` tree/progress/diagnostics/activity, WS `subscribe`/presence, MCP `get_tree`)
  gate on `canRead`: a `private` tree is its owner's alone, an `unlisted` or `public` one is
  readable by anyone holding the id. A denial is byte-identical to an absent tree, so no id can be
  probed for existence. `GET …/progress` serves the **owner's** overlay to every reader — a shared
  tree is shared to show its owner's journey — under the same `canRead` gate.
- **Document writes** (`PUT`, `POST …/fork`, WS `cmd`/`undo`/`redo`, every mutating MCP tool)
  require a session (anonymous → `401`) and gate on `canWrite`, which is ownership and nothing
  else. **A tree is born owned** — the owner is written by the same insert that creates the row
  (create, fork, `PUT` of an absent id) — so there is no instant at which a row exists without
  one. **An unowned tree is nobody's to write** (`canWrite` in `platform/domain/Access.h`): the
  seeded demo tree (`t_9e407a96b5330ebe`, `owner_id NULL`, `public`) and any legacy ownerless row
  are world-readable and editable by no one — first-writer-claims is gone from every path, so no
  account can take one. Every write path runs `canRead` first, so a refusal never confirms that a
  private id names something; a readable tree the caller does not own answers `403`.
- **Progress marks** (WS `progress`, MCP `set_progress`) are **not** document writes and are not
  owner-gated. They gate on `canRead` alone, and each caller writes only their **own** per-user
  overlay (`node_progress` is keyed by `user_id`). So any signed-in reader may mark any tree they
  can read — the demo included — and nobody's marks are visible in anyone else's overlay. The
  `canRead` gate is there so a mark cannot confirm which node ids a private tree holds.
- **MCP-HTTP** (`/mcp`) is gated by a shared bearer token (`WINDMILL_MCP_TOKEN`): no/invalid token →
  `401`; a valid token acts as the configured `WINDMILL_MCP_USER`. Empty token leaves it open with a
  loud startup warning.

**Operator action:** set a GitHub **secret** `WINDMILL_MCP_TOKEN` (e.g. `openssl rand -hex 32`) so
prod enforces MCP auth; agents then send `Authorization: Bearer <token>`. Until it's set, `/mcp` stays
open (the container logs a warning). Of the two follow-ups this listed, the app-side prompt landed:
`SyncSession` (`web/src/products/roadmap/sync/SyncSession.js:296`) dispatches `wm-edit-forbidden` on
an ownership or session refusal, and `web/src/products/roadmap/SkillTreeView.jsx:263` re-checks the
session before the chip speaks. Tenancy is the one that stayed open — see **Still open**.

**Operator action — check for legacy ownerless rows BEFORE this deploy.** Removing first-writer-
claims removed the last code path that could assign an owner to an existing row: the only two
writes to `owner_id` that remain are the INSERTs in `create` and `fork`. After this ships, a row
with `owner_id IS NULL` is permanently unwritable through every surface — HTTP, socket and MCP —
and can be repaired only by hand, in SQL. That is intended for the seeded demo and for nothing
else, so count the others first:

```sql
SELECT id, title, visibility, created_at FROM trees
WHERE owner_id IS NULL AND deleted_at IS NULL AND id <> 't_9e407a96b5330ebe';
```

An **empty result closes the risk** — the demo is the only ownerless row and it is meant to stay
that way. A **non-empty result needs a decision before push**: each row named there belongs to
somebody who can no longer edit it, and the only remedy is an `UPDATE trees SET owner_id = …`
run by hand against the account that should hold it. (Verified against
`products/roadmap/adapters/postgres/PgTreeRepository.cpp`: `owner_id` appears in exactly two
writes, the `INSERT` in `create` and the `INSERT` in `fork` — there is no `UPDATE` of that column
anywhere.)

---

## How it landed, seam by seam

History, not a plan: this section records what each surface needed and what it now does, so the
reasoning behind the shape survives. The two findings it closed were:

- **#1 — no authz on the data plane.** `HttpApi` ran as a fixed `devUser`, the socket minted an
  anonymous `u<N>` per connection, and `windmill_mcp_http` was unauthenticated. Anyone could read
  or write any tree.
- **#8 — unauthenticated `PUT /v1/trees/{id}`** overwrote or created any tree wholesale.

One seam closed both: `AuthService::authenticate(secret) -> std::optional<User>`
(`platform/application/AuthService.cpp`) resolves a cookie/bearer to a user and rolls the session.
Every surface reuses it, and none trusts a client-supplied user/actor id.

### REST (`windmill_server`)

The caller is resolved **per request, not at construction**. The fixed `caller_` is gone;
`HttpApi::callerOf` (`products/roadmap/adapters/http/HttpApi.cpp:24`) delegates to the one shared
`wm::callerOf(req, auth)` (`platform/adapters/http/Caller.h`), which reads the `wm_session` cookie,
falls back to `Authorization: Bearer`, and hands the secret to `AuthService::authenticate` — one
extraction every API on the process calls, rather than a copy per handler.

Reads (`getTree`, `getProgress`, `getDiagnostics`, `getActivity`) gate on `canRead` and answer a
denial as a `404` byte-identical to absence. Writes (`putTree`, `forkTree`) require an
authenticated caller — `401` for anonymous — and then gate on `canWrite`, which is the direct fix
for #8. Progress writes carry the resolved caller into `node_progress`, so the per-user overlay is
genuine; the fixed `dev` actor is gone from the server path, surviving only as the default
`WINDMILL_MCP_USER` of the two standalone MCP binaries (`platform/infra/mcp_main.cpp:67`,
`platform/infra/mcp_http_main.cpp:62`) and as `platform/infra/main.cpp:283`'s MCP fallback.

### Ownership columns

`trees.owner_id` and `trees.visibility` are written, read, filtered and updated.
`PgTreeRepository` (`products/roadmap/adapters/postgres/PgTreeRepository.cpp`) stamps the owner on
the `INSERT` in `create` (`:259`) and in `fork` (`:401`), reads both columns back in `loadAccess`
(`:163`) and `load` (`:202`), filters on them in `listOwnedBy` (`:274`) and `listPublic` (`:334`),
and `setVisibility` (`:391`) is the one `UPDATE` — there is still no `UPDATE` of
`owner_id` anywhere, which is what makes the operator check above conclusive. `StoredTree`
(`products/roadmap/ports/TreeRepository.h:36`) carries `owner` and `visibility` up to the room, so
the authz decision reads loaded facts instead of issuing a second query.

`trees.org_id` was never wired — see **Still open**.

### WebSocket (`/v1/socket`)

The **upgrade** is authenticated, not each frame. `Collab::onOpen` reads the `wm_session` cookie,
falls back to a bearer, and stores a `Principal`
(`products/roadmap/adapters/ws/PresenceHub.h:23`) in the connection context. Three departures from
the original plan, all deliberate:

- A failed authentication does **not** reject the upgrade. The connection joins as a **read-only
  guest** (`u<N>`, `authenticated = false`). The anonymous id survived — but as an identity rather
  than as the hole it was, because a public tree has to be watchable by a stranger.
- A **stated `Origin` must be allow-listed** or the upgrade is closed before a frame is read — the
  same set `main.cpp` composes for CORS, handed to `Collab` through `RoadmapDeps` rather than parsed
  twice. A client that sends no `Origin` (a script, a device, the MCP tooling) is untouched: only a
  browser sends one, and only a browser can be pointed at this server by someone else's page. Until
  2026-08-22 the socket had no gate at all and `SameSite=Lax` was the whole defence.
- The `Principal` keeps the session's **digest**, never the secret, plus `checkedAtMs`. A socket
  outlives the request that opened it, so both a writer and a **reader** re-prove the session
  (throttled to one lookup a minute), and a revocation reaches a connection opened before it.

**Read authorization is re-decided, not granted once.** `Collab::mayRead` is the single verdict —
`canRead` against the tree's *current* access facts, for the principal as the last re-proof left it
— and four things run it. `subscribe`. Every fan-out on `WsPresenceBus`: a refused connection is
dropped from that tree and told "no such tree", exactly as a fresh subscribe would be.
`RoomRegistry::setVisibility` and `RoomRegistry::retire`, which announce a share flip and a
deletion so revocation lands on the event rather than at the tree's next edit. And
`Collab::reproveReaders`, a 15 s pass over every open subscription, which is the only road for the
two revocations no event carries: a session revoked on a tree **nobody is editing**, and
**presence** — `PresenceHub::flush` fans cursors and selections straight to its roster at 20 Hz and
never touches the bus, so a revoked reader went on watching a peer's live cursor and the node ids
they selected long after the bus would have dropped them.

`mayRead` itself never goes to the database: a fan-out runs it under the tree's strand, and
re-proving N subscribers' sessions there meant one serial lookup per subscriber per minute with the
strand held — a measured 16× spike on the first edit after each minute boundary, linear in readers.
The re-proof (`stillAuthorized`, still throttled to one lookup a minute per connection) therefore
runs in exactly two places, both off every strand: on `subscribe`'s own thread, and on the sweeper's.
`Principal::authenticated` and `checkedAtMs` are `std::atomic` because of that sweeper — they are no
longer written only by the connection's own IO thread.

The socket's read paths — `subscribe`, the write frame, the progress mark — plus `HttpApi::readRoom`
and both `ForkService` entries (`fork`, and `describe`, which is the **unauthenticated** magic-link
invite) decide on `RoomRegistry::accessOf`, the stored `owner` + `visibility` row, **before**
`open()` builds a room: a caller about to be refused must not be the reason a whole lattice is
loaded, since with a bounded room table that load evicts a room somebody is using.
**`RoadmapTools::withRoom` (`products/roadmap/adapters/mcp/RoadmapTools.cpp:247`) still opens first
and checks after** — threading the caller through its call sites is its own change, and until that
lands the MCP read tools keep the old ordering.

The real `UserId` is still the op `actor`, the `undoKey` and `progressUser_`, so undo and progress
are per-user. It no longer goes **on the wire**: presence frames carry a per-room seat id
(`p<N>`, `PresenceHub::Member::seat`) instead of `users.id`, because presence fans out to every
co-viewer — anonymous strangers included — on any public or unlisted tree. The display name is
still shown; that half was always intended.

### MCP-HTTP (`/mcp`)

`McpHttpEndpoint::resolveCaller` (`platform/adapters/mcp/McpHttpEndpoint.cpp:103`) takes the
`Bearer` and tries, in order: an OAuth 2.1 access token bound to this resource, then a personal MCP
API key (`mcp_keys` — digest-at-rest, the `api_tokens` table this plan asked for, shipped under its
own name), then the shared `WINDMILL_MCP_TOKEN`. No match is a `401` carrying the
`WWW-Authenticate: Bearer resource_metadata=…` challenge the MCP Authorization spec requires.
`handlePost` refuses a request whose `Origin` is not allow-listed before any of that runs.

Tool gating is the same predicate as REST rather than a parallel one: `RoadmapTools`
(`products/roadmap/adapters/mcp/RoadmapTools.cpp`) runs `canRead` on every read tool and `canRead`
then `canWrite` on every mutating one, both from `platform/domain/Access.h` — the same two
functions the HTTP and socket paths call.

The rate limiter sits in front of all of it. It is not a Drogon filter but a `registerSyncAdvice`
(`platform/infra/main.cpp:458`), because a pre-routing advice that returns a response binds to the
observer overload and is silently dropped; the sync join point runs ahead of routing, so the order
really is rate-limit → authenticate → authorize → handler.

## Still open

- **Rolling-session write amplification.** `AuthService::revalidate`
  (`platform/application/AuthService.cpp:193`) calls `refreshSession` — a DB write — on *every*
  authenticated call, with no TTL throttle. Now that auth gates every request, that is a write per
  read. Roll only when, say, <80 days remain. Pairs with the connection-pooling work.
- **No CI guard against a published port.** Nothing in `.github/workflows/` fails if `db`, `server`
  or `embedder` gains a `ports:` mapping or `network_mode: host` — the one change that would expose
  these processes directly instead of only via Caddy. Today `caddy` is the only service that
  publishes ports (`deploy/docker-compose.yml:174`), and only convention keeps it that way.
- **The tenancy model.** Per-user only, or orgs + roles? `orgs`, `org_members` and `trees.org_id`
  exist in `db/schema.sql` as a Phase-3 reservation and no code reads or writes any of them. The
  answer decides whether the check stays `caller == owner_id` or becomes a membership lookup —
  build it once. Until then the reservation stays in the schema so the question keeps its shapes.

## Rules that do not expire

- **Never** read the acting user/actor from the request body or a client field — always from the
  server-resolved session. (The WS `cmd` frame carries no actor; keep it that way.)
- The `wm_session` cookie is `SameSite=Lax`, which blocks cross-site POST — keep it; don't loosen to
  `None` without CSRF tokens.
