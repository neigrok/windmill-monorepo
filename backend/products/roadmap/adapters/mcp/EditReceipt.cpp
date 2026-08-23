#include "products/roadmap/adapters/mcp/EditReceipt.h"

#include <cstddef>
#include <set>
#include <string>
#include <vector>

namespace wm {

namespace {

// A receipt is not a diagnostics report: name enough to act on, then say how many more.
constexpr std::size_t kMostNamed = 5;

std::string quoted(const NodeId& node) { return "\"" + node.str() + "\""; }

std::string named(const Cycle& cycle) {
  std::string members;
  for (const NodeId& node : cycle.members) {
    if (!members.empty()) members += ", ";
    members += quoted(node);
  }
  return "cycle among " + members;
}

}  // namespace

void answerDiagnostics(const TreeDiagnostics& before, const TreeDiagnostics& after, Json::Value& receipt) {
  // Taken under the tree's strand, `before` and `after` bracket this one write and nothing else,
  // so the difference between them is this edit's doing.
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

  Json::Value list(Json::arrayValue);
  for (std::size_t i = 0; i < introduced.size() && i < kMostNamed; ++i) list.append(introduced[i]);
  if (introduced.size() > kMostNamed)
    list.append("and " + std::to_string(introduced.size() - kMostNamed) +
                " more — call get_diagnostics for the whole list");

  receipt["diagnosticsClean"] = after.clean();
  receipt["introducedDiagnostics"] = list;
}

}
