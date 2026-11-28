# Repository structure

Windmill has three products—roadmap, journal and gym—with one backend and one account. The
repository groups code by surface, then product.

```text
backend/                    C++20 modular monolith
  platform/                 product-neutral auth, OAuth, subscriptions, MCP, email, telemetry, AI usage and
                            the sync engine server
    infra/                  composition roots for the server and standalone MCP transports
    ai_passes/              optional Ed25519 pass issuer for the AI service
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
    platform/               browser sync runtime, product-neutral domain kit, Coach engine, AI client
                            and the translator
    design-system/          shared components
    showcase/               component and product gallery
    shell/                  router, product registry, account, billing and shared navigation
    products/               roadmap/, journal/ and gym/
  test/                     mirrors the source
apps/
  ios/                      App/ (the journal and gym app), Sync/ (the sync engine client), Domain/ (the
                            domain kit, the gym and journal domains on it and roadmap's reads), Agent/
                            (the Coach engine), WindmillKit/ (its AI client and runtime),
                            SyncTestingSurface/ and the dev-only SyncProbe/ app
  android/                  Kotlin/Compose gym app; :app, :platform, :gym (its presentation package
                            projects :gym:domain for the screens) and :gym:domain, the sync engine
                            (:sync-*), the domain kit (:domain-kit, :domain-kit-testing) and the
                            product-neutral agent turn (:agent)
packages/
  api-contract/             shared wire contracts, executable golden fixtures and the JS sync core/client
    agent/                  shared device Coach turn stories and their checker
services/
  embedder/                 HTTP sidecar for journal passage vectors
  ai/                       Rust workspace for AI admission, provider calls and allowance accounting:
                            domain, providers, storage, server; test-only pass signer
  subscriptions/            Rust workspace of the Windmill One subscription service: the crates domain,
                            app_store, storage and server, and the test-only App Store payload signer
tools/                     standalone operational tools
  lift-import/              imports Lift training history over the gym API
  resend-webhook-probe/     sends a signed synthetic bounce to verify webhook configuration
  coach-e2e/                drives the device engines through local pass and AI services
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

## CI and deployment

| Workflow | Responsibility |
|---|---|
| `backend.yml` | build and run C++ tests in Docker, Postgres cases, pattern fuzz and sync deployment conformance; require both ledger services' checks before publishing server, embedder, subscriptions and AI images |
| `web.yml` | install, test and build web; rsync trusted builds to the VPS |
| `ios.yml` | parallel packages/builds, App unit tests and three class-based UI shards; Sync, Domain, Agent, WindmillKit and SyncTestingSurface tests, engine/SyncProbe simulator builds, and App Debug/Release builds with Xcode 27.1 |
| `ios-release.yml` | archive the app and upload it to App Store Connect, dispatched by hand |
| `android.yml` | build and test; tags and versioned dispatches produce unpublished signing inputs |
| `embedder.yml` | check pinned vectors and the sidecar HTTP process |
| `ai.yml` | dependency boundaries, formatting, Clippy, fixture and Postgres tests; hardened image smoke and AI database isolation |
| `subscriptions.yml` | check the subscription service's crate dependency rule, formatting, Clippy with warnings denied and tests; build its image and run it; check its wire fixtures are what `generate.py` writes and pass `check.py` |
| `tools.yml` | run the Lift importer suite |
| `contract.yml` | check the sync corpus is what the JS reference generates; run the reference's tests and a fixed-seed replay fuzz |
| `coach.yml` | check the shared Coach turn stories match their declarations and the AI wire shapes, and Journal Talk's stories match theirs, the pause rule, the AI wire's live messages and the mark's registry row |
| `deploy.yml` | deploy a successful backend main-push SHA or a main-reachable commit SHA; sync minimum changes require an exact manual cutoff acknowledgement |

Build workflows skip Markdown-only changes within their surface. Shared API contracts still trigger
their consumers; web also checks its email README and the verify skill because tests read them.

Backend Postgres integration cases require `WM_PG_TEST` and two isolated databases (`DATABASE_URL`
and `WM_SYNC_DATABASE_URL`, initialized as [RUNNING.md §7](backend/RUNNING.md#7-tests) describes).
The Docker build skips them; backend CI runs them in that image against a Postgres service. Ordinary model tests use
deterministic fakes and fixtures. Actual-model exploration is manual: locally with a user-provided
key, or through the opt-in Coach verification dispatch using the existing repository secret and
disposable accounts (`backend/RUNNING.md`).

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
  (`backend/platform/**/sync*`) and the JS (`packages/api-contract/sync/reference/core` and `client`,
  with the browser runtime in `web/src/platform/sync`), Swift (`apps/ios/Sync`) and Kotlin
  (`apps/android/sync-*`) clients;
  [the domain kit](docs/foundation/domain-kit.md), the pure-logic layer every Swift and Kotlin feature
  domain is declared on, built in Swift (`apps/ios/Domain`) and Kotlin (`apps/android/domain-kit`); and
  [phone-hosted Coach abilities](docs/foundation/mobile/gym_coach.md), specified for both phones.
  Both phones implement phone-hosted turns.
  [The subscription service](docs/foundation/subscriptions.md) for Windmill One is being built; what
  exists is in its [ARCHITECTURE.md](services/subscriptions/ARCHITECTURE.md).
  [The AI service](docs/foundation/ai-service.md), which takes over the AI allowance ledger and every
  provider call, is implemented under `services/ai`; its [architecture](services/ai/ARCHITECTURE.md) names the
  running boundaries. Existing feature callers remain in the backend until their integrations move.
  [The Coach engine](docs/foundation/coach-engine.md) supplies product-neutral device turn libraries
  and AI clients, with shared stories under `packages/api-contract/agent`.
  [Roadmap Coach](docs/foundation/roadmap-coach.md), which replaces tending with a Coach whose
  abilities run on the browser's copy of a roadmap, is specified, and of it the contract, the web's
  read abilities and the context Coach is told at the start of a turn are built.
  [Gym Coach on the AI service](docs/foundation/gym-coach-on-ai-service.md), which moves gym Coach onto
  that engine on every surface, is built on the web and on Android; the iPhone's turn still runs on the server.
  [Roadmap on the sync engine](docs/foundation/roadmap-on-the-engine.md), which moves roadmap's records and rules
  onto the engine and the domain kit, is built, and production's roadmaps sync through the engine; the deletion of
  roadmap's own sync remains. Of [Roadmap on iOS](docs/foundation/roadmap-ios.md), the iPhone's Roadmap room on
  them, the Swift domain's reads, entities, rule book and actions
  (`apps/ios/Domain/Sources/RoadmapDomain`) and the Graph's picture (`apps/ios/Domain/Sources/RoadmapLayout`) are
  built and nothing else. [Journal Talk](docs/foundation/journal-talk.md), live speech to text through the AI
  service, is specified and not built. Of [the web as a device](docs/foundation/web-device-parity.md), which makes
  gym and journal on the web work as they do on a phone, the shared domain's part, the gym room drawn from the
  browser's copy, a workout logged on the web, the signed-out gym with its join at sign-in, the journal's reads of its
  own copy and Coach during a workout are built; the web's writing of the rest settings is not. [Echoes on the AI service](docs/foundation/echoes-on-ai-service.md), which
  moves the journal's two background model calls there, is built.
- [The running Coach conversation contract](docs/gym-coach-contract.md) covers the server-hosted
  model loop, which no client calls. [The iOS app](apps/ios/App/README.md) also documents
  signed-in routine onboarding.
- [Web rules](web/CLAUDE.md), [iOS](apps/ios/README.md) and [Android](apps/android/README.md).
- [Product direction](docs/PRODUCT_LOG.md) and [design consistency gaps](docs/design/consistency.md).
  `docs/design/` holds written canon; Figma holds the drawings.
