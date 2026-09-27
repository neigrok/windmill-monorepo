#pragma once

#include "platform/application/AuthService.h"
#include "platform/application/WorkerPool.h"
#include "platform/application/sync/SyncLive.h"
#include "platform/ports/Clock.h"

#include <drogon/WebSocketController.h>

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
};

// Makes the controller live at /v1/sync/live and starts the session re-proof heartbeat. Call once, before app().run().
void installSyncSocket(SyncSocketDeps deps);
// Referenced from main so the static WS registration in SyncSocket.cpp is not dropped by the linker.
void linkSyncSocket();

// §9.5 WebSocket /v1/sync/live: a thin door onto SyncLive, which decides everything. Only ping is answered on the
// IO thread; the principal, sub, unsub and close run on the connection's strand of the worker pool.
class SyncSocket : public drogon::WebSocketController<SyncSocket> {
public:
  void handleNewConnection(const drogon::HttpRequestPtr& req, const drogon::WebSocketConnectionPtr& conn) override;
  void handleNewMessage(const drogon::WebSocketConnectionPtr& conn, std::string&& message, const drogon::WebSocketMessageType& type) override;
  void handleConnectionClosed(const drogon::WebSocketConnectionPtr& conn) override;

  WS_PATH_LIST_BEGIN
  WS_PATH_ADD("/v1/sync/live");
  WS_PATH_LIST_END
};

}
