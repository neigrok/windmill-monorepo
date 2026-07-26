#include "domain/TreeDiagnostics.h"

#include <algorithm>
#include <map>
#include <set>

namespace wm {

TreeDiagnostics TreeDiagnostics::assess(const LooseGraph& graph) {
  TreeDiagnostics report;

  std::vector<NodeId> ids = graph.presentNodeIds();
  std::set<NodeId> present(ids.begin(), ids.end());
  std::map<NodeId, int> index;
  for (int i = 0; i < static_cast<int>(ids.size()); ++i) index[ids[i]] = i;

  std::vector<std::vector<int>> adjacency(ids.size());
  std::set<NodeId> masked;
  for (const auto& edge : graph.presentEdges()) {
    if (edge.from == edge.to) {
      report.selfEdges.push_back(edge);
      continue;
    }
    if (!present.count(edge.from) || !present.count(edge.to)) {
      report.dangling.push_back(edge);
      // A live child hanging off a tombstoned parent is masked work — the parent can be resurrected.
      if (present.count(edge.to) && graph.isTombstoned(edge.from)) masked.insert(edge.from);
      continue;
    }
    adjacency[index[edge.from]].push_back(index[edge.to]);
  }
  report.maskedWork.assign(masked.begin(), masked.end());

  // Iterative Tarjan: every strongly-connected component of size > 1 is a cycle.
  const int n = static_cast<int>(ids.size());
  std::vector<int> order(n, -1);
  std::vector<int> low(n, 0);
  std::vector<bool> onStack(n, false);
  std::vector<int> component;
  int counter = 0;

  for (int root = 0; root < n; ++root) {
    if (order[root] != -1) continue;
    std::vector<std::pair<int, std::size_t>> work;
    work.emplace_back(root, 0);
    while (!work.empty()) {
      auto& [v, next] = work.back();
      if (next == 0) {
        order[v] = low[v] = counter++;
        component.push_back(v);
        onStack[v] = true;
      }
      if (next < adjacency[v].size()) {
        int w = adjacency[v][next];
        ++next;
        if (order[w] == -1) work.emplace_back(w, 0);
        else if (onStack[w]) low[v] = std::min(low[v], order[w]);
        continue;
      }
      if (low[v] == order[v]) {
        Cycle cycle;
        int u;
        do {
          u = component.back();
          component.pop_back();
          onStack[u] = false;
          cycle.members.push_back(ids[u]);
        } while (u != v);
        if (cycle.members.size() > 1) {
          std::sort(cycle.members.begin(), cycle.members.end());
          report.cycles.push_back(std::move(cycle));
        }
      }
      int finished = v;
      work.pop_back();
      if (!work.empty()) low[work.back().first] = std::min(low[work.back().first], low[finished]);
    }
  }

  // Smells read one linear projection; nodeView per node would rescan every live edge (O(V*E)).
  const TreeData projection = graph.toTreeData(TreeId{}, {});
  for (const auto& node : projection.nodes) {
    if (node.label.size() > maxLabel) report.smells.push_back(Smell{node.id, "label-too-long"});
    if (node.icon.empty()) report.smells.push_back(Smell{node.id, "empty-icon"});
    if (node.prerequisites.size() > inDegreeSmell) report.smells.push_back(Smell{node.id, "high-in-degree"});
  }

  return report;
}

}
