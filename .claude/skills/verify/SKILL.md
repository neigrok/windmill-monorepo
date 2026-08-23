---
name: verify
description: Run the full Windmill stack locally (Postgres + C++ backend + vite) and drive it end-to-end, including MCP edits against a live browser page.
---

# Verifying Windmill locally

## Launch

```sh
# 1. Postgres — db `windmill`; schema.sql is idempotent, re-apply after pulling
pg_isready
psql windmill -f backend/db/schema.sql

# 2. Backend — rebuild first; a stale binary silently lacks newer wiring
cmake --build backend/build --target windmill_server -j 8
cd backend && set -a && . ./.env && set +a && ./build/windmill_server
# Override one variable for a session by sourcing first, then prefixing just that one:
cd backend && set -a && . ./.env && set +a && WINDMILL_MCP_USER=<uuid> ./build/windmill_server

# 3. Frontend — vite.config.js pins port 5173
cd web && npm run dev
```

Env comes from `backend/.env` (gitignored; `.env.example` documents every variable). Do not paste
a multi-variable incantation onto the command line.

- Stop the server **by port**: `lsof -ti tcp:<port> | xargs kill`. Never `pkill -f windmill_server`
  — several agents share this machine and it takes all of their backends too.
- **Pin the two ports: backend 8088, vite 5173.** Outside a production build
  `web/src/shell/apiBase.js` falls back to `http://localhost:8088` (and
  `ws://localhost:8088/v1/socket`) unless `VITE_API_BASE_URL` is set, and
  `WINDMILL_ALLOWED_ORIGINS=http://localhost:5173` is what lets the page's credentialed fetches
  through CORS. Either one wrong and the page renders chrome and says *"Couldn't load this
  roadmap…"*, which reads like a broken tree. A second full stack therefore needs both overridden
  (`VITE_API_BASE_URL` at its backend, `WINDMILL_ALLOWED_ORIGINS` at its vite origin); otherwise
  give parallel agents disjoint ports for backend-only probing (curl/MCP) and keep 8088+5173 for
  whoever needs a browser.
- `WINDMILL_MCP_USER` must be a real uuid in `users`; a non-uuid 500s on `create_tree`.

## Backend suites

```sh
cmake --build backend/build -j8
ctest --test-dir backend/build -V     # three binaries: domain · mcp · adapters
```

Each binary ends with `N/M cases passed, X stopped before the end, Y skipped, Z assertion(s)
failed`. Read all four numbers: *skipped* is never a pass, and a case a `REQUIRE` cut short counts
as *stopped before the end*. `--output-on-failure` prints nothing while green, so use `-V` when the
skip count is what you came for.

The Postgres integration cases (`Pg*` tests in the adapters binary) need a live database and skip
without `WM_PG_TEST`. They seed and clean their own rows, so re-running is free — and they are the
only proof the SQL half works, since CI runs ctest in a container with no database:

```sh
WM_PG_TEST=1 DATABASE_URL="postgresql:///windmill?host=/tmp" \
  ctest --test-dir backend/build -R adapters -V
```

Run them before pushing a change to a Postgres repository or to the tables it reads.

## Driving MCP edits

MCP is HTTP JSON-RPC at `localhost:8088/mcp`, bearer `devtoken`. A session is required: `initialize`
returns the `Mcp-Session-Id` every later call must carry.

```sh
SID=$(curl -si localhost:8088/mcp -H 'Authorization: Bearer devtoken' -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}' \
  | grep -i mcp-session-id | tr -d '\r' | awk '{print $2}')
curl -s localhost:8088/mcp -H "Authorization: Bearer devtoken" -H "Mcp-Session-Id: $SID" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_tree","arguments":{"title":"Scratch"}}}'
```

Make scratch trees with `create_tree`, never raw SQL. Open at `localhost:5173/#/app/<treeId>`.
Clean up afterwards: rows in `trees`, `tree_nodes`, `tree_edges`, `tree_kinds`, `tree_ops`.

### Getting the browser to load your scratch tree

MCP-created trees belong to `WINDMILL_MCP_USER`, and the page must be that same user or the tree
reports "Couldn't load this roadmap". Point MCP at the browser's user rather than doing ownership
surgery in SQL:

1. **Mint a session.** Local mail can't send (502, no Resend key), but `magic_links.token_hash` is a
   plain `sha256(secret)`, so write your own row and redeem it:
   ```sh
   SECRET=$(openssl rand -hex 24); HASH=$(printf '%s' "$SECRET" | shasum -a 256 | awk '{print $1}')
   NOW=$(python3 -c "import time;print(int(time.time()*1000))")
   psql windmill -q -c "INSERT INTO magic_links (token_hash,email,created_ms,expires_ms) \
     VALUES ('$HASH','dev@example.com',$NOW,$((NOW+900000)))"
   curl -si -X POST localhost:8088/v1/auth/verify -H 'content-type: application/json' \
     -H 'Origin: http://localhost:5173' -d "{\"token\":\"$SECRET\"}"   # → Set-Cookie: wm_session=…
   ```
   Use a domain with a dot — the email validator rejects `dev@localhost` as unfinished.
2. **Restart the backend with `WINDMILL_MCP_USER=<that user's uuid>`**, then `create_tree` +
   `import_subgraph`. The tree is natively owned by the signed-in browser user, so `#/app/<id>`
   works and shows the owner surfaces (edit rows, add-step, share).
3. Set the cookie before navigating — over CDP that is `Network.setCookie {name:'wm_session',
   value:…, domain:'localhost', path:'/'}`.

**Rooms are cached in the running server.** A `psql` change to a tree's `visibility` or `owner_id`
is invisible until restart once the server has opened that room. Arrange ownership before the room
is first opened rather than editing rows and restarting.

## Driving the DOM

The Chrome extension can't inject into these pages. Headless Chrome + CDP needs no dependencies:
Node 20 has `WebSocket` behind `node --experimental-websocket`, so a ~40-line raw-CDP driver does
navigation, phone emulation, taps, typing and screenshots. Launch with `--headless=new
--remote-debugging-port=9222 --user-data-dir=<scratch>`.

- **`Emulation.setDeviceMetricsOverride` is per-CDP-session.** Reconnecting drops it and you
  silently measure the desktop layout. Set it in the session that navigates.
- Return values through `JSON.stringify` inside the page — `returnByValue` chokes deep-serializing
  DOM objects (`className` on an SVG element is not a string).
- Guard every probe field on its own and log the failing expression; one null element otherwise
  kills the run with a bare `TypeError: Illegal invocation`.
- **A focused input needs `Emulation.setFocusEmulationEnabled {enabled:true}`.** Headless Chrome
  hands the page no window focus, so `.focus()` commits but no `:focus` styling paints.

### Firefox

`brew install --cask firefox`, then `--headless --window-size=W,H --screenshot <path> <url>` for a
settled page. Firefox has no CDP; the remote agent speaks WebDriver BiDi, so `/json/version` 404s
and a CDP driver hangs.

```sh
firefox --remote-debugging-port=9223 --profile <scratch> about:blank   # logs the ws:// URL
```

- Connect to `ws://127.0.0.1:<port>/session`, then `session.new` → `browsingContext.getTree` →
  `browsingContext.navigate|setViewport|captureScreenshot`, `script.evaluate`.
- **Always `session.end` before closing the socket.** Closing the WS alone leaves the session live
  and the next connect dies on "Maximum number of active sessions".
- `--screenshot` fires on the load event, so it cannot catch an animation. Drive BiDi and sleep.

### The WebGL canvas

- Extension screenshots time out on this page; `javascript_tool` works. Capture the canvas from
  inside the page and inside `requestAnimationFrame` (double-rAF) — there is no
  `preserveDrawingBuffer`, so a grab outside it reads back black.
- The extension blocks returning big base64 strings; POST captures to a local HTTP sink (python
  `http.server` on 127.0.0.1) and Read the PNGs.
- A hidden tab has rAF suspended — activate it via AppleScript (`tell application "Google Chrome" …`)
  before capturing.
- macOS Reduce Motion propagates into the app and turns all motion into snaps by design. Check
  `matchMedia('(prefers-reduced-motion: reduce)').matches` before judging animation. The live scene
  instance is reachable through React fiber internals from `canvas.st-canvas`.

## Signing in without mail

`sessions.token_hash` is a plain `sha256(secret)` hex digest, so mint a session directly and skip
the magic-link flow:

```sh
SECRET=$(openssl rand -hex 24); HASH=$(printf '%s' "$SECRET" | shasum -a 256 | awk '{print $1}')
UID=$(uuidgen | tr 'A-Z' 'a-z')
NOW=$(python3 -c "import time;print(int(time.time()*1000))")
psql windmill -q -c "INSERT INTO users (id,email) VALUES ('$UID','probe-$RANDOM@example.com')"
psql windmill -q -c "INSERT INTO sessions (token_hash,user_id,expires_ms) \
  VALUES ('$HASH','$UID',$((NOW+86400000)))"
# either header works — the caller seam reads the cookie OR the bearer:
curl -s localhost:8088/v1/gym/exercises -H "Authorization: Bearer $SECRET"
```

Deleting the `users` row cascades to sessions and to every product's rows. Prefix anything you seed
(`ses_probe*`, `set_probe*`) so a parallel agent's cleanup never takes your rows.

## Gym — driving the training log

Everything is owner-scoped and idempotent by client-minted id, so a script can be replayed freely.

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

# Routines and the frozen plan. `targetReps` and `targetSets` may each be OMITTED — that is how
# "3 × max" and an open line are expressed. Both absences survive into the frozen `plan`; a zero in
# either would be a target the lifter never set.
curl -s -X POST localhost:8088/v1/gym/routines -H "$C" -H "$J" -d '{"id":"rt_probe00001",
  "name":"Push A","position":0,"entries":[
    {"exerciseId":"bench-press","targetSets":5,"targetReps":5,"targetWeightKg":82.5},
    {"exerciseId":"chin-up","targetSets":3},
    {"exerciseId":"barbell-row"}]}'
curl -s localhost:8088/v1/gym/routines/rt_probe00001 -H "$C"   # `history` rides on this read only; the list omits it
curl -s -X POST localhost:8088/v1/gym/sessions -H "$C" -H "$J" \
  -d '{"id":"ses_probe0002","startedAt":1785686400000,"routineId":"rt_probe00001"}'   # freezes `plan`
curl -s localhost:8088/v1/gym/sessions/ses_probe0002/review -H "$C"
curl -s -X DELETE localhost:8088/v1/gym/sessions/ses_probe0002 -H "$C"               # 204, or 409 open
```

Traps:

- **`POST /v1/gym/sessions` JOINS an already-open session** rather than failing, so the reply can
  carry a different id than you sent — always compare, or a script pours its sets into whatever was
  already open. Send `{"joinOpenSession": false}` for a backfill; a live workout then refuses it
  `409 session-already-open`. `routineId` is read only on the path that actually creates a session.
- **One open session per user** (a partial unique index); an idle one auto-closes four hours after
  its last set, not after its start. `closedItself` on the log row is inferred from `finished_at`
  landing on the last set's instant — there is no column.
- **A replayed create is a 200 with the stored row everywhere** — sessions, sets, routines, custom
  movements. Only an id already spent by another account is a 409. A **new** set into a finished
  session is refused `409 session-finished`, so flush before you finish.
- Tell the 409s apart by the machine `code`, never the sentence: `session-finished` ·
  `set-id-taken` · `session-id-taken` · `session-already-open` · `routine-id-taken` ·
  `exercise-id-taken` · `session-open` (discarding a running workout).
- The review excludes its own session from its history window, so read it after the finish.
