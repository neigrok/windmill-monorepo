# Roadmap readability rig — apparatus

Headless-Chrome captures of the roadmap canvas, driven over raw CDP, plus the seed that puts the dogfood tree
in a local backend. Everything here is repo-relative; the two secrets (the rig user's id and session cookie)
are passed in, never stored here.

```
web/scripts/roadmap-rig/
  capture.mjs        opens the app, waits for a painted and settled scene, captures + measures
  seed.mjs           POST /v1/trees + MCP set_progress from the repo fixture (or a raw get_tree reply)
  probe-captions.mjs attaches to a kept Chrome and lists visible captions after All steps and after Focus
  start-backend.sh   windmill_server on 8088 from backend/build, env from backend/.env + two overrides
  start-vite.sh      vite for any worktree on a chosen port
  stop-port.sh       kills only what LISTENS on the given ports, never by name
```

Offline numbers (no browser) come from `web/scripts/benchmark-roadmap.mjs`, which runs every engine in
`layout/index.js` over the same fixture and prints the pinned readability metrics.

## Pieces

| piece | where | port | how |
|---|---|---|---|
| Postgres | `/tmp:5432`, db `windmill` | 5432 | `pg_isready` |
| backend `windmill_server` | `backend/build/windmill_server` of this repo | **8088** | `start-backend.sh --user <uuid>` |
| vite | any worktree with `web/node_modules` | 5173–5178 | `start-vite.sh <worktree> <port>` |
| headless Chrome + CDP | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | 9222+ | spawned by `capture.mjs`, killed on exit |

Backend env: `backend/.env` is sourced by `start-backend.sh`; two variables are overridden in the script,
never on the binary's command line:

- `WINDMILL_MCP_USER` = the rig's browser user (`--user` or `WM_RIG_USER`), so MCP writes land as that user
- `WINDMILL_ALLOWED_ORIGINS` = `http://localhost:5173` … `5178` (comma-separated; `backend/platform/infra/main.cpp`
  splits on `,`), so one backend serves every vite port. `web/src/shell/apiBase.js` falls back to
  `http://localhost:8088` in dev; no `VITE_API_BASE_URL` is needed.

Logs go under `$WM_RIG_LOGS` (default `${TMPDIR:-/tmp}/windmill-rig`).

## Identity

The rig signs in as one user: a `users` row plus a `sessions` row whose `token_hash = sha256(secret)`, minted
per `.claude/skills/verify/SKILL.md` "Signing in without mail". Hand the secret to every script as
`--cookie <wm_session>` or `WM_RIG_COOKIE`, and the user id to the backend as `--user` / `WM_RIG_USER`. The
seeded tree keeps the dogfood tree's id, `t_9362d9bc883e0a1e`, so the URL is `/#/app/t_9362d9bc883e0a1e`.

## Fixture and seed

`web/test/products/roadmap/fixtures/dogfood-tree.json` is the dogfood tree as captured on 2026-09-09 —
476 steps, 618 links, 9 roots, 6 kinds, status 411 complete / 18 active / 47 none — slimmed to
`id, label, icon, color, prerequisites, order?, outOfOrder?, status`. `dogfoodTree.js` beside it builds the
`SkillTree`, the progress sets and the derived states for tests and the benchmark. No creation stamps
survive the capture, so siblings sort by id; the seeded copy shows the same order in a browser.

`node seed.mjs --backend http://localhost:8088 --cookie <wm_session> [--tree t_…] [--snapshot <raw get_tree json>]`
(idempotent) does, in order:

1. `POST /v1/trees` with the client-supplied id — the document seed (`TreeRegistryApi.cpp`). `status` is
   stripped from the body: there it would be the authored seed, not the caller's mark.
2. MCP `set_progress` in bulk (bearer `devtoken`; the backend must run with `WINDMILL_MCP_USER` = the
   cookie's user).
3. Reads the copy back over HTTP and asserts nodes / edges / complete / active / outOfOrder / kinds.

## Capture

```
cd web/scripts/roadmap-rig
node --experimental-websocket capture.mjs --origin http://localhost:5175 --tree t_9362d9bc883e0a1e \
     --cookie $WM_RIG_COOKIE --out <dir>/desktop --port 9222 --layout radial --focus --caption-mode fixed
node --experimental-websocket capture.mjs --origin http://localhost:5175 --tree t_9362d9bc883e0a1e \
     --cookie $WM_RIG_COOKIE --out <dir>/phone --phone --port 9223 --layout radial --focus --caption-mode fixed
```

Flags: `--width/--height/--dpr` (default 1440×900 dpr 1; `--phone` = 390×844 dpr 3, mobile + touch
emulation), `--select <nodeId>` (default `skilltree-scene`), `--reduced-motion`, `--port` (CDP debug port;
distinct ports run two captures at once), `--keep` (leave Chrome up), `--layout <name>` (opens
`/?layout=<name>#/app/<tree>` so that engine lays the tree out — `layout/index.js` names them), `--focus`
(the working capture is a real press of the Focus control, `.st-view-action` "Focus", else
`scene.focusWorking()`; the selected capture first brings `<select>` on screen; and an `allsteps` capture after
pressing All steps), `--focus-selector` /
`--focus-text` / `--focus-api` (the pieces `--focus` sets), `--select-focus`, `--caption-mode scaled|fixed`
(fixed: captions are CSS-px constants, so the caption-derived zoom is nulled).

What it does, in order: fresh `--user-data-dir` per run → `Network.setCookie wm_session` → device metrics
(+touch on phone) → navigate to the app route (a real document load) → write
`localStorage['windmill:view:last'] = {<tree>:'tree'}` (an owner on a phone otherwise opens the LIST view)
and clear `windmill:last-place` → reload → wait for load → poll every 200 ms until a `canvas.st-canvas`
exists, the scene (found through the canvas element's React fiber) has nodes, `director.busy()` is false, no
glide, no settle, and the camera has been byte-stable for 600 ms → captures.

Captures (CSS px, `Page.captureScreenshot` after a double rAF):

1. `overview.png/.json` — the first view. With no saved place the OWNER opens at the working zoom on the
   frontier step (`ui/viewport.js frontierTarget`); a visitor opens at the whole-tree fit.
2. `working.png/.json` — after Focus (`--focus`), else `scene.focusNode(<select>)`.
3. `selected.png/.json` — `scene.select(null)` then a REAL click / tap on `<select>` at that camera, so the
   app's own selection path runs; `how.result.sceneSelected` records whether it landed.
4. `allsteps.png/.json` — with `--focus`: after pressing All steps. Then two hit-floor probes at the fit, each
   after `select(null)` + `fitToView()`: a REAL tap on `<select>`'s dot and one 8 px beside it, recorded in
   `allSteps.taps.{onNode, besideNode}.outcome` as `selected` (the disc took the hit), `zoomed` (the crowd
   tap glided the working view in) or `missed`.

`measures.json` = `{build, settle, overview, working, selected, allSteps?, console}`. Per capture:
`viewport`, `canvas`, `errorText`, `camera{x,y,zoom}`, `captions{count, pooled, fontMin/Median/Max,
overlappingPairs, overlappingOtherBody, overlappingOwnBody, samples}` — a caption counts when its computed
style is displayed, visible and opaque (this build toggles `st-label--shown`; main toggles `display`),
`bodyDiameterPx{ordinary = 56×0.84×zoom,
crownedRoot = ×1.55, selected = ×1.14}` (the shader floors a drawn body at 6 px, 9 px for a crowned root —
the number here is the un-floored geometry), `nodes{total, onScreen, states}`, `nearestNeighbourPx{…}`,
`treeBounds{…}`, `selected{id,label,sx,sy,onScreen,captionVisible}`. `settle.json` is the poll log;
`console.json` every console entry and exception; `error.txt` only when the tree failed to load.

## Start / stop

```
WM_RIG_USER=<uuid> ./start-backend.sh                       # 8088; refuses if something already LISTENs there
./start-vite.sh "$(git rev-parse --show-toplevel)" 5175     # this worktree
./stop-port.sh 8088 5175                                    # kills only LISTENING pids on those ports
```

`stop-port.sh` uses `lsof -ti tcp:<port> -sTCP:LISTEN`. Plain `lsof -ti tcp:<port>` ALSO lists the Chrome
helper of any browser with a tab open to that port, so never `| xargs kill` without `-sTCP:LISTEN`. Never
`pkill -f windmill_server`.

## Caveats

- Rendering is headless Chrome on SwiftShader, not the GPU; geometry and DOM measurements are unaffected,
  pixels may differ slightly.
- SwiftShader also runs `requestAnimationFrame` at 20–30 Hz and stalls on the first frame after a model
  install, so no fps, frame-interval or settle TIMING from a capture means anything. Take timings from a
  run without `--use-angle=swiftshader --enable-unsafe-swiftshader`, where the same page holds 16.7 ms.
- With 476 > `ARRIVAL_REST_MAX` 400 the director plays the reduced (instant) arrival, so the wait never sees
  it busy; `--reduced-motion` is there for smaller trees.
- Captions overlapping a node body are tested against discs computed from the scene, not pixels.
- A `web/node_modules` that is a SYMLINK into another checkout makes vite serve fonts through `/@fs/…`
  outside `fs.allow` → 403 → fallback face. Use a real `npm ci` in the worktree.
