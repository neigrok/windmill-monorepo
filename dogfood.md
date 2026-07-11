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

## In-app editing vs. persisting a deed

The editor's create/connect/rename gestures currently commit to `localStorage` via
`TreeStore` — a per-browser overlay, **not** the server. So treat in-app edits as a local
preview: they survive reloads on your machine but aren't part of the shared deed log.

To make a deed part of the shared DAG, persist it on the server (the backend `dogfood.md`
recipe). Wiring the editor to write straight to the backend (HTTP `PUT`, or a
`cmd` over the socket) is the next step — until then, authoring happens server-side and
the app is the read/first-paint view.
