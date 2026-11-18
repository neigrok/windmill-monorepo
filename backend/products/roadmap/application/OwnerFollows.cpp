#include "products/roadmap/application/OwnerFollows.h"

#include <trantor/utils/Logger.h>

#include <algorithm>

namespace wm {

bool OwnerFollows::coolingOff(const UserId& owner) {
  const std::lock_guard<std::mutex> lock(mutex_);
  const auto coolOff = coolOffs_.find(owner);
  if (coolOff == coolOffs_.end() || clock_.nowMs() >= coolOff->second.untilMs) return false;
  ++coolOff->second.degraded;
  return true;
}

bool OwnerFollows::enterCoolOff(const UserId& owner) {
  const std::lock_guard<std::mutex> lock(mutex_);
  const std::uint64_t now = clock_.nowMs();
  const std::uint64_t until = now + static_cast<std::uint64_t>(std::chrono::milliseconds{kFollowCoolOff}.count());
  const auto coolOff = coolOffs_.find(owner);
  if (coolOff != coolOffs_.end()) {
    ++coolOff->second.degraded;
    if (now < coolOff->second.untilMs) return false;
    coolOff->second.untilMs = until;  // tried again once it ran out, and failed again: the same cool-off goes on
    return true;
  }
  if (coolOffs_.size() >= kMaxCoolingOff)
    coolOffs_.erase(std::min_element(coolOffs_.begin(), coolOffs_.end(), [](const auto& a, const auto& b) {
      return a.second.sinceMs < b.second.sinceMs;
    }));
  coolOffs_.emplace(owner, CoolOff{now, until, 1});
  return true;
}

void OwnerFollows::endCoolOff(const UserId& owner, const std::string& door) {
  std::uint64_t degraded = 0;
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    const auto coolOff = coolOffs_.find(owner);
    if (coolOff == coolOffs_.end()) return;
    degraded = coolOff->second.degraded;
    coolOffs_.erase(coolOff);
  }
  LOG_INFO << "roadmap_progress_follow_recovered door=" << door << " degraded_replies=" << degraded;
}

}
