#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <drogon/WebSocketConnection.h>

#include <json/json.h>

#include <cstddef>
#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <string>

namespace wm {

// What a socket connection is, resolved once at the upgrade and stored in its context: the
// acting user (a real account id when authenticated, a synthetic guest id otherwise) and
// whether it is authenticated. Anonymous connections may read and show presence; only
// authenticated ones may write.
struct Principal {
  UserId user;
  bool authenticated = false;
  // The display name this connection may show to others — empty for a guest, and empty too for an
  // account still wearing the name we derived from its address (§sharableName). Resolved here, at
  // the one place that knows who the connection is, rather than guessed downstream from the id.
  std::string name;
  // A socket outlives the request that opened it, so the session that authorized it can be revoked
  // — signed out everywhere, or the account closed — while the connection keeps writing. The digest
  // (never the secret) is kept so a writer can re-prove its session; checkedAtMs throttles that to
  // one lookup a minute rather than one per edit.
  std::string sessionDigest;
  std::uint64_t checkedAtMs = 0;
};

// Class C presence (§5): ephemeral cursor/selection, never persisted, never in the op
// log. Each participant's latest state is buffered and flushed to the tree's other
// participants at ≤ 20 Hz (latest-wins per actor, deltas only — §12), so a 60 Hz cursor
// stream costs at most 20 frames/sec per peer. Join/leave are announced so a peer's
// cursor appears and is removed on cue. Colour is assigned here, one hash-derived hue per
// actor. The name is not: an account that chose a display name wears it (`Principal::name`,
// resolved once at the upgrade), and everyone else gets a generated traveller's name.
class PresenceHub {
public:
  void join(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree);
  void update(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree, const Json::Value& frame);
  void leave(const drogon::WebSocketConnectionPtr& conn);
  void flush();  // driven by a 20 Hz timer; sends each moved participant's latest state

private:
  // Cap fan-out on a crowded tree: past this many members a newcomer is not tracked.
  static constexpr std::size_t kMaxMembersPerTree = 200;

  struct Member {
    UserId actor;
    std::string name;
    std::string color;
    std::optional<Vec2> cursor;         // world coords, already projected by the client
    std::optional<std::string> selection;
    bool moved = false;                 // has fresh cursor/selection to send on next flush
  };

  std::string guestName(const UserId& actor, const std::map<drogon::WebSocketConnectionPtr, Member>& members) const;
  Json::Value presenceFrame(const std::string& tree, const Member& member) const;
  Json::Value peerFrame(const std::string& tree, const Member& member, const char* event) const;

  mutable std::mutex mutex_;
  std::map<std::string, std::map<drogon::WebSocketConnectionPtr, Member>> byTree_;
};

}
