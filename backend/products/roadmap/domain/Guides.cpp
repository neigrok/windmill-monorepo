#include "products/roadmap/domain/Guides.h"

#include <algorithm>
#include <cstddef>

namespace wm {

std::vector<Guide> guidesFor(const std::map<TreeId, TreeAbove>& above, const Guide& own) {
  std::vector<Guide> guides;
  // Every tree above is the reader's own, so its guide is theirs unless a fork copied it.
  for (const auto& [id, tree] : above)
    if (!tree.guide.empty()) guides.push_back(Guide{id, tree.title, tree.guide, !tree.guideInherited});
  // They were gathered in id order, which a stable sort keeps among trees at one distance.
  std::stable_sort(guides.begin(), guides.end(), [&](const Guide& left, const Guide& right) {
    return above.at(left.tree).distance > above.at(right.tree).distance;
  });
  if (!own.text.empty()) guides.push_back(own);
  // Past the cap the farthest go: the nearest trees and the tree's own guide keep their places.
  if (guides.size() > kMaxGuides) guides.erase(guides.begin(), guides.end() - static_cast<std::ptrdiff_t>(kMaxGuides));
  return guides;
}

}
