#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/ports/ProgressRepository.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <map>
#include <vector>

namespace wm {

// A `complete` set whose prerequisites are not all complete is still recorded — P1 is advisory — but
// the caller is told so it can warn. `outOfOrder` echoes the word the write carried, so a receipt
// can tell a meant inversion from an unnoticed one. `unchanged` says the caller already held this
// mark at its turn, after the marks before it in the same batch: the same status and the same word
// (Progress::holds). It is written all the same, so its newer stamp lands, as a replica's must for
// every replica to converge.
struct ProgressOutcome {
  ProgressStatus status;
  bool prerequisitesMet;
  bool applied = true;  // false when a strictly-later stamp already stood and this write lost
  bool outOfOrder = false;
  bool unchanged = false;
  bool refused = false;  // the node follows the tree it opens: nothing was written, and the other fields say nothing
  bool operator==(const ProgressOutcome&) const = default;
};

// What one call's marks came to: an outcome per write, in the writes' order, and the registers that
// landed, as an echo carries them.
struct ProgressReceipt {
  std::vector<ProgressOutcome> outcomes;
  Progress recorded;

  // No mark was recorded and at least one was refused: what the call's write line says in place of `ok`.
  bool cameToARefusal() const;
};

// Carries the stamp the marking replica minted. Distinct from domain `ProgressMark`, which is the
// register a write LANDS in once the overlay keeps it.
struct ProgressWrite {
  NodeId node;
  ProgressStatus status;
  std::vector<NodeId> prerequisites;
  Hlc at;
  bool outOfOrder = false;
};

// Writes a user's private progress overlay with one completion status per node.
// P1 is advised, never enforced, and reads only the node's prerequisites, so
// progress never depends on the tree being a valid DAG.
class ProgressService {
public:
  ProgressService(ProgressRepository& repo, TreeRepository& trees);

  // A door's marks on `tree`, handed over once the strand is released, with the pointers the room handed
  // `user` (TreeRoom::pointersFor). A mark on a node that follows its tree (domain/OpenedTrees.h) is refused
  // and each advisory reads the followed completed set, off one read made only when there is a pointer.
  ProgressReceipt mark(const TreeId& tree, const std::map<NodeId, TreeId>& pointers, const UserId& user,
                       const std::vector<ProgressWrite>& writes, std::uint64_t receivedAtMs);

  ProgressOutcome setStatus(const std::vector<NodeId>& prerequisites, const TreeId& treeId,
                            const UserId& user, const NodeId& node, ProgressStatus status, bool outOfOrder,
                            const Hlc& at, std::uint64_t receivedAtMs);

  // The writes as given, on nodes that may have left the tree. Each advisory is judged against the
  // committed final overlay, and outcomes follow the writes' order.
  std::vector<ProgressOutcome> setStatuses(const TreeId& treeId, const UserId& user,
                                           const std::vector<ProgressWrite>& writes,
                                           std::uint64_t receivedAtMs);

  Progress progressOf(const TreeId& treeId, const UserId& user);

private:
  ProgressRepository& repo_;
  TreeRepository& trees_;
};

}
