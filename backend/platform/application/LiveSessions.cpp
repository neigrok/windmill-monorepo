#include "platform/application/LiveSessions.h"

#include <algorithm>
#include <set>
#include <utility>

namespace wm {

LiveSessions::Handle LiveSessions::enter(std::vector<std::string> digests, std::uint64_t now, Close close) {
  std::lock_guard lock(mutex_);
  const Handle handle = ++next_;
  connections_.emplace(handle, Connection{std::move(digests), now, std::move(close)});
  return handle;
}

void LiveSessions::leave(Handle connection) {
  std::lock_guard lock(mutex_);
  connections_.erase(connection);
}

void LiveSessions::revoked(const std::vector<std::string>& digests) {
  const std::set<std::string> ended(digests.begin(), digests.end());
  closeWhere([&ended](Handle, const Connection& connection) {
    return std::any_of(connection.digests.begin(), connection.digests.end(), [&ended](const std::string& digest) { return ended.contains(digest); });
  });
}

void LiveSessions::reprove(const std::function<bool(const std::string& digest)>& proves, std::uint64_t now) {
  std::vector<std::pair<Handle, std::vector<std::string>>> due;
  {
    std::lock_guard lock(mutex_);
    for (const auto& [handle, connection] : connections_) {
      if (connection.provenAt + kReproveAfterMs <= now) due.emplace_back(handle, connection.digests);
    }
  }
  std::set<Handle> failed;
  std::set<Handle> proven;
  for (const auto& [handle, digests] : due) {
    const bool holds = std::all_of(digests.begin(), digests.end(), proves);
    (holds ? proven : failed).insert(handle);
  }
  {
    std::lock_guard lock(mutex_);
    for (const Handle handle : proven) {
      if (const auto connection = connections_.find(handle); connection != connections_.end()) connection->second.provenAt = now;
    }
  }
  closeWhere([&failed](Handle handle, const Connection&) { return failed.contains(handle); });
}

void LiveSessions::closeWhere(const std::function<bool(Handle, const Connection&)>& closes) {
  std::vector<Close> closing;
  {
    std::lock_guard lock(mutex_);
    for (auto connection = connections_.begin(); connection != connections_.end();) {
      if (!closes(connection->first, connection->second)) {
        ++connection;
        continue;
      }
      closing.push_back(std::move(connection->second.close));
      connection = connections_.erase(connection);
    }
  }
  for (const Close& close : closing) close();
}

}
