cmake_minimum_required(VERSION 3.20)
project(windmill_backend CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(windmill_domain
  domain/LooseGraph.cpp
  domain/Command.cpp
  domain/TreeDiagnostics.cpp
  domain/SkillTree.cpp
  domain/TrunkTree.cpp
  domain/UnlockRules.cpp
  domain/TreeHealth.cpp)
target_include_directories(windmill_domain PUBLIC ${CMAKE_SOURCE_DIR})

add_library(windmill_application
  application/TreeRoom.cpp
  application/RoomRegistry.cpp
  application/ProgressService.cpp
  application/ActivityFeed.cpp
  application/UndoService.cpp)
target_link_libraries(windmill_application PUBLIC windmill_domain)

add_executable(windmill_domain_tests
  test/main.cpp
  test/domain/LooseGraphTest.cpp
  test/domain/CommandTest.cpp
  test/domain/TreeDiagnosticsTest.cpp
  test/domain/SkillTreeTest.cpp
  test/domain/TrunkTreeTest.cpp
  test/domain/UnlockRulesTest.cpp
  test/domain/TreeHealthTest.cpp
  test/application/TreeRoomTest.cpp
  test/application/RoomRegistryTest.cpp
  test/application/ProgressServiceTest.cpp
  test/application/ActivityFeedTest.cpp
  test/application/UndoServiceTest.cpp)
target_link_libraries(windmill_domain_tests PRIVATE windmill_application)

enable_testing()
add_test(NAME domain COMMAND windmill_domain_tests)

# Real adapters (SPEC §11). Guarded: the core library + tests always build; the server
# target appears only once Drogon and libpqxx are installed (brew install drogon libpqxx).
find_package(Drogon CONFIG QUIET)
find_package(libpqxx CONFIG QUIET)

if(Drogon_FOUND AND libpqxx_FOUND)
  add_library(windmill_adapters
    adapters/json/TreeJson.cpp
    adapters/json/CommandJson.cpp
    adapters/postgres/PgTreeRepository.cpp
    adapters/postgres/PgProgressRepository.cpp
    adapters/postgres/PgOpLog.cpp
    adapters/http/HttpApi.cpp
    adapters/ws/WsPresenceBus.cpp
    adapters/ws/PresenceHub.cpp
    adapters/ws/Collab.cpp
    adapters/ws/TreeSocket.cpp)
  target_link_libraries(windmill_adapters PUBLIC windmill_application Drogon::Drogon libpqxx::pqxx)

  add_executable(windmill_server infra/main.cpp)
  target_link_libraries(windmill_server PRIVATE windmill_adapters)
  message(STATUS "windmill_server enabled (Drogon + libpqxx found)")
else()
  message(STATUS "Drogon/libpqxx not found — building core + tests only; run 'brew install drogon libpqxx' to enable windmill_server")
endif()
