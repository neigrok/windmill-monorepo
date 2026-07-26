#include "domain/UnlockRules.h"

#include <algorithm>

namespace wm {

std::map<NodeId, NodeState> UnlockRules::derive(const SkillTree& tree, const Progress& progress) {
  std::map<NodeId, NodeState> states;
  for (const NodeSpec& node : tree.nodes()) {
    if (progress.completed.count(node.id)) {
      states[node.id] = NodeState::complete;
      continue;
    }
    if (progress.inProgress.count(node.id)) {
      states[node.id] = NodeState::active;
      continue;
    }
    bool unlocked = std::all_of(node.prerequisites.begin(), node.prerequisites.end(),
                                [&](const NodeId& prereq) { return progress.completed.count(prereq) > 0; });
    states[node.id] = unlocked ? NodeState::available : NodeState::locked;
  }
  return states;
}

}
