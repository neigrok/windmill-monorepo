#pragma once

#include "adapters/ws/WsPresenceBus.h"
#include "application/RoomRegistry.h"
#include "ports/OpLog.h"

#include <drogon/WebSocketConnection.h>

#include <atomic>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>

namespace wm {

// Coordinates the socket layer with the rooms: subscribe → snapshot, cmd → merge +
// broadcast, presence → relay. A single mutex serializes room access — a coarse
// stand-in for the per-tree strand (§11) until rooms get real strands.
class Collab {
public:
  Collab(RoomRegistry& registry, OpLog& ops, WsPresenceBus& bus);

  void onOpen(const drogon::WebSocketConnectionPtr& conn);
  void onMessage(const drogon::WebSocketConnectionPtr& conn, const std::string& text);
  void onClose(const drogon::WebSocketConnectionPtr& conn);

private:
  void subscribe(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, Seq lastSeq);
  void command(const drogon::WebSocketConnectionPtr& conn, const std::string& treeId, const Json::Value& frame);
  std::mutex& strandFor(const std::string& treeId);

  RoomRegistry& registry_;
  OpLog& ops_;
  WsPresenceBus& bus_;
  std::mutex strandsMutex_;
  std::map<std::string, std::unique_ptr<std::mutex>> strands_;  // one writer per tree (§11)
  std::atomic<std::uint64_t> tick_{1};  // first command HLC sorts after the genesis seed
  std::atomic<std::uint64_t> actorSeq_{0};
};

void setCollab(std::shared_ptr<Collab> collab);
Collab* collab();

}
