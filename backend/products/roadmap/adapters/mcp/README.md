# MCP adapter (`adapters/mcp/`)

The Model Context Protocol edge of the backend: it lets an AI agent read and author
Windmill roadmaps through the **same application core** an HTTP or WebSocket client drives.
It is a first-class adapter alongside `adapters/http/` and `adapters/ws/` — not a proxy.
Edits route through the tree's `TreeRoom`, so they are merged, sequenced, logged to
`tree_ops`, and persisted to the per-entry lattice tables (`tree_nodes` / `tree_edges` /
`tree_kinds`) exactly like any other edit. (`trees.document` is the legacy whole-tree blob —
`schema.sql:67` says so; a tree's rows are backfilled from it on first load.)

## Shape

The engine and the HTTP transport are product-neutral and live in platform; the catalog, the
projections and the documents are roadmap's:

```
platform/adapters/mcp/
  McpServer.{h,cpp}        transport-agnostic JSON-RPC 2.0 engine (initialize, tools/list,
                           tools/call, resources/list, resources/read, ping). Depends only on
                           jsoncpp + an injected ToolHost, a ServerInfo and a resource vector.
  CompositeToolHost.{h,cpp} every connected product's tools behind the one ToolHost McpServer
                           binds, AND the grant gate: it filters tools/list and refuses an
                           out-of-scope call, refuses a duplicate tool name at construction, and
                           refuses an argument no schema declares. `windmillServerInfo()` frames
                           the handshake from the products it holds.
  McpHttpEndpoint.{h,cpp}  the Streamable-HTTP transport: sessions, Origin checks, the three
                           verbs, and `McpAuth` — how a request becomes a `ToolCaller`.
products/roadmap/adapters/mcp/
  RoadmapTools.{h,cpp}     roadmap's ToolHost: the tool catalog + dispatch into RoomRegistry /
                           TreeRoom / ProgressService. It declares its tools and never its own
                           gate — the grant was settled above it.
  ToolArgs.{h,cpp}         one home for argument validation and for the sentence a refusal is
                           written in — every tool routes through it.
  ReadShape.{h,cpp}        the read projections (`fields`) and paging (`limit`/`cursor`).
  EditReceipt.{h,cpp}      what an edit answers about diagnostics: the whole-tree flag, and what
                           THIS edit introduced.
  RoadmapResources.{h,cpp} what this product says it is: `roadmapInstructions()` (its paragraph
                           in the `instructions` brief every client reads on connect) and
                           `roadmapResources()` (`windmill://quickstart`).
  golden/wire_corpus.json  a byte-compared transcript of one authoring session (WireCorpusTest).
platform/infra/
  main.cpp                 `windmill_server`   — REST + the collab socket + MCP, one process.
  mcp_main.cpp             `windmill_mcp`      — stdio transport (local hosts spawn it).
  mcp_http_main.cpp        `windmill_mcp_http` — standalone HTTP transport (local/standalone).
```

All three composition roots build the same one-module composite and ask `windmillServerInfo()`
for the handshake, so the surface and the paragraph an agent connects to cannot differ by
transport. The server's name and version belong to the server; each product supplies only its own
paragraph, which is what lets a second product join without rewriting the first one's brief.

The dependency arrow points inward: `McpServer` knows nothing of rooms, Postgres, or HTTP;
the transports know nothing of the tools. The edit tools reuse the existing `commandFromJson`
codec — their argument names are the command payload keys, save for the node handle, which the
tool layer normalizes (`nodeId` → the codec's `id`) before the decode. `commandFromJson` stays a
bare yes/no on purpose: it is also the op-log replay decoder (`PgOpLog`), so **arguments are
validated in the tool layer**, where the failure can name the field.

## The error contract

Every failure is one line, and it names four things when they apply: the **tool**, the
**argument** by its published spelling (or its JSON path — `nodes[3].label`, `updates[1].status`),
the **value given** (its type when the type was wrong, its size when a cap was hit, its text when
an enum missed), and the **limit or legal set** it missed. Where there is an obvious next move it
rides along as a second sentence.

```
rename_node: missing required argument "nodeId". Call get_tree with fields ["id","label"] to list the ids this tree has.
annotate_node: description is 4613 characters, max 4000
import_subgraph: nodes[0] must be an object, got string. Each item is a JSON object, not a JSON-encoded string.
set_progress: status "finished" is not one of {active, complete, none}
```

The checks live in `ToolArgs.{h,cpp}` — one home, every tool — and the tool name is stamped
exactly once, by `RoadmapTools::callTool`, which also catches: a type-confused read throws inside
jsoncpp, and a malformed argument must fail its own call rather than the whole HTTP request.
Every cap a tool enforces is also published as `maxLength` / `maxItems` in its `inputSchema`, so a
client can pre-validate what the server refuses.
`test/products/roadmap/adapters/mcp/ToolErrorContractTest.cpp` pins the messages themselves.

## Handles

- `treeId` — the roadmap, on every tree-scoped tool.
- `nodeId` — a node that **exists**, on every tool that edits or marks one. The older `id` spelling
  is still accepted (declared `deprecated` in the schema, since `additionalProperties: false`
  would otherwise have a client's own validator reject it), and never published as canonical.
- `id` — the id **proposed** for a NEW thing: `create_node`, `add_kind`, `import_subgraph`'s
  `nodes[].id` and `kinds[].id`. A different concept, deliberately a different word;
  `create_node` refuses `nodeId` outright and `add_kind` refuses `kindId`.
- Legend kinds publish `id` for the kind that exists too — a kind is not a node, and all six
  `*_kind` tools spell it alike. `kindId` is read there as the silent alias (`ToolArgs.h:44`).

## Resources

`resources/list` and `resources/read` serve `windmill://quickstart` (markdown) — edge direction,
the handle law, what is never refused, the read projections, and the caps. A resource costs no
tool slot, so it is the right home for what an agent needs before its first call. Everything it
claims is checked against the shipped catalog by a test.

## Transports

The engine `McpServer::handle` is pure (`Json request → optional<Json> reply`). Two thin
transports wrap it; both speak JSON-RPC 2.0, protocol version `2025-06-18`:

- **stdio** (`windmill_mcp`) — newline-delimited frames on stdin/stdout, what local hosts
  (Claude Code/Desktop) launch. stdout is the protocol channel; logs go to stderr. There is no
  session and no bearer: a process you spawned is already the authorization, and it acts as
  `WINDMILL_MCP_USER`.
- **Streamable HTTP** (`McpHttpEndpoint`) — the remote transport. One endpoint (`/mcp` by
  default):
  - `POST` — the body is one JSON-RPC message. A *request* gets its JSON-RPC response as
    `application/json`; a *notification* gets `202 Accepted`. `initialize` mints an
    `Mcp-Session-Id` (returned as a header) that every later call must present. Sessions are
    idle-expiring (30 minutes, refreshed on use).
  - `GET` — would open a server→client SSE stream; we have none, so `405`.
  - `DELETE` — ends a session.
  - The `Origin` header is validated (DNS-rebinding protection); a client that sends no Origin
    at all is not a browser and passes. No server→client streaming is used because every tool
    is synchronous. (`windmill_mcp_http` also serves `/healthz`; in `windmill_server` the
    liveness probe is the app root, per `deploy/docker-compose.yml`.)

**The HTTP transport is mounted twice, and the deployed one is `windmill_server`.** `main.cpp`
registers the same `McpHttpEndpoint` on the REST host's `WINDMILL_MCP_PATH`, over the *same*
`RoomRegistry` that REST and the collab socket use — so a tree has exactly one live room in
production, and an agent's edit fans out to connected browsers through `WsPresenceBus` as it
lands. `windmill_mcp_http` is the standalone build of that endpoint: its own process, its own
`RoomRegistry`, a null presence bus. Keep it for local and single-purpose runs; do not point
two writers at one database if you can avoid it (see *Operating notes*).

## Auth

`McpAuth` (`platform/adapters/mcp/McpHttpEndpoint.h`) is how a request becomes a `ToolCaller` —
the account it acts as, the grant its credential carries, AND the connection the credential is
(`ToolConnection{id, name}`: the OAuth client id and registered name, or the MCP key's public id and
the name it was minted under; both empty for the shared token and the unauthenticated shape, which is
"no connection stands behind this call", never a placeholder) — and `McpHttpEndpoint::resolveCaller`
tries three credentials in order against the `Authorization: Bearer …` header:

1. **An OAuth access token** — validated by `OAuthService::resolveAccessToken`, which requires
   it to be unexpired *and* audience-bound to this server's resource URL, and which answers with
   the token's parsed scope and its client as the connection (a client row that has since vanished
   costs the name and nothing else). This is the real path: a client discovers the authorization server
   through the RFC 9728 metadata document, runs the authorization-code + PKCE flow against the
   API host, and acts as the granting account, within the grant the human approved.
2. **A personal MCP API key** — `McpKeyService::resolveKey`, the static-token fallback for
   clients that cannot do OAuth. Minted in settings, stored as a digest, resolvable to its owner
   — with the key itself as the connection — until revoked or the account closes. Only `windmill_server` wires this one. `mcp_keys.scope`
   exists and is honoured; the mint endpoint asks for none, so every key today is account-wide.
3. **`WINDMILL_MCP_TOKEN`** — one shared secret, compared in constant time, that acts as
   `WINDMILL_MCP_USER` with `McpAuth::fallbackScope`. It exists for CI and for an agent on the
   box; it is not per-caller identity and should be left unset in any deployment more than one
   person can reach.

A request that presents none of them gets `401` with a
`WWW-Authenticate: Bearer resource_metadata="…"` challenge naming
`/.well-known/oauth-protected-resource`, which is served unauthenticated by both HTTP roots.

The one case with no authentication at all is **none of the three configured** — no OAuth
service, no key service, no shared token. Then every request runs as `WINDMILL_MCP_USER` with
`McpAuth::fallbackScope`. That is the stdio shape and the test shape; a deployment in that state
is one you have to keep private yourself.

## Scopes

A grant is `<product>:<level>`, space-delimited on the wire, with three levels that never imply one
another — `roadmap:read roadmap:write` does not carry `roadmap:delete`, and a connection holding it
does not see `delete_tree`, `delete_node` or `remove_kind` in `tools/list` at all. Every tool
declares its level beside its description (`RoadmapToolCatalog.cpp`), `CompositeToolHost` is the one
place that enforces it, and `/.well-known/oauth-authorization-server` publishes the whole vocabulary
in `scopes_supported`, derived from the products actually connected.

**An empty scope is the account-wide grant**, deliberately: every code and token minted before this
existed carries `scope ''`, so narrowing it would disconnect every connected client on deploy. It is
the one exception to fail-closed, and it is written down at the parse site
(`platform/domain/ToolScope.h`).

Tending does NOT go through the composite. `TendingService` holds roadmap's host directly, because a
tend agent reads node text an attacker may have written (`ScopedToolHost.h`) and has no business
seeing another product's tools. The two narrowings stack: `ScopedToolHost` pins a run to one tree,
the composite pins a credential to its grant.

Above the auth check both HTTP roots meter by IP, keyed on the forwarded client address:
`windmill_server`'s general API ceiling (25 req/s per client, burst 50) covers `/mcp` along with
everything else; `windmill_mcp_http` runs its own (20 req/s, burst 40). Traffic arriving with no
proxy header is treated as internal and is not limited.

## Tools

| | Tool | Effect |
| --- | --- | --- |
| registry | `create_tree` · `list_trees` · `delete_tree` | plant / discover / soft-delete a roadmap you own |
| read | `get_tree` | title + nodes (label, icon, color, position, description, links) + edges + seq |
| read | `get_diagnostics` | cycles / dangling / self-edges / smells |
| read | `get_health` | tidiness metrics + 0–100 score (needs a valid DAG) |
| read | `get_progress` | the caller's completed / in-progress node ids |
| read | `find_nodes` | search nodes by `color`/`kind` and/or a `query` substring (id + label + description), best match first |
| edit | `create_node` | add a node — `prerequisites[]`, `description`, `links` all optional |
| edit | `annotate_node` | set a node's `description` and/or `links` |
| edit | `rename_node` · `set_node_color` · `move_node` | Class A content edits |
| edit | `connect` · `disconnect` · `reconnect` | prerequisite-edge edits |
| edit | `delete_node` · `tidy` · `prune` | tombstone / transitive reduction / GC dangling edges + orphan progress |
| edit | `import_subgraph` | bulk upsert a whole `get_tree`-shaped slice as one graft frame |
| legend | `add_kind` (inline label+description) · `rename_kind` · `describe_kind` · `remove_kind` · `reorder_kinds` · `recolor_kind` | the legend |
| write | `set_progress` | per-user overlay: single `nodeId`+`status`, or a bulk `updates[]` (order-safe) |
| resource | `windmill://quickstart` | the read-me-first document; no tool slot |

Every tree-scoped tool takes `treeId`. Edits return
`{applied, seq, diagnosticsClean, introducedDiagnostics}` — nothing is ever rejected, so the
receipt is how an agent learns what its change did. The two answer different questions:
`diagnosticsClean` is the whole tree's state (a `false` may be dirt that was already there), and
`introducedDiagnostics` names what THIS edit broke — the cycles, dangling and self-edges present
after it that the tree did not hold before, bracketed under the tree's strand so the difference
is this write's doing and nothing else's. An innocent edit on a dirty tree answers `[]`, which is
the round trip to `get_diagnostics` that the flag alone always cost.

## What `status` means

One word, one concept, wherever it appears: **`status` is the caller's own mark** — `active`,
`complete` or `none`, the vocabulary `set_progress` writes and `get_progress` returns. Ask
`get_tree` or `find_nodes` for the `status` field and every node answers, marked or not; an
omitted key would leave a caller unable to tell "no mark" from "not served".

The document's authored baseline — the inert seed a shared or demo tree carries, which every
reader sees before their own marks — is a second fact, and wears a second name: **`seedStatus`**,
readable through `fields` and writable as `import_subgraph`'s `nodes[].seedStatus`. An imported
node that carries `status` is refused by name rather than silently publishing a private mark into
a shared document.

### Bulk & ergonomics

- **`import_subgraph`** takes the exact JSON `get_tree` returns (`{title?, nodes[], kinds[]}`,
  plus an optional `progress[]`) and applies it in **one** op via the subgraph CRDT graft path.
  It is **upsert by id**: an incoming id already present is overwritten and reported in
  `nodeCollisions`/`kindCollisions`; a new id is added; nothing is removed. Pass `dryRun: true`
  to preview the collisions and change nothing. This collapses hundreds of `create_node` +
  `connect` + `set_progress` calls into a single call.
- **`set_progress`** accepts a bulk `updates[]` and evaluates the `prerequisitesMet` advisory
  against the **committed batch**, so completing a subtree out of dependency order no longer
  misreports. Unknown node ids are rejected, so no orphan overlay rows are ever created.
- **`prune`** GCs a tree: it drops dangling/self edges in one op and clears the caller's
  progress rows for nodes no longer in the tree.
- **`add_kind`** seeds `label` + `description` inline, so a legend entry lands in one op.
- **`find_nodes`** searches without pulling the whole tree: `color` or `kind` pins a hue
  (a node's color *is* its kind), `query` is a case-insensitive substring over **id + label +
  description**, and every set filter must match (AND). Matches come back best first — an exact
  id, then an id prefix, then a label hit, then an id substring, then a description-only hit —
  so pasting an id you already know finds that node, at the top, instead of somebody else's node
  whose prose happens to mention it. Ranking and matching are one question, so both live in the
  pure `selectNodes` read-model (`domain/NodeQuery`); the order is deterministic, which is what
  keeps a resume `cursor` pointing at the row it was minted from.

## Build

`brew install drogon libpqxx`, then `cmake --build build`. The MCP-carrying targets are
`windmill_server` (REST + socket + MCP), `windmill_mcp` (stdio), `windmill_mcp_http`
(standalone HTTP), and the `windmill_mcp_tests` suite. The Docker image builds, smoke-tests and
installs `windmill_server` and `windmill_mcp_http`; `windmill_mcp` is a developer-machine target.

## Register — the deployed server

MCP is same-origin with the app — `https://windmill.works/mcp`, proxied to `windmill_server`
(there is no `mcp.` subdomain any more; `deploy/Caddyfile:86` records the retirement).

```bash
claude mcp add --transport http windmill https://windmill.works/mcp
```

The client is challenged, discovers the authorization server from
`/.well-known/oauth-protected-resource`, and runs OAuth against the API host — you approve the
grant in the browser and it acts as your account. A client that cannot do OAuth uses a personal
key from settings instead, as `Authorization: Bearer <key>`.

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

Identity is per caller: an OAuth token acts as the account that granted it, a personal key as
its owner. `WINDMILL_MCP_USER` is the fallback identity only — the stdio process, the shared
token, and a deployment with no auth wired at all.

## Operating notes

- **One live room, and one process that should hold it.** `windmill_server` mounts MCP over the
  same `RoomRegistry` as REST and the socket, so agent and browser edits share one head, one
  `seq` and one broadcast. Running `windmill_mcp_http` (or `windmill_mcp`) against the *same*
  database opens a second registry: each process reloads head on open and is the authority for
  a tree while it holds it, so two of them writing one tree can still race on `(tree_id, seq)`.
  That is a local/standalone topology, not a second production writer.
- **Blocking DB on the event loop.** Repositories are synchronous libpqxx. Each borrows a
  connection for one transaction from a bounded pool of at most 20
  (`platform/adapters/postgres/PgPool.h`), opened lazily and given a 5s statement timeout.
  The call still blocks its event-loop thread for the length of the query; async is the
  remaining move before high load.
- **Clock.** MCP and the web `Collab` share one HLC domain: every write is stamped by the
  tree's room clock (`TreeRoom::nextStamp`, wall time from the `Clock` port), so an agent's
  edit and a socket edit are directly comparable and can never collide on a stamp. Clients
  will stamp their own writes in a later step (see the repo-root `docs/GRAPH_SYNC_DESIGN.md`).
