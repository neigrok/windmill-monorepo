#include "domain/SkillTree.h"

#include <deque>

namespace wm {

SkillTree::SkillTree(TreeData data) : data_(std::move(data)) {
  for (const NodeSpec& node : data_.nodes) {
    if (!nodesById_.emplace(node.id, &node).second) {
      throw InvalidTree("Duplicate node id \"" + node.id.str() + "\"");
    }
  }

  for (const NodeSpec& node : data_.nodes) {
    for (const NodeId& prereq : node.prerequisites) {
      if (!nodesById_.count(prereq)) {
        throw InvalidTree("Node \"" + node.id.str() + "\" lists unknown prerequisite \"" + prereq.str() + "\"");
      }
    }
  }

  for (const NodeSpec& node : data_.nodes) {
    childrenIndex_[node.id] = {};
    for (const NodeId& prereq : node.prerequisites) edges_.push_back(Edge{prereq, node.id});
  }
  for (const Edge& edge : edges_) childrenIndex_[edge.from].push_back(nodesById_.at(edge.to));

  std::map<NodeId, int> inDegree;
  std::deque<NodeId> queue;
  for (const NodeSpec& node : data_.nodes) {
    inDegree[node.id] = static_cast<int>(node.prerequisites.size());
    if (node.prerequisites.empty()) queue.push_back(node.id);
  }
  while (!queue.empty()) {
    NodeId id = queue.front();
    queue.pop_front();
    orderedIds_.push_back(id);
    for (const NodeSpec* child : childrenIndex_.at(id)) {
      if (--inDegree[child->id] == 0) queue.push_back(child->id);
    }
  }
  if (orderedIds_.size() != data_.nodes.size()) {
    throw InvalidTree("Tree \"" + data_.id.str() + "\" has a cycle");
  }

  trunk_ = TrunkTree(*this);
}

const NodeSpec& SkillTree::nodeById(const NodeId& id) const {
  auto it = nodesById_.find(id);
  if (it == nodesById_.end()) throw InvalidTree("Unknown node id \"" + id.str() + "\"");
  return *it->second;
}

std::vector<const NodeSpec*> SkillTree::roots() const {
  std::vector<const NodeSpec*> found;
  for (const NodeSpec& node : data_.nodes) {
    if (node.prerequisites.empty()) found.push_back(&node);
  }
  return found;
}

std::vector<const NodeSpec*> SkillTree::parentsOf(const NodeId& id) const {
  std::vector<const NodeSpec*> parents;
  for (const NodeId& prereq : nodeById(id).prerequisites) parents.push_back(nodesById_.at(prereq));
  return parents;
}

const std::vector<const NodeSpec*>& SkillTree::childrenOf(const NodeId& id) const {
  return childrenIndex_.at(id);
}

}
