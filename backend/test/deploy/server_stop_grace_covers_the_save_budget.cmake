# A deploy replaces the server's container: Docker sends SIGTERM, waits the service's stop_grace_period, then kills it. The
# server stops within its own budget for the saves still to run, plus one statement already running at the signal, so
# the grace period must be longer than both together with a second to spare (deploy/README.md).
# Run: cmake -DCOMPOSE=<docker-compose.yml> -DREGISTRY=<RoomRegistry.h> -DPOOL=<PgPool.h> -P <this file>.
foreach(input COMPOSE REGISTRY POOL)
  if(NOT EXISTS "${${input}}")
    message(FATAL_ERROR "No file at ${${input}}")
  endif()
endforeach()

file(READ "${REGISTRY}" registry)
if(NOT registry MATCHES "kShutdownSaveBudget{([0-9]+)}")
  message(FATAL_ERROR "RoomRegistry.h no longer states kShutdownSaveBudget in milliseconds")
endif()
set(budget_ms "${CMAKE_MATCH_1}")

file(READ "${POOL}" pool)
string(REPLACE "'" "" pool "${pool}")
if(NOT pool MATCHES "kStatementTimeout{([0-9]+)}")
  message(FATAL_ERROR "PgPool.h no longer states kStatementTimeout in milliseconds")
endif()
set(statement_ms "${CMAKE_MATCH_1}")

# The grace period of the `server` service alone: the first one stated after its key, before the next service's.
file(STRINGS "${COMPOSE}" lines)
set(in_server FALSE)
set(grace_ms "")
foreach(line IN LISTS lines)
  if(line MATCHES "^  ([a-z_-]+):[ \t]*$")
    if(CMAKE_MATCH_1 STREQUAL "server")
      set(in_server TRUE)
    else()
      set(in_server FALSE)
    endif()
  elseif(in_server AND line MATCHES "^    stop_grace_period:[ \t]*([0-9]+)s[ \t]*$")
    math(EXPR grace_ms "${CMAKE_MATCH_1} * 1000")
  endif()
endforeach()
if(grace_ms STREQUAL "")
  message(FATAL_ERROR "The server service states no stop_grace_period in whole seconds: Compose would give it its default")
endif()

math(EXPR needed_ms "${budget_ms} + ${statement_ms} + 1000")
if(grace_ms LESS needed_ms)
  message(FATAL_ERROR "stop_grace_period is ${grace_ms} ms, and the server may take ${needed_ms} ms to stop: "
                      "its save budget ${budget_ms} ms, a running statement ${statement_ms} ms, and a second")
endif()
message(STATUS "stop_grace_period ${grace_ms} ms covers the ${needed_ms} ms the server may take to stop")
