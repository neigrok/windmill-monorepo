#pragma once

#include "domain/Ids.h"
#include "domain/SkillTree.h"
#include "domain/Tree.h"

#include <map>

namespace wm {

// The single place that decides a node's NodeState from a tree + a user's progress.
struct UnlockRules {
  static std::map<NodeId, NodeState> derive(const SkillTree& tree, const Progress& progress);
};

}
