cmake_minimum_required(VERSION 3.20)
project(windmill_backend CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(windmill_domain
  domain/LooseGraph.cpp
  domain/Legend.cpp
  domain/Subgraph.cpp
  domain/Command.cpp
  domain/NodeQuery.cpp
  domain/TreeDiagnostics.cpp
  domain/SkillTree.cpp
  domain/TrunkTree.cpp
  domain/UnlockRules.cpp
  domain/TreeHealth.cpp
  domain/TreeSummary.cpp
  domain/Auth.cpp
  domain/OAuth.cpp)
target_include_directories(windmill_domain PUBLIC ${CMAKE_SOURCE_DIR})

add_library(windmill_application
  application/TreeRoom.cpp
  application/RoomRegistry.cpp
  application/ProgressService.cpp
  application/ActivityFeed.cpp
  application/AuthService.cpp
  application/ForkService.cpp
  application/McpKeyService.cpp
  application/OAuthService.cpp
  application/TreeRegistry.cpp)
target_link_libraries(windmill_application PUBLIC windmill_domain)

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
  test/application/TreeRegistryTest.cpp
  test/application/ForkServiceTest.cpp
  test/application/TreeRoomTest.cpp
  test/application/RoomRegistryTest.cpp
  test/application/ProgressServiceTest.cpp
  test/application/ActivityFeedTest.cpp
  test/domain/AuthTest.cpp
  test/application/AuthServiceTest.cpp
  test/domain/OAuthTest.cpp
  test/application/OAuthServiceTest.cpp
  test/application/McpKeyServiceTest.cpp)
target_link_libraries(windmill_domain_tests PRIVATE windmill_application)

enable_testing()
add_test(NAME domain COMMAND windmill_domain_tests)

# Real adapters (SPEC §11). Guarded: the core library + tests always build; the server
# target appears only once Drogon and libpqxx are installed (brew install drogon libpqxx).
find_package(Drogon CONFIG QUIET)
find_package(libpqxx CONFIG QUIET)
find_package(OpenSSL QUIET)  # magic-link token entropy + digests (adapters/crypto)

if(Drogon_FOUND AND libpqxx_FOUND)
  add_library(windmill_adapters
    adapters/json/TreeJson.cpp
    adapters/json/SubgraphJson.cpp
    adapters/json/CommandJson.cpp
    adapters/postgres/PgTreeRepository.cpp
    adapters/postgres/PgProgressRepository.cpp
    adapters/postgres/PgOpLog.cpp
    adapters/postgres/PgAuthRepository.cpp
    adapters/postgres/PgOAuthRepository.cpp
    adapters/postgres/PgMcpKeyRepository.cpp
    adapters/postgres/PgEventRepository.cpp
    adapters/postgres/PgFeedbackRepository.cpp
    adapters/http/HttpApi.cpp
    adapters/http/SharePageApi.cpp
    adapters/http/AuthApi.cpp
    adapters/http/McpKeyApi.cpp
    adapters/http/EventsApi.cpp
    adapters/http/FeedbackApi.cpp
    adapters/http/ComposeApi.cpp
    adapters/http/OAuthApi.cpp
    adapters/http/Caller.cpp
    adapters/http/TreeRegistryApi.cpp
    adapters/crypto/OpenSslTokenGenerator.cpp
    adapters/email/ResendEmailSender.cpp
    adapters/llm/AnthropicComposer.cpp
    adapters/ws/WsPresenceBus.cpp
    adapters/ws/PresenceHub.cpp
    adapters/ws/Collab.cpp
    adapters/ws/TreeSocket.cpp)
  target_link_libraries(windmill_adapters PUBLIC windmill_application Drogon::Drogon libpqxx::pqxx OpenSSL::Crypto)

  # MCP adapter (SPEC §11 boundary): a first-class edge onto the same application core, so
  # an AI agent authors roadmaps through the rooms exactly as HTTP/WS clients do. The engine
  # (McpServer) is transport-agnostic; stdio and Streamable-HTTP are two thin transports.
  # Defined before windmill_server so the server can mount the HTTP transport in-process —
  # one RoomRegistry for REST, the socket, and MCP (a tree has a single live room).
  add_library(windmill_mcp_lib
    adapters/mcp/McpServer.cpp
    adapters/mcp/RoadmapTools.cpp
    adapters/mcp/McpHttpEndpoint.cpp)
  target_link_libraries(windmill_mcp_lib PUBLIC windmill_adapters)

  # One process serves REST, the collab socket, AND MCP over the same rooms.
  add_executable(windmill_server infra/main.cpp)
  target_link_libraries(windmill_server PRIVATE windmill_mcp_lib)
  message(STATUS "windmill_server enabled (Drogon + libpqxx found)")

  add_executable(windmill_mcp infra/mcp_main.cpp)               # stdio transport (local hosts)
  target_link_libraries(windmill_mcp PRIVATE windmill_mcp_lib)

  add_executable(windmill_mcp_http infra/mcp_http_main.cpp)     # standalone HTTP transport (legacy; now folded into windmill_server)
  target_link_libraries(windmill_mcp_http PRIVATE windmill_mcp_lib)

  add_executable(windmill_mcp_tests
    test/main.cpp
    test/adapters/mcp/McpServerTest.cpp
    test/adapters/mcp/RoadmapToolsTest.cpp
    test/adapters/mcp/McpHttpEndpointTest.cpp)
  target_link_libraries(windmill_mcp_tests PRIVATE windmill_mcp_lib)
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
    test/adapters/http/TreeRegistryApiTest.cpp
    test/adapters/ws/CollabTest.cpp
    test/adapters/email/ResendEmailSenderTest.cpp
    test/adapters/llm/AnthropicComposerTest.cpp)
  target_link_libraries(windmill_adapters_tests PRIVATE windmill_adapters)
  add_test(NAME adapters COMMAND windmill_adapters_tests)
else()
  message(STATUS "Drogon/libpqxx not found — building core + tests only; run 'brew install drogon libpqxx' to enable windmill_server")
endif()
