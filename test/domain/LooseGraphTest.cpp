#include "domain/Command.h"
#include "domain/LooseGraph.h"
#include "test/testing.h"

using namespace wm;

static NodeId nid(const char* s) { return NodeId{std::string(s)}; }
static Hlc at(std::uint64_t ms, const char* actor = "a") { return Hlc{ms, 0, actor}; }

TEST(project_present_nodes_and_edges) {
  LooseGraph g;
  g.createNode(nid("root"), "Root", "zap", NodeColor::sky, std::nullopt, at(1));
  g.createNode(nid("child"), "Child", "image", NodeColor::gold, Vec2{1, 2}, at(2));
  g.addEdge(nid("root"), nid("child"), at(3));

  auto data = g.toTreeData(TreeId{std::string("t")}, "Title");
  CHECK_EQ(data.nodes.size(), 2u);

  auto child = g.nodeView(nid("child"));
  CHECK(child.has_value());
  CHECK_EQ(child->prerequisites.size(), 1u);
  CHECK_EQ(child->prerequisites[0], nid("root"));
  CHECK(child->position.has_value());
  CHECK_EQ(child->color, NodeColor::gold);
}

TEST(duplicate_add_edge_collapses) {
  LooseGraph g;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  g.createNode(nid("b"), "B", "x", NodeColor::sky, std::nullopt, at(1));
  g.addEdge(nid("a"), nid("b"), at(2));
  g.addEdge(nid("a"), nid("b"), at(3));
  CHECK_EQ(g.liveEdges().size(), 1u);
}

TEST(edge_add_wins_on_tie) {
  LooseGraph g;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  g.createNode(nid("b"), "B", "x", NodeColor::sky, std::nullopt, at(1));
  Hlc tie{5, 0, "a"};
  g.addEdge(nid("a"), nid("b"), tie);
  g.removeEdge(nid("a"), nid("b"), tie);
  CHECK(g.edgePresent(nid("a"), nid("b")));
}

TEST(edge_later_remove_then_later_add) {
  LooseGraph g;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  g.createNode(nid("b"), "B", "x", NodeColor::sky, std::nullopt, at(1));

  g.addEdge(nid("a"), nid("b"), at(2));
  g.removeEdge(nid("a"), nid("b"), at(3));
  CHECK_FALSE(g.edgePresent(nid("a"), nid("b")));

  g.addEdge(nid("a"), nid("b"), at(4));
  CHECK(g.edgePresent(nid("a"), nid("b")));
}

TEST(label_lww_highest_stamp_wins) {
  LooseGraph g;
  g.createNode(nid("x"), "first", "i", NodeColor::sky, std::nullopt, at(1));
  g.setLabel(nid("x"), "second", at(3));
  g.setLabel(nid("x"), "stale", at(2));
  CHECK_EQ(g.nodeView(nid("x"))->label, std::string("second"));
}

TEST(delete_tombstones_then_resurrection_revives_edges) {
  LooseGraph g;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  g.createNode(nid("b"), "B", "x", NodeColor::sky, std::nullopt, at(1));
  g.addEdge(nid("a"), nid("b"), at(2));

  g.deleteNode(nid("b"), at(3));
  CHECK_FALSE(g.hasNode(nid("b")));
  CHECK_EQ(g.liveEdges().size(), 0u);
  CHECK_EQ(g.presentEdges().size(), 1u);

  g.createNode(nid("b"), "B", "x", NodeColor::sky, std::nullopt, at(4));
  CHECK(g.hasNode(nid("b")));
  CHECK_EQ(g.liveEdges().size(), 1u);
}

TEST(status_seed_round_trips_through_projection) {
  LooseGraph g;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1), std::string("complete"));
  auto view = g.nodeView(nid("a"));
  CHECK(view->status.has_value());
  CHECK_EQ(*view->status, std::string("complete"));
}

TEST(export_import_round_trips_full_state) {
  LooseGraph g;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, Vec2{1, 2}, at(1));
  g.createNode(nid("b"), "B", "x", NodeColor::gold, std::nullopt, at(1));
  g.addEdge(nid("a"), nid("b"), at(2));

  LooseGraph reloaded(g.exportState());
  CHECK(reloaded.presentNodeIds() == g.presentNodeIds());
  CHECK(reloaded.liveEdges() == g.liveEdges());
  CHECK_EQ(reloaded.nodeView(nid("a"))->color, NodeColor::sky);
  CHECK(reloaded.nodeView(nid("a"))->position.has_value());
}

TEST(export_import_preserves_tombstones_and_inert_edges) {
  LooseGraph g;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  g.createNode(nid("b"), "B", "x", NodeColor::sky, std::nullopt, at(1));
  g.addEdge(nid("a"), nid("b"), at(2));
  g.deleteNode(nid("b"), at(3));  // b tombstoned; edge a->b now inert

  LooseGraph reloaded(g.exportState());  // full-state round-trip (the projection would lose these)
  CHECK_FALSE(reloaded.hasNode(nid("b")));
  CHECK_EQ(reloaded.liveEdges().size(), 0u);
  CHECK_EQ(reloaded.presentEdges().size(), 1u);  // inert edge survived

  reloaded.createNode(nid("b"), "B", "x", NodeColor::sky, std::nullopt, at(4));  // resurrect
  CHECK(reloaded.hasNode(nid("b")));
  CHECK_EQ(reloaded.liveEdges().size(), 1u);  // edge revived — lossless
}

TEST(merge_is_order_independent) {
  std::vector<std::pair<Command, Hlc>> ops = {
    {CreateNode{nid("a"), "A", "x", NodeColor::sky, std::nullopt, std::nullopt}, at(1)},
    {CreateNode{nid("b"), "B", "x", NodeColor::gold, nid("a"), std::nullopt}, at(2)},
    {RenameNode{nid("b"), "B2"}, at(4)},
    {RenameNode{nid("b"), "stale"}, at(3)},
    {AddEdge{nid("a"), nid("b")}, at(5)},
    {RemoveEdge{nid("a"), nid("b")}, at(6)},
    {AddEdge{nid("a"), nid("b")}, at(7)},
  };

  LooseGraph forward;
  for (auto it = ops.begin(); it != ops.end(); ++it) merge(forward, it->first, it->second);
  LooseGraph reversed;
  for (auto it = ops.rbegin(); it != ops.rend(); ++it) merge(reversed, it->first, it->second);

  CHECK(forward.presentNodeIds() == reversed.presentNodeIds());
  CHECK(forward.liveEdges() == reversed.liveEdges());
  CHECK_EQ(forward.nodeView(nid("b"))->label, reversed.nodeView(nid("b"))->label);
  CHECK_EQ(forward.nodeView(nid("b"))->label, std::string("B2"));
}
