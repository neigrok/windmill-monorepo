#pragma once

#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/SkillTree.h"
#include "products/roadmap/domain/Tree.h"

#include <map>
#include <vector>

namespace wm {

// The single place that decides a node's NodeState from a tree + a user's progress.
//
// The cascade reads nodes and their prerequisites and nothing else, so it also runs over the bare
// node list of a tree SkillTree would refuse to build — an MCP read must answer on an untidy tree,
// never 500 on it. A prerequisite that names no node is a prerequisite nobody has completed, so its
// dependant is locked; a cycle locks every member.
struct UnlockRules {
  static std::map<NodeId, NodeState> derive(const std::vector<NodeSpec>& nodes, const Progress& progress);
  static std::map<NodeId, NodeState> derive(const SkillTree& tree, const Progress& progress);
};

}
