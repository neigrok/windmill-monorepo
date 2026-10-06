#pragma once

#include <drogon/WebSocketController.h>

namespace wm {

class TreeSocket : public drogon::WebSocketController<TreeSocket> {
public:
  void handleNewConnection(const drogon::HttpRequestPtr& req,
                           const drogon::WebSocketConnectionPtr& conn) override;
  void handleNewMessage(const drogon::WebSocketConnectionPtr& conn, std::string&& message,
                        const drogon::WebSocketMessageType& type) override;
  void handleConnectionClosed(const drogon::WebSocketConnectionPtr& conn) override;

  WS_PATH_LIST_BEGIN
  WS_PATH_ADD("/v1/socket");
  WS_PATH_LIST_END
};

// Referenced from registerRoutes so linking windmill_roadmap retains the static WS registration.
void linkTreeSocket();

}
