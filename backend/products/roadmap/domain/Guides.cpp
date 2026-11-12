#include "products/roadmap/domain/Guides.h"

#include <algorithm>
#include <utility>

namespace wm {

std::map<TreeId, TreeAbove> nearestGuided(const std::map<TreeId, TreeAbove>& above, std::size_t room) {
  std::vector<std::pair<TreeId, TreeAbove>> guided;
  for (const auto& entry : above)
    if (!entry.second.guide.empty()) guided.push_back(entry);
  // They were gathered in id order, which a stable sort keeps among trees at one distance.
  std::stable_sort(guided.begin(), guided.end(),
                   [](const auto& left, const auto& right) { return left.second.distance < right.second.distance; });
  if (guided.size() > room) guided.resize(room);
  return {guided.begin(), guided.end()};
}

std::vector<Guide> guidesFor(const std::map<TreeId, TreeAbove>& above, const Guide& own) {
  // The tree's own guide always keeps its place, so it takes one from the trees above when it has text.
  const std::map<TreeId, TreeAbove> kept = nearestGuided(above, own.text.empty() ? kMaxGuides : kMaxGuides - 1);
  std::vector<Guide> guides;
  // Every tree above is the reader's own, so its guide is theirs unless a fork copied it.
  for (const auto& [id, tree] : kept) guides.push_back(Guide{id, tree.title, tree.guide, !tree.guideInherited});
  std::stable_sort(guides.begin(), guides.end(), [&](const Guide& left, const Guide& right) {
    return kept.at(left.tree).distance > kept.at(right.tree).distance;
  });
  if (!own.text.empty()) guides.push_back(own);
  return guides;
}

}
