#include "products/roadmap/domain/NodeQuery.h"

#include <algorithm>
#include <cctype>
#include <utility>

namespace wm {

namespace {
std::string lower(std::string text) {
  std::transform(text.begin(), text.end(), text.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return text;
}

// Why a node matched, and so where it sits in the answer: the enum's own order IS the ranking.
enum class Relevance { exactId, idPrefix, label, idSubstring, description, unqueried, none };

Relevance relevanceOf(const NodeSpec& node, const std::string& needle) {  // `needle` already lowered
  if (needle.empty()) return Relevance::unqueried;  // nothing asked, so every node ranks alike
  const std::string id = lower(node.id.str());
  if (id == needle) return Relevance::exactId;
  if (id.rfind(needle, 0) == 0) return Relevance::idPrefix;
  if (lower(node.label).find(needle) != std::string::npos) return Relevance::label;
  if (id.find(needle) != std::string::npos) return Relevance::idSubstring;
  if (lower(node.description).find(needle) != std::string::npos) return Relevance::description;
  return Relevance::none;
}
}

std::vector<NodeSpec> selectNodes(const TreeData& tree, const NodeFilter& filter) {
  std::optional<NodeColor> kindHue;
  if (filter.kind) {
    for (const Kind& kind : tree.kinds)
      if (kind.id == *filter.kind) kindHue = kind.hue;
    if (!kindHue) return {};  // a kind id the legend doesn't carry matches no node
  }

  const std::string needle = lower(filter.query);
  std::vector<std::pair<Relevance, const NodeSpec*>> ranked;
  for (const NodeSpec& node : tree.nodes) {
    if (filter.color && node.color != *filter.color) continue;
    if (kindHue && node.color != *kindHue) continue;
    const Relevance relevance = relevanceOf(node, needle);
    if (relevance == Relevance::none) continue;
    ranked.emplace_back(relevance, &node);
  }
  // Stable, so nodes that matched the same way keep the tree's order — and only the matches are
  // sorted, never the whole tree.
  std::stable_sort(ranked.begin(), ranked.end(),
                   [](const auto& left, const auto& right) { return left.first < right.first; });

  std::vector<NodeSpec> matches;
  matches.reserve(ranked.size());
  for (const auto& match : ranked) matches.push_back(*match.second);
  return matches;
}

}
