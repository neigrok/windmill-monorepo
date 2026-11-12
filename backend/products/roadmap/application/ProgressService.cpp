#include "products/roadmap/application/ProgressService.h"

#include "products/roadmap/domain/Access.h"
#include "products/roadmap/domain/OpenedTrees.h"

#include <algorithm>
#include <map>
#include <set>

namespace wm {

ProgressService::ProgressService(ProgressRepository& repo, TreeRepository& trees) : repo_(repo), trees_(trees) {}

ProgressReceipt ProgressService::mark(const TreeData& tree, const std::optional<UserId>& owner, const UserId& user,
                                      const std::vector<ProgressWrite>& writes, std::uint64_t receivedAtMs) {
  const OpenedTrees opened(canWrite(user, owner) ? trees_.openedFrom(user, treesOpenedBy(tree))
                                                 : std::map<TreeId, OpenedTree>{});
  const std::set<NodeId> following = opened.following(tree);
  std::vector<ProgressUpdate> updates;
  for (const ProgressWrite& write : writes)
    if (!following.count(write.node)) updates.push_back({write.node, write.status, write.outOfOrder, write.at});

  const ProgressOutcome refused{ProgressStatus::none, false, false, false, true};
  ProgressReceipt receipt;
  if (updates.empty()) {
    receipt.outcomes.assign(writes.size(), refused);
    return receipt;
  }
  const std::vector<bool> applied = repo_.setStatuses(tree.id, user, updates, receivedAtMs);
  // One read after the commit, so completing a subtree out of dependency order misreports no advisory.
  const std::set<NodeId> completed = opened.followed(tree, repo_.load(tree.id, user)).completed;
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

}
