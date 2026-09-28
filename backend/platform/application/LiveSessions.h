#pragma once

#include "platform/ports/SessionRevocations.h"

#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace wm {

// The sessions this process's live connections were opened on (engine.md §6.8): each connection's session digests,
// when they were last proven, and the close that ends it. A connection is closed, never served on as anonymous:
// - a session the account service revokes closes its connections at once, before they send anything more;
// - every other one is proven again once kReproveAfterMs have passed, so a session that expired, or was revoked
//   where this process never heard of it, closes within that and one heartbeat.
// Every method may run on any thread at the same time as the others.
class LiveSessions final : public SessionRevocations {
public:
  static constexpr std::uint64_t kReproveAfterMs = 60'000;

  using Handle = std::uint64_t;
  using Close = std::function<void()>;

  // A connection opened on `digests`, every session it sent, proven at `now`. `close` runs at most once, never under
  // the registry's lock, and the connection leaves the registry as it does.
  Handle enter(std::vector<std::string> digests, std::uint64_t now, Close close);
  // A connection that closed on its own. One already closed is ignored.
  void leave(Handle connection);

  void revoked(const std::vector<std::string>& digests) override;

  // One heartbeat pass, on a blocking thread: each connection last proven kReproveAfterMs ago or more is proven again,
  // every digest by `proves`, and one that fails closes. The lock is never held across `proves`.
  void reprove(const std::function<bool(const std::string& digest)>& proves, std::uint64_t now);

private:
  struct Connection {
    std::vector<std::string> digests;
    std::uint64_t provenAt = 0;
    Close close;
  };

  // Takes each connection that `closes` out of the registry, then closes it outside the lock.
  void closeWhere(const std::function<bool(Handle, const Connection&)>& closes);

  std::mutex mutex_;
  Handle next_ = 0;
  std::map<Handle, Connection> connections_;
};

}
