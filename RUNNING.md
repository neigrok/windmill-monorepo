# Running windmill-backend (Phase 0)

Phase 0 is a single-user, no-auth REST service over Postgres: load/save a tree document,
read its progress and diagnostics. Rooms, the op log, and WebSockets arrive in Phase 2.

## 1. Install dependencies

`postgresql@14` and `openssl@3` are already installed. Add the two adapters need:

```sh
brew install drogon libpqxx
```

## 2. Database

```sh
brew services start postgresql@14        # or: pg_ctl -D /opt/homebrew/var/postgresql@14 start
createdb windmill
psql windmill -f db/schema.sql
```

## 3. Build

```sh
cmake -S . -B build
cmake --build build --target windmill_server
```

CMake prints `windmill_server enabled` once Drogon + libpqxx are found. Without them it
builds only the core library + tests and skips the server (see the status line).

## 4. Run

```sh
DATABASE_URL="postgresql://localhost/windmill" ./build/windmill_server      # listens on :8080
```

If `:8080` is taken (Docker Desktop grabs it by default), set `PORT`:

```sh
DATABASE_URL="postgresql://localhost/windmill" PORT=8088 ./build/windmill_server
```

## 5. Exercise it

```sh
# seed a tree (whole-document write)
curl -X PUT localhost:8080/v1/trees/demo -H 'content-type: application/json' -d '{
  "title": "Demo",
  "nodes": [
    { "id": "product", "label": "Windmill", "icon": "sprout", "color": "gold", "prerequisites": [] },
    { "id": "renderer", "label": "WebGL2 renderer", "icon": "zap", "color": "sky", "prerequisites": ["product"] }
  ]
}'

curl localhost:8080/v1/trees/demo                 # -> { "seq": 0, "data": { ... } }
curl localhost:8080/v1/trees/demo/diagnostics     # -> { "cycles": [], "dangling": [], ... }
curl localhost:8080/v1/trees/demo/progress        # -> { "completed": [], "inProgress": [] }
```

## 6. Point the frontend at it

Swap `MockTreeRepository` → an `HttpTreeRepository` whose `loadTree()` GETs
`/v1/trees/<id>` and returns `data`. That is the Phase 0 exit criterion: the dogfood
roadmap loads and saves from the server.

## Endpoints (Phase 0)

| Method | Path | Body / result |
| --- | --- | --- |
| POST | `/v1/trees` | `{ title?, nodes?, kinds? }` → `200 { treeId }` (plant a new owned roadmap; body is the starting `TreeData` — send `nodes`/`kinds` to seed an initial tree, or none for a blank tree with the default legend; 401 signed out; quest plants are ordinary full-body creates — the F5 catalog ships with the client) |
| GET | `/v1/trees` | → `{ trees[] }` (the caller's owned roadmaps, newest-first: `{ id, title, total, done, updatedAt, dominantKind? }`; 401 if signed out) |
| DELETE | `/v1/trees/:id` | → `204` (owner-only soft-delete; 403 someone else's, 404 unknown, 401 signed out) |
| GET | `/v1/trees/:id` | → `{ seq, data }` (`data.kinds` = the legend, F6) |
| PUT | `/v1/trees/:id` | `TreeData` → `{ seq, data }` (whole-document write; seeds the default legend on a new tree) |
| POST | `/v1/trees/:id/fork` | `{ id, title? }` → `{ seq, data }` (copies the document — nodes, edges, kinds — verbatim) |
| GET | `/v1/trees/:id/progress` | → `{ completed[], inProgress[] }` (fixed `dev` user) |
| GET | `/v1/trees/:id/diagnostics` | → `{ cycles[], dangling[], selfEdges[], smells[] }` |
| GET | `/v1/trees/:id/activity` | `?since=&limit=` → `{ events[] }` (human feed from `tree_ops`) |
