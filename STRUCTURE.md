# Windmill monorepo — structure

Windmill is a brand of three self-growth products, one shared backend, one superapp per
surface. The directory tree is meant to read like a description of the system: group by
**surface** (toolchain) first, then by **product**.

```
backend/     one C++ modular-monolith binary
  platform/    shared, product-neutral: auth · oauth · billing · mcp engine · email ·
               users · telemetry · access · generic id/crdt primitives · http host
  products/    one module per product, each plugging routes + mcp tools into the host
    roadmap/     the RPG skill-tree app (the original Windmill)
    notes/       daily notes            (scaffold)
    gym/         training log           (scaffold)
  db/          schema.sql (platform tables + per-product tables)
  test/        mirrors src: test/platform, test/products/<p>

web/         one Vite/React superapp; product modules lazy-loaded behind a switcher
  design-system/  product-neutral component library (core · forms · feedback · navigation)
  shell/          app frame: auth · billing · account · settings-shell · connect ·
                  feedback · marketing frame · apiBase · telemetry · router + switcher
  products/       one front-end per product
    roadmap/  notes/  gym/

apps/        native superapps (one per OS; roadmap/notes/gym are module groups inside)
  ios/         Swift
  android/     Kotlin

packages/    cross-surface shared assets (consumed by more than one surface)
  api-contract/   wire types + the genesis-legend golden (single source of truth)
  design-tokens/  raw color/space/type scales web CSS and native both mirror

docs/        brand-level narrative + design canon
.github/     root workflows: backend.yml (context backend/) · web.yml (workdir web/)
.attic/      pre-restructure repos, kept as a local recovery net (gitignored)
```

## The one rule that keeps this honest

**Platform is product-neutral; products depend on platform, never the reverse; products
never depend on each other.** A file earns a place in `platform/` (or `design-system/`,
`shell/`) only if it is provably free of product vocabulary. When a "generic-looking"
mechanism is actually shaped by one product (the roadmap sync/CRDT/room cluster is
node-shaped end to end), it stays in that product. Reusable *patterns* are documented, not
prematurely abstracted — the second consumer earns the abstraction.

## How a product plugs in

- **Backend:** each product exposes `<product>::registerRoutes(app, deps)` and
  `<product>::makeTools()`. `backend/platform/infra` composes the shared host and calls each.
- **Web:** each product exports a route table; `web/shell` composes them and renders the
  product switcher. The shell knows an "active product home" — it hard-codes no product.

## Per-surface docs

Each surface keeps its own `CLAUDE.md`/`NOTES.md`/`SPEC.md` for the detail that only matters
inside it. This file is the map between them.
