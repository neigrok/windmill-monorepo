#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"

#include <drogon/WebSocketConnection.h>

#include <json/json.h>

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <utility>

namespace wm {

// What a socket connection is, resolved once at the upgrade and stored in its context. The user
// is a real account id when authenticated, a synthetic guest id otherwise; anonymous connections
// may read and show presence, only authenticated ones may write.
struct Principal {
  Principal(UserId user, bool authenticated, std::string name, std::string sessionDigest,
            std::uint64_t checkedAtMs)
      : user(std::move(user)), authenticated(authenticated), name(std::move(name)),
        sessionDigest(std::move(sessionDigest)), checkedAtMs(checkedAtMs) {}

  // Written once, at the upgrade, and only read afterwards, so no synchronization is owed.
  const UserId user;
  // Empty for a guest, and for an account still wearing the name derived from its address.
  const std::string name;
  // The digest, never the secret, so a writer can re-prove its session; checkedAtMs throttles
  // that to one lookup a minute.
  const std::string sessionDigest;

  // Atomic: the sweeper thread narrows these while the connection's own thread reads them.
  std::atomic<bool> authenticated;
  std::atomic<std::uint64_t> checkedAtMs;
};

// Ephemeral cursor/selection, never persisted and never in the op log. Each participant's
// latest state is flushed to the tree's other participants at ≤ 20 Hz, latest-wins per actor,
// deltas only.
class PresenceHub {
public:
  void join(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree);
  void update(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree, const Json::Value& frame);
  void leave(const drogon::WebSocketConnectionPtr& conn);
  // Leave ONE room: a socket that may no longer read this tree may still belong in another.
  void leave(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree);
  void flush();  // driven by a 20 Hz timer

private:
  // Past this many members a newcomer is not tracked.
  static constexpr std::size_t kMaxMembersPerTree = 200;

  struct Member {
    UserId actor;
    // What this member is called ON THE WIRE: a seat number minted per room, never the account id,
    // since presence fans out to every co-viewer including anonymous strangers.
    std::string seat;
    std::string name;
    std::string color;
    std::optional<Vec2> cursor;         // world coords, already projected by the client
    std::optional<std::string> selection;
    bool moved = false;
  };

  struct Room {
    std::uint64_t seats = 0;
    std::map<drogon::WebSocketConnectionPtr, Member> members;
  };

  std::string guestName(const UserId& actor, const std::map<drogon::WebSocketConnectionPtr, Member>& members) const;
  // Caller holds mutex_.
  void depart(const std::string& tree, const drogon::WebSocketConnectionPtr& conn);
  Json::Value presenceFrame(const std::string& tree, const Member& member) const;
  Json::Value peerFrame(const std::string& tree, const Member& member, const char* event) const;

  mutable std::mutex mutex_;
  std::map<std::string, Room> byTree_;
};

}
