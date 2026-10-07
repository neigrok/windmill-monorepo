# Repository structure

Windmill has three products—roadmap, journal and gym—with one backend and one account. The
repository groups code by surface, then product.

```text
backend/                    C++20 modular monolith
  platform/                 product-neutral auth, OAuth, billing, MCP, email, telemetry, AI usage and
                            the sync engine server
    infra/                  composition roots for the server and standalone MCP transports
  products/
    roadmap/                tree domain, synchronization and roadmap adapters
    journal/                pages, nudges, voice and echoes
    gym/                    training log, routines, Coach and gym adapters
    probe/                  the sync engine's test-only product; linked into tests and
                            windmill_server_probe, never into windmill_server
  db/                       idempotent schema, the probe's test schema and analyst funnel views
  deploy/                   Docker Compose, Caddy and production configuration
  test/                     platform/, products/, e2e/ and golden/
web/                        Vite/React superapp for all three products
  src/
    main.jsx                entry point
    styles/                 shared tokens and global styles
    telemetry/              product-neutral telemetry
    platform/               browser sync engine and product-neutral domain kit
    design-system/          shared components
    showcase/               component and product gallery
    shell/                  router, product registry, account, billing and shared navigation
    products/               roadmap/, journal/ and gym/
  test/                     mirrors the source
apps/
  ios/                      App/ (the journal and gym app), Sync/ (the sync engine client), Domain/ (the
                            domain kit and the gym and journal domains on it), SyncTestingSurface/ and
                            the dev-only SyncProbe/ app
  android/                  Kotlin/Compose gym app; :app, :platform, :gym and :gym:domain, the sync
                            engine (:sync-*) and the domain kit (:domain-kit, :domain-kit-testing)
packages/
  api-contract/             shared wire contracts and executable golden fixtures
services/
  embedder/                 HTTP sidecar for journal passage vectors
tools/                     standalone operational tools
  lift-import/              imports Lift training history over the gym API
  resend-webhook-probe/     sends a signed synthetic bounce to verify webhook configuration
docs/                       product strategy, current contracts, design canon and unresolved work
.github/workflows/          build, test, release-input and deployment workflows
```

## Dependency rule

**Platform is product-neutral. Products depend on platform, never the reverse or on each other.**
Composition roots may import each product to assemble the application. Product-specific mechanisms
stay in their product even when their names sound generic; roadmap owns its node-shaped sync and
room machinery.

- **Backend:** each product declares a dependency struct and `registerRoutes` in `routes.h`.
  `platform/infra/main.cpp` builds dependencies and mounts routes. Roadmap and gym also implement
  `ToolHost`; `CompositeToolHost` filters their MCP tools by the caller's grant.
- **Web:** `shell/products.js` composes product route tables and settings sections. Shared settings
  and marketing surfaces consume that registry. Showcase reaches a product only through its
  `showcase.js` entry point; `test/shell-boundaries` checks those imports.
- **Native:** Android products depend on `:platform`; Android implements gym. Each phone holds a
  sync engine client, which names no product, and the domain kit with the product domains on it.
  iOS implements journal and gym in one app (`apps/ios/App`).

Raw design tokens are mirrored in `web/src/styles/tokens/` and
`apps/android/platform/src/main/kotlin/works/windmill/platform/design/Tokens.kt`. Edit them together.
`PLAN_COPY`, shared subscription wording, still lives in roadmap's web settings module.

## CI and deployment

| Workflow | Responsibility |
|---|---|
| `backend.yml` | build and run C++ tests in Docker, then the Postgres cases, the pattern fuzz and the sync deployment conformance (directly and through the production Caddyfile) in that image against a Postgres service; publish server and embedder images |
| `web.yml` | install, test and build web; rsync trusted builds to the VPS |
| `ios.yml` | `swift test` of the Sync, Domain and SyncTestingSurface packages on macOS; simulator builds of the engine and the SyncProbe app; build and test of the app |
| `ios-release.yml` | archive the app and upload it to App Store Connect, dispatched by hand |
| `ios-expire-builds.yml` | manually expire pre-engine TestFlight builds 1–5 after typed confirmation; protect builds 6 and later |
| `android.yml` | build and test; tags and versioned dispatches produce unpublished signing inputs |
| `embedder.yml` | check pinned vectors and the sidecar HTTP process |
| `tools.yml` | run the Lift importer suite |
| `contract.yml` | check the sync corpus is what the JS reference generates; run the reference's tests and a fixed-seed replay fuzz |
| `deploy.yml` | deploy a successful backend main-push SHA or a manually selected image tag |

Build workflows skip Markdown-only changes within their surface. Shared API contracts still trigger
their consumers; web also checks its email README and the verify skill because tests read them.

Backend Postgres integration cases require `WM_PG_TEST` and two isolated databases (`DATABASE_URL`
and `WM_SYNC_DATABASE_URL`, initialized as [RUNNING.md §7](backend/RUNNING.md#7-tests) describes).
The Docker build skips them; backend CI runs them in that image against a Postgres service. Automated model tests use
deterministic fakes and fixtures. Actual-model exploration is manual and local with a user-provided
key.

The web deploy must land first on a fresh host because the embedder mounts its weights from the
served web directory. See [deployment](backend/deploy/README.md) and
[embedder operations](services/embedder/README.md).

Android CI holds no private signing key and publishes no release. The local release helper verifies
source/run identities, signs with the retained key and checks the certificate and application
contents. Native acceptance and a same-key update check precede publication. See
[Android releases](apps/android/README.md#ci-and-releases).

## Documentation map

- [Backend rules](backend/CLAUDE.md), [local setup](backend/RUNNING.md), [roadmap spec](backend/SPEC.md),
  [authentication](backend/AUTH.md) and [authorization](backend/AUTHZ.md).
- [Journal architecture](backend/products/journal/ARCHITECTURE.md) and
  [gym architecture](backend/products/gym/ARCHITECTURE.md).
- `docs/foundation/` holds specifications that apply to more than one product or platform:
  [the sync engine](docs/foundation/engine.md) for every product and surface, built in the C++ server
  (`backend/platform/**/sync*`) and the JS (`web/src/platform/sync`), Swift (`apps/ios/Sync`) and
  Kotlin (`apps/android/sync-*`) clients;
  [the domain kit](docs/foundation/domain-kit.md), the pure-logic layer every Swift and Kotlin feature
  domain is declared on, built in Swift (`apps/ios/Domain`) and Kotlin (`apps/android/domain-kit`); and
  [gym Coach on the client](docs/foundation/mobile/gym_coach.md) for both phones, specified and not
  yet built.
- [Web rules](web/CLAUDE.md), [iOS](apps/ios/README.md) and [Android](apps/android/README.md).
- [Product direction](docs/PRODUCT_LOG.md) and [design consistency gaps](docs/design/consistency.md).
  `docs/design/` holds written canon; Figma holds the drawings.
