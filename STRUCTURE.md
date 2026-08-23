# Windmill monorepo — structure

Three products, one shared backend, one superapp per surface. The tree groups by **surface**
(toolchain) first, then by **product**.

```
backend/     one C++ modular-monolith binary
  platform/    shared, product-neutral: auth · oauth · billing · mcp engine · email · users ·
               telemetry · ai spend metering · access · id/crdt primitives · http host · infra
               (the composition-root executables)
  products/    one module per product, each plugging its routes and optionally its MCP tools
               into the host
    roadmap/     the RPG skill tree
    journal/     the night-canvas daily journal
    gym/         the training log
  db/          schema.sql (platform tables + per-product tables) · funnel.sql
  test/        mirrors the source: test/platform, test/products/<p>, test/e2e, test/golden

web/         one Vite/React superapp; product modules lazy-loaded behind a switcher
  index.html · package.json · vite.config.js · test/
  src/
    main.jsx        entry
    styles/  telemetry/   app-global, product-neutral
    design-system/  product-neutral component library (core · forms · feedback · navigation)
    showcase/       the routed #/showcase gallery. Separate from the design system because it
                    exhibits products as well as primitives, and reaches each product only
                    through `products/<p>/showcase.js` (test/shell-boundaries enforces that)
    shell/          app frame: App.jsx (router + product switcher) · auth · billing · account ·
                    settings · chrome · connect · feedback · marketing · pwa · apiBase ·
                    products.js
    products/       roadmap/  journal/  gym/

apps/        native superapps, one per OS
  ios/         SwiftUI. project.yml (XcodeGen) declares the app target; App/ is the composition
               root; WindmillKit/ holds WindmillPlatform + WindmillJournal + WindmillGym +
               WindmillRoadmap. Journal and gym are the built rooms; roadmap mounts a pointer to
               where it lives. iOS-only: build and test through xcodebuild against a simulator,
               never `swift build`
  android/     Kotlin/Compose. Gradle modules :app :platform :gym under the same one-directional
               rule. Gym is the built room. JVM unit tests including the ladder golden; builds via
               the committed wrapper (./gradlew build, JDK 17+)

packages/    cross-surface shared assets
  api-contract/   wire types, the genesis-legend golden, the gym weight-ladder golden (web + iOS +
                  Android each test against it)
  design-tokens/  a README and nothing else. The color/space/type scales live in
                  web/src/styles/tokens and are mirrored by hand in
                  apps/ios/WindmillKit/Sources/WindmillPlatform/Tokens.swift and
                  apps/android/platform/…/design/Tokens.kt

services/    sidecars the backend calls out to, deployed beside it in the same compose file
  embedder/       Node + transformers.js turning journal passages into 384-dimension vectors for
                  echoes. It loads paraphrase-multilingual-MiniLM-L12-v2; the browser's own journal
                  search loads bge-small-en-v1.5, and no vector crosses between them. Journal's echo
                  pass is dark without it (backend/products/journal/ports/Embedder.h)

tools/       one-shot scripts, never a product surface
  lift-import/          imports the author's Lift training history into the gym log over the API
  resend-webhook-probe/ sends one signed bounce for a .invalid address to prove the Resend
                        delivery webhook is armed in prod

docs/        brand-level narrative: PRODUCT_LOG (strategy) · DESIGN_BRIEFS · design/ (the written
             canon — guidelines, briefs, the consistency ledger; the drawings live in five Figma
             files) · LAUNCH · per-topic design and exploration notes
.github/     backend.yml (context backend/ — test, build, push the image) · web.yml (workdir web/ —
             test, build, rsync dist/ to the VPS) · ios.yml (build + test only) · android.yml
             (build + test on push/PR; on an android-v* tag it ships a release APK to a GitHub
             Release) · deploy.yml (manual: renders ~/windmill/.env on the VPS from GitHub secrets
             and variables, then compose up) · embedder.yml · tools.yml
.attic/      pre-restructure repos, kept as a local recovery net (gitignored)
```

A backend push publishes an image; it does not deploy. On a fresh host the web deploy must land
before the backend one — the embedder bind-mounts its model weights out of the served web directory
(`services/embedder/README.md`).

## The one rule

**Platform is product-neutral; products depend on platform, never the reverse; products never
depend on each other.** A file earns a place in `platform/` (or `design-system/`, `shell/`) only if
it is free of product vocabulary. A generic-looking mechanism that is actually shaped by one
product stays in that product — the roadmap sync/CRDT/room cluster is node-shaped end to end.
Reusable *patterns* are documented, not prematurely abstracted; the second consumer earns the
abstraction.

## How a product plugs in

- **Backend:** each product exposes `<product>::registerRoutes(app, deps)` over a `…Deps` struct it
  declares in its own `routes.h`; `backend/platform/infra` composes the shared host and calls each.
  MCP tools are the second seam: a product implements `platform/ports/ToolHost.h`, classifying each
  tool by product and access level, and `main.cpp` registers it as a `ToolModule` on the
  `CompositeToolHost` that `McpServer` binds. That composite is the permission gate — a client's
  grant selects which products' tools it can see and call. Roadmap and gym publish tools.
- **Web:** each product exports a route table; `shell` composes them and renders the product
  switcher. The shell hard-codes no product: a neutral surface asks `shell/products.js` for the
  active product, defaulting to the first. Products register their settings sections on the route
  table (`settingsSections: { main, data }`); `shell/settings/SettingsPage.jsx` composes them off
  the product registry and imports no product section. The brand root is
  `shell/marketing/BrandLanding.jsx`, which builds its doors by mapping the registry; each
  product's landing lives in its own folder.

## Open boundary edges

- `PLAN_COPY`, the tier vocabulary for the one brand-wide subscription, is roadmap's
  (`web/src/products/roadmap/settings/PlanSection.jsx`).
- `backend/platform/infra` (the composition-root executables) depend on roadmap by nature — they
  compose it.

## Per-surface docs

Each surface keeps its own `CLAUDE.md`/`NOTES.md`/`SPEC.md` for the detail that only matters inside
it. This file is the map between them.
