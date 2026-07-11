# Dogfooding: the app renders our deed DAG

We track what we've built as nodes in the `windmill-roadmap` tree, and this app renders
it — so the roadmap is our own running log of deeds. A **deed** is a node; its
**prerequisites** are the deeds it built on. This file is the frontend side: how the app
gets nodes, and how new deeds show up.

## Where nodes come from

`SkillTreeView` loads the roadmap through `HttpTreeRepository`
(`src/skilltree/persistence/HttpTreeRepository.js`), which fetches from the backend:

- `GET {baseUrl}/v1/trees/windmill-roadmap` → the tree
- `GET {baseUrl}/v1/trees/windmill-roadmap/progress` → this user's progress

`baseUrl` defaults to `http://localhost:8088` and the tree id to `windmill-roadmap`
(edit the constants in `HttpTreeRepository.js` to point elsewhere). The 5,000-node perf
tree (the "huge" dataset) is still generated client-side by `MockTreeRepository`.

## Add a deed

The tree is **server-owned**, so you add deeds on the backend and reload the app:

1. Append a node and `PUT` it to the server — see `windmill-backend/dogfood.md`.
2. Reload the app. The new deed appears in the roadmap, wired to its prerequisites.

Fields the frontend reads off each node:

- `label`, `icon` (lucide name), `color` — how the node looks; `color` also groups its
  branch/sector.
- `prerequisites` — the edges into this deed; they place it in the DAG.
- `position` (optional) — a manual nudge; otherwise the layout engine places it.
- `status: "complete" | "active"` — an authoring seed. On first load `HttpTreeRepository`
  turns these into progress (completed / in-progress), so finished deeds light up.

## Live over the socket (read-path)

On the dogfood roadmap the app now goes **live**: `CollabClient`
(`src/skilltree/persistence/CollabClient.js`) opens `ws://localhost:8088/v1/socket`,
subscribes, and applies authoritative op frames through the same `syncStructure` seam a
local edit uses. So a deed added on the server — or an edit from another client —
appears in the app without a reload. (An op that would leave the graph invalid, e.g. a
remote cycle, is swallowed and the view holds its last valid render; a proper
loose-graph render path is still future work.)

## In-app editing over the socket (write-path)

In-app edits now also send a `cmd` over the socket, so two tabs genuinely co-edit: a
create, rename, recolor, reposition, connect, reconnect, drop-edge, or tidy in one tab
merges on the backend and appears in the others. `CollabClient` tags each sent op and
skips its own echo, so an author never double-applies its own edit. Edits still commit
to `localStorage` too, as a per-browser fallback.

**Delete is not synced yet**: the app's delete splices children up to grandparents, but
the backend's `DeleteNode` is a plain tombstone — the two must be aligned before delete
can ride the socket. Until then a delete stays local.
