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

TEST(join_folds_a_partial_state_without_touching_others) {
  LooseGraph base;
  base.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));

  LooseGraph addition;
  addition.createNode(nid("b"), "B", "x", NodeColor::gold, std::nullopt, at(2));
  addition.addEdge(nid("a"), nid("b"), at(3));

  base.join(addition.exportState());
  CHECK(base.hasNode(nid("a")));
  CHECK(base.hasNode(nid("b")));
  CHECK(base.edgePresent(nid("a"), nid("b")));
  CHECK_EQ(base.nodeView(nid("a"))->label, std::string("A"));
}

TEST(join_is_idempotent) {
  LooseGraph source;
  source.createNode(nid("a"), "A", "x", NodeColor::sky, Vec2{1, 2}, at(1));
  source.createNode(nid("b"), "B", "x", NodeColor::gold, std::nullopt, at(2));
  source.addEdge(nid("a"), nid("b"), at(3));
  source.deleteNode(nid("b"), at(4));
  GraphState state = source.exportState();

  LooseGraph once;
  once.join(state);
  LooseGraph twice;
  twice.join(state);
  twice.join(state);
  CHECK(once.exportState() == twice.exportState());
}

TEST(join_is_commutative_over_full_states) {
  LooseGraph left;
  left.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  left.setLabel(nid("a"), "A-late", at(9));

  LooseGraph right;
  right.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(2));
  right.setLabel(nid("a"), "A-early", at(5));
  right.createNode(nid("b"), "B", "x", NodeColor::gold, std::nullopt, at(3));

  LooseGraph leftFirst;
  leftFirst.join(left.exportState());
  leftFirst.join(right.exportState());

  LooseGraph rightFirst;
  rightFirst.join(right.exportState());
  rightFirst.join(left.exportState());

  CHECK(leftFirst.exportState() == rightFirst.exportState());
  CHECK_EQ(leftFirst.nodeView(nid("a"))->label, std::string("A-late"));  // highest stamp wins either way
}

TEST(join_keeps_more_add_beats_concurrent_remove) {
  LooseGraph seed;
  seed.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  seed.createNode(nid("b"), "B", "x", NodeColor::sky, std::nullopt, at(1));
  GraphState shared = seed.exportState();

  Hlc concurrent{5, 0, "a"};  // an identical stamp on both sides — the tie the add must win
  LooseGraph adder(shared);
  adder.addEdge(nid("a"), nid("b"), concurrent);
  LooseGraph remover(shared);
  remover.removeEdge(nid("a"), nid("b"), concurrent);

  LooseGraph converged(shared);
  converged.join(adder.exportState());
  converged.join(remover.exportState());
  CHECK(converged.edgePresent(nid("a"), nid("b")));  // add-biased element set keeps the edge
}

TEST(join_lets_a_deleted_nodes_offline_children_survive) {
  LooseGraph shared;
  shared.createNode(nid("parent"), "Parent", "x", NodeColor::sky, std::nullopt, at(1));
  GraphState base = shared.exportState();

  LooseGraph phone(base);      // the phone deletes the parent
  phone.deleteNode(nid("parent"), at(10));

  LooseGraph laptop(base);     // the laptop, offline, builds children under it
  laptop.createNode(nid("child"), "Child", "x", NodeColor::gold, std::nullopt, at(20));
  laptop.addEdge(nid("parent"), nid("child"), at(21));

  LooseGraph converged(base);
  converged.join(phone.exportState());
  converged.join(laptop.exportState());

  CHECK_FALSE(converged.hasNode(nid("parent")));       // the delete stands
  CHECK(converged.hasNode(nid("child")));              // but the child's work is not lost
  CHECK_EQ(converged.presentEdges().size(), 1u);       // the edge is latent, ready to resurrect
  converged.createNode(nid("parent"), "Parent", "x", NodeColor::sky, std::nullopt, at(30));
  CHECK(converged.edgePresent(nid("parent"), nid("child")));  // one re-add brings the subtree back
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

  Legend legend;
  LooseGraph forward;
  for (auto it = ops.begin(); it != ops.end(); ++it) merge(forward, legend, it->first, it->second);
  LooseGraph reversed;
  for (auto it = ops.rbegin(); it != ops.rend(); ++it) merge(reversed, legend, it->first, it->second);

  CHECK(forward.presentNodeIds() == reversed.presentNodeIds());
  CHECK(forward.liveEdges() == reversed.liveEdges());
  CHECK_EQ(forward.nodeView(nid("b"))->label, reversed.nodeView(nid("b"))->label);
  CHECK_EQ(forward.nodeView(nid("b"))->label, std::string("B2"));
}
