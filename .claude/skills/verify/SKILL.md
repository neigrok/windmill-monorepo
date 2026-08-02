---
name: verify
description: Run the full Windmill stack locally (Postgres + C++ backend + vite) and drive it end-to-end, including MCP edits against a live browser page.
---

# Verifying Windmill locally

## Launch

Paths are the **monorepo's** (`backend/`, `web/`) — the old `windmill-backend/` ·
`windmill-frontend/` split is gone.

```sh
# 1. Postgres (usually already running; db `windmill` exists)
pg_isready
# schema drifts behind the binary — always safe to re-apply (idempotent):
psql windmill -f backend/db/schema.sql

# 2. Backend — REBUILD FIRST; a stale binary silently lacks newer wiring (e.g. MCP→ws fan-out)
cmake --build backend/build --target windmill_server -j 8
# Env comes from backend/.env (gitignored; .env.example documents every variable).
# Do NOT paste an eight-variable incantation onto the command line — the owner asked for
# this explicitly on 2026-07-25.
cd backend && set -a && . ./.env && set +a && ./build/windmill_server
# Overriding one variable for a session is fine — source, then override just that one:
cd backend && set -a && . ./.env && set +a && WINDMILL_MCP_USER=<uuid> ./build/windmill_server

# 3. Frontend
cd web && npx vite --port 5173
```

**Stopping the server: kill BY PORT, never `pkill -f windmill_server`.** Waves run several
agents at once and they share this machine — on 2026-08-01 one reviewer's `pkill` killed
three other agents' backends mid-probe. `lsof -ti tcp:<port> | xargs kill` only takes yours.
Take a port nobody else has (agents in a wave should be handed disjoint ranges).

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
- **A focused input needs `Emulation.setFocusEmulationEnabled {enabled:true}`.** Headless
  Chrome hands the page no window focus, so `autoFocus` and `.focus()` commit but no
  `:focus` styling paints — you screenshot a resting field and conclude the ring is fine.

### Firefox (for the bugs Chrome won't show)

`brew install --cask firefox`, then `--headless --window-size=W,H --screenshot <path> <url>`
is a one-liner for a settled page. **Firefox has no CDP** (Mozilla dropped it); the remote
agent speaks WebDriver BiDi, so `/json/version` 404s and a CDP driver just hangs.

```sh
firefox --remote-debugging-port=9223 --profile <scratch> about:blank   # logs the ws:// URL
```

- Connect to `ws://127.0.0.1:<port>/session`, then `session.new` → `browsingContext.getTree`
  → `browsingContext.navigate|setViewport|captureScreenshot`, `script.evaluate`.
- **Always `session.end` before closing the socket.** Closing the WS alone leaves the
  session live and the next connect dies on "Maximum number of active sessions" — which
  reads like a bug in your script, not a leak from the last run.
- `--screenshot` fires on the load event, so it can't catch an animation. Drive BiDi and
  sleep instead, or the moat/typing scenes are always captured at their static end state.

## Observing the WebGL canvas

- Chrome-extension screenshots time out on this page; `javascript_tool` works. Capture the canvas from inside the page instead, and grabs MUST run inside `requestAnimationFrame` (double-rAF), or the WebGL buffer reads back black (no preserveDrawingBuffer).
- The extension blocks returning big base64 strings; POST captures to a local HTTP sink (simple python http.server on 127.0.0.1) and Read the PNGs.
- A hidden tab has rAF suspended — activate the tab via AppleScript (`tell application "Google Chrome" …`) before capturing.
- macOS Reduce Motion propagates into the app (`prefers-reduced-motion`) and turns all motion into snaps by design — check `matchMedia('(prefers-reduced-motion: reduce)').matches` before judging animation. The live scene instance is reachable for pokes via React fiber internals from `canvas.st-canvas`.

## Signing in without mail — the two-line recipe every wave re-derives

Local mail can't send (502, no Resend key). Every agent that needs an authenticated caller
has independently rediscovered this; it is written down once so nobody derives it again.
`sessions.token_hash` is a plain `sha256(secret)` hex digest, so mint your own session and
skip the magic-link flow entirely:

```sh
SECRET=$(openssl rand -hex 24); HASH=$(printf '%s' "$SECRET" | shasum -a 256 | awk '{print $1}')
UID=$(uuidgen | tr 'A-Z' 'a-z')
NOW=$(python3 -c "import time;print(int(time.time()*1000))")
psql windmill -q -c "INSERT INTO users (id,email) VALUES ('$UID','probe-$RANDOM@example.com')"
psql windmill -q -c "INSERT INTO sessions (token_hash,user_id,expires_ms) \
  VALUES ('$HASH','$UID',$((NOW+86400000)))"
# then either header works — the caller seam reads the cookie OR the bearer:
curl -s localhost:8088/v1/gym/exercises -H "Authorization: Bearer $SECRET"
```

Clean up afterwards: deleting the `users` row cascades to sessions and to every product's
rows. **Prefix anything you seed** (`ses_probe*`, `set_probe*`) so a parallel agent's cleanup
never takes your rows and yours never takes theirs.

## Gym (products/gym) — driving the training log

Everything is owner-scoped and idempotent by **client-minted id**, which makes it pleasant to
drive by hand: re-running a POST is a no-op that hands back the stored row, so a script can be
replayed freely.

```sh
C="Authorization: Bearer $SECRET"; J='content-type: application/json'
curl -s localhost:8088/v1/gym/exercises -H "$C"                     # 64 seeded movements
curl -s -X POST localhost:8088/v1/gym/sessions -H "$C" -H "$J" \
  -d '{"id":"ses_probe0001","startedAt":1785600000000}'
curl -s -X POST localhost:8088/v1/gym/sessions/ses_probe0001/sets -H "$C" -H "$J" \
  -d '{"id":"set_probe0001","exerciseId":"bench-press","weightKg":82.5,"reps":8,"completedAt":1785600060000}'
curl -s -X POST localhost:8088/v1/gym/sessions/ses_probe0001/finish -H "$C" -H "$J" \
  -d '{"finishedAt":1785603600000}'
curl -s "localhost:8088/v1/gym/last?exercise=bench-press" -H "$C"    # the prefill read
```

Traps worth knowing before you burn an hour on them:

- **`POST /v1/gym/sessions` JOINS an already-open session** rather than failing, so the reply
  can carry a *different* id than you sent. Always compare — a script that ignores this pours
  its sets into whatever session was already open.
- **One open session per user** is a partial unique index, and an idle one auto-closes after
  4 h *of no activity* (measured from the last set, not from the start).
- A **new** set into a finished session is refused `409 session-finished`; a **replay** of one
  that already landed still returns `200` with the stored row. That asymmetry is the whole
  offline story — flush before you finish.
- The three 409s are told apart by the machine `code`, never by the sentence:
  `session-finished` · `set-id-taken` · `session-id-taken`.
- The schema seeds the catalog with `ON CONFLICT DO NOTHING`, so re-applying `schema.sql`
  never clobbers a renamed display name — and re-applying twice is the idempotency test.

## Known gotchas

- Live ws frames can stall for idle/quiet tabs; state catches up in bursts via reconnect grafts (dogfood node `ws-keepalive`). If a live edit doesn't appear in seconds, it's likely this, not your change — a page reload always converges.
- MCP arg names on some tools differ from the deployed schema (local `rename_node` wants `id`, not `nodeId`); errors don't name the expected field.
