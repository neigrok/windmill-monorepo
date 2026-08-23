#pragma once

#include "platform/application/Heartbeat.h"
#include "products/roadmap/adapters/ws/PresenceHub.h"
#include "products/roadmap/adapters/ws/WsPresenceBus.h"
#include "platform/application/AuthService.h"
#include "products/roadmap/application/ProgressService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "platform/ports/Clock.h"
#include "products/roadmap/ports/OpLog.h"

#include <drogon/HttpRequest.h>
#include <drogon/WebSocketConnection.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <unordered_map>

namespace wm {

// Coordinates the socket layer with the rooms: subscribe → snapshot, cmd → merge + broadcast,
// presence → relay.
class Collab {
public:
  // `allowedOrigins` is the same set main.cpp composes for CORS, so the socket and the JSON API
  // can never disagree about who may talk to this server from a browser.
  Collab(RoomRegistry& registry, OpLog& ops, WsPresenceBus& bus,
         ProgressService& progress, AuthService& auth, PresenceHub& presence, Clock& clock,
         std::set<std::string> allowedOrigins);

  void onOpen(const drogon::HttpRequestPtr& req, const drogon::WebSocketConnectionPtr& conn);
  void onMessage(const drogon::WebSocketConnectionPtr& conn, const std::string& text);
  void onClose(const drogon::WebSocketConnectionPtr& conn);

  // One pass of the periodic reader re-proof: re-prove every open subscription's session, then
  // re-run the read gate over every tree that has one. It reaches the two revocations no broadcast
  // can carry — an idle tree, and presence. Public so a test can run exactly one pass.
  void reproveReaders();

private:
  void subscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame);
  // How often an open socket re-proves its session: a revoked session keeps writing for at most
  // this long, and keeps reading for at most this plus kReproveEverySeconds.
  static constexpr std::uint64_t kRevalidateEveryMs = 60000;

  bool stillAuthorized(const drogon::WebSocketConnectionPtr& conn);
  // May this connection still READ this tree? A verdict and never a lookup: a fan-out runs it
  // under the tree's strand, so it must not touch the database.
  bool mayRead(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree);
  void subgraphFrame(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame);
  void progress(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame);
  bool overRate(const drogon::WebSocketConnectionPtr& conn);

  RoomRegistry& registry_;
  OpLog& ops_;
  WsPresenceBus& bus_;
  ProgressService& progress_;
  AuthService& auth_;
  PresenceHub& presence_;
  Clock& clock_;
  std::set<std::string> allowedOrigins_;

  static constexpr double kReproveEverySeconds = 15.0;
  // Last, so it destructs first: its destructor joins the sweeper, which must happen while the
  // bus, the registry and the presence roster are still alive.
  Heartbeat reprove_;
  std::atomic<std::uint64_t> actorSeq_{0};

  struct WsRate { double tokens; std::chrono::steady_clock::time_point seen; };
  std::mutex wsMutex_;
  std::unordered_map<const void*, WsRate> wsRate_;
};

void setCollab(std::shared_ptr<Collab> collab);
Collab* collab();

}
