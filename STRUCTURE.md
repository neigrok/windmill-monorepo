# Repository structure

Windmill has three products—roadmap, journal and gym—with one backend and one account. The
repository groups code by surface, then product.

```text
backend/                    C++20 modular monolith
  platform/                 product-neutral auth, OAuth, billing, MCP, email, telemetry and AI usage
    infra/                  composition roots for the server and standalone MCP transports
  products/
    roadmap/                tree domain, synchronization and roadmap adapters
    journal/                pages, nudges, voice and echoes
    gym/                    training log, routines, Coach and gym adapters
  db/                       idempotent schema and analyst funnel views
  deploy/                   Docker Compose, Caddy and production configuration
  test/                     platform/, products/, e2e/ and golden/
web/                        Vite/React superapp for all three products
  src/
    main.jsx                entry point
    styles/                 shared tokens and global styles
    telemetry/              product-neutral telemetry
    design-system/          shared components
    showcase/               component and product gallery
    shell/                  router, product registry, account, billing and shared navigation
    products/               roadmap/, journal/ and gym/
  test/                     mirrors the source
apps/
  ios/                      SwiftUI app; XcodeGen project and WindmillKit package
  android/                  Kotlin/Compose app; :app, :platform and :gym Gradle modules
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
- **Native:** iOS packages depend on `WindmillPlatform`; Android products depend on `:platform`.
  iOS implements journal and gym and points roadmap readers to web. Android implements gym.

Raw design tokens are mirrored in `web/src/styles/tokens/`,
`apps/ios/WindmillKit/Sources/WindmillPlatform/Tokens.swift` and
`apps/android/platform/src/main/kotlin/works/windmill/platform/design/Tokens.kt`. Edit them together.
`PLAN_COPY`, shared subscription wording, still lives in roadmap's web settings module.

## CI and deployment

| Workflow | Responsibility |
|---|---|
| `backend.yml` | build and run C++ tests in Docker; publish server and embedder images |
| `web.yml` | install, test and build web; rsync trusted builds to the VPS |
| `ios.yml` | simulator app build, crash-report tests and WindmillKit tests |
| `ios-release.yml` | archive and upload the tested iOS main-push commit to App Store Connect, or release manually |
| `android.yml` | build and test; tags and versioned dispatches produce unpublished signing inputs |
| `embedder.yml` | check pinned vectors and the sidecar HTTP process |
| `tools.yml` | run the Lift importer suite |
| `deploy.yml` | deploy a successful backend main-push SHA or a manually selected image tag |

Build workflows skip Markdown-only changes within their surface. Shared API contracts still trigger
their consumers, and web retains its email README because a test reads it.

Backend Postgres integration cases require `WM_PG_TEST` and a local database; the Docker CI build
runs without one. Automated model tests use deterministic fakes and fixtures. Actual-model
exploration is manual and local with a user-provided key.

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
  [the sync engine](docs/foundation/engine.md) for every product and surface, and
  [gym Coach on the client](docs/foundation/mobile/gym_coach.md) for both phones. Both are specified
  and not yet implemented.
- [Web rules](web/CLAUDE.md), [iOS](apps/ios/README.md) and [Android](apps/android/README.md).
- [Product direction](docs/PRODUCT_LOG.md) and [design consistency gaps](docs/design/consistency.md).
  `docs/design/` holds written canon; Figma holds the drawings.
