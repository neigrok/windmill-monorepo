#include "domain/Command.h"
#include "domain/LooseGraph.h"
#include "test/testing.h"

using namespace wm;

static NodeId nid(const char* s) { return NodeId{std::string(s)}; }
static Hlc at(std::uint64_t ms, const char* actor = "a") { return Hlc{ms, 0, actor}; }

static LooseGraph seeded() {
  LooseGraph g;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  g.createNode(nid("b"), "B", "x", NodeColor::gold, Vec2{3, 4}, at(1));
  g.addEdge(nid("a"), nid("b"), at(2));
  return g;
}

TEST(invert_rename_restores_prior_label) {
  LooseGraph g = seeded();
  Command rename = RenameNode{nid("b"), "renamed"};
  auto inverse = invert(g, rename);
  merge(g, rename, at(5));
  CHECK_EQ(g.nodeView(nid("b"))->label, std::string("renamed"));
  CHECK_EQ(inverse.size(), 1u);
  merge(g, inverse[0], at(6));
  CHECK_EQ(g.nodeView(nid("b"))->label, std::string("B"));
}

TEST(invert_add_edge_that_existed_is_noop) {
  LooseGraph g = seeded();
  auto inverse = invert(g, Command{AddEdge{nid("a"), nid("b")}});
  CHECK_EQ(inverse.size(), 0u);
}

TEST(invert_add_edge_removes_new_edge) {
  LooseGraph g = seeded();
  g.createNode(nid("c"), "C", "x", NodeColor::sky, std::nullopt, at(1));
  Command add = AddEdge{nid("a"), nid("c")};
  auto inverse = invert(g, add);
  merge(g, add, at(5));
  CHECK(g.edgePresent(nid("a"), nid("c")));
  CHECK_EQ(inverse.size(), 1u);
  merge(g, inverse[0], at(6));
  CHECK_FALSE(g.edgePresent(nid("a"), nid("c")));
}

TEST(invert_delete_recreates_node_with_fields) {
  LooseGraph g = seeded();
  Command del = DeleteNode{nid("b")};
  auto inverse = invert(g, del);
  merge(g, del, at(5));
  CHECK_FALSE(g.hasNode(nid("b")));
  CHECK_EQ(inverse.size(), 1u);
  merge(g, inverse[0], at(6));
  CHECK(g.hasNode(nid("b")));
  CHECK_EQ(g.nodeView(nid("b"))->label, std::string("B"));
  CHECK_EQ(g.nodeView(nid("b"))->color, NodeColor::gold);
  CHECK_EQ(g.liveEdges().size(), 1u);
}

TEST(transitive_reduction_drops_redundant_edge) {
  LooseGraph g;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  g.createNode(nid("b"), "B", "x", NodeColor::sky, std::nullopt, at(1));
  g.createNode(nid("c"), "C", "x", NodeColor::sky, std::nullopt, at(1));
  g.addEdge(nid("a"), nid("b"), at(2));
  g.addEdge(nid("b"), nid("c"), at(2));
  g.addEdge(nid("a"), nid("c"), at(2));  // redundant: a reaches c through b

  auto redundant = g.redundantEdges();
  CHECK_EQ(redundant.size(), 1u);
  CHECK_EQ(redundant[0], (Edge{nid("a"), nid("c")}));

  Command tidy = TransitiveReduction{};
  auto inverse = invert(g, tidy);
  merge(g, tidy, at(5));
  CHECK_FALSE(g.edgePresent(nid("a"), nid("c")));
  CHECK(g.edgePresent(nid("a"), nid("b")));
  CHECK(g.edgePresent(nid("b"), nid("c")));

  CHECK_EQ(inverse.size(), 1u);
  merge(g, inverse[0], at(6));
  CHECK(g.edgePresent(nid("a"), nid("c")));
}
