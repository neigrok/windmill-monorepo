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

std::vector<ProgressOutcome> ProgressService::setStatuses(const TreeId& treeId, const UserId& user,
                                                          const std::vector<ProgressMark>& marks) {
  for (const ProgressMark& mark : marks) repo_.setStatus(treeId, user, mark.node, mark.status, mark.at);

  Progress final = repo_.load(treeId, user);  // one read; every advisory reads the same committed state
  std::vector<ProgressOutcome> outcomes;
  outcomes.reserve(marks.size());
  for (const ProgressMark& mark : marks) {
    bool prerequisitesMet = true;
    if (mark.status == ProgressStatus::complete)
      for (const NodeId& prereq : mark.prerequisites)
        if (!final.completed.count(prereq)) { prerequisitesMet = false; break; }
    outcomes.push_back({mark.status, prerequisitesMet});
  }
  return outcomes;
}

Progress ProgressService::progressOf(const TreeId& treeId, const UserId& user) {
  return repo_.load(treeId, user);
}

}
