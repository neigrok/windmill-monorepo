# Authz — enforcing the session on the data plane

`AUTH.md` gives identity (a session behind a cookie or bearer). This is enforcement: how that
session gates the tree, WebSocket and MCP surfaces.

## The model

Visibility-gated read, owner-only write, per-user progress. The two predicates are `canRead` and
`canWrite` in `platform/domain/Access.h`, and every surface calls those and no parallel copy.

- **Reads** (`GET` tree/progress/diagnostics/activity, WS `subscribe`/presence, MCP `get_tree`) gate
  on `canRead`: a `private` tree is its owner's alone, an `unlisted` or `public` one is readable by
  anyone holding the id. A denial is byte-identical to an absent tree, so no id can be probed for
  existence. `GET …/progress` serves the **owner's** overlay to every reader, under the same gate.
- **Document writes** (`PUT`, `POST …/fork`, WS `cmd`/`undo`/`redo`, every mutating MCP tool) require
  a session (anonymous → `401`) and gate on `canWrite`, which is ownership and nothing else. **A tree
  is born owned** — the owner is written by the same insert that creates the row (create, fork, `PUT`
  of an absent id) — so there is no instant at which a row exists without one. **An unowned tree is
  nobody's to write**: the seeded demo tree (`t_9e407a96b5330ebe`, `owner_id NULL`, `public`) is
  world-readable and editable by no one. Every write path runs `canRead` first, so a refusal never
  confirms that a private id names something; a readable tree the caller does not own answers `403`.
- **Progress marks** (WS `progress`, MCP `set_progress`) are not document writes and are not
  owner-gated. They gate on `canRead` alone, and each caller writes only their own per-user overlay
  (`node_progress` is keyed by `user_id`). Any signed-in reader may mark any tree they can read — the
  demo included — and nobody's marks are visible in anyone else's overlay. The `canRead` gate is
  there so a mark cannot confirm which node ids a private tree holds.

`owner_id` is written by exactly two statements, the `INSERT` in `create` and the `INSERT` in `fork`
(`products/roadmap/adapters/postgres/PgTreeRepository.cpp`). There is no `UPDATE` of that column
anywhere, so a row with `owner_id IS NULL` is unwritable through every surface and can be repaired
only by hand in SQL.

## Per surface

`AuthService::authenticate(secret) -> std::optional<User>` resolves a cookie or bearer to a user and
rolls the session. Every surface reuses it, and none trusts a client-supplied user or actor id.

### REST

The caller is resolved per request. `HttpApi::callerOf` delegates to `wm::callerOf(req, auth)`
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

**Read authorization is re-decided, not granted once.** `Collab::mayRead` is the single verdict —
`canRead` against the tree's *current* access facts — and four things run it: `subscribe`; every
fan-out on `WsPresenceBus` (a refused connection is dropped from that tree and told "no such tree");
`RoomRegistry::setVisibility` and `RoomRegistry::retire`, so a share flip and a deletion land on the
event; and `Collab::reproveReaders`, a 15 s sweep over every open subscription, which is the only
road for the two revocations no event carries — a session revoked on a tree nobody is editing, and
presence, since `PresenceHub::flush` fans cursors and selections straight to its roster at 20 Hz and
never touches the bus.

**`mayRead` never goes to the database.** A fan-out runs it under the tree's strand, and re-proving N
sessions there costs one serial lookup per subscriber per minute with the strand held. The re-proof
(`stillAuthorized`) therefore runs in exactly two places, both off every strand: on `subscribe`'s own
thread, and on the sweeper's. `Principal::authenticated` and `checkedAtMs` are `std::atomic` because
of that sweeper.

`subscribe`, the write frame, the progress mark, `HttpApi::readRoom` and both `ForkService` entries
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

**Operator action:** set a GitHub secret `WINDMILL_MCP_TOKEN` (e.g. `openssl rand -hex 32`) so prod
enforces MCP auth. An empty token leaves `/mcp` open behind a startup warning.

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
