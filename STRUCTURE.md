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
  index.html · package.json · vite.config.js · test/
  src/
    main.jsx        entry
    styles/  telemetry/   app-global, product-neutral (stay at src/ root)
    design-system/  product-neutral component library (core · forms · feedback · navigation)
    shell/          app frame: App.jsx (router + product switcher) · auth · billing · account ·
                    settings-shell · connect · feedback · marketing · apiBase · products.js
    products/       one front-end per product
      roadmap/  notes/  gym/

apps/        native superapps (one per OS; roadmap/notes/gym are mountable module libraries)
  ios/         Swift — compilable SwiftPM scaffold (WindmillPlatform + Roadmap/Notes/Gym + app)
  android/     Kotlin — structured scaffold (Gradle project is a later native wave)

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

## Known follow-ups from the split

The restructure was a behavior-identical relocation; these are the honest edges where a pure
platform boundary wasn't reached.

The three **backend** edges are now **closed** (the `platform-purity` bet) — the platform library no
longer depends on any product, so a notes/gym-only backend needs nothing from roadmap:

- `AuthApi` moved to `platform/adapters/http`; the one product-shaped act (planting a tree on a fork
  sign-in) sits behind a platform `SignupFork` port that roadmap's `ForkSignup` injects. ✓
- The MCP resource catalog is injected into `McpServer` (`std::vector<McpResource>`); the quickstart
  content lives in `products/roadmap/adapters/mcp/RoadmapResources`. ✓
- `platform/ports/EmailSender.h` is magic-link/fork only; the roadmap reminder and journal nudge
  mails are product-owned ports (`ReminderMailSender`, `NudgeMailSender`) over a neutral `ResendClient`
  transport. ✓

Still open (**web** + infra):

- **`web`: settings is a spliced page** — `shell/settings/SettingsPage.jsx` imports 4 roadmap
  sections directly to preserve render order. Invert so products register settings sections.
- **`web`: `shell/marketing/Marketing.jsx`** still reads roadmap trees and its copy is roadmap-only
  — it's the brand landing to be revised for three products.
- **`backend/infra`** (the composition-root executables) sit under `platform/infra`; they depend on
  roadmap by nature (they compose it). Fine today; revisit if a neutral app-assembly layer is wanted.

## Per-surface docs

Each surface keeps its own `CLAUDE.md`/`NOTES.md`/`SPEC.md` for the detail that only matters
inside it. This file is the map between them.
