---
name: verify
description: Run the full Windmill stack locally (Postgres + C++ backend + vite) and drive it end-to-end, including MCP edits against a live browser page.
---

# Verifying Windmill locally

## Launch

```sh
# 1. Postgres (usually already running; db `windmill` exists)
pg_isready
# schema drifts behind the binary — always safe to re-apply (idempotent):
psql windmill -f windmill-backend/db/schema.sql

# 2. Backend — REBUILD FIRST; a stale binary silently lacks newer wiring (e.g. MCP→ws fan-out)
cd windmill-backend && cmake --build build --target windmill_server -j 8
# Env comes from windmill-backend/.env (gitignored; .env.example documents every variable).
# Do NOT paste an eight-variable incantation onto the command line — the owner asked for
# this explicitly on 2026-07-25.
set -a && . ./.env && set +a && ./build/windmill_server
# Overriding one variable for a session is fine — source, then override just that one:
set -a && . ./.env && set +a && WINDMILL_MCP_USER=<uuid> ./build/windmill_server

# 3. Frontend
cd windmill-frontend && npx vite --port 5173
```

- `WINDMILL_ALLOWED_ORIGINS` is required — without it the dev page's credentialed fetches fail CORS ("Failed to fetch").
- `WINDMILL_MCP_USER` must be a real uuid in `users` (the default "dev" 500s on create_tree; owner_id is uuid). The uuid above is the seeded `dev@localhost` user in the local db.

## Driving MCP edits

MCP is HTTP JSON-RPC at `localhost:8088/mcp`, bearer `devtoken`. Sessions are required:

```sh
SID=$(curl -si localhost:8088/mcp -H 'Authorization: Bearer devtoken' -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}' \
  | grep -i mcp-session-id | tr -d '\r' | awk '{print $2}')
curl -s localhost:8088/mcp -H "Authorization: Bearer devtoken" -H "Mcp-Session-Id: $SID" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_tree","arguments":{"title":"Scratch"}}}'
```

Make a scratch tree via `create_tree` (never seed via raw SQL — a hand-inserted legacy `document` blob backfills with zero-sentinel HLC stamps and projects as an empty tree). Open at `localhost:5173/#/app/<treeId>`. Delete scratch trees afterwards: rows in `trees`, `tree_nodes`, `tree_edges`, `tree_kinds`, `tree_ops`.

### Getting the browser to actually load your scratch tree

MCP-created trees belong to `WINDMILL_MCP_USER`, and the page must be **that same user**
or the tree just reports "Couldn't load this roadmap". Don't fix that with SQL — do it by
pointing MCP at the browser's user, which needs no ownership surgery and no cache dance:

1. **Get a session.** Local mail can't send (502, no Resend key) but `/v1/auth/magic-link`
   still writes the row, and you can't reverse the hash — so mint your own. The
   `magic_links.token_hash` column is a plain `sha256(secret)`:
   ```sh
   SECRET=$(openssl rand -hex 24); HASH=$(printf '%s' "$SECRET" | shasum -a 256 | awk '{print $1}')
   NOW=$(python3 -c "import time;print(int(time.time()*1000))")
   psql windmill -q -c "INSERT INTO magic_links (token_hash,email,created_ms,expires_ms) \
     VALUES ('$HASH','dev@example.com',$NOW,$((NOW+900000)))"
   curl -si -X POST localhost:8088/v1/auth/verify -H 'content-type: application/json' \
     -H 'Origin: http://localhost:5173' -d "{\"token\":\"$SECRET\"}"   # → Set-Cookie: wm_session=…
   ```
   Note `dev@localhost` (the seeded user) is **rejected** by the email validator as
   "unfinished" — use a real-looking domain.
2. **Restart the backend with `WINDMILL_MCP_USER=<that user's uuid>`**, then `create_tree`
   + `import_subgraph`. The tree is now natively owned by the signed-in browser user, so
   `#/app/<id>` just works and you get the OWNER surfaces (edit rows, add-step, share).
3. Set the cookie in the browser before navigating — over CDP that is
   `Network.setCookie {name:'wm_session', value:…, domain:'localhost', path:'/'}`.

**Rooms are cached in the running server.** Any `psql` change to a tree's `visibility` or
`owner_id` after the server has opened that room is invisible until you restart it. This
is the single most time-wasting trap in local verification — prefer arranging ownership
*before* the room is first opened (step 2) over editing rows and restarting.

### Driving the DOM without the extension

The Chrome extension can't inject into these pages, but headless Chrome + CDP needs no
dependencies: Node 20 has `WebSocket` behind `node --experimental-websocket`, so a ~40-line
raw-CDP driver does navigation, phone emulation, taps, typing and screenshots. Launch with
`--headless=new --remote-debugging-port=9222 --user-data-dir=<scratch>`.

- **`Emulation.setDeviceMetricsOverride` is per-CDP-session.** Reconnecting drops it and
  you silently measure the desktop layout. Set it in the same session that navigates.
- Return values through `JSON.stringify` inside the page — `returnByValue` chokes
  deep-serializing DOM objects (`className` on an SVG element is not a string).
- Guard every probe field on its own; one null element otherwise kills the whole run with
  a bare `TypeError: Illegal invocation` and no clue which expression threw. Log the
  failing expression.

## Observing the WebGL canvas

- Chrome-extension screenshots time out on this page; `javascript_tool` works. Capture the canvas from inside the page instead, and grabs MUST run inside `requestAnimationFrame` (double-rAF), or the WebGL buffer reads back black (no preserveDrawingBuffer).
- The extension blocks returning big base64 strings; POST captures to a local HTTP sink (simple python http.server on 127.0.0.1) and Read the PNGs.
- A hidden tab has rAF suspended — activate the tab via AppleScript (`tell application "Google Chrome" …`) before capturing.
- macOS Reduce Motion propagates into the app (`prefers-reduced-motion`) and turns all motion into snaps by design — check `matchMedia('(prefers-reduced-motion: reduce)').matches` before judging animation. The live scene instance is reachable for pokes via React fiber internals from `canvas.st-canvas`.

## Known gotchas

- Live ws frames can stall for idle/quiet tabs; state catches up in bursts via reconnect grafts (dogfood node `ws-keepalive`). If a live edit doesn't appear in seconds, it's likely this, not your change — a page reload always converges.
- MCP arg names on some tools differ from the deployed schema (local `rename_node` wants `id`, not `nodeId`); errors don't name the expected field.
