#include "domain/NodeQuery.h"

#include <algorithm>
#include <cctype>

namespace wm {

namespace {
std::string lower(std::string text) {
  std::transform(text.begin(), text.end(), text.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return text;
}

bool contains(const std::string& haystack, const std::string& needle) {
  return lower(haystack).find(lower(needle)) != std::string::npos;
}
}

std::vector<NodeSpec> selectNodes(const TreeData& tree, const NodeFilter& filter) {
  std::optional<NodeColor> kindHue;
  if (filter.kind) {
    for (const Kind& kind : tree.kinds)
      if (kind.id == *filter.kind) kindHue = kind.hue;
    if (!kindHue) return {};  // a kind id the legend doesn't carry matches no node
  }

  std::vector<NodeSpec> matches;
  for (const NodeSpec& node : tree.nodes) {
    if (filter.color && node.color != *filter.color) continue;
    if (kindHue && node.color != *kindHue) continue;
    if (!filter.query.empty() && !contains(node.label, filter.query) && !contains(node.description, filter.query))
      continue;
    matches.push_back(node);
  }
  return matches;
}

}
