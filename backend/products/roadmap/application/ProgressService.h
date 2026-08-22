#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/ports/ProgressRepository.h"

#include <vector>

namespace wm {

// The recorded status plus whether the P1 rule held. A `complete` set whose
// prerequisites are not all complete is still recorded — P1 is advisory (§3) — but the
// caller is told so it can warn.
struct ProgressOutcome {
  ProgressStatus status;
  bool prerequisitesMet;
};

// One requested write plus the prerequisites its advisory is judged against, carrying the stamp
// the marking replica minted. The Action loads the prerequisites from the room; the batch below
// resolves ordering so the advisory reads committed state, not the instant of each write. Distinct
// from domain `ProgressMark`, which is the register a write LANDS in once the overlay keeps it.
struct ProgressWrite {
  NodeId node;
  ProgressStatus status;
  std::vector<NodeId> prerequisites;
  Hlc at;
};

// Writes a user's private progress overlay. P2 (active/complete exclusivity) is
// structural — one status per node. P1 is advised, never enforced. The advisory check
// reads only the node's prerequisites (from the loose graph's live edges), so progress
// never depends on the tree being a valid DAG (§3 — progress never blocks on collaborators).
class ProgressService {
public:
  explicit ProgressService(ProgressRepository& repo);

  ProgressOutcome setStatus(const std::vector<NodeId>& prerequisites, const TreeId& treeId,
                            const UserId& user, const NodeId& node, ProgressStatus status, const Hlc& at,
                            std::uint64_t receivedAtMs);

  // Apply a batch, then judge each advisory against the committed final overlay — so completing
  // a subtree out of dependency order no longer yields a spurious prerequisitesMet:false (§9).
  // Outcomes are returned in the marks' order.
  std::vector<ProgressOutcome> setStatuses(const TreeId& treeId, const UserId& user,
                                           const std::vector<ProgressWrite>& writes,
                                           std::uint64_t receivedAtMs);

  Progress progressOf(const TreeId& treeId, const UserId& user);

private:
  ProgressRepository& repo_;
};

}
