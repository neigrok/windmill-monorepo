cmake_minimum_required(VERSION 3.20)
project(windmill_backend CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# An unset build type means -O0, and -O0's fat un-inlined frames overflow drogon's ~512 KB
# worker-thread stack once a request handler calls a few layers deep (Caller -> Api -> Service ->
# Pg -> pqxx) — corrupting by-value return slots (a page read back as an empty/garbage struct) with
# no crash. Prod builds Release (backend/Dockerfile), so this only ever bit a plain local
# `cmake -S . -B build`. Default local builds to RelWithDebInfo — optimized like prod, with symbols.
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE RelWithDebInfo CACHE STRING "Build type (Release-like default; see note above)" FORCE)
  message(STATUS "No CMAKE_BUILD_TYPE set — defaulting to RelWithDebInfo (an -O0 build overflows drogon's worker stack)")
endif()

# Windmill is one modular-monolith backend behind a brand of products. `windmill_platform` is
# the product-neutral core (auth, oauth, billing, the MCP transport engine, the vendor edges);
# `windmill_roadmap` is the skill-tree product (trees, the sync/room cluster, the roadmap tools)
# and depends on the platform, never the other way round. A future product (notes, gym) adds its
# own products/<name> library beside roadmap and mirrors the same seam.

# --- platform + roadmap CORE (domain + application) — always built, even without Drogon/libpqxx,
# so the pure logic and its tests stand up on Trantor + jsoncpp alone. The adapters (the messy
# vendor edges) are folded into these same two libraries below, once Drogon + libpqxx are found.
add_library(windmill_platform
  platform/domain/Auth.cpp
  platform/domain/Mail.cpp
  platform/domain/OAuth.cpp
  platform/application/AuthService.cpp
  platform/application/Entitlements.cpp
  platform/application/OAuthService.cpp
  platform/application/McpKeyService.cpp)
target_include_directories(windmill_platform PUBLIC ${CMAKE_SOURCE_DIR})

add_library(windmill_roadmap
  products/roadmap/domain/LooseGraph.cpp
  products/roadmap/domain/Legend.cpp
  products/roadmap/domain/Subgraph.cpp
  products/roadmap/domain/Command.cpp
  products/roadmap/domain/NodeQuery.cpp
  products/roadmap/domain/TreeDiagnostics.cpp
  products/roadmap/domain/SkillTree.cpp
  products/roadmap/domain/TrunkTree.cpp
  products/roadmap/domain/UnlockRules.cpp
  products/roadmap/domain/TreeHealth.cpp
  products/roadmap/domain/TreeSummary.cpp
  products/roadmap/domain/Gallery.cpp
  products/roadmap/domain/Tending.cpp
  products/roadmap/domain/Reminders.cpp
  products/roadmap/application/TreeRoom.cpp
  products/roadmap/application/RoomRegistry.cpp
  products/roadmap/application/ProgressService.cpp
  products/roadmap/application/ActivityFeed.cpp
  products/roadmap/application/ForkService.cpp
  products/roadmap/application/ScopedToolHost.cpp
  products/roadmap/application/TendingService.cpp
  products/roadmap/application/TreeRegistry.cpp
  products/roadmap/application/ReminderSweep.cpp)
target_include_directories(windmill_roadmap PUBLIC ${CMAKE_SOURCE_DIR})
target_link_libraries(windmill_roadmap PUBLIC windmill_platform)

# --- journal product CORE (domain + application). Depends on windmill_platform only, never
# windmill_roadmap — the same one-way rule roadmap follows (STRUCTURE.md). The messy adapters (Pg,
# http, json) fold into this same library under the Drogon guard below, so journal stays one lib
# whether or not the vendor edges are present.
add_library(windmill_journal
  products/journal/domain/Page.cpp
  products/journal/domain/NudgePlan.cpp
  products/journal/domain/EchoFinder.cpp
  products/journal/application/PageService.cpp
  products/journal/application/NudgeSweep.cpp
  products/journal/application/EchoSweep.cpp)
target_include_directories(windmill_journal PUBLIC ${CMAKE_SOURCE_DIR})
target_link_libraries(windmill_journal PUBLIC windmill_platform)

# --- gym product CORE (domain + application). Same one-way rule: windmill_platform only, never
# another product. The adapters (Pg, http, json) fold into this same library under the Drogon
# guard below, so gym stays one lib whether or not the vendor edges are present.
add_library(windmill_gym
  products/gym/domain/Training.cpp
  products/gym/application/LogService.cpp)
target_include_directories(windmill_gym PUBLIC ${CMAKE_SOURCE_DIR})
target_link_libraries(windmill_gym PUBLIC windmill_platform)

# Drogon + libpqxx gate the real adapters (SPEC §11). Found here, up front, because Drogon also
# exports Trantor and jsoncpp as imported targets — and TendingService (in the roadmap core) needs
# both: its agent loop runs on a private trantor event-loop thread so the durable half can answer
# the HTTP request at once, and the ToolHost port (platform/ports/ToolHost.h) speaks Json::Value.
find_package(Drogon CONFIG QUIET)
find_package(libpqxx CONFIG QUIET)
find_package(OpenSSL QUIET)  # magic-link token entropy + digests (platform/adapters/crypto)

# Never find Trantor twice: its bundled Findc-ares.cmake creates the c-ares_lib imported target
# without an existence guard, so a second find — Drogon's own find_dependency(Trantor), or an
# explicit one here — aborts the configure trying to recreate it. When Drogon is present it has
# already brought both targets; only reach for them directly in a core-only build without Drogon.
if(NOT TARGET Trantor::Trantor)
  find_package(Trantor CONFIG REQUIRED)
endif()
if(NOT TARGET JsonCpp::JsonCpp)
  find_package(jsoncpp CONFIG REQUIRED)
endif()
target_link_libraries(windmill_platform PUBLIC Trantor::Trantor JsonCpp::JsonCpp)

add_executable(windmill_domain_tests
  test/main.cpp
  test/domain/AccessTest.cpp
  test/domain/LooseGraphTest.cpp
  test/domain/LegendTest.cpp
  test/domain/SubgraphTest.cpp
  test/domain/CommandTest.cpp
  test/domain/NodeQueryTest.cpp
  test/domain/TreeDiagnosticsTest.cpp
  test/domain/SkillTreeTest.cpp
  test/domain/TrunkTreeTest.cpp
  test/domain/UnlockRulesTest.cpp
  test/domain/TreeHealthTest.cpp
  test/domain/TreeSummaryTest.cpp
  test/domain/GalleryTest.cpp
  test/application/TreeRegistryTest.cpp
  test/application/ForkServiceTest.cpp
  test/application/TreeRoomTest.cpp
  test/application/RoomRegistryTest.cpp
  test/application/ProgressServiceTest.cpp
  test/application/ActivityFeedTest.cpp
  test/domain/AuthTest.cpp
  test/domain/MailTest.cpp
  test/application/AuthServiceTest.cpp
  test/application/EntitlementsTest.cpp
  test/domain/OAuthTest.cpp
  test/application/OAuthServiceTest.cpp
  test/application/McpKeyServiceTest.cpp
  test/application/ScopedToolHostTest.cpp
  test/application/TendingServiceTest.cpp
  test/domain/TendingTest.cpp
  test/domain/TreeTest.cpp
  test/domain/RemindersTest.cpp
  test/application/ReminderSweepTest.cpp
  test/products/journal/domain/PageTest.cpp
  test/products/journal/domain/NudgePlanTest.cpp
  test/products/journal/domain/EchoFinderTest.cpp
  test/products/journal/application/PageServiceTest.cpp
  test/products/journal/application/NudgeSweepTest.cpp
  test/products/journal/application/EchoSweepTest.cpp
  test/products/gym/domain/TrainingTest.cpp
  test/products/gym/application/LogServiceTest.cpp)
target_link_libraries(windmill_domain_tests PRIVATE windmill_roadmap windmill_journal windmill_gym)

enable_testing()
add_test(NAME domain COMMAND windmill_domain_tests)

# Real adapters (SPEC §11). Guarded: the two core libraries + the domain tests always build; the
# server and the vendor edges appear only once Drogon and libpqxx are installed (brew install
# drogon libpqxx) — both were located up front, above, so the cores could link Trantor + jsoncpp
# through Drogon. The adapters are folded straight into windmill_platform / windmill_roadmap, so a
# product stays one library whether or not the vendor edges are present.
if(Drogon_FOUND AND libpqxx_FOUND)
  # Platform adapters: the vendor edges + the MCP transport engine (McpServer/McpHttpEndpoint) —
  # transport-agnostic, product-neutral. Resources rides here because the engine reads its catalog.
  target_sources(windmill_platform PRIVATE
    platform/adapters/json/JsonText.cpp
    platform/adapters/http/PageShell.cpp
    platform/adapters/http/Caller.cpp
    platform/adapters/http/AuthApi.cpp
    platform/adapters/http/OAuthApi.cpp
    platform/adapters/http/McpKeyApi.cpp
    platform/adapters/http/EventsApi.cpp
    platform/adapters/http/FeedbackApi.cpp
    platform/adapters/http/VendorCall.cpp
    platform/adapters/postgres/PgAuthRepository.cpp
    platform/adapters/postgres/PgAccountFootprint.cpp
    platform/adapters/postgres/PgOAuthRepository.cpp
    platform/adapters/postgres/PgMcpKeyRepository.cpp
    platform/adapters/postgres/PgSubscriptionRepository.cpp
    platform/adapters/postgres/PgEventRepository.cpp
    platform/adapters/postgres/PgFeedbackRepository.cpp
    platform/adapters/postgres/PgServerErrorRepository.cpp
    platform/adapters/crypto/OpenSslTokenGenerator.cpp
    platform/adapters/email/ResendClient.cpp
    platform/adapters/email/ResendEmailSender.cpp
    platform/adapters/email/ResendSignature.cpp
    platform/adapters/email/ResendWebhookApi.cpp
    platform/adapters/oidc/IdToken.cpp
    platform/adapters/oidc/GoogleOAuthClient.cpp
    platform/adapters/oidc/AppleOAuthClient.cpp
    platform/adapters/sentry/SentryClient.cpp
    platform/adapters/sentry/LogTee.cpp
    platform/adapters/http/AccessLog.cpp
    platform/adapters/http/LogFormat.cpp
    platform/adapters/amplitude/AmplitudeClient.cpp
    platform/adapters/paddle/PaddleSignature.cpp
    platform/adapters/paddle/PaddleApiClient.cpp
    platform/adapters/paddle/BillingApi.cpp
    platform/adapters/mcp/McpServer.cpp
    platform/adapters/mcp/McpHttpEndpoint.cpp)
  target_link_libraries(windmill_platform PUBLIC Drogon::Drogon libpqxx::pqxx OpenSSL::Crypto)

  # Roadmap adapters: the roadmap tools an AI agent drives (RoadmapTools), the sync/room socket,
  # the LLM edges, the JSON boundary, and the roadmap postgres/http surfaces. They reach the vendor
  # deps through windmill_platform (linked PUBLIC above).
  target_sources(windmill_roadmap PRIVATE
    products/roadmap/adapters/auth/ForkSignup.cpp
    products/roadmap/adapters/email/ResendReminderSender.cpp
    products/roadmap/adapters/json/TreeJson.cpp
    products/roadmap/adapters/json/SubgraphJson.cpp
    products/roadmap/adapters/json/CommandJson.cpp
    products/roadmap/adapters/postgres/PgTreeRepository.cpp
    products/roadmap/adapters/postgres/PgProgressRepository.cpp
    products/roadmap/adapters/postgres/PgOpLog.cpp
    products/roadmap/adapters/postgres/PgOgImageRepository.cpp
    products/roadmap/adapters/postgres/PgOgVideoRepository.cpp
    products/roadmap/adapters/postgres/PgReminderRepository.cpp
    products/roadmap/adapters/postgres/PgTendRunRepository.cpp
    products/roadmap/adapters/http/HttpApi.cpp
    products/roadmap/adapters/http/SharePageApi.cpp
    products/roadmap/adapters/http/GalleryApi.cpp
    products/roadmap/adapters/http/OgImageApi.cpp
    products/roadmap/adapters/http/OgVideoApi.cpp
    products/roadmap/adapters/http/ComposeApi.cpp
    products/roadmap/adapters/http/TreeRegistryApi.cpp
    products/roadmap/adapters/http/TendingApi.cpp
    products/roadmap/adapters/http/RemindersApi.cpp
    products/roadmap/adapters/llm/AnthropicComposer.cpp
    products/roadmap/adapters/llm/AnthropicAgent.cpp
    products/roadmap/adapters/ws/WsPresenceBus.cpp
    products/roadmap/adapters/ws/PresenceHub.cpp
    products/roadmap/adapters/ws/Collab.cpp
    products/roadmap/adapters/ws/TreeSocket.cpp
    products/roadmap/adapters/mcp/RoadmapTools.cpp
    products/roadmap/adapters/mcp/RoadmapResources.cpp
    products/roadmap/adapters/mcp/ReadShape.cpp
    products/roadmap/adapters/mcp/EditReceipt.cpp
    products/roadmap/adapters/mcp/ToolArgs.cpp
    products/roadmap/routes.cpp)

  # Journal adapters: the Pg storage, the JSON wire boundary, the REST surface, and the route seam.
  # They reach Drogon + libpqxx through windmill_platform (linked PUBLIC by the core lib above).
  target_sources(windmill_journal PRIVATE
    products/journal/adapters/email/ResendNudgeSender.cpp
    products/journal/adapters/json/PageJson.cpp
    products/journal/adapters/postgres/PgJournalRepository.cpp
    products/journal/adapters/postgres/PgNudgeRepository.cpp
    products/journal/adapters/postgres/PgEchoRepository.cpp
    products/journal/adapters/http/JournalApi.cpp
    products/journal/adapters/http/NudgeApi.cpp
    products/journal/adapters/http/EchoApi.cpp
    products/journal/adapters/http/VoiceApi.cpp
    products/journal/adapters/llm/OpenAiTranscriber.cpp
    products/journal/routes.cpp)

  # Gym adapters: the Pg storage, the JSON wire boundary, the REST surface, and the route seam.
  # They reach Drogon + libpqxx through windmill_platform (linked PUBLIC by the core lib above).
  target_sources(windmill_gym PRIVATE
    products/gym/adapters/json/TrainingJson.cpp
    products/gym/adapters/postgres/PgTrainingRepository.cpp
    products/gym/adapters/http/GymApi.cpp
    products/gym/routes.cpp)

  # One process serves REST, the collab socket, AND MCP over the same rooms. main.cpp is the
  # composition root: it builds platform + roadmap singletons, mounts the shared MCP endpoint, and
  # calls roadmap::registerRoutes for the product half (products/roadmap/routes.h).
  add_executable(windmill_server platform/infra/main.cpp)
  target_link_libraries(windmill_server PRIVATE windmill_roadmap windmill_journal windmill_gym)
  message(STATUS "windmill_server enabled (Drogon + libpqxx found)")

  add_executable(windmill_mcp platform/infra/mcp_main.cpp)            # stdio transport (local hosts)
  target_link_libraries(windmill_mcp PRIVATE windmill_roadmap)

  add_executable(windmill_mcp_http platform/infra/mcp_http_main.cpp)  # standalone HTTP transport (legacy; folded into windmill_server)
  target_link_libraries(windmill_mcp_http PRIVATE windmill_roadmap)

  add_executable(windmill_mcp_tests
    test/main.cpp
    test/adapters/mcp/McpServerTest.cpp
    test/adapters/mcp/RoadmapToolsTest.cpp
    test/adapters/mcp/ToolErrorContractTest.cpp
    test/adapters/mcp/WireCorpusTest.cpp
    test/adapters/mcp/McpHttpEndpointTest.cpp)
  target_link_libraries(windmill_mcp_tests PRIVATE windmill_roadmap)
  # The golden MCP wire (WireCorpusTest) lives beside the roadmap tools and is byte-compared against
  # a fresh transcript; the source path is handed in so the check finds it from any build tree.
  target_compile_definitions(windmill_mcp_tests PRIVATE
    WM_WIRE_CORPUS_PATH="${CMAKE_SOURCE_DIR}/products/roadmap/adapters/mcp/golden/wire_corpus.json")
  add_test(NAME mcp COMMAND windmill_mcp_tests)

  add_executable(windmill_adapters_tests
    test/main.cpp
    test/adapters/json/SubgraphJsonTest.cpp
    test/adapters/json/TreeJsonTest.cpp
    test/adapters/http/EventsApiTest.cpp
    test/adapters/http/FeedbackApiTest.cpp
    test/adapters/http/ComposeApiTest.cpp
    test/adapters/http/RateLimiterTest.cpp
    test/adapters/http/HttpApiTest.cpp
    test/adapters/http/SharePageApiTest.cpp
    test/adapters/http/GalleryApiTest.cpp
    test/adapters/http/OgImageApiTest.cpp
    test/adapters/http/OgVideoApiTest.cpp
    test/adapters/http/TreeRegistryApiTest.cpp
    test/adapters/http/RemindersApiTest.cpp
    test/adapters/http/VendorCallTest.cpp
    test/adapters/ws/CollabTest.cpp
    test/adapters/email/ResendEmailSenderTest.cpp
    test/adapters/email/ResendSignatureTest.cpp
    test/adapters/email/ResendWebhookApiTest.cpp
    test/adapters/sentry/LogTeeTest.cpp
    test/adapters/http/AccessLogTest.cpp
    test/adapters/paddle/PaddleSignatureTest.cpp
    test/adapters/llm/AnthropicComposerTest.cpp
    test/adapters/llm/AnthropicAgentTest.cpp
    test/products/journal/adapters/http/JournalApiTest.cpp
    test/products/journal/adapters/http/NudgeApiTest.cpp
    test/products/journal/adapters/http/EchoApiTest.cpp
    test/products/journal/adapters/http/VoiceApiTest.cpp
    test/products/journal/adapters/postgres/PgJournalRepositoryTest.cpp
    test/products/gym/adapters/http/GymApiTest.cpp
    test/products/gym/adapters/postgres/PgTrainingRepositoryTest.cpp)
  target_link_libraries(windmill_adapters_tests PRIVATE windmill_roadmap windmill_journal windmill_gym)
  add_test(NAME adapters COMMAND windmill_adapters_tests)
else()
  message(STATUS "Drogon/libpqxx not found — building core + tests only; run 'brew install drogon libpqxx' to enable windmill_server")
endif()
