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
                          tools/call, ping). Depends only on jsoncpp + an injected ToolHost.
  RoadmapTools.{h,cpp}    the ToolHost: the tool catalog + dispatch into RoomRegistry /
                          TreeRoom / ProgressService.
  McpHttpEndpoint.{h,cpp} the Streamable-HTTP transport (sessions, Origin checks, verbs).
infra/mcp_main.cpp        `windmill_mcp`      — stdio transport (local hosts spawn it).
infra/mcp_http_main.cpp   `windmill_mcp_http` — HTTP transport (the deployable API).
```

The dependency arrow points inward: `McpServer` knows nothing of rooms, Postgres, or HTTP;
the transports know nothing of the tools. The 9 edit tools reuse the existing
`commandFromJson` codec — their argument names *are* the command payload keys — so each is a
thin, well-described intent over machinery that already exists.

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

## Tools (14)

| | Tool | Effect |
| --- | --- | --- |
| read | `get_tree` | title + nodes + prerequisite edges + current seq |
| read | `get_diagnostics` | cycles / dangling / self-edges / smells |
| read | `get_health` | tidiness metrics + 0–100 score (needs a valid DAG) |
| read | `get_progress` | the caller's completed / in-progress node ids |
| edit | `create_node` | add a node (mints a slug id from the label if none given) |
| edit | `rename_node` · `set_node_color` · `move_node` | Class A content edits |
| edit | `connect` · `disconnect` · `reconnect` | prerequisite-edge edits |
| edit | `delete_node` · `tidy` | tombstone / transitive reduction |
| write | `set_progress` | per-user overlay: active / complete / none |

Every tool takes `treeId`. Edits return `{applied, seq, opId, diagnosticsClean}` so the agent
learns immediately whether its change kept the graph valid (nothing is ever rejected).

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
