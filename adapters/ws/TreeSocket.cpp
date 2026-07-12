#include "adapters/ws/TreeSocket.h"

#include "adapters/ws/Collab.h"

namespace wm {

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

void linkTreeSocket() {}

}
