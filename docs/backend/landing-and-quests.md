# Backend contracts — Landing page, starter quests & tree creation

The marketing landing page (`ui_kits/marketing/index.html`) sells two actions the backend must
serve: **"Start your tree"** (create a roadmap) and the developer **Paths** (authored starter
quests). Everything else on the page is static or already contracted. These build on the
**multi-tree registry** the F2 decision put in the backend (per-user trees). Related contracts:
`docs/backend/X5-read-only-mobile.md` (fork, gallery, public `/t/:id`), `docs/backend/F6-color-legend.md`.

## 1. Quest catalog (F5 — the starter paths)

Authored learning trees with real prerequisite logic (ownership gates lifetimes, fundamentals
gate frameworks). The landing shows four; the shelf carries **nine**. Dev paths are adapted from
the roadmap.sh community maps (CC BY-SA) — the shelf carries the attribution.

**The catalog is client-shipped static content — `/v1/quests` will never be built.** The nine
quests live in the frontend bundle (`src/skilltree/quests/roster/`, one module per quest:
structure, legend kinds, descriptions, estimate, attribution), gated by the roster CI test.
The backend never learns what a quest is: planting one is an ordinary tree create carrying the
quest's full body, indistinguishable from a paste-import. Seasonal roster review is a frontend
deploy, not an operator data seed.

## 2. Create a tree

- **`POST /v1/trees`** — create a roadmap in the caller's registry. Body is the starting
  `TreeData`:
  ```
  { title?: "My roadmap",     // names it; omit everything for an empty tree with the default legend
    nodes?: [...], kinds?: [...],  // seed structure + legend (quest plants and paste-imports send these)
    id?: "t_…" }              // the anon-first claim seam: a client-minted id the server keeps
  → 200 { treeId, existed }
  ```
  Requires a session (X6 cookie). **Signed out is not an error:** per `auth.md`, "your first tree
  lives in your browser" — the client bears the tree **locally** when there's no session (or the
  server can't answer) and claims it on sign-in (the X6 adoption/union). Quest plants ride the same
  two roads: signed in, the full quest body goes up as one `POST /v1/trees`; signed out, it's borne
  locally and claimed later — no quest-specific wire shape anywhere.

## 3. The playable demo & the hosted share page

The landing's "Try the live demo" and the hero "Fork this tree" point at a public read-only tree.
Reuse the **`/t/:id`** public route (X5): a fixed demo tree id (e.g. `demo`) serves the "Learn to
sail" roadmap read-only. No new endpoint — just seed the demo tree and make its id stable.

## 4. Changelog (optional)

The nav links to a Changelog. Either a static page/markdown the frontend renders, or
**`GET /v1/changelog` → { entries: [{ date, title, body }] }`**. Low priority; a static route is fine.

## Notes

- Tree creation needs the **per-user tree registry** (create/list/delete), the same dependency
  the gallery and fork carry — build it once. The quest catalog needs nothing from the backend.
- The nine starter quests are authored content shipped as frontend modules — keep quest ids
  stable (they ride telemetry props and the roster gate test).
- Frontend status: the shelf lives at `#/app/start` (the empty-gallery landing); the marketing
  Paths section links to it, and every card plants through the two roads above.
