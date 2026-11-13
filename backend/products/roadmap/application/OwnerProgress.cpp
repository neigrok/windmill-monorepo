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
  std::map<UserId, std::optional<OpenedTrees>> byOwner;
  const std::uint64_t started = clock_.nowMs();
  for (const OwnersTrees& owner : owners) {
    std::set<TreeId> opened;
    for (const auto& [tree, pointers] : owner.trees)
      for (const auto& [node, pointer] : pointers) opened.insert(pointer.tree);
    std::optional<OpenedTrees>& standing = byOwner[owner.owner];
    if (opened.empty()) {
      // No pointer among this owner's trees: nothing is followed, and every row is the stored one.
      standing.emplace(std::map<TreeId, OpenedTree>{});
      continue;
    }
    const auto spent = std::chrono::milliseconds{static_cast<std::int64_t>(clock_.nowMs() - started)};
    standing = followed(owner.owner, opened, std::max(cap - spent, std::chrono::milliseconds{0}), door, shown.tally);
  }

  for (const OwnersTrees& owner : owners)
    for (const auto& [tree, pointers] : owner.trees)
      shown.progress.emplace(tree, readerView(marks_.load(tree, owner.owner), pointers, byOwner.at(owner.owner)));
  return shown;
}

std::optional<OpenedTrees> OwnerProgress::followed(const UserId& owner, const std::set<TreeId>& opened,
                                                   std::chrono::milliseconds budget, const std::string& door,
                                                   FollowTally& tally) {
  if (coolingOff(owner)) {
    ++tally.coolingOff;
    return std::nullopt;
  }
  // The request's time for follows ran out before this one.
  if (budget.count() <= 0) {
    ++tally.pastCap;
    return std::nullopt;
  }
  budget = std::min(kReaderFollowBudget, budget);
  // Begun before the read borrows its connection, so its duration counts the wait for one.
  WriteObservation observation{"roadmap.progress.follow", "roadmap", door};
  try {
    OpenedTrees standing(trees_.openedFrom(owner, opened, budget));
    ++tally.followed;
    observation.skip();  // a follow that answers writes nothing, as the tree read's own does
    endCoolOff(owner, door);
    return standing;
  } catch (const std::bad_alloc&) {
    throw;
  } catch (const FollowTimedOut&) {
    // Cut short by the request's cap rather than its own budget, the owner is not to blame.
    if (budget < kReaderFollowBudget) {
      ++tally.pastCap;
      observation.skip();
      return std::nullopt;
    }
    ++tally.timedOut;
    if (enterCoolOff(owner)) observation.finish("timeout");
    else observation.skip();
  } catch (const std::exception& failure) {
    ++tally.failed;
    if (enterCoolOff(owner)) observation.fail(failure);
    else observation.skip();
  }
  return std::nullopt;
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
