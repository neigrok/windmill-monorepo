# Backend contract — Tree registry: list the caller's roadmaps (F1·F2)

The multi-tree frontend needs to answer one question the moment a signed-in user opens the app:
**which roadmaps do I own?** That's this endpoint. It's the read half of the per-user tree
registry named as a shared dependency in `docs/backend/landing-and-quests.md` ("create/list/delete
— build it once"); the **create** half (`POST /v1/trees`) already lives there (§2). This doc adds
**`GET /v1/trees`**. Related: `docs/backend/F6-color-legend.md` (kinds/`dominantKind`),
`docs/backend/X5-read-only-mobile.md` (the `/t/:id` public route).

> **Principle: the list is glanceable, not a feed.** One row per owned tree — name, progress, when
> it last moved — ordered so the top row is the one to reopen. No pagination, no vanity counts.

---

## 1. Where the client uses it

Two callers, one shape (`src/skilltree/persistence/TreeRegistry.js` → `listTrees()`):

- **App entry resolver** (`src/skilltree/SkillTreeApp.jsx`): bare `#/app` opens `trees[0]` — so
  **order matters**: the newest/most-recently-touched tree must be first. Empty list → the birth
  canvas (`#/app/new`).
- **TreeSwitcher** (`src/skilltree/ui/TreeSwitcher.jsx`): the plaque menu's YOURS list — each row
  renders a progress ring + name + "`{done} of {total}` · `{updatedAt} ago`". The current tree is
  matched by `id` and checked.

The client **degrades gracefully**: any non-200, network error, or missing field falls back to
showing just the current tree + "New tree". So a partial or unavailable response never breaks the
app — but a correct one lights up the whole switcher.

## 2. The endpoint

**`GET /v1/trees`** — the roadmaps the caller owns. Credentialed (the `wm_session` cookie;
`credentials: 'include'`, credentialed CORS to the app origin, same as `/v1/me`).

```
200 {
  "trees": [
    { "id": "t_9f3a…",
      "title": "Kitchen garden",
      "total": 35,
      "done": 21,
      "updatedAt": 1783846003851,     // epoch ms — or ISO 8601; the client parses both
      "dominantKind": "olive" },
    …
  ]
}
```

Empty registry → `200 { "trees": [] }` (the client then shows the birth canvas).

### Row fields

| Field | Type | Required | What it drives (client) |
|---|---|---|---|
| `id` | string | **yes** | the tree id for `#/app/:id`; the resolver opens `trees[0].id`; dedupe/current-match key |
| `title` | string | **yes** (may be `""`) | the row name; empty renders as "Untitled roadmap" |
| `total` | integer | **yes** | step count — the ring denominator and the "N of M" readout |
| `done` | integer | **yes** | **this user's** completed steps — the ring numerator and readout |
| `updatedAt` | epoch ms (number) **or** ISO 8601 (string) | **yes** | the "2h ago" stamp **and** the sort key |
| `dominantKind` | enum: `terracotta`·`olive`·`gold`·`sky`·`brick`·`plum` | optional | the ring's hue; omitted → the client defaults to `terracotta` |

### Ordering

**Newest first — `updatedAt` descending.** The app-entry resolver opens `trees[0]`, so "most
recently touched" must lead. Ties may break by `id`; it only needs to be stable.

## 3. Semantics — the exact values

- **`total`** is the number of steps (nodes) in the tree — the same count the share card and the
  read-only "X of Y" readout use.
- **`done`** is scoped to the **authenticated caller's** progress overlay (F6/progress), not a
  global — the switcher shows *your* standing in *your* tree. A tree with no completions is `0`.
- **`updatedAt`** is the tree's **last meaningful forward change** — creation, a structural edit, or
  a progress mark (the design's row reads it as "last forward change", F1·F2 §4.2). It is both the
  displayed recency and the list order, so a tree you just planted or just advanced jumps to the top.
- **`dominantKind`** is the tree's dominant hue — the most-worn node color, or the root's kind when
  counts tie — the same value the share/gallery card computes (`ShareStats.dominantKind`). It exists
  only to tint the row's ring; the client tolerates its absence.
- **Which trees:** the ones the caller **owns** (their registry), including trees they forked or
  planted from a quest. Not example trees, not shared-with-me (there is no such concept in v1).

## 4. Auth, errors, scale

- **No session → `401`.** The client treats it as "no server trees" and falls back (a signed-out
  visitor lands on the birth canvas, which then opens the sign-in door on plant). Returning
  `200 { "trees": [] }` for an anonymous caller is equally acceptable — the client can't tell them
  apart — but `401` keeps this uniform with the rest of the API.
- **No other error states are meaningful to the client** — it degrades on anything non-200.
- **No pagination in v1.** Return all owned trees, newest-first. A user with a handful of roadmaps
  is the expected case; if a cap is ever needed, prefer a soft limit of the ~100 most-recent and add
  `?limit`/cursor later rather than paginating now.

## 5. Consistency with create

`POST /v1/trees` (create, `landing-and-quests.md §2`) must make the new tree appear in this list on
the next call, at the top (its `updatedAt` is "now"). The client relies on exactly that: after a
birth it navigates to the returned `treeId`, and the next time the switcher opens, that tree is
present and current-matched.

## 6. Adjacent — the sibling to build alongside

The switcher's design (F1·F2 §4.3) also has a **delete** row behind a confirm ("Delete '{title}'?
… This can't be undone"). That's **`DELETE /v1/trees/:id`** — the write sibling of this list, and
the third of the registry's "create/list/delete" trio. It's **not wired in the client yet** (the
create slice deferred it), so it's out of scope here — but it's the natural next contract, and
building it with the list keeps the registry whole.
