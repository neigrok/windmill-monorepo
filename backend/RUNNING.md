# Running the Windmill backend locally

One binary — `windmill_server` — serves every product: the REST API, the collab WebSocket
and MCP, all from one process against one Postgres. Every write is behind a session, so a
signed-out caller can read a public tree and nothing else. `CLAUDE.md` in this directory is
the map of the tree; `deploy/README.md` is the production runbook.

## 1. Install dependencies

Four: `postgresql@14`, `openssl@3`, and the two vendor libraries the adapters need.

```sh
brew install postgresql@14 openssl@3 drogon libpqxx
```

## 2. Database

```sh
brew services start postgresql@14        # or: pg_ctl -D /opt/homebrew/var/postgresql@14 start
createdb windmill
psql windmill -f db/schema.sql
```

`db/schema.sql` is one file for every product and idempotent — re-run it after pulling.

## 3. Build

```sh
cmake -S . -B build
cmake --build build --target windmill_server
```

CMake prints `windmill_server enabled` once Drogon + libpqxx are found. Without them it
builds only the core libraries + tests and skips the server (see the status line).

## 4. Run

```sh
DATABASE_URL="postgresql://localhost/windmill" PORT=8088 ./build/windmill_server
```

`:8088` because that is what `web/src/shell/apiBase.js` falls back to outside a production
build, so the web app finds it with no configuration. The default is `:8080`, which Docker
Desktop usually holds.

Everything else is optional and each feature stays dark without its key — copy
`.env.example` to `.env` and `set -a; source .env; set +a` before the binary if you want
any of them.

## 5. Exercise it

You need a session first, because every write and every private read is behind one. Signing
in through the web app needs a working `RESEND_API_KEY`: without it `POST /v1/auth/magic-link`
answers `502` and nothing is logged — no mail, no link. So on a bare machine, mint the
session by hand. `sessions.token_hash` is the hex SHA-256 of the cookie value:

```sh
psql windmill -c "insert into users (id, email, name) values (gen_random_uuid(), 'you@example.com', 'You') on conflict (email) do nothing"
HASH=$(printf %s localdev | shasum -a 256 | cut -d' ' -f1)
psql windmill -c "insert into sessions (token_hash, user_id, expires_ms) select '$HASH', id, 99999999999999 from users where email='you@example.com'"
```

Then every call carries `-b wm_session=localdev`:

```sh
# plant a tree — the server mints the id
curl -b wm_session=localdev -X POST localhost:8088/v1/trees \
  -H 'content-type: application/json' -d '{
  "title": "Demo",
  "nodes": [
    { "id": "product", "label": "Windmill", "icon": "sprout", "color": "gold", "prerequisites": [] },
    { "id": "renderer", "label": "WebGL2 renderer", "icon": "zap", "color": "sky", "prerequisites": ["product"] }
  ]
}'                                                        # -> { "treeId": "t_…", "existed": false }

TREE=t_…                                                  # the id it just answered with
curl -b wm_session=localdev localhost:8088/v1/me                          # -> { "user": { … } }
curl -b wm_session=localdev localhost:8088/v1/trees                       # -> { "trees": [ … ] }
curl -b wm_session=localdev localhost:8088/v1/trees/$TREE                 # -> { "seq", "data", "state", … }
curl -b wm_session=localdev localhost:8088/v1/trees/$TREE/diagnostics     # -> { "cycles": [], "dangling": [], … }
curl -b wm_session=localdev localhost:8088/v1/trees/$TREE/progress        # -> { "completed": [], "inProgress": [], "cleared": [] }
```

A new tree is `private`, so the same reads without the cookie answer `404 no such tree` —
that refusal is byte-identical to a tree that does not exist, deliberately.

## 6. Point the frontend at it

Nothing to swap: `HttpTreeRepository`
(`web/src/products/roadmap/persistence/HttpTreeRepository.js`) is the only repository the
web app has, and it takes its base URL from `web/src/shell/apiBase.js` — which resolves to
`http://localhost:8088` outside a production build. So run the server on `:8088`, then
`cd ../web && npm run dev`, and the app is talking to it. (`VITE_API_BASE_URL` overrides,
for a preview build pointed somewhere else.)

## Roadmap tree endpoints

The roadmap tree surface only — the server also serves auth, oauth, billing, MCP keys,
reminders, the share/gallery pages, and all of journal's and gym's routes. Those live in
each product's `routes.cpp`.

| Method | Path | Body / result |
| --- | --- | --- |
| POST | `/v1/trees` | `{ title?, nodes?, kinds?, id? }` → `200 { treeId, existed }` (plant a new owned roadmap; body is the starting `TreeData` — send `nodes`/`kinds` to seed an initial tree, or none for a blank tree with the default legend; a supplied `id` must be `t_` + 16 lowercase hex; 401 signed out; quest plants are ordinary full-body creates — the F5 catalog ships with the client) |
| GET | `/v1/trees` | → `{ trees[] }` (the caller's owned roadmaps, newest-first: `{ id, title, total, done, createdAt, updatedAt, dominantKind? }` — `createdAt` is when the tree was planted, `updatedAt` when it last moved, both epoch ms; 401 if signed out) |
| DELETE | `/v1/trees/:id` | → `204` (owner-only soft-delete; 403 someone else's, 404 unknown, 401 signed out) |
| GET | `/v1/trees/:id` | → `{ seq, data, state, createdAt, visibility, mine }` (`data.kinds` = the legend, F6; `state` is the full CRDT state; `createdAt` is the planting time in epoch ms — the week-N card counts from it, never the calendar week) |
| PUT | `/v1/trees/:id` | `TreeData` → `{ seq, data }` (whole-document write; seeds the default legend on a new tree; owner-only once the tree has an owner) |
| POST | `/v1/trees/:id/fork` | `{ id?, title? }` → `{ seq, data }` (copies the document — nodes, edges, kinds — verbatim, progress cleared) |
| GET | `/v1/trees/:id/progress` | → `{ completed[], inProgress[], cleared[] }` (the **owner's** progress, not the caller's — a visitor to a shared tree sees what the owner has done) |
| GET | `/v1/trees/:id/diagnostics` | → `{ cycles[], dangling[], selfEdges[], smells[], maskedWork[] }` |
| GET | `/v1/trees/:id/activity` | `?since=&limit=` → `{ events[] }` (human feed from `tree_ops`) |

Every row above is gated by `canRead`/`canWrite` (`platform/domain/Access.h`): a private
tree is owner-only and answers `404` to everyone else; unlisted and public read alike.
