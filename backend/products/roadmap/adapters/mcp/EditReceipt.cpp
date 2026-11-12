#include "products/roadmap/adapters/mcp/EditReceipt.h"

#include <cstddef>
#include <set>
#include <string>
#include <vector>

namespace wm {

namespace {

constexpr std::size_t kMostNamed = 5;

template <typename Tag>
std::string quoted(const Id<Tag>& id) { return "\"" + id.str() + "\""; }

std::string named(const Cycle& cycle) {
  std::string members;
  for (const NodeId& node : cycle.members) {
    if (!members.empty()) members += ", ";
    members += quoted(node);
  }
  return "cycle among " + members;
}

std::string named(const TreeLoop& loop) {
  std::string way;
  for (const TreeOnLoop& on : loop.path) {
    if (!way.empty()) way += " -> ";
    way += quoted(on.tree);
  }
  if (loop.pathOmitted > 0) way += " and " + std::to_string(loop.pathOmitted) + " more";
  return "loop of trees from " + quoted(loop.node) + " through " + way;
}

}  // namespace

void answerDiagnostics(const TreeDiagnostics& before, const TreeDiagnostics& after, Json::Value& receipt,
                       const PointerDiagnostics& closed) {
  std::set<std::vector<NodeId>> knownCycles;
  for (const Cycle& cycle : before.cycles) knownCycles.insert(cycle.members);
  const std::set<Edge> knownDangling(before.dangling.begin(), before.dangling.end());
  const std::set<Edge> knownSelfEdges(before.selfEdges.begin(), before.selfEdges.end());

  std::vector<std::string> introduced;
  for (const Cycle& cycle : after.cycles)
    if (!knownCycles.count(cycle.members)) introduced.push_back(named(cycle));
  for (const Edge& edge : after.dangling)
    if (!knownDangling.count(edge))
      introduced.push_back("dangling edge " + quoted(edge.from) + " -> " + quoted(edge.to));
  for (const Edge& edge : after.selfEdges)
    if (!knownSelfEdges.count(edge)) introduced.push_back("self-edge on " + quoted(edge.from));
  for (const TreeLoop& loop : closed.treeLoops) introduced.push_back(named(loop));
  const std::size_t all = introduced.size() + closed.treeLoopsOmitted;

  Json::Value list(Json::arrayValue);
  for (std::size_t i = 0; i < introduced.size() && i < kMostNamed; ++i) list.append(introduced[i]);
  if (all > kMostNamed)
    list.append("and " + std::to_string(all - kMostNamed) +
                " more — call get_diagnostics for the whole list");

  receipt["diagnosticsClean"] = after.clean();
  receipt["introducedDiagnostics"] = list;
}

void answerKeptEdges(const std::vector<Edge>& kept, Json::Value& receipt) {
  constexpr std::size_t kMostListed = 50;
  Json::Value list(Json::arrayValue);
  for (std::size_t i = 0; i < kept.size() && i < kMostListed; ++i) {
    Json::Value edge(Json::objectValue);
    edge["from"] = kept[i].from.str();
    edge["to"] = kept[i].to.str();
    list.append(edge);
  }
  if (kept.size() > kMostListed)
    list.append("and " + std::to_string(kept.size() - kMostListed) +
                " more — re-send with prerequisiteMode \"replace\" to drop every edge the batch does not name");
  receipt["keptEdges"] = list;
  receipt["keptEdgeCount"] = static_cast<Json::UInt64>(kept.size());
}

}
