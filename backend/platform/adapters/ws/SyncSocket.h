#pragma once

#include "platform/application/AuthService.h"
#include "platform/application/WorkerPool.h"
#include "platform/application/sync/SyncLive.h"
#include "platform/ports/Clock.h"

#include <drogon/HttpFilter.h>
#include <drogon/WebSocketController.h>

#include <cstdint>
#include <memory>
#include <set>
#include <string>

namespace wm::sync {

struct SyncSocketDeps {
  std::shared_ptr<SyncLive> live;
  std::shared_ptr<WorkerPool> workers;
  std::shared_ptr<AuthService> auth;
  std::shared_ptr<Clock> clock;
  // The set main.cpp composes for CORS, so the socket and the JSON API agree on who may call from a browser.
  std::set<std::string> allowedOrigins;
  // The registry's minVersion, and the epoch a refused upgrade carries (§9.1), as SyncDeps holds them.
  std::int64_t minSchema = 1;
  std::string epoch;
};

// Makes the controller live at /v1/sync/live and starts the session re-proof heartbeat. Call once, before app().run().
void installSyncSocket(SyncSocketDeps deps);
// Referenced from main so the static WS registration in SyncSocket.cpp is not dropped by the linker.
void linkSyncSocket();

// §9.1 and §9.5 on the upgrade to /v1/sync/live?schema=<version>, before the connection upgrades: the version is
// the query parameter `schema` alone, since a browser WebSocket cannot send headers, as Drogon presents it (the
// last value of a repeated one). One that is missing or not a decimal integer is answered 400 malformed, one below
// minSchema 426 upgrade-required. Drogon creates the gate by the name SyncSocket's path list gives.
class SyncSchemaGate : public drogon::HttpFilter<SyncSchemaGate> {
public:
  void doFilter(const drogon::HttpRequestPtr& req, drogon::FilterCallback&& refuse, drogon::FilterChainCallback&& pass) override;
};

// §9.5 WebSocket /v1/sync/live: a thin door onto SyncLive, which decides everything. Only ping is answered on the
// IO thread; the principal, sub, unsub and close run on the connection's strand of the worker pool.
class SyncSocket : public drogon::WebSocketController<SyncSocket> {
public:
  void handleNewConnection(const drogon::HttpRequestPtr& req, const drogon::WebSocketConnectionPtr& conn) override;
  void handleNewMessage(const drogon::WebSocketConnectionPtr& conn, std::string&& message, const drogon::WebSocketMessageType& type) override;
  void handleConnectionClosed(const drogon::WebSocketConnectionPtr& conn) override;

  WS_PATH_LIST_BEGIN
  WS_PATH_ADD("/v1/sync/live", "wm::sync::SyncSchemaGate");
  WS_PATH_LIST_END
};

}
