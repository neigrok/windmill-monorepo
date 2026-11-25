#include "products/roadmap/adapters/ws/TreeSocket.h"

#include "products/roadmap/adapters/ws/Collab.h"

#include <drogon/HttpAppFramework.h>

#include <memory>

namespace wm {

void TreeUpgradeGate::doFilter(const drogon::HttpRequestPtr& req, drogon::FilterCallback&& refuse, drogon::FilterChainCallback&& pass) {
  if (!collab()) return pass();
  if (const std::optional<drogon::HttpResponsePtr> refusal = collab()->admit(req)) return refuse(*refusal);
  pass();
}

void TreeSocket::handleNewConnection(const drogon::HttpRequestPtr& req, const drogon::WebSocketConnectionPtr& conn) {
  if (collab()) collab()->onOpen(req, conn);
}

void TreeSocket::handleNewMessage(const drogon::WebSocketConnectionPtr& conn, std::string&& message,
                                  const drogon::WebSocketMessageType& type) {
  if (type != drogon::WebSocketMessageType::Text) return;
  if (collab()) collab()->onMessage(conn, message);
}

void TreeSocket::handleConnectionClosed(const drogon::WebSocketConnectionPtr& conn) {
  if (collab()) collab()->onClose(conn);
}

void installTreeSocket() { drogon::app().registerController(std::make_shared<TreeSocket>()); }

}
