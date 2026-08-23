# MCP adapter (`adapters/mcp/`)

The Model Context Protocol edge: an AI agent reads and authors Windmill roadmaps through the
same application core an HTTP or WebSocket client drives. Edits route through the tree's
`TreeRoom`, so they are merged, sequenced, logged to `tree_ops`, and persisted to the per-entry
lattice tables (`tree_nodes` / `tree_edges` / `tree_kinds`) like any other edit.

## Layout

The engine and the HTTP transport are product-neutral and live in platform; the catalog, the
projections and the documents are roadmap's.

```
platform/adapters/mcp/
  McpServer                JSON-RPC 2.0 engine (initialize, tools/list, tools/call,
                           resources/list, resources/read, ping). Depends only on jsoncpp + an
                           injected ToolHost, a ServerInfo and a resource vector.
  CompositeToolHost        every connected product's tools behind the one ToolHost McpServer
                           binds, AND the grant gate: filters tools/list, refuses an
                           out-of-scope call, a duplicate tool name at construction, and an
                           argument no schema declares. A retired name answers with the sentence
                           naming its replacement, consulted only after a catalog miss;
                           construction refuses a retirement that shadows a live tool or names a
                           replacement no product declares. `windmillServerInfo()` frames the
                           handshake.
  McpHttpEndpoint          the Streamable-HTTP transport: sessions, Origin checks, the three
                           verbs, and `McpAuth`.
products/roadmap/adapters/mcp/
  RoadmapTools             roadmap's ToolHost: catalog + dispatch into RoomRegistry / TreeRoom /
                           ProgressService. It declares its tools and never its own gate.
  ToolArgs                 argument validation and the sentence a refusal is written in.
  ReadShape                the read projections (`fields`) and paging (`limit`/`cursor`).
  EditReceipt              what an edit answers about diagnostics.
  RoadmapResources         `roadmapInstructions()` and `roadmapResources()`.
  golden/wire_corpus.json  a byte-compared transcript of one authoring session (WireCorpusTest).
platform/infra/
  main.cpp                 `windmill_server`   — REST + the collab socket + MCP, one process.
  mcp_main.cpp             `windmill_mcp`      — stdio transport (local hosts spawn it).
  mcp_http_main.cpp        `windmill_mcp_http` — standalone HTTP transport (local/standalone).
```

All three composition roots build the same composite and ask `windmillServerInfo()` for the
handshake, so the surface an agent connects to cannot differ by transport.

The dependency arrow points inward: `McpServer` knows nothing of rooms, Postgres, or HTTP; the
transports know nothing of the tools. The edit tools reuse the `commandFromJson` codec — their
argument names are the command payload keys, save for the node handle, which the tool layer
normalizes (`nodeId` → the codec's `id`) before the decode. `commandFromJson` is also the op-log
replay decoder (`PgOpLog`) and answers a bare yes/no, so arguments are validated in the tool layer.

## The error contract

Every failure is one line naming four things when they apply: the **tool**, the **argument** by
its published spelling (or its JSON path — `nodes[3].label`, `updates[1].status`), the **value
given** (its type when the type was wrong, its size when a cap was hit, its text when an enum
missed), and the **limit or legal set** it missed. An obvious next move rides along as a second
sentence.

```
rename_node: missing required argument "nodeId". Call get_tree with fields ["id","label"] to list the ids this tree has.
annotate_node: description is 4613 characters, max 4000
import_subgraph: nodes[0] must be an object, got string. Each item is a JSON object, not a JSON-encoded string.
set_progress: status "finished" is not one of {active, complete, none}
```

The checks live in `ToolArgs.{h,cpp}` — one home, every tool. `RoadmapTools::callTool` stamps the
tool name exactly once and catches: a type-confused read throws inside jsoncpp, and a malformed
argument must fail its own call rather than the whole HTTP request. Every cap a tool enforces is
published as `maxLength` / `maxItems` in its `inputSchema`.
`test/products/roadmap/adapters/mcp/ToolErrorContractTest.cpp` pins the messages themselves.

## Handles

- `treeId` — the roadmap, on every tree-scoped tool.
- `nodeId` — a node that **exists**, on every tool that edits or marks one. The `id` spelling is
  also accepted (declared `deprecated` in the schema, since `additionalProperties: false` would
  otherwise have a client's own validator reject it), and never published as canonical.
- `id` — the id **proposed** for a NEW thing: `create_node`, `add_kind`, `import_subgraph`'s
  `nodes[].id` and `kinds[].id`. `create_node` refuses `nodeId` outright, `add_kind` refuses
  `kindId`.
- Legend kinds publish `id` for the kind that exists too, and all six `*_kind` tools spell it
  alike. `kindId` is the silent alias there (`ToolArgs.h:44`).

## Resources

`resources/list` and `resources/read` serve `windmill://quickstart` (markdown) — edge direction,
the handle law, what is never refused, the read projections, and the caps. A test checks every
claim it makes against the shipped catalog.

## Transports

`McpServer::handle` is pure (`Json request → optional<Json> reply`). Two thin transports wrap it;
both speak JSON-RPC 2.0, protocol version `2025-06-18`:

- **stdio** (`windmill_mcp`) — newline-delimited frames on stdin/stdout, what local hosts launch.
  stdout is the protocol channel; logs go to stderr. No session and no bearer: a process you
  spawned is already the authorization, and it acts as `WINDMILL_MCP_USER`.
- **Streamable HTTP** (`McpHttpEndpoint`) — the remote transport, one endpoint (`/mcp` by
  default):
  - `POST` — the body is one JSON-RPC message. A *request* gets its JSON-RPC response as
    `application/json`; a *notification* gets `202 Accepted`. `initialize` mints an
    `Mcp-Session-Id` header that every later call must present. Sessions idle-expire after 30
    minutes, refreshed on use.
  - `GET` — would open a server→client SSE stream; there is none, so `405`.
  - `DELETE` — ends a session.
  - The `Origin` header is validated (DNS-rebinding protection); a client that sends no Origin
    is not a browser and passes. `windmill_mcp_http` also serves `/healthz`; in `windmill_server`
    the liveness probe is the app root (`deploy/docker-compose.yml`).

The deployed HTTP transport is `windmill_server`: `main.cpp` registers `McpHttpEndpoint` on the
REST host's `WINDMILL_MCP_PATH`, over the *same* `RoomRegistry` REST and the collab socket use, so
an agent's edit fans out to connected browsers through `WsPresenceBus` as it lands.
`windmill_mcp_http` is the standalone build of that endpoint — its own process, its own
`RoomRegistry`, a null presence bus — for local and single-purpose runs only (see *Operating
notes*).

## Auth

`McpAuth` (`platform/adapters/mcp/McpHttpEndpoint.h`) turns a request into a `ToolCaller` — the
account it acts as, the grant its credential carries, and the connection the credential is
(`ToolConnection{id, name}`: the OAuth client id and registered name, or the MCP key's public id
and the name it was minted under; both empty for the shared token and the unauthenticated shape).
`McpHttpEndpoint::resolveCaller` tries three credentials in order against the
`Authorization: Bearer …` header:

1. **An OAuth access token** — `OAuthService::resolveAccessToken` requires it unexpired *and*
   audience-bound to this server's resource URL, and answers with the token's parsed scope and
   its client as the connection. The client discovers the authorization server through the RFC
   9728 metadata document, runs authorization-code + PKCE against the API host, and acts as the
   granting account within the grant the human approved.
2. **A personal MCP API key** — `McpKeyService::resolveKey`, the fallback for clients that cannot
   do OAuth. Minted in settings, stored as a digest, resolvable to its owner until revoked or the
   account closes. Only `windmill_server` wires this one. `mcp_keys.scope` is honoured, but the
   mint endpoint asks for none, so every key is account-wide.
3. **`WINDMILL_MCP_TOKEN`** — one shared secret, compared in constant time, acting as
   `WINDMILL_MCP_USER` with `McpAuth::fallbackScope`. For CI and an agent on the box; leave it
   unset in any deployment more than one person can reach.

A request presenting none of them gets `401` with a
`WWW-Authenticate: Bearer resource_metadata="…"` challenge naming
`/.well-known/oauth-protected-resource`, served unauthenticated by both HTTP roots. With none of
the three configured, every request runs as `WINDMILL_MCP_USER` with `McpAuth::fallbackScope` —
the stdio shape and the test shape; keep such a deployment private yourself.

## Scopes

A grant is `<product>:<level>`, space-delimited on the wire, with three levels that never imply
one another — `roadmap:read roadmap:write` does not carry `roadmap:delete`, and a connection
holding it does not see `delete_tree`, `delete_node` or `remove_kind` in `tools/list` at all.
Every tool declares its level beside its description (`RoadmapToolCatalog.cpp`),
`CompositeToolHost` is the one place that enforces it, and
`/.well-known/oauth-authorization-server` publishes the vocabulary in `scopes_supported`, derived
from the products actually connected.

**An empty scope is the account-wide grant** — the one exception to fail-closed, written down at
the parse site (`platform/domain/ToolScope.h`).

Tending does NOT go through the composite: `TendingService` holds roadmap's host directly
(`ScopedToolHost.h`). The two narrowings stack — `ScopedToolHost` pins a run to one tree, the
composite pins a credential to its grant.

Above the auth check both HTTP roots meter by IP, keyed on the forwarded client address:
`windmill_server`'s general API ceiling (25 req/s per client, burst 50) covers `/mcp`;
`windmill_mcp_http` runs its own (20 req/s, burst 40). Traffic arriving with no proxy header is
treated as internal and is not limited.

## Tools

| | Tool | Effect |
| --- | --- | --- |
| registry | `create_tree` · `list_trees` · `delete_tree` | plant / discover / soft-delete a roadmap you own |
| read | `get_tree` | title + nodes (label, icon, color, position, description, links) + edges + seq |
| read | `get_diagnostics` | cycles / dangling / self-edges / smells |
| read | `get_health` | tidiness metrics + 0–100 score (needs a valid DAG) |
| read | `get_progress` | the caller's completed / in-progress node ids |
| read | `find_nodes` | search by `color`/`kind`, the derived `state`, and/or a `query` substring (id + label + description), best match first — `{state: "available"}` is the frontier |
| edit | `create_node` | add a node — `prerequisites[]`, `description`, `links` all optional |
| edit | `annotate_node` | set a node's `description` and/or `links` |
| edit | `rename_node` · `set_node_color` · `move_node` | content edits |
| edit | `connect` · `disconnect` · `reconnect` | prerequisite-edge edits |
| edit | `delete_node` · `tidy` · `prune` | tombstone / transitive reduction / GC dangling edges + orphan progress |
| edit | `import_subgraph` | bulk upsert a whole `get_tree`-shaped slice as one graft frame |
| legend | `add_kind` (inline label+description) · `rename_kind` · `describe_kind` · `remove_kind` · `reorder_kinds` · `recolor_kind` | the legend |
| write | `set_progress` | per-user overlay: single `nodeId`+`status`, or a bulk `updates[]` (order-safe) |
| resource | `windmill://quickstart` | the read-me-first document; no tool slot |

Every tree-scoped tool takes `treeId`. Edits return
`{applied, seq, diagnosticsClean, introducedDiagnostics}` — nothing is ever rejected, so the
receipt is how an agent learns what its change did. The two keys answer different questions:
`diagnosticsClean` is the whole tree's state (a `false` may be dirt that was already there), and
`introducedDiagnostics` names what THIS edit broke — the cycles, dangling and self-edges present
after it that the tree did not hold before, bracketed under the tree's strand. An innocent edit
on a dirty tree answers `[]`.

## `status`, `seedStatus`, `state`, `summary`

Three distinct facts, three words:

- **`status` is the caller's own mark** — `active`, `complete` or `none`, the vocabulary
  `set_progress` writes and `get_progress` returns. Ask `get_tree` or `find_nodes` for it and
  every node answers, marked or not, so a caller can tell "no mark" from "not served".
- **`seedStatus` is the document's authored baseline** — the inert seed a shared or demo tree
  carries, which every reader sees before their own marks. Readable through `fields`, writable as
  `import_subgraph`'s `nodes[].seedStatus`. An imported node carrying `status` is refused by name
  rather than publishing a private mark into a shared document.
- **`state` is what the tree derives** — `locked`, `available`, `active` or `complete`, the
  unlock cascade `domain/UnlockRules` runs over a node's prerequisites and the caller's marks.
  A `fields` value on `get_tree` and `find_nodes`, never in a default, computed once per read
  over the whole tree (a prerequisite may sit off the page). It answers on an untidy tree —
  derived over the bare node list, never through `SkillTree`, which throws on dirt: a cycle locks
  every member, and a dangling edge (which the projected document does not carry — it lives in
  `get_diagnostics`) locks nothing. An anonymous reader's cascade runs over no marks: roots
  available, the rest locked. `find_nodes` takes `state` as a filter too, ANDed with the rest and
  applied after the ranked selection but before the page, so `count` and the cursor speak of the
  filtered set.

**`summary` is a projection of `description`**, not a fourth fact: its opening 200 characters,
cut at a word and ellipsized when anything was cut. Ask for `summary` to skim and `description`
for one node's whole text.

## Bulk

- **`import_subgraph`** takes the JSON `get_tree` returns (`{title?, nodes[], kinds[]}`, plus an
  optional `progress[]`) and applies it in **one** op via the subgraph CRDT graft path. It is
  **upsert by id**: an incoming id already present is overwritten and reported in
  `nodeCollisions`/`kindCollisions`; a new id is added; nothing is removed. The receipt counts
  `nodes`, `edges` and `kinds` as carried, so a batch whose prerequisites were put in the wrong
  place reads as `edges: 0`. `dryRun: true` previews the collisions and the refusals and changes
  nothing. The graft is held to the per-tree capacity (10000 nodes, 20000 edges), counted on what
  the tree would hold AFTER the upsert, so re-sending nodes already present costs nothing. The
  graft path does not run the domain's `validate()` — this tool's own item checks are the only
  admission standing there.
- **`set_progress`** accepts a bulk `updates[]` and evaluates the `prerequisitesMet` advisory
  against the committed batch, so a subtree completed out of dependency order still reports
  correctly. Unknown node ids are rejected, so no orphan overlay rows are created.
- **`prune`** drops dangling/self edges in one op and clears the caller's progress rows for nodes
  no longer in the tree.
- **`find_nodes`** searches without pulling the whole tree. `color` and `kind` are one filter (a
  node's color *is* its kind); every set filter must match (AND). Matches come back best first —
  exact id, id prefix, label hit, id substring, description-only hit. Matching and ranking live in
  the pure `selectNodes` read-model (`domain/NodeQuery`); the order is deterministic, which is what
  keeps a resume `cursor` pointing at the row it was minted from.

## Build

`brew install drogon libpqxx`, then `cmake --build build`. The MCP-carrying targets are
`windmill_server` (REST + socket + MCP), `windmill_mcp` (stdio), `windmill_mcp_http` (standalone
HTTP), and the `windmill_mcp_tests` suite. The Docker image builds, smoke-tests and installs
`windmill_server` and `windmill_mcp_http`; `windmill_mcp` is a developer-machine target.

## Register — the deployed server

MCP is same-origin with the app — `https://windmill.works/mcp`, proxied to `windmill_server`.

```bash
claude mcp add --transport http windmill https://windmill.works/mcp
```

The client is challenged, discovers the authorization server from
`/.well-known/oauth-protected-resource`, and runs OAuth against the API host. A client that
cannot do OAuth uses a personal key from settings instead, as `Authorization: Bearer <key>`.

## Run — stdio (local)

```bash
claude mcp add windmill --env DATABASE_URL=postgresql://localhost/windmill \
  --env WINDMILL_MCP_USER=<your account id> \
  -- /ABS/PATH/windmill/backend/build/windmill_mcp
```

## Run — standalone HTTP (local)

```bash
DATABASE_URL=postgresql://…/windmill \
PORT=8090 \
WINDMILL_MCP_ALLOWED_ORIGINS="http://localhost:5173" \
WINDMILL_MCP_PUBLIC_URL="http://localhost:8090" \
WINDMILL_OAUTH_ISSUER="http://localhost:8088" \
  ./build/windmill_mcp_http
```

### Configuration (env)

Read by every root that serves MCP unless a row says otherwise.

| Var | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://localhost/windmill` | Postgres connection |
| `PORT` | `8090` (`windmill_mcp_http`) | listen port |
| `WINDMILL_MCP_HOST` | `0.0.0.0` (`windmill_mcp_http`) | bind address |
| `WINDMILL_MCP_THREADS` | `8` (`windmill_mcp_http`) | Drogon worker threads |
| `WINDMILL_MCP_PATH` | `/mcp` | endpoint path (HTTP roots) |
| `WINDMILL_MCP_ALLOWED_ORIGINS` | *(empty)* | comma-separated browser Origin allow-list; `*` allows all. Non-browser clients send no Origin and are always allowed. |
| `WINDMILL_MCP_PUBLIC_URL` | `windmill_server`: `WINDMILL_API_URL` · `windmill_mcp_http`: `http://localhost:8090` | the externally reachable origin. `+ WINDMILL_MCP_PATH` is the OAuth **resource** (audience) a token must be bound to, and the base of the metadata URL in the 401 challenge — get it wrong and every valid token is refused. |
| `WINDMILL_OAUTH_ISSUER` | `http://localhost:8088` (`windmill_mcp_http`) | the authorization server advertised in the protected-resource metadata. `windmill_server` is its own issuer and advertises itself. |
| `WINDMILL_MCP_TOKEN` | *(empty)* | optional shared bearer that acts as `WINDMILL_MCP_USER`. CI and local agents only — it is a second key to every tree that user owns. |
| `WINDMILL_MCP_USER` | `dev` | who an unauthenticated request acts as: the stdio caller, and the account `WINDMILL_MCP_TOKEN` maps to |

Identity is per caller: an OAuth token acts as the account that granted it, a personal key as its
owner. `WINDMILL_MCP_USER` is the fallback identity only.

## Operating notes

- **One live room, one process holding it.** Running `windmill_mcp_http` (or `windmill_mcp`)
  against the *same* database as `windmill_server` opens a second registry: each process reloads
  head on open and is the authority for a tree while it holds it, so two of them writing one tree
  can race on `(tree_id, seq)`. A local/standalone topology, never a second production writer.
- **Blocking DB on the event loop.** Repositories are synchronous libpqxx. Each borrows a
  connection for one transaction from a bounded pool of at most 20
  (`platform/adapters/postgres/PgPool.h`), opened lazily and given a 5s statement timeout. The
  call blocks its event-loop thread for the length of the query.
- **Clock.** An MCP write is stamped by the tree's room clock (`TreeRoom::nextStamp`, wall time
  from the `Clock` port), the same HLC domain a socket write joins, so the two are directly
  comparable and can never collide on a stamp.
