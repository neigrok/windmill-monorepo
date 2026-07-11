#pragma once

#include "domain/Ids.h"
#include "domain/Tree.h"

#include <drogon/WebSocketConnection.h>

#include <json/json.h>

#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <string>

namespace wm {

// Class C presence (§5): ephemeral cursor/selection, never persisted, never in the op
// log. Each participant's latest state is buffered and flushed to the tree's other
// participants at ≤ 20 Hz (latest-wins per actor, deltas only — §12), so a 60 Hz cursor
// stream costs at most 20 frames/sec per peer. Join/leave are announced so a peer's
// cursor appears and is removed on cue. Profiles are assigned here for now (one colour
// per actor); real display names/colours arrive with accounts (Phase 1).
class PresenceHub {
public:
  void join(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree);
  void update(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree, const Json::Value& frame);
  void leave(const drogon::WebSocketConnectionPtr& conn);
  void flush();  // driven by a 20 Hz timer; sends each moved participant's latest state

private:
  struct Member {
    UserId actor;
    std::string name;
    std::string color;
    std::optional<Vec2> cursor;         // world coords, already projected by the client
    std::optional<std::string> selection;
    bool moved = false;                 // has fresh cursor/selection to send on next flush
  };

  Json::Value presenceFrame(const std::string& tree, const Member& member) const;
  Json::Value peerFrame(const std::string& tree, const Member& member, const char* event) const;

  mutable std::mutex mutex_;
  std::map<std::string, std::map<drogon::WebSocketConnectionPtr, Member>> byTree_;
};

}
