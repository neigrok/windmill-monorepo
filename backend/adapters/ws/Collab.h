#pragma once

#include "adapters/ws/PresenceHub.h"
#include "adapters/ws/WsPresenceBus.h"
#include "application/AuthService.h"
#include "application/ProgressService.h"
#include "application/RoomRegistry.h"
#include "ports/Clock.h"
#include "ports/OpLog.h"

#include <drogon/HttpRequest.h>
#include <drogon/WebSocketConnection.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace wm {

// Coordinates the socket layer with the rooms: subscribe → snapshot, cmd → merge +
// broadcast, presence → relay. A single mutex serializes room access — a coarse
// stand-in for the per-tree strand (§11) until rooms get real strands.
class Collab {
public:
  Collab(RoomRegistry& registry, OpLog& ops, WsPresenceBus& bus,
         ProgressService& progress, AuthService& auth, PresenceHub& presence, Clock& clock);

  void onOpen(const drogon::HttpRequestPtr& req, const drogon::WebSocketConnectionPtr& conn);
  void onMessage(const drogon::WebSocketConnectionPtr& conn, const std::string& text);
  void onClose(const drogon::WebSocketConnectionPtr& conn);

private:
  void subscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame);
  // How often an open socket re-proves its session on a write. A revoked session keeps writing for
  // at most this long, which is the trade against a database lookup per edit.
  static constexpr std::uint64_t kRevalidateEveryMs = 60000;

  bool stillAuthorized(const drogon::WebSocketConnectionPtr& conn);
  void subgraphFrame(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame);
  void progress(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame);
  bool overRate(const drogon::WebSocketConnectionPtr& conn);  // per-connection message-rate gate

  RoomRegistry& registry_;
  OpLog& ops_;
  WsPresenceBus& bus_;
  ProgressService& progress_;
  AuthService& auth_;  // resolves the wm_session cookie / bearer at the socket upgrade
  PresenceHub& presence_;
  Clock& clock_;  // wall time for the room's HLC; the room owns the clock, this feeds it now
  std::atomic<std::uint64_t> actorSeq_{0};

  // Per-connection message-rate bucket, so one socket can't flood the write path. Keyed by
  // the connection pointer; created on open, erased on close.
  struct WsRate { double tokens; std::chrono::steady_clock::time_point seen; };
  std::mutex wsMutex_;
  std::unordered_map<const void*, WsRate> wsRate_;
};

void setCollab(std::shared_ptr<Collab> collab);
Collab* collab();

}
