#include "products/roadmap/application/OwnerProgress.h"

#include "platform/application/WriteObservation.h"

#include <trantor/utils/Logger.h>

#include <algorithm>
#include <new>
#include <optional>
#include <set>

namespace wm {

OwnerProgress::OwnerProgress(ProgressRepository& marks, TreeRepository& trees, Clock& clock)
    : marks_(marks), trees_(trees), clock_(clock) {}

Progress OwnerProgress::stored(const TreeId& tree, const UserId& owner) { return marks_.load(tree, owner); }

ShownToReaders OwnerProgress::shownToReaders(const std::vector<OwnersTrees>& owners, std::chrono::milliseconds cap,
                                             const std::string& door) {
  // The follows come first: each owner's standing trees, or nothing for an owner left unread.
  ShownToReaders shown;
  std::map<UserId, std::optional<OpenedTrees>> followed;
  const std::uint64_t started = clock_.nowMs();
  for (const OwnersTrees& owner : owners) {
    std::set<TreeId> opened;
    for (const auto& [tree, pointers] : owner.trees)
      for (const auto& [node, pointer] : pointers) opened.insert(pointer.tree);
    std::optional<OpenedTrees>& standing = followed[owner.owner];
    if (opened.empty()) {
      // No pointer among this owner's trees: nothing is followed, and every row is the stored one.
      standing.emplace(std::map<TreeId, OpenedTree>{});
      continue;
    }
    if (coolingOff(owner.owner)) {
      ++shown.tally.coolingOff;
      continue;
    }
    const std::uint64_t spent = clock_.nowMs() - started;
    if (spent >= static_cast<std::uint64_t>(cap.count())) {
      ++shown.tally.pastCap;
      continue;
    }
    const std::chrono::milliseconds budget =
        std::min(kReaderFollowBudget, cap - std::chrono::milliseconds{static_cast<std::int64_t>(spent)});
    // Begun before the read borrows its connection, so its duration counts the wait for one.
    WriteObservation observation{"roadmap.progress.follow", "roadmap", door};
    try {
      standing.emplace(trees_.openedFrom(owner.owner, opened, budget));
      ++shown.tally.followed;
      observation.skip();  // a follow that answers writes nothing, as the tree read's own does
      endCoolOff(owner.owner, door);
    } catch (const std::bad_alloc&) {
      throw;
    } catch (const FollowTimedOut&) {
      // Cut short by the request's cap rather than its own budget, the owner is not to blame.
      if (budget < kReaderFollowBudget) {
        ++shown.tally.pastCap;
        observation.skip();
        continue;
      }
      ++shown.tally.timedOut;
      if (enterCoolOff(owner.owner)) observation.finish("timeout");
      else observation.skip();
    } catch (const std::exception& failure) {
      ++shown.tally.failed;
      if (enterCoolOff(owner.owner)) observation.fail(failure);
      else observation.skip();
    }
  }

  for (const OwnersTrees& owner : owners)
    for (const auto& [tree, pointers] : owner.trees)
      shown.progress.emplace(tree, readerView(marks_.load(tree, owner.owner), pointers, followed.at(owner.owner)));
  return shown;
}

bool OwnerProgress::coolingOff(const UserId& owner) {
  const std::lock_guard<std::mutex> lock(mutex_);
  const auto coolOff = coolOffs_.find(owner);
  if (coolOff == coolOffs_.end() || clock_.nowMs() >= coolOff->second.untilMs) return false;
  ++coolOff->second.degraded;
  return true;
}

bool OwnerProgress::enterCoolOff(const UserId& owner) {
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

void OwnerProgress::endCoolOff(const UserId& owner, const std::string& door) {
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
