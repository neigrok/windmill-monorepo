#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/TreeDiagnostics.h"
#include "test/testing.h"

using namespace wm;

static NodeId nid(const char* s) { return NodeId{std::string(s)}; }
static Hlc at(std::uint64_t ms, const char* actor = "a") { return Hlc{ms, 0, actor}; }

static void put(LooseGraph& g, const char* id) {
  g.createNode(nid(id), id, "icon", NodeColor::sky, std::nullopt, at(1));
}

TEST(clean_graph_reports_clean) {
  LooseGraph g;
  put(g, "a");
  put(g, "b");
  g.addEdge(nid("a"), nid("b"), at(2));
  auto report = TreeDiagnostics::assess(g);
  CHECK(report.clean());
  CHECK_EQ(report.cycles.size(), 0u);
  CHECK_EQ(report.dangling.size(), 0u);
  CHECK_EQ(report.selfEdges.size(), 0u);
}

TEST(self_edge_detected) {
  LooseGraph g;
  put(g, "a");
  g.addEdge(nid("a"), nid("a"), at(2));
  auto report = TreeDiagnostics::assess(g);
  CHECK_FALSE(report.clean());
  CHECK_EQ(report.selfEdges.size(), 1u);
  CHECK_EQ(report.cycles.size(), 0u);
}

TEST(dangling_edge_detected) {
  LooseGraph g;
  put(g, "a");
  put(g, "b");
  g.addEdge(nid("a"), nid("b"), at(2));
  g.deleteNode(nid("b"), at(3));
  auto report = TreeDiagnostics::assess(g);
  CHECK_EQ(report.dangling.size(), 1u);
  CHECK_EQ(report.dangling[0], (Edge{nid("a"), nid("b")}));
  CHECK_FALSE(report.clean());
}

TEST(masked_work_flags_a_tombstoned_parent_with_a_live_child) {
  // The phone deletes "parent"; the laptop, concurrently, builds a child under it.
  LooseGraph g;
  put(g, "parent");
  g.deleteNode(nid("parent"), at(10));           // the delete stands
  g.createNode(nid("child"), "Child", "x", NodeColor::gold, std::nullopt, at(20));
  g.addEdge(nid("parent"), nid("child"), at(21)); // a live child hangs off the tombstone

  auto report = TreeDiagnostics::assess(g);
  CHECK_EQ(report.maskedWork.size(), 1u);
  CHECK_EQ(report.maskedWork[0], nid("parent"));

  // Resurrecting the parent clears the masked-work signal — the child is re-connected.
  g.createNode(nid("parent"), "Parent", "x", NodeColor::sky, std::nullopt, at(30));
  CHECK_EQ(TreeDiagnostics::assess(g).maskedWork.size(), 0u);
}

TEST(a_plain_deleted_leaf_is_not_masked_work) {
  LooseGraph g;
  put(g, "a");
  put(g, "b");
  g.addEdge(nid("a"), nid("b"), at(2));
  g.deleteNode(nid("b"), at(3));  // a deleted CHILD (no live children of its own) is not masked work
  CHECK_EQ(TreeDiagnostics::assess(g).maskedWork.size(), 0u);
}

TEST(cycle_detected_with_members) {
  LooseGraph g;
  put(g, "a");
  put(g, "b");
  put(g, "c");
  g.addEdge(nid("a"), nid("b"), at(2));
  g.addEdge(nid("b"), nid("c"), at(2));
  g.addEdge(nid("c"), nid("a"), at(2));
  auto report = TreeDiagnostics::assess(g);
  CHECK_EQ(report.cycles.size(), 1u);
  CHECK_EQ(report.cycles[0].members.size(), 3u);
  CHECK_EQ(report.cycles[0].members[0], nid("a"));
  CHECK_EQ(report.cycles[0].members[1], nid("b"));
  CHECK_EQ(report.cycles[0].members[2], nid("c"));
  CHECK_FALSE(report.clean());
}

TEST(two_node_cycle_detected) {
  LooseGraph g;
  put(g, "a");
  put(g, "b");
  g.addEdge(nid("a"), nid("b"), at(2));
  g.addEdge(nid("b"), nid("a"), at(2));
  auto report = TreeDiagnostics::assess(g);
  CHECK_EQ(report.cycles.size(), 1u);
  CHECK_EQ(report.cycles[0].members.size(), 2u);
}

TEST(high_in_degree_smell) {
  LooseGraph g;
  put(g, "child");
  for (int i = 0; i < 5; ++i) {
    std::string parent = "p" + std::to_string(i);
    g.createNode(NodeId{parent}, parent, "icon", NodeColor::sky, std::nullopt, at(1));
    g.addEdge(NodeId{parent}, nid("child"), at(2));
  }
  auto report = TreeDiagnostics::assess(g);
  CHECK(report.clean());
  bool found = false;
  for (const auto& smell : report.smells) {
    if (smell.node == nid("child") && smell.kind == "high-in-degree") found = true;
  }
  CHECK(found);
}
