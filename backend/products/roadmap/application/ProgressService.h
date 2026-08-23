#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/ports/ProgressRepository.h"

#include <vector>

namespace wm {

// A `complete` set whose prerequisites are not all complete is still recorded — P1 is advisory — but
// the caller is told so it can warn.
struct ProgressOutcome {
  ProgressStatus status;
  bool prerequisitesMet;
  bool applied = true;  // false when a strictly-later stamp already stood and this write lost
};

// Carries the stamp the marking replica minted. Distinct from domain `ProgressMark`, which is the
// register a write LANDS in once the overlay keeps it.
struct ProgressWrite {
  NodeId node;
  ProgressStatus status;
  std::vector<NodeId> prerequisites;
  Hlc at;
};

// Writes a user's private progress overlay. P2 (active/complete exclusivity) is structural — one
// status per node. P1 is advised, never enforced, and reads only the node's prerequisites, so
// progress never depends on the tree being a valid DAG.
class ProgressService {
public:
  explicit ProgressService(ProgressRepository& repo);

  ProgressOutcome setStatus(const std::vector<NodeId>& prerequisites, const TreeId& treeId,
                            const UserId& user, const NodeId& node, ProgressStatus status, const Hlc& at,
                            std::uint64_t receivedAtMs);

  // Each advisory is judged against the committed final overlay, so completing a subtree out of
  // dependency order yields no spurious prerequisitesMet:false. Outcomes follow the marks' order.
  std::vector<ProgressOutcome> setStatuses(const TreeId& treeId, const UserId& user,
                                           const std::vector<ProgressWrite>& writes,
                                           std::uint64_t receivedAtMs);

  Progress progressOf(const TreeId& treeId, const UserId& user);

private:
  ProgressRepository& repo_;
};

}
