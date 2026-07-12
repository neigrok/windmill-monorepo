#pragma once

#include "adapters/ws/PresenceHub.h"
#include "adapters/ws/WsPresenceBus.h"
#include "application/ProgressService.h"
#include "application/RoomRegistry.h"
#include "application/UndoService.h"
#include "ports/OpLog.h"

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
  Collab(RoomRegistry& registry, OpLog& ops, WsPresenceBus& bus, UndoService& undos,
         ProgressService& progress, UserId progressUser, PresenceHub& presence);

  void onOpen(const drogon::WebSocketConnectionPtr& conn);
  void onMessage(const drogon::WebSocketConnectionPtr& conn, const std::string& text);
  void onClose(const drogon::WebSocketConnectionPtr& conn);

private:
  void subscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, Seq lastSeq);
  void command(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame);
  void progress(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame);
  void undoRedo(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, bool isUndo);
  bool overRate(const drogon::WebSocketConnectionPtr& conn);  // per-connection message-rate gate

  RoomRegistry& registry_;
  OpLog& ops_;
  WsPresenceBus& bus_;
  UndoService& undos_;
  ProgressService& progress_;
  UserId progressUser_;  // fixed `dev` today; the authenticated user once accounts land (Phase 1)
  PresenceHub& presence_;
  std::atomic<std::uint64_t> tick_{1};  // first command HLC sorts after the genesis seed
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
