#pragma once

#include "domain/Ids.h"
#include "domain/SkillTree.h"
#include "domain/Tree.h"
#include "ports/ProgressRepository.h"

namespace wm {

// The recorded status plus whether the P1 rule held. A `complete` set whose
// prerequisites are not all complete is still recorded — P1 is advisory (§3) — but the
// caller is told so it can warn.
struct ProgressOutcome {
  ProgressStatus status;
  bool prerequisitesMet;
};

// Writes a user's private progress overlay. P2 (active/complete exclusivity) is
// structural — one status per node. P1 is advised, never enforced.
class ProgressService {
public:
  explicit ProgressService(ProgressRepository& repo);

  ProgressOutcome setStatus(const SkillTree& tree, const TreeId& treeId, const UserId& user,
                            const NodeId& node, ProgressStatus status, const Hlc& at);
  Progress progressOf(const TreeId& treeId, const UserId& user);

private:
  ProgressRepository& repo_;
};

}
