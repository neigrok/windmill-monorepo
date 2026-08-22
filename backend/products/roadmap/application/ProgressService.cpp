#include "products/roadmap/application/ProgressService.h"

namespace wm {

ProgressService::ProgressService(ProgressRepository& repo) : repo_(repo) {}

ProgressOutcome ProgressService::setStatus(const std::vector<NodeId>& prerequisites, const TreeId& treeId,
                                           const UserId& user, const NodeId& node, ProgressStatus status,
                                           const Hlc& at, std::uint64_t receivedAtMs) {
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

  const bool applied = repo_.setStatus(treeId, user, node, status, at, receivedAtMs);
  return {status, prerequisitesMet, applied};
}

std::vector<ProgressOutcome> ProgressService::setStatuses(const TreeId& treeId, const UserId& user,
                                                          const std::vector<ProgressWrite>& writes,
                                                          std::uint64_t receivedAtMs) {
  std::vector<bool> applied;
  applied.reserve(writes.size());
  for (const ProgressWrite& write : writes)
    applied.push_back(repo_.setStatus(treeId, user, write.node, write.status, write.at, receivedAtMs));

  Progress final = repo_.load(treeId, user);  // one read; every advisory reads the same committed state
  std::vector<ProgressOutcome> outcomes;
  outcomes.reserve(writes.size());
  for (const ProgressWrite& write : writes) {
    bool prerequisitesMet = true;
    if (write.status == ProgressStatus::complete)
      for (const NodeId& prereq : write.prerequisites)
        if (!final.completed.count(prereq)) { prerequisitesMet = false; break; }
    outcomes.push_back({write.status, prerequisitesMet, applied[outcomes.size()]});
  }
  return outcomes;
}

Progress ProgressService::progressOf(const TreeId& treeId, const UserId& user) {
  return repo_.load(treeId, user);
}

}
