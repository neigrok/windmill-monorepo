# MCP adapter (`adapters/mcp/`)

The Model Context Protocol edge of the backend: it lets an AI agent read and author
Windmill roadmaps through the **same application core** an HTTP or WebSocket client drives.
It is a first-class adapter alongside `adapters/http/` and `adapters/ws/` — not a proxy.
Edits route through the tree's `TreeRoom`, so they are merged, sequenced, logged to
`tree_ops`, and persisted to `trees.document` exactly like any other edit.

## Shape

```
adapters/mcp/
  McpServer.{h,cpp}       transport-agnostic JSON-RPC 2.0 engine (initialize, tools/list,
                          tools/call, resources/list, resources/read, ping). Depends only on
                          jsoncpp + an injected ToolHost.
  RoadmapTools.{h,cpp}    the ToolHost: the tool catalog + dispatch into RoomRegistry /
                          TreeRoom / ProgressService.
  ToolArgs.{h,cpp}        one home for argument validation and for the sentence a refusal is
                          written in — every tool routes through it.
  ReadShape.{h,cpp}       the read projections (`fields`) and paging (`limit`/`cursor`).
  Resources.{h,cpp}       the MCP resources served: `windmill://quickstart`.
  McpHttpEndpoint.{h,cpp} the Streamable-HTTP transport (sessions, Origin checks, verbs).
infra/mcp_main.cpp        `windmill_mcp`      — stdio transport (local hosts spawn it).
infra/mcp_http_main.cpp   `windmill_mcp_http` — HTTP transport (the deployable API).
```

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
client can pre-validate what the server refuses. `test/adapters/mcp/ToolErrorContractTest.cpp`
pins the messages themselves.

## Handles

- `treeId` — the roadmap, on every tree-scoped tool.
- `nodeId` — a node that **exists**, on every tool that edits or marks one. The older `id` spelling
  is still accepted (declared `deprecated` in the schema, since `additionalProperties: false`
  would otherwise have a client's own validator reject it), and never published as canonical.
- `id` — the id **proposed** for a NEW node: `create_node`, `import_subgraph`'s `nodes[].id`.
  A different concept, deliberately a different word; `create_node` refuses `nodeId` outright.
- Legend kinds keep their own `id`: a kind is not a node.

## Resources

`resources/list` and `resources/read` serve `windmill://quickstart` (markdown) — edge direction,
the handle law, what is never refused, the read projections, and the caps. A resource costs no
tool slot, so it is the right home for what an agent needs before its first call. Everything it
claims is checked against the shipped catalog by a test.

## Transports

The engine `McpServer::handle` is pure (`Json request → optional<Json> reply`). Two thin
transports wrap it; both speak JSON-RPC 2.0, protocol version `2025-06-18`:

- **stdio** (`windmill_mcp`) — newline-delimited frames on stdin/stdout, what local hosts
  (Claude Code/Desktop) launch. stdout is the protocol channel; logs go to stderr.
- **Streamable HTTP** (`windmill_mcp_http`) — the remote/deployable transport. One endpoint
  (`/mcp` by default):
  - `POST` — the body is one JSON-RPC message. A *request* gets its JSON-RPC response as
    `application/json`; a *notification* gets `202 Accepted`. `initialize` mints an
    `Mcp-Session-Id` (returned as a header) that every later call must present.
  - `GET` — would open a server→client SSE stream; we have none, so `405`.
  - `DELETE` — ends a session.
  - The `Origin` header is validated (DNS-rebinding protection); `/healthz` is a liveness
    probe. No server→client streaming is used because every tool is synchronous.

## Tools

| | Tool | Effect |
| --- | --- | --- |
| registry | `create_tree` · `list_trees` · `delete_tree` | plant / discover / soft-delete a roadmap you own |
| read | `get_tree` | title + nodes (label, icon, color, position, description, links) + edges + seq |
| read | `get_diagnostics` | cycles / dangling / self-edges / smells |
| read | `get_health` | tidiness metrics + 0–100 score (needs a valid DAG) |
| read | `get_progress` | the caller's completed / in-progress node ids |
| read | `find_nodes` | search nodes by `color`/`kind` and/or a `query` substring (label + description) |
| edit | `create_node` | add a node — `prerequisites[]`, `description`, `links` all optional |
| edit | `annotate_node` | set a node's `description` and/or `links` |
| edit | `rename_node` · `set_node_color` · `move_node` | Class A content edits |
| edit | `connect` · `disconnect` · `reconnect` | prerequisite-edge edits |
| edit | `delete_node` · `tidy` · `prune` | tombstone / transitive reduction / GC dangling edges + orphan progress |
| edit | `import_subgraph` | bulk upsert a whole `get_tree`-shaped slice as one graft frame |
| legend | `add_kind` (inline label+description) · `rename_kind` · `describe_kind` · `remove_kind` · `reorder_kinds` · `recolor_kind` | the legend |
| write | `set_progress` | per-user overlay: single `nodeId`+`status`, or a bulk `updates[]` (order-safe) |
| resource | `windmill://quickstart` | the read-me-first document; no tool slot |

Every tree-scoped tool takes `treeId`. Edits return `{applied, seq, diagnosticsClean}` so the
agent learns immediately whether its change kept the graph valid (nothing is ever rejected).

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
  (a node's color *is* its kind), `query` is a case-insensitive substring over label +
  description, and every set filter must match (AND). Backed by the pure `selectNodes`
  read-model (`domain/NodeQuery`).

## Build

`brew install drogon libpqxx`, then `cmake --build build`. Produces `windmill_mcp` (stdio),
`windmill_mcp_http` (HTTP), and `windmill_mcp_tests`.

## Run & register — stdio (local)

```bash
claude mcp add windmill --env DATABASE_URL=postgresql://localhost/windmill \
  -- /ABS/PATH/windmill-backend/build/windmill_mcp
```

## Deploy & register — HTTP (the main API)

```bash
DATABASE_URL=postgresql://…/windmill \
PORT=8090 \
WINDMILL_MCP_ALLOWED_ORIGINS="https://app.windmill.dev" \
  ./build/windmill_mcp_http
```

Point a client at the URL:

```bash
claude mcp add --transport http windmill https://your-host/mcp
```

### Configuration (env)

| Var | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://localhost/windmill` | Postgres connection |
| `PORT` | `8090` | listen port |
| `WINDMILL_MCP_HOST` | `0.0.0.0` | bind address |
| `WINDMILL_MCP_THREADS` | `8` | Drogon worker threads |
| `WINDMILL_MCP_PATH` | `/mcp` | endpoint path |
| `WINDMILL_MCP_ALLOWED_ORIGINS` | *(empty)* | comma-separated browser Origin allow-list; `*` allows all. Non-browser clients send no Origin and are always allowed. |
| `WINDMILL_MCP_USER` | `dev` | the identity edits/progress are written as |

Identity: the agent writes as `dev` by default (the same fixed user the web dogfood reads).
When accounts land (Phase 1) this becomes the authenticated caller — see below.

## Known limitations (tied to SPEC §12 hardening)

- **Auth is deferred.** The HTTP transport is complete and safe (sessions, Origin checks),
  but there is no per-caller authentication yet — every session acts as `WINDMILL_MCP_USER`.
  Deploy behind your own gateway/network boundary until Phase 1. The auth seam is the
  session: Phase 1 maps a bearer token → user at `handlePost`, and per-session identity
  flows into `RoadmapTools`.
- **One writer per tree, across processes.** `windmill_mcp_http` runs its own `RoomRegistry`
  against the shared Postgres (the standalone topology). It reloads head from the database on
  open and is the effective authority for a tree during a session; the database is the bus,
  so agent edits are durable and visible to the web on reload. Simultaneous web+MCP editing
  of the *same* tree can still race on `(tree_id, seq)` until §12 sticky routing (a single
  room owner) — or fold the MCP endpoint into `windmill_server` to share one RoomRegistry.
- **Blocking DB in the event loop.** Repositories are connection-per-request (synchronous
  libpqxx), matching the existing HTTP server. Add a pool / async before high load.
- **Clock.** MCP and the web `Collab` now share one HLC domain: every write is stamped by
  the tree's room clock (`TreeRoom::nextStamp`, wall time from the Clock port), so an agent's
  edit and a socket edit are directly comparable and can never collide on a stamp. Clients
  will stamp their own writes in a later step (see `GRAPH_SYNC_DESIGN.md`).

## Next

- Per-caller auth (bearer token → user) at the session seam — pairs with Phase 1.
- `list_trees` / `create_tree` tools once a `TreeRepository::list` port exists (agent
  discovery; today a tree id must be known).
- Optionally co-host the endpoint in `windmill_server` to share one RoomRegistry and
  broadcast agent edits live to connected browsers.
