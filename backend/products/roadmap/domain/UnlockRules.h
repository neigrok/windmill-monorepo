#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/SkillTree.h"
#include "products/roadmap/domain/Tree.h"

#include <map>
#include <vector>

namespace wm {

// Decides a node's NodeState from a tree + a user's progress. Reads nodes and their prerequisites
// only, so it also runs over the bare node list of a tree SkillTree would refuse to build. A
// prerequisite that names no node locks its dependant; a cycle locks every member.
struct UnlockRules {
  static std::map<NodeId, NodeState> derive(const std::vector<NodeSpec>& nodes, const Progress& progress);
  static std::map<NodeId, NodeState> derive(const SkillTree& tree, const Progress& progress);
};

}
