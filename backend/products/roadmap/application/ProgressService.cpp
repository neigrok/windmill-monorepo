#include "products/roadmap/application/ProgressService.h"

#include "platform/application/WriteObservation.h"
#include "products/roadmap/domain/OpenedTrees.h"

#include <algorithm>
#include <new>
#include <optional>
#include <set>

namespace wm {

ProgressService::ProgressService(ProgressRepository& repo, TreeRepository& trees) : repo_(repo), trees_(trees) {}

bool ProgressReceipt::cameToARefusal() const {
  return recorded.marks.empty() &&
         std::any_of(outcomes.begin(), outcomes.end(), [](const ProgressOutcome& outcome) { return outcome.refused; });
}

ProgressReceipt ProgressService::mark(const TreeId& tree, const std::map<NodeId, TreeId>& pointers, const UserId& user,
                                      const std::vector<ProgressWrite>& writes, std::uint64_t receivedAtMs) {
  ProgressReceipt receipt;
  if (writes.empty()) return receipt;
  std::set<TreeId> opened;
  for (const auto& [node, target] : pointers) opened.insert(target);
  const OpenedTrees standing(trees_.openedFrom(user, opened));
  const std::set<NodeId> following = standing.following(pointers);
  std::vector<ProgressUpdate> updates;
  for (const ProgressWrite& write : writes)
    if (!following.count(write.node)) updates.push_back({write.node, write.status, write.outOfOrder, write.at});

  const ProgressOutcome refused{ProgressStatus::none, false, false, false, true};
  if (updates.empty()) {
    receipt.outcomes.assign(writes.size(), refused);
    return receipt;
  }
  const std::vector<bool> applied = repo_.setStatuses(tree, user, updates, receivedAtMs);
  // One read after the commit, so completing a subtree out of dependency order misreports no advisory.
  const std::set<NodeId> completed = standing.followed(pointers, repo_.load(tree, user)).completed;
  auto landed = applied.begin();
  for (const ProgressWrite& write : writes) {
    if (following.count(write.node)) {
      receipt.outcomes.push_back(refused);
      continue;
    }
    const bool prerequisitesMet =
        write.status != ProgressStatus::complete ||
        std::all_of(write.prerequisites.begin(), write.prerequisites.end(),
                    [&](const NodeId& prerequisite) { return completed.count(prerequisite) > 0; });
    receipt.outcomes.push_back({write.status, prerequisitesMet, *landed, write.outOfOrder});
    if (*landed)
      receipt.recorded.record(write.node, ProgressMark{write.status, write.at, receivedAtMs, write.outOfOrder});
    ++landed;
  }
  return receipt;
}

ProgressOutcome ProgressService::setStatus(const std::vector<NodeId>& prerequisites, const TreeId& treeId,
                                           const UserId& user, const NodeId& node, ProgressStatus status,
                                           bool outOfOrder, const Hlc& at, std::uint64_t receivedAtMs) {
  bool prerequisitesMet = true;
  if (status == ProgressStatus::complete) {
    Progress current = repo_.load(treeId, user);
    for (const NodeId& prereq : prerequisites) {
      if (!current.completed.count(prereq)) {
        prerequisitesMet = false;
        break;
      }
    }
  }

  const bool applied = repo_.setStatus(treeId, user, node, status, outOfOrder, at, receivedAtMs);
  return {status, prerequisitesMet, applied, outOfOrder};
}

std::vector<ProgressOutcome> ProgressService::setStatuses(const TreeId& treeId, const UserId& user,
                                                          const std::vector<ProgressWrite>& writes,
                                                          std::uint64_t receivedAtMs) {
  std::vector<ProgressUpdate> updates;
  updates.reserve(writes.size());
  for (const ProgressWrite& write : writes)
    updates.push_back({write.node, write.status, write.outOfOrder, write.at});
  const std::vector<bool> applied = repo_.setStatuses(treeId, user, updates, receivedAtMs);

  Progress final = repo_.load(treeId, user);  // one read; every advisory reads the same committed state
  std::vector<ProgressOutcome> outcomes;
  outcomes.reserve(writes.size());
  for (const ProgressWrite& write : writes) {
    bool prerequisitesMet = true;
    if (write.status == ProgressStatus::complete)
      for (const NodeId& prereq : write.prerequisites)
        if (!final.completed.count(prereq)) { prerequisitesMet = false; break; }
    outcomes.push_back({write.status, prerequisitesMet, applied[outcomes.size()], write.outOfOrder});
  }
  return outcomes;
}

Progress ProgressService::progressOf(const TreeId& treeId, const UserId& user) {
  return repo_.load(treeId, user);
}

std::map<TreeId, Progress> ProgressService::shownToReaders(const UserId& owner,
                                                           const std::map<TreeId, std::map<NodeId, TreeId>>& trees,
                                                           const std::string& door) {
  std::set<TreeId> opened;
  for (const auto& [tree, pointers] : trees)
    for (const auto& [node, target] : pointers) opened.insert(target);
  // With no pointer among them nothing is followed, and every row is the stored one.
  std::optional<OpenedTrees> followed{OpenedTrees({})};
  if (!opened.empty()) {
    WriteObservation observation{"roadmap.progress.follow", "roadmap", door};
    try {
      followed = OpenedTrees(trees_.openedFrom(owner, opened, kReaderFollowBudget));
      observation.finish();
    } catch (const std::bad_alloc&) {
      throw;
    } catch (const FollowTimedOut&) {
      followed.reset();
      observation.finish("timeout");
    } catch (const std::exception& failure) {
      followed.reset();
      observation.fail(failure);
    }
  }
  std::map<TreeId, Progress> shown;
  for (const auto& [tree, pointers] : trees) shown.emplace(tree, readerView(repo_.load(tree, owner), pointers, followed));
  return shown;
}

}
