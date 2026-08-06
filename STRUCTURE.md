# Windmill monorepo — structure

Windmill is a brand of three self-growth products, one shared backend, one superapp per
surface. The directory tree is meant to read like a description of the system: group by
**surface** (toolchain) first, then by **product**.

```
backend/     one C++ modular-monolith binary
  platform/    shared, product-neutral: auth · oauth · billing · mcp engine · email ·
               users · telemetry · access · generic id/crdt primitives · http host
  products/    one module per product, each plugging its routes AND (optionally) its MCP
               tools into the host — roadmap and gym publish tools today
    roadmap/     the RPG skill-tree app (the original Windmill)
    journal/     the night-canvas daily journal (shipped)
    gym/         training log (phase 0 built — see its ARCHITECTURE.md)
  db/          schema.sql (platform tables + per-product tables)
  test/        mirrors src: test/platform, test/products/<p>

web/         one Vite/React superapp; product modules lazy-loaded behind a switcher
  index.html · package.json · vite.config.js · test/
  src/
    main.jsx        entry
    styles/  telemetry/   app-global, product-neutral (stay at src/ root)
    design-system/  product-neutral component library (core · forms · feedback · navigation)
    showcase/       the routed #/showcase gallery. Its own surface rather than part of the
                    design system, because it EXHIBITS products as well as primitives — and it
                    reaches each one only through `products/<p>/showcase.js`, the module that
                    product declares for it (test/shell-boundaries enforces exactly that)
    shell/          app frame: App.jsx (router + product switcher) · auth · billing · account ·
                    settings-shell · connect · feedback · marketing · apiBase · products.js
    products/       one front-end per product
      roadmap/  journal/  gym/

apps/        native superapps (one per OS; journal/roadmap/gym are mountable module libraries)
  ios/         Swift — a real SwiftUI app. project.yml (XcodeGen) declares the app target;
               App/ is the composition root; WindmillKit/ is the package (WindmillPlatform +
               Journal/Roadmap/Gym). Journal and gym are the built rooms — the night canvas,
               offline-first, claimed on sign-in; and the training log, which is here because the
               phone is the only device that can own an open session. Roadmap mounts and says where
               it does live. iOS-only: builds and tests through xcodebuild against a simulator,
               never `swift build`
  android/     Kotlin — structured scaffold (Gradle project is a later native wave)

packages/    cross-surface shared assets (consumed by more than one surface)
  api-contract/   one truth several languages must state separately — wire types, the
                  genesis-legend golden, the gym weight-ladder golden (web + iOS each test it)
  design-tokens/  a README and nothing else — no tokens, no consumers. The intended home for
                  the raw color/space/type scales, which today live in web/src/styles/tokens
                  and are mirrored by hand in iOS's WindmillPlatform/Tokens.swift

services/    sidecars the backend calls out to, deployed beside it in the same compose file
  embedder/       Node + transformers.js, running the same bge-small weights the browser
                  downloads, so a journal echo's vectors share the browser's space. Journal's
                  nightly echo pass is dark without it (backend/products/journal/ports/Embedder.h)

tools/       one-shot scripts kept for the record, never a product surface
  lift-import/          the author's Lift training history into the gym log, over the public API
  resend-webhook-probe/ sends one genuinely-signed bounce for a .invalid address to prove the
                        Resend delivery webhook is armed in prod (dark and forgeable both 401)

docs/        brand-level narrative: PRODUCT_LOG (strategy) · DESIGN_BRIEFS (the design-facing
             half of the plan; the canon itself lives in the claude.ai Design project) · LAUNCH
             · per-topic design/exploration notes
.github/     root workflows: backend.yml (context backend/ — test, build, push the image) ·
             web.yml (workdir web/ — test, build, rsync dist/ to the VPS) · ios.yml (workdir
             apps/ios — build + test only, ships nothing) · deploy.yml (manual: renders
             ~/windmill/.env on the VPS from GitHub secrets + variables, then compose up) ·
             embedder.yml (path-filtered: the sidecar and the on-device worker it must agree
             with) · tools.yml (path-filtered: tools/). The last two ship nothing either.
             A backend push publishes an image; it does not deploy. On a fresh host the WEB
             deploy must land before the backend one — the embedder bind-mounts its model
             weights out of the served web directory (services/embedder/README.md).
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

- **Backend:** each product exposes `<product>::registerRoutes(app, deps)` over a `…Deps`
  struct it declares in its own `routes.h`. `backend/platform/infra` composes the shared host
  and calls each. MCP tools are the second seam: a product implements
  `platform/ports/ToolHost.h`, classifying each tool by product and access level, and
  `main.cpp` registers it as a `ToolModule` on the `CompositeToolHost` that `McpServer` binds.
  That composite is the permission gate — a client's grant selects which products' tools it can
  see and call. Roadmap is the only module registered today.
- **Web:** each product exports a route table; `web/shell` composes them and renders the
  product switcher. The shell knows an "active product home" — it hard-codes no product.

## Known follow-ups from the split

The restructure was a behavior-identical relocation; these are the honest edges where a pure
platform boundary wasn't reached.

The three **backend** edges are now **closed** (the `platform-purity` bet) — the platform library no
longer depends on any product, so a journal/gym-only backend needs nothing from roadmap:

- `AuthApi` moved to `platform/adapters/http`; the one product-shaped act (planting a tree on a fork
  sign-in) sits behind a platform `SignupFork` port that roadmap's `ForkSignup` injects. ✓
- The MCP resource catalog is injected into `McpServer` (`std::vector<McpResource>`); the quickstart
  content lives in `products/roadmap/adapters/mcp/RoadmapResources`. ✓
- `platform/ports/EmailSender.h` is magic-link/fork only; the roadmap reminder and journal nudge
  mails are product-owned ports (`ReminderMailSender`, `NudgeMailSender`) over a neutral `ResendClient`
  transport. ✓ Mail comes BACK the same way: one Resend account means one webhook
  (`platform/adapters/email/ResendWebhookApi`) carrying feedback about every mail the brand sends, so
  the signature check, the parse and the pure verdict (`platform/domain/Mail.h`) are platform's, and
  each product registers a `MailStream` saying what a dead mailbox stops (`platform/ports/MailSuppression.h`).
  One bounce writes them all; gym registers none. ✓

Still open (**web** + infra):

- ~~**`web`: settings is a spliced page**~~ **closed** — products now register their settings sections
  on the route table (`settingsSections: { main, data }`); `shell/settings/SettingsPage.jsx` composes
  them off the product registry and imports no product section. (`YourDataSection` still lives in
  roadmap — its export is tree-shaped; moving it to shell with a product-contributed exporter is a
  follow-up. It also fuses in **account closure**, which is brand-wide: deleting your Windmill
  account is presently reachable only through a roadmap-owned section. And `PLAN_COPY` — the tier
  vocabulary for the one brand-wide subscription — is still roadmap's. The gate left; the words
  stayed.)
- ~~**`web`: `shell/marketing/Marketing.jsx`** reads roadmap trees and its copy is roadmap-only~~
  **closed** — the file is gone (`934a241`). The brand root is `BrandLanding.jsx`, which builds its
  three doors by mapping the registry, and each product's landing lives in its own folder.
  The softer half — the shell-side knowledge the import graph could not see — is **closed too**
  (2026-08-05): `landingHeads.js` no longer holds paths into product source trees, because each
  product owns its own landing head beside the landing it describes and names its own module from
  there; the brand root's hero derives from the registry rather than being hand-copied in three
  places; and `App.jsx`'s `LEGACY_DOORS` derives its product rows from `switchHash` + `shell.room`,
  filtered to open products — which turned the conspicuous absence of `#/gym` into a stated rule.
  The boundary test now walks **everything that is not a product**, stylesheets included, rather
  than only `src/shell/`.

  Still open, and a decision rather than an edit: `AccountSeat`'s `treeCount` / "My trees" row
  needs a noun the active product supplies (a registry field with one contributor today).
  `OAuthConsent` no longer hardcodes its scope words — it renders the requested grant, grouped by
  product, from `web/src/shell/auth/scopes.js`.
- **`backend/infra`** (the composition-root executables) sit under `platform/infra`; they depend on
  roadmap by nature (they compose it). Fine today; revisit if a neutral app-assembly layer is wanted.

## Per-surface docs

Each surface keeps its own `CLAUDE.md`/`NOTES.md`/`SPEC.md` for the detail that only matters
inside it. This file is the map between them.
