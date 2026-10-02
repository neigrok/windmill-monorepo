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

# The sync contract (packages/api-contract/sync): the registries the sync engine embeds and the golden
# corpus its tests replay. The Docker build receives it as the named context `contract` and points
# this at it (Dockerfile).
set(WM_API_CONTRACT_DIR "${CMAKE_SOURCE_DIR}/../packages/api-contract" CACHE PATH "The api-contract package that holds sync/")
if(NOT EXISTS "${WM_API_CONTRACT_DIR}/sync/probe.registry.json")
  message(FATAL_ERROR "No sync contract at ${WM_API_CONTRACT_DIR}/sync: set WM_API_CONTRACT_DIR to the api-contract package")
endif()

# Embeds a sync registry file as `std::string_view <namespace>::<function>()`, from the template
# platform/domain/sync/RegistryText.cpp.in. The file is a configure dependency, so an edit re-embeds
# it and a binary carries exactly the registry it was built and tested with.
function(wm_embed_registry target namespace function file)
  file(READ "${file}" WM_REGISTRY_TEXT)
  string(FIND "${WM_REGISTRY_TEXT}" ")wmregistry\"" delimiter)
  if(NOT delimiter EQUAL -1)
    message(FATAL_ERROR "${file} holds the raw-string delimiter )wmregistry\"")
  endif()
  set(WM_REGISTRY_SOURCE "${file}")
  set(WM_REGISTRY_NAMESPACE "${namespace}")
  set(WM_REGISTRY_FUNCTION "${function}")
  set(generated "${CMAKE_BINARY_DIR}/generated/${target}_${function}.cpp")
  configure_file("${CMAKE_SOURCE_DIR}/platform/domain/sync/RegistryText.cpp.in" "${generated}" @ONLY)
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${file}")
  target_sources(${target} PRIVATE "${generated}")
endfunction()

# Windmill is one modular-monolith backend behind a brand of products. `windmill_platform` is
# the product-neutral core (auth, oauth, billing, the MCP transport engine, the vendor edges);
# `windmill_roadmap` is the skill-tree product (trees, the sync/room cluster, the roadmap tools)
# and depends on the platform, never the other way round. `windmill_journal` and `windmill_gym`
# mirror that seam — one products/<name> library each, beside roadmap and linked into the server.

# --- platform + roadmap CORE (domain + application). The adapters (the messy vendor edges) are
# folded into these same libraries below.
add_library(windmill_platform
  platform/domain/AiFuse.cpp
  platform/domain/AiUsage.cpp
  platform/domain/Auth.cpp
  platform/domain/Mail.cpp
  platform/domain/MailArming.cpp
  platform/domain/OAuth.cpp
  platform/domain/sync/Jcs.cpp
  platform/domain/sync/Digest.cpp
  platform/domain/sync/Pattern.cpp
  platform/domain/sync/Registry.cpp
  platform/domain/sync/Record.cpp
  platform/domain/sync/Lattice.cpp
  platform/domain/sync/FractionalIndex.cpp
  platform/domain/sync/Identity.cpp
  platform/domain/sync/TextMerge.cpp
  platform/domain/sync/Scope.cpp
  platform/domain/sync/Wire.cpp
  platform/domain/sync/Credentials.cpp
  platform/domain/sync/Shape.cpp
  platform/domain/sync/Admit.cpp
  platform/application/AuthService.cpp
  platform/application/Entitlements.cpp
  platform/application/LiveSessions.cpp
  platform/application/OAuthService.cpp
  platform/application/McpKeyService.cpp
  platform/application/WorkerPool.cpp
  platform/application/sync/SyncCatalog.cpp
  platform/application/sync/Admission.cpp
  platform/application/sync/ServerCall.cpp
  platform/application/sync/SyncService.cpp
  platform/application/sync/SyncLive.cpp
  platform/ports/ToolHost.cpp)
target_include_directories(windmill_platform PUBLIC ${CMAKE_SOURCE_DIR})

add_library(windmill_roadmap
  products/roadmap/domain/LooseGraph.cpp
  products/roadmap/domain/Legend.cpp
  products/roadmap/domain/Subgraph.cpp
  products/roadmap/domain/Command.cpp
  products/roadmap/domain/Graft.cpp
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
# http, json) fold into this same library below.
add_library(windmill_journal
  products/journal/domain/Page.cpp
  products/journal/domain/NudgePlan.cpp
  products/journal/domain/Passage.cpp
  products/journal/domain/SpanReconcile.cpp
  products/journal/domain/EchoSelection.cpp
  products/journal/application/PageService.cpp
  products/journal/application/NudgeSweep.cpp
  products/journal/application/EchoSweep.cpp
  products/journal/application/EchoExplain.cpp
  products/journal/application/EchoDerivations.cpp
  products/journal/application/WarmEchoRepository.cpp)
target_include_directories(windmill_journal PUBLIC ${CMAKE_SOURCE_DIR})
target_link_libraries(windmill_journal PUBLIC windmill_platform)

# --- gym product CORE (domain + application). Same one-way rule: windmill_platform only, never
# another product. The adapters (Pg, http, json) fold into this same library below.
add_library(windmill_gym
  products/gym/domain/Training.cpp
  products/gym/domain/Preferences.cpp
  products/gym/domain/Routine.cpp
  products/gym/domain/Proposal.cpp
  products/gym/domain/Thread.cpp
  products/gym/domain/Review.cpp
  products/gym/domain/Correction.cpp
  products/gym/domain/History.cpp
  products/gym/domain/Statistics.cpp
  products/gym/domain/Record.cpp
  products/gym/domain/ReadReceipt.cpp
  products/gym/domain/Note.cpp
  products/gym/domain/Bodyweight.cpp
  products/gym/application/TrainingService.cpp
  products/gym/application/CatalogService.cpp
  products/gym/application/ProgramService.cpp
  products/gym/application/ThreadService.cpp
  products/gym/application/PreferencesService.cpp
  products/gym/application/NotesService.cpp
  products/gym/application/BodyweightService.cpp)
target_include_directories(windmill_gym PUBLIC ${CMAKE_SOURCE_DIR})
target_link_libraries(windmill_gym PUBLIC windmill_platform)

add_library(windmill_gym_sync
  products/gym/sync/domain/GymRules.cpp
  products/gym/sync/application/GymProduct.cpp)
target_include_directories(windmill_gym_sync PUBLIC ${CMAKE_SOURCE_DIR})
target_link_libraries(windmill_gym_sync PUBLIC windmill_platform)
target_link_libraries(windmill_gym PUBLIC windmill_gym_sync)
file(READ "${WM_API_CONTRACT_DIR}/sync/composition.json" WM_COMPOSITION)
string(JSON WM_REGISTRY_COUNT LENGTH "${WM_COMPOSITION}" registries)
string(JSON WM_GYM_REGISTRY GET "${WM_COMPOSITION}" registries 0)
string(JSON WM_JOURNAL_REGISTRY GET "${WM_COMPOSITION}" registries 1)
if(NOT WM_REGISTRY_COUNT EQUAL 2 OR NOT WM_GYM_REGISTRY STREQUAL "gym.registry.json" OR NOT WM_JOURNAL_REGISTRY STREQUAL "journal.registry.json")
  message(FATAL_ERROR "wave 1 binds the gym + journal composition")
endif()
wm_embed_registry(windmill_gym_sync wm::gym::engine registryText "${WM_API_CONTRACT_DIR}/sync/${WM_GYM_REGISTRY}")

add_library(windmill_journal_sync
  products/journal/sync/domain/JournalRules.cpp
  products/journal/sync/application/JournalProduct.cpp
  products/journal/sync/adapters/postgres/PgJournal.cpp
  products/journal/sync/adapters/postgres/PgJournalBackfill.cpp)
target_include_directories(windmill_journal_sync PUBLIC ${CMAKE_SOURCE_DIR})
target_link_libraries(windmill_journal_sync PUBLIC windmill_platform)
wm_embed_registry(windmill_journal_sync wm::journal::engine registryText "${WM_API_CONTRACT_DIR}/sync/${WM_JOURNAL_REGISTRY}")

add_library(windmill_product_sync platform/infra/SyncProducts.cpp)
target_link_libraries(windmill_product_sync PUBLIC windmill_gym_sync windmill_journal_sync)
wm_embed_registry(windmill_product_sync wm::sync compositionText "${WM_API_CONTRACT_DIR}/sync/composition.json")

# --- probe: the sync engine's test and dev product (packages/api-contract/sync/probe.registry.json), the
# worked example of a product on the engine. Only the test binaries and windmill_server_probe link it;
# windmill_server never does, and the Dockerfile proves it. Its Postgres adapter and the dev stack's endpoints
# fold in below.
add_library(windmill_probe
  products/probe/domain/ProbeRules.cpp
  products/probe/application/ProbeProduct.cpp)
target_include_directories(windmill_probe PUBLIC ${CMAKE_SOURCE_DIR})
target_link_libraries(windmill_probe PUBLIC windmill_platform)
wm_embed_registry(windmill_probe wm::probe registryText "${WM_API_CONTRACT_DIR}/sync/probe.registry.json")

# The vendor edges, every one required. Drogon is its pinned release with the patches in third_party/drogon (README.md
# there), and it brings Trantor and jsoncpp, which the cores use too: TendingService runs its agent loop on a trantor
# event loop, and the ToolHost port (platform/ports/ToolHost.h) speaks Json::Value.
include(third_party/drogon/drogon.cmake)
# The patched build's own package files, whatever an earlier configure cached: a changed patch builds a new prefix.
set(Drogon_DIR "${WM_DROGON_PREFIX}/lib/cmake/Drogon" CACHE PATH "The patched Drogon's package" FORCE)
set(Trantor_DIR "${WM_DROGON_PREFIX}/lib/cmake/Trantor" CACHE PATH "The patched Drogon's Trantor" FORCE)
find_package(Drogon ${WM_DROGON_VERSION} EXACT CONFIG REQUIRED)
# Ahead of every other include directory, so an unpatched Drogon installed beside the other vendor headers (Homebrew's,
# in /opt/homebrew/include) can never shadow the patched one: its HttpRequest has one virtual fewer.
include_directories(BEFORE SYSTEM "${WM_DROGON_PREFIX}/include")
find_package(libpqxx CONFIG REQUIRED)
find_package(OpenSSL REQUIRED)  # magic-link token entropy + digests (platform/adapters/crypto)
find_package(CURL REQUIRED)
find_package(ZLIB REQUIRED)
if(NOT TARGET JsonCpp::JsonCpp)
  find_package(jsoncpp CONFIG REQUIRED)
endif()
target_link_libraries(windmill_platform PUBLIC Trantor::Trantor JsonCpp::JsonCpp)

add_executable(windmill_domain_tests
  test/main.cpp
  test/platform/domain/AccessTest.cpp
  test/platform/domain/AiUsageTest.cpp
  test/platform/domain/IdsTest.cpp
  test/platform/domain/sync/JcsTest.cpp
  test/platform/domain/sync/DigestTest.cpp
  test/platform/domain/sync/PatternTest.cpp
  test/platform/domain/sync/RegistryTest.cpp
  test/platform/domain/sync/ShapeTest.cpp
  test/platform/domain/sync/WireTest.cpp
  test/platform/domain/sync/CredentialsTest.cpp
  test/platform/domain/sync/LatticeTest.cpp
  test/platform/domain/sync/FractionalIndexTest.cpp
  test/platform/domain/sync/TextMergeTest.cpp
  test/platform/domain/sync/AdmitTest.cpp
  test/platform/domain/sync/CorpusTest.cpp
  test/platform/domain/ToolScopeTest.cpp
  test/platform/domain/AuthTest.cpp
  test/platform/domain/MailTest.cpp
  test/platform/domain/MailArmingTest.cpp
  test/platform/domain/OAuthTest.cpp
  test/platform/application/AuthServiceTest.cpp
  test/platform/application/EntitlementsTest.cpp
  test/platform/application/LiveSessionsTest.cpp
  test/platform/application/OAuthServiceTest.cpp
  test/platform/application/McpKeyServiceTest.cpp
  test/platform/application/MailSweepTest.cpp
  test/platform/application/WorkerPoolTest.cpp
  test/platform/application/sync/SyncCatalogTest.cpp
  test/platform/application/sync/AdmissionTest.cpp
  test/platform/application/sync/ServerCallTest.cpp
  test/platform/application/sync/ServerBuilderTest.cpp
  test/platform/application/sync/SyncServiceTest.cpp
  test/platform/application/sync/SyncLiveTest.cpp
  test/products/roadmap/domain/IdsTest.cpp
  test/products/roadmap/domain/LooseGraphTest.cpp
  test/products/roadmap/domain/LegendTest.cpp
  test/products/roadmap/domain/SubgraphTest.cpp
  test/products/roadmap/domain/CommandTest.cpp
  test/products/roadmap/domain/GraftTest.cpp
  test/products/roadmap/domain/NodeQueryTest.cpp
  test/products/roadmap/domain/TreeDiagnosticsTest.cpp
  test/products/roadmap/domain/SkillTreeTest.cpp
  test/products/roadmap/domain/TrunkTreeTest.cpp
  test/products/roadmap/domain/UnlockRulesTest.cpp
  test/products/roadmap/domain/TreeHealthTest.cpp
  test/products/roadmap/domain/TreeSummaryTest.cpp
  test/products/roadmap/domain/GalleryTest.cpp
  test/products/roadmap/domain/TendingTest.cpp
  test/products/roadmap/domain/TreeTest.cpp
  test/products/roadmap/domain/RemindersTest.cpp
  test/products/roadmap/application/TreeRegistryTest.cpp
  test/products/roadmap/application/ForkServiceTest.cpp
  test/products/roadmap/application/TreeRoomTest.cpp
  test/products/roadmap/application/RoomRegistryTest.cpp
  test/products/roadmap/application/ProgressServiceTest.cpp
  test/products/roadmap/application/ActivityFeedTest.cpp
  test/products/roadmap/application/ScopedToolHostTest.cpp
  test/products/roadmap/application/TendingServiceTest.cpp
  test/products/roadmap/application/ReminderSweepTest.cpp
  test/products/journal/domain/PageTest.cpp
  test/products/journal/domain/NudgePlanTest.cpp
  test/products/journal/domain/PassageTest.cpp
  test/products/journal/domain/SpanReconcileTest.cpp
  test/products/journal/domain/EchoSelectionTest.cpp
  test/products/journal/application/PageServiceTest.cpp
  test/products/journal/application/NudgeSweepTest.cpp
  test/products/journal/application/EchoSweepTest.cpp
  test/products/journal/application/EchoDerivationsTest.cpp
  test/products/journal/application/WarmEchoRepositoryTest.cpp
  test/products/gym/sync/domain/GymRulesTest.cpp
  test/products/journal/sync/domain/JournalRulesTest.cpp
  test/products/journal/sync/application/JournalFeedTest.cpp
  test/products/gym/domain/TrainingTest.cpp
  test/products/gym/domain/PreferencesTest.cpp
  test/products/gym/domain/RoutineTest.cpp
  test/products/gym/domain/ProposalTest.cpp
  test/products/gym/domain/ThreadTest.cpp
  test/products/gym/domain/ReviewTest.cpp
  test/products/gym/domain/CorrectionTest.cpp
  test/products/gym/domain/HistoryTest.cpp
  test/products/gym/domain/StatisticsTest.cpp
  test/products/gym/domain/RecordTest.cpp
  test/products/gym/domain/ReadReceiptTest.cpp
  test/products/gym/domain/NoteTest.cpp
  test/products/gym/domain/BodyweightTest.cpp
  test/products/gym/application/TrainingServiceTest.cpp
  test/products/gym/application/CatalogServiceTest.cpp
  test/products/gym/application/ProgramServiceTest.cpp
  test/products/gym/application/ThreadServiceTest.cpp
  test/products/gym/application/NotesServiceTest.cpp
  test/products/gym/application/BodyweightServiceTest.cpp)
target_link_libraries(windmill_domain_tests PRIVATE windmill_roadmap windmill_journal windmill_gym windmill_probe windmill_product_sync)
# The corpus and the product registries are read from the contract at run time, so the tests see every file the
# contract holds.
target_compile_definitions(windmill_domain_tests PRIVATE WM_SYNC_CONTRACT_DIR="${WM_API_CONTRACT_DIR}/sync")

enable_testing()
add_test(NAME domain COMMAND windmill_domain_tests)
# The production edge forwards every credential line as received (engine.md §9.1): its Caddyfile rewrites none of them.
add_test(NAME deploy COMMAND ${CMAKE_COMMAND} -DCADDYFILE=${CMAKE_SOURCE_DIR}/deploy/Caddyfile
                             -P ${CMAKE_SOURCE_DIR}/test/deploy/caddyfile_forwards_credentials.cmake)

# The adapters, folded straight into windmill_platform / windmill_roadmap / windmill_journal / windmill_gym, so a
# product is one library with its vendor edges in it.
target_link_libraries(windmill_gym PUBLIC ZLIB::ZLIB)
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
  platform/adapters/postgres/PgPool.cpp
  platform/adapters/postgres/PgAiUsageRepository.cpp
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
  platform/adapters/llm/AnthropicClient.cpp
  platform/adapters/llm/AgentLoop.cpp
  platform/adapters/llm/AnthropicStream.cpp
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
  platform/adapters/amplitude/AmplitudeUsageSink.cpp
  platform/adapters/paddle/PaddleSignature.cpp
  platform/adapters/paddle/PaddleApiClient.cpp
  platform/adapters/paddle/BillingApi.cpp
  platform/adapters/mcp/McpServer.cpp
  platform/adapters/mcp/McpHttpEndpoint.cpp
  platform/adapters/mcp/CompositeToolHost.cpp
  platform/adapters/postgres/PgSyncStore.cpp
  platform/adapters/postgres/PgTableType.cpp
  platform/adapters/http/SyncApi.cpp
  platform/adapters/ws/SyncSocket.cpp)
target_link_libraries(windmill_platform PUBLIC Drogon::Drogon libpqxx::pqxx OpenSSL::Crypto CURL::libcurl)

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
  products/roadmap/adapters/mcp/RoadmapToolCatalog.cpp
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
  products/journal/adapters/llm/AnthropicCurator.cpp
  products/journal/adapters/llm/AnthropicSegmenter.cpp
  products/journal/adapters/llm/HttpEmbedder.cpp
  products/journal/routes.cpp)

# Gym adapters: the Pg storage, the one wire boundary (JSON, for every client), the REST surface,
# the tools an agent drives, the panel that drives those same tools from inside the app, and the
# route seam.
# They reach Drogon + libpqxx through windmill_platform (linked PUBLIC by the core lib above).
target_sources(windmill_gym PRIVATE
  products/gym/sync/adapters/postgres/GymDoor.cpp
  products/gym/sync/adapters/postgres/GymTrainingDoor.cpp
  products/gym/sync/adapters/postgres/GymRecordDoor.cpp
  products/gym/adapters/json/HistoryJson.cpp
  products/gym/adapters/json/TrainingJson.cpp
  products/gym/adapters/postgres/PgLogHistory.cpp
  products/gym/adapters/postgres/PgLogRepository.cpp
  products/gym/adapters/postgres/PgCatalogRepository.cpp
  products/gym/adapters/postgres/PgProgramRepository.cpp
  products/gym/adapters/postgres/PgAskThreadRepository.cpp
  products/gym/adapters/postgres/PgPreferencesRepository.cpp
  products/gym/adapters/postgres/PgNotesRepository.cpp
  products/gym/adapters/postgres/PgBodyweightRepository.cpp
  products/gym/adapters/http/TrainingHistoryApi.cpp
  products/gym/adapters/http/TrainingApi.cpp
  products/gym/adapters/http/CatalogApi.cpp
  products/gym/adapters/http/ProgramApi.cpp
  products/gym/adapters/http/PreferencesApi.cpp
  products/gym/adapters/http/NotesApi.cpp
  products/gym/adapters/http/BodyweightApi.cpp
  products/gym/adapters/http/ThreadsApi.cpp
  products/gym/adapters/http/CoachImage.cpp
  products/gym/adapters/http/AskApi.cpp
  products/gym/adapters/llm/AnthropicAsk.cpp
  products/gym/adapters/mcp/GymTools.cpp
  products/gym/adapters/mcp/GymToolCatalog.cpp
  products/gym/application/AskService.cpp
  products/gym/routes.cpp)

# One process serves REST, the collab socket, AND MCP over the same rooms. main.cpp is the
# composition root: it builds platform + roadmap singletons, mounts the shared MCP endpoint, and
# calls roadmap::registerRoutes for the product half (products/roadmap/routes.h).
add_executable(windmill_server platform/infra/main.cpp)
target_link_libraries(windmill_server PRIVATE windmill_roadmap windmill_journal windmill_gym windmill_product_sync)

# The real composition with a harness-controlled clock; never copied to the runtime image.
add_executable(windmill_server_test_clock platform/infra/main.cpp)
target_compile_definitions(windmill_server_test_clock PRIVATE WM_TEST_CLOCK=1)
target_link_libraries(windmill_server_test_clock PRIVATE windmill_roadmap windmill_journal windmill_gym windmill_product_sync)

find_package(Python3 COMPONENTS Interpreter REQUIRED)
add_test(NAME gym_differential COMMAND ${Python3_EXECUTABLE}
  ${CMAKE_SOURCE_DIR}/test/e2e/gym_write_differential_test.py)

# The same server with the sync engine over the probe product (db/probe.sql): the test and dev stack's
# server, never the image's. main.cpp refuses to start it where WINDMILL_APP_URL is https.
add_executable(windmill_server_probe platform/infra/main.cpp)
target_compile_definitions(windmill_server_probe PRIVATE WM_SYNC_PROBE=1)
target_link_libraries(windmill_server_probe PRIVATE windmill_roadmap windmill_journal windmill_gym windmill_probe windmill_product_sync)

add_executable(windmill_mcp platform/infra/mcp_main.cpp)            # stdio transport (local hosts)
target_link_libraries(windmill_mcp PRIVATE windmill_roadmap)

add_executable(windmill_mcp_http platform/infra/mcp_http_main.cpp)  # standalone HTTP transport: windmill_server serves MCP in prod, and this still ships in the image for local/single-purpose runs (Dockerfile builds, smoke-tests and installs it)
target_link_libraries(windmill_mcp_http PRIVATE windmill_roadmap)

add_executable(windmill_gym_backfill platform/infra/gym_backfill_main.cpp)
target_link_libraries(windmill_gym_backfill PRIVATE windmill_gym_sync)

add_executable(windmill_gym_snapshot platform/infra/gym_snapshot_main.cpp)
target_link_libraries(windmill_gym_snapshot PRIVATE windmill_gym)

add_executable(windmill_gym_rehearsal_seed platform/infra/gym_rehearsal_seed_main.cpp)
target_link_libraries(windmill_gym_rehearsal_seed PRIVATE windmill_gym)

add_executable(windmill_mcp_tests
  test/http_main.cpp
  test/platform/adapters/mcp/McpServerTest.cpp
  test/platform/adapters/mcp/McpHttpEndpointTest.cpp
  test/platform/adapters/mcp/CompositeToolHostTest.cpp
  test/platform/adapters/mcp/ToolAnnotationsTest.cpp
  test/products/roadmap/adapters/mcp/RoadmapToolsTest.cpp
  test/products/roadmap/adapters/mcp/ToolErrorContractTest.cpp
  test/products/roadmap/adapters/mcp/WireCorpusTest.cpp
  test/products/gym/adapters/mcp/GymToolsTest.cpp)
# Both products' tool surfaces link here: the gym suite pins its own catalog AND that no gym name
# collides with a roadmap one, which is the difference between a boot failure and a green suite.
target_link_libraries(windmill_mcp_tests PRIVATE windmill_roadmap windmill_gym)
# The golden MCP wire (WireCorpusTest) lives beside the roadmap tools and is byte-compared against
# a fresh transcript; the source path is handed in so the check finds it from any build tree.
target_compile_definitions(windmill_mcp_tests PRIVATE
  WM_WIRE_CORPUS_PATH="${CMAKE_SOURCE_DIR}/products/roadmap/adapters/mcp/golden/wire_corpus.json")
add_test(NAME mcp COMMAND windmill_mcp_tests)

# The probe's Postgres adapter and the dev stack's endpoints, on the probe library (never linked into windmill_server).
target_sources(windmill_probe PRIVATE
  products/probe/adapters/postgres/PgProbe.cpp
  products/probe/adapters/http/DevApi.cpp)

# The sync engine over Postgres alone, so `ctest -R sync` runs it without every product's Pg suite. Its
# cases use WM_SYNC_DATABASE_URL, isolated from the REST adapters' DATABASE_URL, with schema.sql,
# probe.sql, gym_sync.sql and journal_sync.sql applied. They skip unless WM_PG_TEST is set.
add_executable(windmill_sync_tests
  test/http_main.cpp
  test/platform/adapters/http/SyncApiTest.cpp
  test/platform/adapters/postgres/PgSyncCorpusTest.cpp
  test/platform/adapters/postgres/PgSyncStoreTest.cpp
  test/platform/adapters/postgres/PgAdmissionConcurrencyTest.cpp
  test/platform/adapters/postgres/PgPullSnapshotTest.cpp
  test/products/probe/adapters/postgres/PgProbeTest.cpp
  test/products/gym/sync/adapters/postgres/PgGymTest.cpp
  test/products/gym/sync/adapters/postgres/PgGymBackfillTest.cpp
  test/products/journal/sync/adapters/postgres/PgJournalTest.cpp
  test/products/journal/sync/adapters/postgres/PgJournalBackfillTest.cpp)
target_sources(windmill_gym_sync PRIVATE
  products/gym/sync/adapters/postgres/PgGym.cpp
  products/gym/sync/adapters/postgres/PgGymBackfill.cpp)
target_link_libraries(windmill_sync_tests PRIVATE windmill_probe windmill_product_sync windmill_journal)
target_compile_definitions(windmill_sync_tests PRIVATE
  WM_SYNC_CONTRACT_DIR="${WM_API_CONTRACT_DIR}/sync"
  WM_PG_TEST_URL_ENV="WM_SYNC_DATABASE_URL")
add_test(NAME sync COMMAND windmill_sync_tests)

add_executable(windmill_adapters_tests
  test/http_main.cpp
  test/platform/adapters/http/AuthApiTest.cpp
  test/platform/adapters/http/OAuthApiTest.cpp
  test/platform/adapters/http/McpKeyApiTest.cpp
  test/platform/adapters/http/EventsApiTest.cpp
  test/platform/adapters/http/FeedbackApiTest.cpp
  test/platform/adapters/http/RateLimiterTest.cpp
  test/platform/adapters/http/VendorCallTest.cpp
  test/platform/adapters/http/AccessLogTest.cpp
  test/third_party/drogon/PatchesTest.cpp
  test/platform/adapters/crypto/OpenSslTokenGeneratorTest.cpp
  test/platform/adapters/email/ResendEmailSenderTest.cpp
  test/platform/adapters/email/ResendSignatureTest.cpp
  test/platform/adapters/email/ResendWebhookApiTest.cpp
  test/platform/adapters/oidc/IdTokenTest.cpp
  test/platform/adapters/sentry/LogTeeTest.cpp
  test/platform/adapters/paddle/PaddleSignatureTest.cpp
  test/platform/adapters/paddle/BillingApiTest.cpp
  test/platform/adapters/amplitude/AmplitudeUsageSinkTest.cpp
  test/platform/adapters/amplitude/AmplitudeClientTest.cpp
  test/platform/adapters/postgres/PgAiUsageRepositoryTest.cpp
  test/platform/adapters/postgres/PgAuthRepositoryTest.cpp
  test/platform/adapters/postgres/PgPoolTest.cpp
  test/platform/adapters/postgres/PgSubscriptionRepositoryTest.cpp
  test/products/roadmap/adapters/json/SubgraphJsonTest.cpp
  test/products/roadmap/adapters/json/TreeJsonTest.cpp
  test/products/roadmap/adapters/json/CommandJsonTest.cpp
  test/products/roadmap/adapters/postgres/PgProgressRepositoryTest.cpp
  test/products/roadmap/adapters/postgres/PgOpLogTest.cpp
  test/products/roadmap/adapters/http/ComposeApiTest.cpp
  test/products/roadmap/adapters/http/HttpApiTest.cpp
  test/products/roadmap/adapters/http/SharePageApiTest.cpp
  test/products/roadmap/adapters/http/GalleryApiTest.cpp
  test/products/roadmap/adapters/http/OgImageApiTest.cpp
  test/products/roadmap/adapters/http/OgVideoApiTest.cpp
  test/products/roadmap/adapters/http/TreeRegistryApiTest.cpp
  test/products/roadmap/adapters/http/RemindersApiTest.cpp
  test/products/roadmap/adapters/ws/CollabTest.cpp
  test/platform/adapters/llm/AgentLoopTest.cpp
  test/platform/adapters/llm/AnthropicStreamTest.cpp
  test/products/roadmap/adapters/llm/AnthropicComposerTest.cpp
  test/products/roadmap/adapters/llm/AnthropicAgentTest.cpp
  test/products/journal/adapters/http/JournalApiTest.cpp
  test/products/journal/adapters/http/NudgeApiTest.cpp
  test/products/journal/adapters/http/EchoApiTest.cpp
  test/products/journal/adapters/http/VoiceApiTest.cpp
  test/products/journal/adapters/llm/AnthropicCuratorTest.cpp
test/products/journal/adapters/llm/AnthropicSegmenterTest.cpp
  test/products/journal/adapters/postgres/PgJournalRepositoryTest.cpp
  test/products/journal/adapters/postgres/PgEchoRepositoryTest.cpp
  test/products/gym/sync/adapters/postgres/GymTrainingDoorTest.cpp
  test/products/gym/sync/adapters/postgres/GymAdoptionDoorTest.cpp
  test/products/gym/sync/adapters/postgres/GymRecordDoorTest.cpp
  test/products/gym/adapters/http/GymDoorApiTest.cpp
  test/products/gym/adapters/http/GymFreezeTest.cpp
  test/products/gym/adapters/http/TrainingApiTest.cpp
  test/products/gym/adapters/http/CatalogApiTest.cpp
  test/products/gym/adapters/http/ProgramApiTest.cpp
  test/products/gym/adapters/http/PreferencesApiTest.cpp
  test/products/gym/adapters/http/NotesApiTest.cpp
  test/products/gym/adapters/http/BodyweightApiTest.cpp
  test/products/gym/adapters/http/ThreadsApiTest.cpp
  test/products/gym/adapters/http/AskApiTest.cpp
  test/products/gym/adapters/llm/AnthropicAskTest.cpp
  test/products/gym/application/AskServiceTest.cpp
  test/products/gym/adapters/postgres/PgLogHistoryTest.cpp
  test/products/gym/adapters/postgres/PgLogRepositoryTest.cpp
  test/products/gym/adapters/postgres/PgCatalogRepositoryTest.cpp
  test/products/gym/adapters/postgres/PgProgramRepositoryTest.cpp
  test/products/gym/adapters/postgres/PgAskThreadRepositoryTest.cpp
  test/products/gym/adapters/postgres/PgPreferencesRepositoryTest.cpp
  test/products/gym/adapters/postgres/PgNotesRepositoryTest.cpp
  test/products/gym/adapters/postgres/PgBodyweightRepositoryTest.cpp)
target_link_libraries(windmill_adapters_tests PRIVATE windmill_roadmap windmill_journal windmill_gym windmill_product_sync)
add_test(NAME adapters COMMAND windmill_adapters_tests)
