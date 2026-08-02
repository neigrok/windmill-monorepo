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
    journal/     the night-canvas daily journal (shipped; products/notes is its empty pre-rename scaffold)
    gym/         training log (phase 0 built — see its ARCHITECTURE.md)
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
      roadmap/  journal/  gym/  (notes/ is journal's empty pre-rename scaffold)

apps/        native superapps (one per OS; roadmap/notes/gym are mountable module libraries)
  ios/         Swift — SwiftPM package (WindmillPlatform + Roadmap/Notes/Gym + app); the gym
               ladder is the first real product logic, tested against packages/api-contract
  android/     Kotlin — structured scaffold (Gradle project is a later native wave)

packages/    cross-surface shared assets (consumed by more than one surface)
  api-contract/   one truth several languages must state separately — wire types, the
                  genesis-legend golden, the gym weight-ladder golden (web + iOS each test it)
  design-tokens/  raw color/space/type scales web CSS and native both mirror

tools/       one-shot scripts kept for the record, never a product surface
  lift-import/    the author's Lift training history into the gym log, over the public API

docs/        brand-level narrative + design canon
.github/     root workflows: backend.yml (context backend/) · web.yml (workdir web/) ·
             ios.yml (workdir apps/ios — build + test only, ships nothing)
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
  three doors by mapping the registry, and each product's landing lives in its own folder. What
  survives is softer and the import graph cannot see it: `shell/marketing/landingHeads.js` holds
  hard-coded **paths into product source trees** (`src/products/*/marketing/*.jsx`) and a
  roadmap-flavoured `/` fallback whose CTA is hard-coded where `BrandLanding` derives it — the same
  fact stated twice, on both sides of the boundary, free to disagree the day gym opens. Same species:
  `App.jsx`'s `LEGACY_DOORS` (which already omits `#/gym`), `AccountSeat`'s `treeCount` / "My trees",
  and `OAuthConsent`'s roadmap-only scope words on a platform surface.
- **`backend/infra`** (the composition-root executables) sit under `platform/infra`; they depend on
  roadmap by nature (they compose it). Fine today; revisit if a neutral app-assembly layer is wanted.

## Per-surface docs

Each surface keeps its own `CLAUDE.md`/`NOTES.md`/`SPEC.md` for the detail that only matters
inside it. This file is the map between them.
