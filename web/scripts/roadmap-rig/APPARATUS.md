# Roadmap capture rig

Headless Chrome captures the roadmap canvas over CDP. `seed.mjs` installs the repository's dogfood
fixture in a local backend. Pass the test account id and session cookie through arguments or
environment variables; never store them here.

## Start and seed

The rig expects Postgres, `backend/build/windmill_server`, `backend/.env`, Chrome at
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, and a local `web/node_modules`.
Create a test session using the [local backend runbook](../../../backend/RUNNING.md).

From this directory:

```sh
WM_RIG_USER=<uuid> ./start-backend.sh
./start-vite.sh "$(git rev-parse --show-toplevel)" 5175
node seed.mjs --backend http://localhost:8088 --cookie "$WM_RIG_COOKIE"
```

`start-backend.sh` sources `backend/.env`, sets `WINDMILL_MCP_USER` to the test user and allows
origins on ports 5173–5178. It refuses to start while port 8088 is occupied. Logs go to
`$WM_RIG_LOGS`, defaulting to `${TMPDIR:-/tmp}/windmill-rig`.

The cookie must belong to that same user. `seed.mjs` defaults to the committed fixture in
`web/test/products/roadmap/fixtures/dogfood-tree.json`; `--snapshot <file>` accepts a raw MCP
`get_tree` reply and `--tree <id>` selects a different tree id. The default MCP bearer is `devtoken`;
`--mcpToken` overrides it.

Seeding creates the document through `POST /v1/trees`, writes private progress through MCP, then
reads the result back and checks structure and progress counts. The default tree id is
`t_9362d9bc883e0a1e`. `dogfoodTree.js` beside the fixture builds the model used by tests and
`web/scripts/benchmark-roadmap.mjs` for offline layout measurements.

## Capture

```sh
node --experimental-websocket capture.mjs --origin http://localhost:5175 \
  --tree t_9362d9bc883e0a1e --cookie "$WM_RIG_COOKIE" --out /tmp/roadmap-desktop \
  --port 9222 --layout bubble --focus --caption-mode fixed
node --experimental-websocket capture.mjs --origin http://localhost:5175 \
  --tree t_9362d9bc883e0a1e --cookie "$WM_RIG_COOKIE" --out /tmp/roadmap-phone \
  --phone --port 9223 --layout bubble --focus --caption-mode fixed
```

Each run creates a fresh Chrome profile, supplies the session, sets device dimensions and opens
the app in tree view. It waits for a populated canvas, no active ceremony/settle/glide and a
stable camera before capturing.

| Option | Effect |
|---|---|
| `--width`, `--height`, `--dpr` | Defaults to 1440×900 at DPR 1. |
| `--phone` | 390×844 at DPR 3 with mobile and touch emulation. |
| `--select <nodeId>` | Node used for focus and selection checks; default `skilltree-scene`. |
| `--layout <name>` | Uses the normal layout query parameter. |
| `--focus` | Captures Focus and All steps states as well as initial and selected views. |
| `--caption-mode fixed` | Measures the current captions at their fixed CSS-pixel size. |
| `--reduced-motion` | Enables the reduced-motion preference. |
| `--keep` | Leaves Chrome open for `probe-captions.mjs`. |
| `--port` | Distinct CDP ports allow concurrent captures. |

Each view produces a PNG and JSON measurements. `measures.json` includes camera, caption
visibility/collisions, node sizes, bounds, selection and hit-floor outcomes. `settle.json` records
the wait; `console.json` records browser messages; `error.txt` records a tree-load failure.
Captions count only when computed display, visibility and opacity make them visible.

## Stop and interpret

```sh
./stop-port.sh 8088 5175
```

Stop only listening processes: `lsof -ti tcp:<port> -sTCP:LISTEN`. Omitting the LISTEN filter can
also select a browser connected to that port. Avoid process-name kills.

Captures use SwiftShader. Geometry and DOM measurements remain useful, but pixels can differ
from hardware rendering and these runs cannot establish GPU frame rate or interactive latency.
Use a hardware-backed browser for timing. A node_modules symlink into another checkout can also
put fonts outside Vite's allowed filesystem root; install dependencies in the worktree itself.
