# Backend contracts — Landing page, starter quests & tree creation

The marketing landing page (`ui_kits/marketing/index.html`) sells two actions the backend must
serve: **"Start your tree"** (create a roadmap) and the developer **Paths** (authored starter
quests). Everything else on the page is static or already contracted. These build on the
**multi-tree registry** the F2 decision put in the backend (per-user trees). Related contracts:
`docs/backend/X5-read-only-mobile.md` (fork, gallery, public `/t/:id`), `docs/backend/F6-color-legend.md`.

## 1. Quest catalog (F5 — the starter paths)

Authored learning trees with real prerequisite logic (ownership gates lifetimes, fundamentals
gate frameworks). The landing shows four; the copy promises **nine**. Dev paths are adapted from
the roadmap.sh community maps (CC BY-SA) — carry the attribution in the payload.

- **`GET /v1/quests`** — public, no auth. List the catalog for the Paths grid + a quest picker:
  ```
  { quests: [ {
      id: "frontend",
      title: "Frontend path",
      readout: "24 steps · ~4 months",   // human string; or { stepCount, etaWeeks } and the client formats
      kinds: ["terracotta","sky","gold"], // the legend hues, for the card's rule + dots
      stepCount: 24,
      tags: ["dev"],
      source: "roadmap.sh (CC BY-SA)"     // attribution, nullable
    }, … ] }
  ```
- **`GET /v1/quests/:id`** — the full template to preview/plant: the tree structure (nodes with
  labels, kinds, descriptions, prerequisites) + the F6 legend. Same shape a tree load returns, minus
  progress. Public.

## 2. Create a tree

- **`POST /v1/trees`** — create a roadmap in the caller's registry. Body:
  ```
  { fromQuest?: "frontend",   // clone a quest template (structure + legend + descriptions), progress reset
    title?: "My roadmap",     // for a blank tree
    blank?: true }            // an empty tree with the default legend (Build/Learn/Milestone, F6)
  → 200 { treeId }
  ```
  Requires a session (X6 cookie). **Signed out is not an error:** per `auth.md`, "your first tree
  lives in your browser" — the client creates the tree **locally** when there's no session and
  claims it on sign-in (the X6 adoption/union). So this endpoint is the signed-in path; the
  signed-out path is client-only (no call). The magic-link/fork flows already encode "the fork
  waits server-side behind the link" — creation from a quest while signed-out follows the same
  claim-on-sign-in rule.

## 3. The playable demo & the hosted share page

The landing's "Try the live demo" and the hero "Fork this tree" point at a public read-only tree.
Reuse the **`/t/:id`** public route (X5): a fixed demo tree id (e.g. `demo`) serves the "Learn to
sail" roadmap read-only. No new endpoint — just seed the demo tree and make its id stable.

## 4. Changelog (optional)

The nav links to a Changelog. Either a static page/markdown the frontend renders, or
**`GET /v1/changelog` → { entries: [{ date, title, body }] }`**. Low priority; a static route is fine.

## Notes

- Quest catalog + tree creation both need the **per-user tree registry** (create/list/delete),
  the same dependency the gallery and fork carry — build it once.
- The nine starter quests are authored content; treat the catalog as data the operator seeds, not
  code. Keep quest ids stable (they appear in URLs and the client's local "claim" bookkeeping).
- Frontend status: the landing ships now with its CTAs pointed at the existing app (`#/` and the
  read-only `#/t/demo`) and the X6 sign-in door; wiring "Start your tree" to real quest-planting
  lands when `/v1/quests` + `POST /v1/trees` exist (a small frontend follow-up).
