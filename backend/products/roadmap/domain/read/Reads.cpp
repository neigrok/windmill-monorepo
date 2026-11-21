#include "products/roadmap/domain/read/Reads.h"

#include <algorithm>

namespace wm::roadmap::read {

namespace {

constexpr std::size_t kListed = 50;
constexpr std::size_t kNamed = 10;
constexpr std::size_t kLongLabelBytes = 256;
constexpr std::size_t kHighInDegree = 4;
constexpr std::size_t kPathShown = 8;
constexpr const char* kHueOrder[] = {"terracotta", "olive", "gold", "brick", "sky", "plum"};

template <typename Entry>
Listed<Entry> listed(std::vector<Entry> entries) {
  const std::size_t omitted = entries.size() > kListed ? entries.size() - kListed : 0;
  if (entries.size() > kListed) entries.resize(kListed);
  return Listed<Entry>{std::move(entries), omitted};
}

Counted counted(const std::vector<std::string>& ids) {
  return Counted{ids.size(), std::vector<std::string>(ids.begin(), ids.begin() + std::min(ids.size(), kNamed))};
}

int hueRank(const std::string& hue) {
  for (int rank = 0; rank < 6; ++rank)
    if (hue == kHueOrder[rank]) return rank;
  return -1;
}

std::string asciiLower(std::string text) {
  for (char& letter : text)
    if (letter >= 'A' && letter <= 'Z') letter = static_cast<char>(letter - 'A' + 'a');
  return text;
}

}

LegendRead::LegendRead(const RoadmapTree& tree) {
  for (const Kind& kind : tree.kinds)
    if (kind.present) kinds_.push_back(kind);
  for (const Kind& kind : kinds_) byHue_[kind.hue].push_back(kind);
  for (auto& [hue, kinds] : byHue_)
    std::stable_sort(kinds.begin(), kinds.end(), [](const Kind& a, const Kind& b) {
      return a.born != b.born ? a.born < b.born : a.id < b.id;
    });
}

const Kind* LegendRead::ownerOf(const std::string& hue) const {
  const auto found = byHue_.find(hue);
  return found == byHue_.end() ? nullptr : &found->second.front();
}

std::vector<HueOwner> LegendRead::owners() const {
  std::vector<HueOwner> owners;
  for (const auto& [hue, kinds] : byHue_) owners.push_back(HueOwner{hue, kinds.front().id});
  return owners;
}

std::vector<HueCollision> LegendRead::collisions() const {
  std::vector<HueCollision> collisions;
  for (const auto& [hue, kinds] : byHue_) {
    if (kinds.size() < 2) continue;
    HueCollision collision{hue, kinds.front().id, {}};
    for (std::size_t index = 1; index < kinds.size(); ++index) collision.others.push_back(kinds[index].id);
    std::sort(collision.others.begin(), collision.others.end());
    collisions.push_back(std::move(collision));
  }
  return collisions;
}

std::vector<std::string> selectNodes(const RoadmapTree& tree, const NodeFilter& filter) {
  const Kind* kind = nullptr;
  if (filter.kind) {
    for (const Kind& candidate : tree.kinds)
      if (candidate.present && candidate.id == *filter.kind) kind = &candidate;
    if (!kind) return {};
  }
  const std::string needle = asciiLower(filter.query.value_or(""));
  std::vector<std::pair<std::string, int>> ranked;
  for (const Step& node : tree.nodes) {
    if (!node.present || (filter.color && node.color != *filter.color) || (kind && node.color != kind->hue)) continue;
    const std::string id = asciiLower(node.id);
    const int rank = needle.empty()                                           ? 5
                     : id == needle                                           ? 0
                     : id.starts_with(needle)                                 ? 1
                     : asciiLower(node.label).find(needle) != std::string::npos ? 2
                     : id.find(needle) != std::string::npos                   ? 3
                     : asciiLower(node.description).find(needle) != std::string::npos ? 4
                                                                              : -1;
    if (rank >= 0) ranked.emplace_back(node.id, rank);
  }
  std::stable_sort(ranked.begin(), ranked.end(), [](const auto& a, const auto& b) { return a.second < b.second; });
  std::vector<std::string> ids;
  for (const auto& [id, rank] : ranked) ids.push_back(id);
  return ids;
}

Diagnostics diagnose(const FollowGraph& graph) {
  const RoadmapTree& tree = graph.tree();
  std::vector<std::vector<std::string>> cycles;
  std::vector<std::vector<std::string>> absentCycles;
  const auto& parents = graph.parents();
  for (const std::vector<std::size_t>& group : components(parents).groups) {
    const bool selfLoop = std::find(parents[group[0]].begin(), parents[group[0]].end(), group[0]) != parents[group[0]].end();
    if (group.size() == 1 && !selfLoop) continue;
    std::vector<std::string> ids;
    for (const std::size_t vertex : group) ids.push_back(graph.rawIds()[vertex]);
    std::vector<std::string> present;
    for (const std::string& id : ids)
      if (graph.isPresent(id)) present.push_back(id);
    std::sort(present.begin(), present.end());
    if (!present.empty()) cycles.push_back(std::move(present));
    else {
      std::sort(ids.begin(), ids.end());
      absentCycles.push_back(std::move(ids));
    }
  }
  for (auto* groups : {&cycles, &absentCycles})
    std::stable_sort(groups->begin(), groups->end(), [](const auto& a, const auto& b) { return a[0] < b[0]; });

  const LegendRead legend(tree);
  Diagnostics found;
  found.legendEmpty = legend.kinds().empty() && !graph.ids().empty();
  std::vector<std::string> ids = graph.ids();
  std::sort(ids.begin(), ids.end());
  std::vector<std::string> longLabel;
  std::vector<std::string> emptyIcon;
  std::vector<std::string> highDegree;
  std::vector<std::pair<std::string, std::vector<std::string>>> unclaimed;
  for (const std::string& id : ids) {
    const Step* node = tree.step(id);
    if (!node) continue;
    if (node->label.size() > kLongLabelBytes) longLabel.push_back(id);
    if (node->icon.empty()) emptyIcon.push_back(id);
    if (graph.inDegree(id) > kHighInDegree) highDegree.push_back(id);
    if (!found.legendEmpty && !legend.claims(node->color)) {
      auto hue = std::find_if(unclaimed.begin(), unclaimed.end(), [&](const auto& entry) { return entry.first == node->color; });
      if (hue == unclaimed.end()) hue = unclaimed.insert(unclaimed.end(), {node->color, {}});
      hue->second.push_back(id);
    }
  }
  std::vector<Counted> countedCycles;
  for (const auto& cycle : cycles) countedCycles.push_back(counted(cycle));
  std::vector<Counted> countedAbsent;
  for (const auto& cycle : absentCycles) countedAbsent.push_back(counted(cycle));
  found.cycles = listed(std::move(countedCycles));
  found.absentCycles = listed(std::move(countedAbsent));
  std::vector<std::pair<std::string, std::string>> missing;
  std::vector<std::pair<std::string, std::string>> selfEdges;
  for (const Edge& edge : graph.liveEdges()) {
    if (!tree.step(edge.from) || !tree.step(edge.to)) missing.emplace_back(edge.from, edge.to);
    if (edge.from == edge.to) selfEdges.emplace_back(edge.from, edge.to);
  }
  found.missingEdges = listed(std::move(missing));
  found.selfEdges = listed(std::move(selfEdges));
  for (const auto& [kind, nodes] : {std::pair{"label-too-long", &longLabel}, std::pair{"empty-icon", &emptyIcon},
                                    std::pair{"high-in-degree", &highDegree}})
    if (!nodes->empty()) found.smells.push_back(Smell{kind, counted(*nodes)});
  std::stable_sort(unclaimed.begin(), unclaimed.end(), [](const auto& a, const auto& b) {
    const int left = hueRank(a.first);
    const int right = hueRank(b.first);
    return left != right ? left < right : a.first < b.first;
  });
  for (const auto& [hue, nodes] : unclaimed) found.unclaimedHues.push_back(UnclaimedHue{hue, counted(nodes)});
  return found;
}

PointerDiagnostics pointerDiagnostics(const RoadmapAccount& account, const std::string& tree) {
  const std::map<std::string, WayBack> ways = account.waysBack(tree);
  PointerDiagnostics found;
  std::vector<Opening> openings = account.openingsOf(tree);
  std::stable_sort(openings.begin(), openings.end(), [](const Opening& a, const Opening& b) { return a.node < b.node; });
  for (const Opening& opening : openings) {
    if (opening.status == OpeningStatus::dangling) {
      if (found.danglingPointers.size() == kListed) ++found.danglingPointersOmitted;
      else found.danglingPointers.push_back(DanglingPointer{opening.node, opening.tree});
      continue;
    }
    const auto way = ways.find(opening.tree);
    if (way == ways.end() || opening.status == OpeningStatus::unknown) continue;
    if (found.treeLoops.size() == kListed) {
      ++found.treeLoopsOmitted;
      continue;
    }
    const std::size_t length = way->second.distance + 1;
    TreeLoop loop{opening.node, {}, 0};
    std::string current = opening.tree;
    while (loop.path.size() < std::min(kPathShown, length)) {
      loop.path.push_back(PathStep{current, account.locationOf(current).title});
      const auto next = ways.find(current);
      if (next == ways.end() || !next->second.next) break;
      current = *next->second.next;
    }
    loop.pathOmitted = length > loop.path.size() ? length - loop.path.size() : 0;
    found.treeLoops.push_back(std::move(loop));
  }
  std::vector<StaleBranch> stale = account.staleBranchesOf(tree);
  std::stable_sort(stale.begin(), stale.end(), [](const StaleBranch& a, const StaleBranch& b) { return a.node < b.node; });
  found.staleBranchesOmitted = stale.size() > kListed ? stale.size() - kListed : 0;
  if (stale.size() > kListed) stale.resize(kListed);
  found.staleBranches = std::move(stale);
  return found;
}

}
