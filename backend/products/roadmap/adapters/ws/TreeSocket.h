#pragma once

#include <drogon/HttpFilter.h>
#include <drogon/WebSocketController.h>

namespace wm {

// The upgrade to /v1/socket, before the connection upgrades: what collab() admits (Collab::admit). Drogon creates it by
// the name TreeSocket's path list gives.
class TreeUpgradeGate : public drogon::HttpFilter<TreeUpgradeGate> {
public:
  void doFilter(const drogon::HttpRequestPtr& req, drogon::FilterCallback&& refuse, drogon::FilterChainCallback&& pass) override;
};

class TreeSocket : public drogon::WebSocketController<TreeSocket, false> {
public:
  void handleNewConnection(const drogon::HttpRequestPtr& req,
                           const drogon::WebSocketConnectionPtr& conn) override;
  void handleNewMessage(const drogon::WebSocketConnectionPtr& conn, std::string&& message,
                        const drogon::WebSocketMessageType& type) override;
  void handleConnectionClosed(const drogon::WebSocketConnectionPtr& conn) override;

  WS_PATH_LIST_BEGIN
  WS_PATH_ADD("/v1/socket", "wm::TreeUpgradeGate");
  WS_PATH_LIST_END
};

// Makes the controller live at /v1/socket, each connection served through collab(). Call once, before app().run(), and
// only where roadmap's rooms serve: where the engine serves roadmap's scopes the path is retired (routes.cpp).
void installTreeSocket();

}
