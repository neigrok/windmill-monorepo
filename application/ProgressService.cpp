#include "application/ProgressService.h"

namespace wm {

ProgressService::ProgressService(ProgressRepository& repo) : repo_(repo) {}

ProgressOutcome ProgressService::setStatus(const std::vector<NodeId>& prerequisites, const TreeId& treeId,
                                           const UserId& user, const NodeId& node, ProgressStatus status,
                                           const Hlc& at) {
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

  repo_.setStatus(treeId, user, node, status, at);
  return {status, prerequisitesMet};
}

Progress ProgressService::progressOf(const TreeId& treeId, const UserId& user) {
  return repo_.load(treeId, user);
}

}
