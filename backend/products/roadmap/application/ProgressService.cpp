#include "products/roadmap/application/ProgressService.h"

#include "products/roadmap/domain/OpenedTrees.h"

#include <algorithm>
#include <set>

namespace wm {

ProgressService::ProgressService(ProgressRepository& repo, TreeRepository& trees) : repo_(repo), trees_(trees) {}

bool ProgressReceipt::cameToARefusal() const {
  return recorded.marks.empty() &&
         std::any_of(outcomes.begin(), outcomes.end(), [](const ProgressOutcome& outcome) { return outcome.refused; });
}

ProgressReceipt ProgressService::mark(const TreeId& tree, const std::map<NodeId, TreeId>& pointers, const UserId& user,
                                      const std::vector<ProgressWrite>& writes, StampedBy stampedBy,
                                      std::uint64_t receivedAtMs) {
  ProgressReceipt receipt;
  if (writes.empty()) return receipt;
  const OpenedTrees standing(trees_.openedFrom(user, treesOpenedBy(pointers)));
  const std::set<NodeId> following = standing.following(tree, pointers);
  std::vector<ProgressUpdate> updates;
  for (const ProgressWrite& write : writes)
    if (!following.count(write.node)) updates.push_back({write.node, write.status, write.outOfOrder, write.at});

  const ProgressOutcome refused{.status = ProgressStatus::none, .prerequisitesMet = false, .applied = false, .refused = true};
  if (updates.empty()) {
    receipt.outcomes.assign(writes.size(), refused);
    return receipt;
  }
  const std::vector<ProgressWritten> written = repo_.setStatuses(tree, user, updates, stampedBy, receivedAtMs);
  // One read after the commit, so completing a subtree out of dependency order misreports no advisory.
  const std::set<NodeId> completed = standing.followed(tree, pointers, repo_.load(tree, user)).completed;
  auto did = written.begin();
  for (const ProgressWrite& write : writes) {
    if (following.count(write.node)) {
      receipt.outcomes.push_back(refused);
      continue;
    }
    const bool prerequisitesMet =
        write.status != ProgressStatus::complete ||
        std::all_of(write.prerequisites.begin(), write.prerequisites.end(),
                    [&](const NodeId& prerequisite) { return completed.count(prerequisite) > 0; });
    receipt.outcomes.push_back({write.status, prerequisitesMet, did->landed.has_value(), write.outOfOrder,
                                did->held && did->held->carries(write.status, write.outOfOrder)});
    if (did->landed) receipt.recorded.record(write.node, *did->landed);
    ++did;
  }
  return receipt;
}

Progress ProgressService::progressOf(const TreeId& treeId, const UserId& user) {
  return repo_.load(treeId, user);
}

}
