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
`get_tree` reply. The default MCP bearer is `devtoken`; `--mcpToken` overrides it.

Seeding plants the roadmap through MCP (`planter.mjs`, which `web/scripts/benchmark-board.mjs` plants with too): MCP is
the door every server write for a person takes with roadmap's switch on, as production's is, or off, so the seed runs
against a backend with or without `ROADMAP_ENGINE_ENABLED`. `create_tree` makes it with the fixture's legend, `import_subgraph`
plants its steps under their own ids, so `--select` names a fixture step, and `update_nodes` writes the private progress.
The server mints the roadmap's id, which the seed prints; capture takes it as `--tree`. The seed then reads the copy back,
its steps, links and legend through MCP `get_tree` and its marks through `GET /v1/trees/{id}/progress`, and checks the
counts. `dogfoodTree.js` beside the fixture builds the model used by tests and `web/scripts/benchmark-roadmap.mjs` for
offline layout measurements.

## Capture

```sh
node --experimental-websocket capture.mjs --origin http://localhost:5175 \
  --api http://localhost:8088 \
  --tree <the id seed.mjs printed> --cookie "$WM_RIG_COOKIE" --out /tmp/roadmap-desktop \
  --port 9222 --layout bubble --focus --caption-mode fixed
node --experimental-websocket capture.mjs --origin http://localhost:5175 \
  --api http://localhost:8088 \
  --tree <the id seed.mjs printed> --cookie "$WM_RIG_COOKIE" --out /tmp/roadmap-phone \
  --phone --port 9223 --layout bubble --focus --caption-mode fixed
```

Each run creates a fresh Chrome profile, supplies the session, sets device dimensions and opens
the app in tree view. It confirms the requested view and optional theme, waits for the server's
real answer to the room's session, then waits for a populated canvas, no active
ceremony/settle/glide and a camera stable for 600 ms. Each shot also loads visible text's computed
fonts, waits for finite animations and awaits two animation frames.
Pass the API origin compiled into the frontend: Vite defaults to `http://localhost:8088`.
For a same-origin built stack, omit `--api` or supply the same origin as `--origin`. Both options
accept only HTTP(S) origins without credentials, paths, queries or fragments.

| Option | Effect |
|---|---|
| `--api <origin>` | Observes the room's session on this API origin as well as the frontend origin; defaults to `--origin`. |
| `--width`, `--height`, `--dpr` | Defaults to 1440×900 at DPR 1. |
| `--phone` | 390×844 at DPR 3 with mobile and touch emulation. |
| `--select <nodeId>` | Node used for focus and selection checks; default `skilltree-scene`. |
| `--layout <name>` | Uses the normal layout query parameter. |
| `--theme light\|dark` | Sets and confirms the requested appearance; omitted leaves the app's default. |
| `--focus` | Captures Focus and All steps states as well as initial and selected views. |
| `--caption-mode fixed` | Measures the current captions at their fixed CSS-pixel size. |
| `--reduced-motion` | Enables the reduced-motion preference. |
| `--keep` | Leaves Chrome open for `probe-captions.mjs`. |
| `--port` | Distinct CDP ports allow concurrent captures. |

Each view produces a PNG and JSON measurements. `measures.json` includes camera, caption
visibility/collisions, node sizes, bounds, selection and hit-floor outcomes. `settle.json` records
the wait; `console.json` records browser messages; `error.txt` records a tree-load failure.
Captions count only when computed display, visibility and opacity make them visible.

## Shared browser proof

`browser-proof.mjs` is import-safe and shared by capture and the production smoke. Browser launch,
accounts, SQL/REST readers, artifacts and Graph camera internals belong to each caller.

- `settleVisuals({ timeoutMs })` is a self-contained browser callback for `page.evaluate`, or
  `evalJson(cdp, settleVisuals.toString())` over raw CDP. It loads visible text with its computed
  font style, weight, size and family and its actual glyphs, awaits `document.fonts.ready`, finite
  animations and two animation frames. Infinite animation loops do not block it. The default
  deadline is 10 seconds. Callers first assert the requested theme/view; visual settlement does
  not establish navigation or the Graph's camera settlement.
- Install `installRoadmapObserver({ origins })` before navigation with `context.addInitScript` or
  CDP's `Page.addScriptToEvaluateOnNewDocument`. It ignores non-HTTP documents and child frames,
  preserves real WebSockets and `fetch`, and observes, on the exact supplied origins only, the
  session of either room: the one with the switch off on `/v1/socket`, and the room on the device's
  copy, which production's build reads, through the sync engine's `POST /v1/sync/pull` and `/v1/sync/live`.
  `window.__roadmapProof.waitForBaseline({ treeId, reach, timeoutMs })` accepts the first of these to
  hold. On the socket, a `subgraph` with `intent: delta` replying to the current subscribe on an open
  socket: live frames, unrelated trees and superseded subscriptions cannot satisfy it, and replies
  to repeated same-tree subscribes are associated in send order, since the wire has no subscription
  request id. Through the engine, a pull that answered the roadmap's `tree/<id>` scope with its rows,
  while an open live socket follows that scope: a `sub` of it sent, with no `unsub` and no `gone` or
  `not-found` frame since, and no later pull answering the scope otherwise. The engine names no
  reach; a pull served to nobody (`as: null`) can only read, so its reach is `reader`, and one
  served to an account has none. Evidence retains tree/reach/generation and socket write kinds,
  never node content or an account. Socket writes are observed **after transmission**; this
  observer does not prevent them.
- `installReadOnlyGuard(context, { origins, sentryHosts })` installs context HTTP routing before
  navigation. Exact first-party origins identify `/v1/events` (202) and `/cdn-cgi/rum` (200). Sentry hosts,
  including optional exact local fixture hostnames, and Cloudflare telemetry receive 200 without
  transmission. All other HTTP mutations, including requests to external origins, are recorded
  and aborted before transmission. Blocking the initial external request prevents a 307/308
  redirect from carrying its body into a first-party origin without another route interception.
  GET, HEAD and OPTIONS continue, and so does a first-party `POST /v1/sync/pull`, the sync engine's
  read, which posts the scopes it asks for; analytics script GETs retain their bytes and integrity checks.
  Exact-origin classification remains in the evidence: `http-mutation` is first-party and
  `external-http-mutation` is external. The result exposes counts, a `clientErrors` count and
  mutation categories, without bodies or URLs. Keep pageerror/console listeners: the guard does
  not waive application failures. The capture command uses an authenticated local fixture and
  does not install this live-read guard.
  The smoke reports bounded failure categories, stages and counts rather than raw page errors,
  console messages, request URLs or roadmap text.
- `waitForConfirmed(read, predicate, { timeoutMs, intervalMs, label })` polls an authoritative
  caller-owned reader and returns the matched value. Defaults are 10 seconds and 50 ms. Labels
  are static lower-case operation names such as `saved-record`; errors never include the last
  value or a reader's raw exception. The overall deadline includes a pending read, but cannot
  cancel that I/O: callers also bound SQL commands and network requests.

The local fixture gate is `node --test --test-timeout=180000
web/test/scripts/roadmap-rig/browser-proof.test.mjs` from the repository root. It uses Chromium
and local fixture ports 5317/8317; reserve those ports for this test process.

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

Capture geometry still has legacy assumptions: the default caption mode is scaled, the reported
focus minimum is 0.6, disc measurements omit renderer size floors, and the session cookie is
scoped to localhost. Use `--caption-mode fixed` for current captions and a localhost fixture.
Treat derived disc sizes and focus descriptions as provisional; this work does not verify the
whole geometry apparatus. Their correction is tracked by
[align-capture-geometry in the dogfood tree](https://windmill.works/#/app/t_9362d9bc883e0a1e?step=align-capture-geometry).
