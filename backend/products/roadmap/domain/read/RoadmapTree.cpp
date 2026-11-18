#include "products/roadmap/domain/read/RoadmapTree.h"

#include <algorithm>
#include <set>
#include <stdexcept>

namespace wm::roadmap::read {

namespace {

template <typename Record>
bool authoredBefore(const Record& a, const Record& b) {
  if (a.ord != b.ord) return a.ord < b.ord;
  if (a.born != b.born) return a.born < b.born;
  return a.id < b.id;
}

}

RoadmapTree::RoadmapTree(TreeRecords records)
    : id(records.id), present(records.present), read(records.read), parent(records.parent), meta(records.meta),
      nodes(std::move(records.nodes)), edges(std::move(records.edges)), kinds(std::move(records.kinds)) {
  if (meta.root.empty()) meta.root = id;
  std::stable_sort(nodes.begin(), nodes.end(), authoredBefore<Step>);
  std::stable_sort(kinds.begin(), kinds.end(), authoredBefore<Kind>);
  std::stable_sort(edges.begin(), edges.end(), [](const Edge& a, const Edge& b) {
    return a.from != b.from ? a.from < b.from : a.to < b.to;
  });
  for (Mark& mark : records.marks) marks.insert_or_assign(mark.node, std::move(mark));
  for (Pointer& pointer : records.pointers) pointers.insert_or_assign(pointer.node, std::move(pointer));
  for (std::size_t slot = 0; slot < nodes.size(); ++slot) slots_.emplace(nodes[slot].id, slot);
  std::set<std::string> kindIds;
  for (const Kind& kind : kinds) kindIds.insert(kind.id);
  if (slots_.size() != nodes.size() || kindIds.size() != kinds.size())
    throw std::invalid_argument("Duplicate normalized roadmap identity");
}

const Step* RoadmapTree::step(const std::string& stepId) const {
  const auto found = slots_.find(stepId);
  return found == slots_.end() ? nullptr : &nodes[found->second];
}

const Pointer* RoadmapTree::pointerOn(const std::string& stepId) const {
  const auto found = pointers.find(stepId);
  return found == pointers.end() ? nullptr : &found->second;
}

const Mark* RoadmapTree::markOn(const std::string& stepId) const {
  const auto found = marks.find(stepId);
  return found == marks.end() ? nullptr : &found->second;
}

}
