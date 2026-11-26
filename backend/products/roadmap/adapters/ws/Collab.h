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
#include <drogon/HttpResponse.h>
#include <drogon/WebSocketConnection.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

namespace wm {

// Coordinates the socket layer with the rooms: subscribe → snapshot, cmd → merge + broadcast,
// presence → relay.
class Collab {
public:
  // `allowedOrigins` is the same set main.cpp composes for CORS, so the socket and the JSON API
  // can never disagree about who may talk to this server from a browser. `trees` names a subtree in its subscribe
  // answer, read through its parent.
  Collab(RoomRegistry& registry, TreeRepository& trees, OpLog& ops, WsPresenceBus& bus,
         ProgressService& progress, AuthService& auth, PresenceHub& presence, Clock& clock,
         std::set<std::string> allowedOrigins);
  ~Collab() { stop(); }
  void stop() { reprove_.stop(); }

  // The upgrade's gate (TreeUpgradeGate), before the connection upgrades: a stated origin off the allow-list answers 403,
  // since a WebSocket upgrade gets no CORS preflight, and credentials the rule refuses answer 401 (SentCaller), each with one
  // WARN line under `roadmap.ws.upgrade`. Otherwise it leaves the caller on `req` for onOpen and the access line.
  std::optional<drogon::HttpResponsePtr> admit(const drogon::HttpRequestPtr& req);
  // Opens a socket the gate admitted, as its caller or, for none or one lapsed credential, as a read-only guest; any other
  // connection is closed.
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
  // What may this connection still receive of this tree? A verdict and never a lookup: a fan-out
  // runs it under the tree's strand, so it must not touch the database.
  Reach reachOf(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree);
  void subgraphFrame(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame);
  // The reject of a frame that deletes owning steps without naming their subtrees, each branch with its size.
  Json::Value branchUnconfirmed(const std::string& treeId, const std::vector<UnconfirmedBranch>& unconfirmed);
  void progress(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame);
  bool overRate(const drogon::WebSocketConnectionPtr& conn);

  RoomRegistry& registry_;
  TreeRepository& trees_;
  OpLog& ops_;
  WsPresenceBus& bus_;
  ProgressService& progress_;
  AuthService& auth_;
  PresenceHub& presence_;
  Clock& clock_;
  std::set<std::string> allowedOrigins_;

  static constexpr double kReproveEverySeconds = 15.0;
  std::atomic<std::uint64_t> actorSeq_{0};

  struct WsRate { double tokens; std::chrono::steady_clock::time_point seen; };
  std::mutex wsMutex_;
  std::unordered_map<const void*, WsRate> wsRate_;
  Heartbeat reprove_;
};

void setCollab(std::shared_ptr<Collab> collab);
void stopCollab();
Collab* collab();

}
