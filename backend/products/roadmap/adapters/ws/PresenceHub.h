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

// What a socket connection is, resolved once at the upgrade and stored in its context: the
// acting user (a real account id when authenticated, a synthetic guest id otherwise) and
// whether it is authenticated. Anonymous connections may read and show presence; only
// authenticated ones may write.
struct Principal {
  Principal(UserId user, bool authenticated, std::string name, std::string sessionDigest,
            std::uint64_t checkedAtMs)
      : user(std::move(user)), authenticated(authenticated), name(std::move(name)),
        sessionDigest(std::move(sessionDigest)), checkedAtMs(checkedAtMs) {}

  // Written once, at the upgrade, and only read afterwards — so no synchronization is owed on them.
  const UserId user;
  // The display name this connection may show to others — empty for a guest, and empty too for an
  // account still wearing the name we derived from its address (§sharableName). Resolved here, at
  // the one place that knows who the connection is, rather than guessed downstream from the id.
  const std::string name;
  // A socket outlives the request that opened it, so the session that authorized it can be revoked
  // — signed out everywhere, or the account closed — while the connection keeps writing. The digest
  // (never the secret) is kept so a writer can re-prove its session; checkedAtMs throttles that to
  // one lookup a minute rather than one per edit.
  const std::string sessionDigest;

  // ATOMIC, because these two are the only mutable fields and they are no longer written only by
  // the connection's own IO thread: the periodic reader re-proof walks every open subscription from
  // one sweeper thread and narrows whichever principal it finds revoked, while that connection's
  // own thread reads the same two fields on its next frame. Both are single values with no
  // invariant between them — a re-proof that races another only costs a duplicate lookup — so a
  // relaxed pair is the whole of what is needed, and a mutex here would put every frame behind it.
  std::atomic<bool> authenticated;
  std::atomic<std::uint64_t> checkedAtMs;
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
  // Leave ONE room — what a revocation calls, since a socket that may no longer read this tree may
  // still be legitimately present in another.
  void leave(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree);
  void flush();  // driven by a 20 Hz timer; sends each moved participant's latest state

private:
  // Cap fan-out on a crowded tree: past this many members a newcomer is not tracked.
  static constexpr std::size_t kMaxMembersPerTree = 200;

  struct Member {
    UserId actor;
    // What this member is called ON THE WIRE, and the reason the two ids are separate. `actor` is
    // the real account id for a signed-in connection — users.id, the system-wide primary key — and
    // presence fans out to every co-viewer, anonymous strangers included, on any public or unlisted
    // tree. A seat number minted per room tells a peer everything it needs (which cursor is whose)
    // and nothing about WHO: it cannot be correlated across trees, and it dies with the room. The
    // room still reasons with the real UserId — colour, name and the op actor are unchanged.
    std::string seat;
    std::string name;
    std::string color;
    std::optional<Vec2> cursor;         // world coords, already projected by the client
    std::optional<std::string> selection;
    bool moved = false;                 // has fresh cursor/selection to send on next flush
  };

  // One tree's roster, plus the seat counter it hands out. The counter lives beside the members so
  // it resets with them: a room nobody is in keeps nothing, not even a number.
  struct Room {
    std::uint64_t seats = 0;
    std::map<drogon::WebSocketConnectionPtr, Member> members;
  };

  std::string guestName(const UserId& actor, const std::map<drogon::WebSocketConnectionPtr, Member>& members) const;
  // Announce and remove one member from one room, erasing the room when its last member goes.
  // Caller holds mutex_; both leave() overloads are this, once and for every tree.
  void depart(const std::string& tree, const drogon::WebSocketConnectionPtr& conn);
  Json::Value presenceFrame(const std::string& tree, const Member& member) const;
  Json::Value peerFrame(const std::string& tree, const Member& member, const char* event) const;

  mutable std::mutex mutex_;
  std::map<std::string, Room> byTree_;
};

}
