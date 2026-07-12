#include "domain/Command.h"
#include "domain/Legend.h"
#include "domain/LooseGraph.h"
#include "test/testing.h"

using namespace wm;

static NodeId nid(const char* s) { return NodeId{std::string(s)}; }
static KindId kid(const char* s) { return KindId{std::string(s)}; }
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
  Legend legend;
  Command rename = RenameNode{nid("b"), "renamed"};
  auto inverse = invert(g, legend, rename);
  merge(g, legend, rename, at(5));
  CHECK_EQ(g.nodeView(nid("b"))->label, std::string("renamed"));
  CHECK_EQ(inverse.size(), 1u);
  merge(g, legend, inverse[0], at(6));
  CHECK_EQ(g.nodeView(nid("b"))->label, std::string("B"));
}

TEST(invert_add_edge_that_existed_is_noop) {
  LooseGraph g = seeded();
  Legend legend;
  auto inverse = invert(g, legend, Command{AddEdge{nid("a"), nid("b")}});
  CHECK_EQ(inverse.size(), 0u);
}

TEST(invert_add_edge_removes_new_edge) {
  LooseGraph g = seeded();
  Legend legend;
  g.createNode(nid("c"), "C", "x", NodeColor::sky, std::nullopt, at(1));
  Command add = AddEdge{nid("a"), nid("c")};
  auto inverse = invert(g, legend, add);
  merge(g, legend, add, at(5));
  CHECK(g.edgePresent(nid("a"), nid("c")));
  CHECK_EQ(inverse.size(), 1u);
  merge(g, legend, inverse[0], at(6));
  CHECK_FALSE(g.edgePresent(nid("a"), nid("c")));
}

TEST(invert_delete_recreates_node_with_fields) {
  LooseGraph g = seeded();
  Legend legend;
  Command del = DeleteNode{nid("b")};
  auto inverse = invert(g, legend, del);
  merge(g, legend, del, at(5));
  CHECK_FALSE(g.hasNode(nid("b")));
  CHECK_EQ(inverse.size(), 1u);
  merge(g, legend, inverse[0], at(6));
  CHECK(g.hasNode(nid("b")));
  CHECK_EQ(g.nodeView(nid("b"))->label, std::string("B"));
  CHECK_EQ(g.nodeView(nid("b"))->color, NodeColor::gold);
  CHECK_EQ(g.liveEdges().size(), 1u);
}

TEST(transitive_reduction_drops_redundant_edge) {
  LooseGraph g;
  Legend legend;
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
  auto inverse = invert(g, legend, tidy);
  merge(g, legend, tidy, at(5));
  CHECK_FALSE(g.edgePresent(nid("a"), nid("c")));
  CHECK(g.edgePresent(nid("a"), nid("b")));
  CHECK(g.edgePresent(nid("b"), nid("c")));

  CHECK_EQ(inverse.size(), 1u);
  merge(g, legend, inverse[0], at(6));
  CHECK(g.edgePresent(nid("a"), nid("c")));
}

TEST(recolor_kind_swaps_hue_and_repaints_nodes) {
  LooseGraph g;
  g.createNode(nid("a"), "A", "x", NodeColor::olive, std::nullopt, at(1));
  g.createNode(nid("b"), "B", "x", NodeColor::olive, std::nullopt, at(1));
  g.createNode(nid("c"), "C", "x", NodeColor::gold, std::nullopt, at(1));
  Legend legend({{kid("learn"), NodeColor::olive, "Learn", ""}}, at(1));

  Command recolor = RecolorKind{kid("learn"), NodeColor::sky};
  auto inverse = invert(g, legend, recolor);
  merge(g, legend, recolor, at(5));

  CHECK_EQ(legend.hueOf(kid("learn")).value(), NodeColor::sky);
  CHECK_EQ(g.nodeView(nid("a"))->color, NodeColor::sky);   // olive nodes repainted
  CHECK_EQ(g.nodeView(nid("b"))->color, NodeColor::sky);
  CHECK_EQ(g.nodeView(nid("c"))->color, NodeColor::gold);  // gold untouched

  CHECK_EQ(inverse.size(), 1u);
  merge(g, legend, inverse[0], at(6));
  CHECK_EQ(legend.hueOf(kid("learn")).value(), NodeColor::olive);
  CHECK_EQ(g.nodeView(nid("a"))->color, NodeColor::olive);  // fully restored
  CHECK_EQ(g.nodeView(nid("b"))->color, NodeColor::olive);
}

TEST(invert_add_kind_removes_it) {
  LooseGraph g;
  Legend legend;
  Command add = AddKind{kid("sky"), NodeColor::sky};
  auto inverse = invert(g, legend, add);
  merge(g, legend, add, at(5));
  CHECK(legend.has(kid("sky")));
  CHECK_EQ(inverse.size(), 1u);
  merge(g, legend, inverse[0], at(6));
  CHECK_FALSE(legend.has(kid("sky")));
}

TEST(invert_remove_kind_restores_hue_label_and_order) {
  Legend legend({{kid("build"), NodeColor::terracotta, "Build", "Things you make"},
                 {kid("learn"), NodeColor::olive, "Learn", "Things you figure out"},
                 {kid("milestone"), NodeColor::gold, "Milestone", "Moments that matter"}},
                at(1));
  LooseGraph g;  // no nodes wear olive, so learn is removable

  Command remove = RemoveKind{kid("learn")};
  auto inverse = invert(g, legend, remove);
  merge(g, legend, remove, at(5));
  CHECK_FALSE(legend.has(kid("learn")));

  // Server-driven undo replays each inverse op with a strictly-increasing HLC.
  std::uint64_t tick = 6;
  for (const Command& cmd : inverse) merge(g, legend, cmd, at(tick++));
  auto restored = legend.view(kid("learn"));
  CHECK(restored.has_value());
  CHECK_EQ(restored->hue, NodeColor::olive);
  CHECK_EQ(restored->label, std::string("Learn"));
  CHECK_EQ(restored->description, std::string("Things you figure out"));
  CHECK_EQ(legend.orderedIds()[1], kid("learn"));  // back in its middle slot
}

TEST(validate_passes_graph_commands_always) {
  LooseGraph g = seeded();
  Legend legend;
  CHECK_FALSE(validate(g, legend, Command{RenameNode{nid("b"), "x"}}).has_value());
  CHECK_FALSE(validate(g, legend, Command{DeleteNode{nid("nope")}}).has_value());
  CHECK_FALSE(validate(g, legend, Command{AddEdge{nid("a"), nid("b")}}).has_value());
}

TEST(validate_add_kind_rejects_taken_hue_and_full_legend) {
  LooseGraph g;
  Legend legend = Legend::seededDefaults(at(1));  // terracotta, olive, gold taken
  CHECK(validate(g, legend, Command{AddKind{kid("dupe"), NodeColor::olive}}).has_value());
  CHECK_FALSE(validate(g, legend, Command{AddKind{kid("fresh"), NodeColor::sky}}).has_value());

  legend.addKind(kid("a"), NodeColor::sky, at(2));
  legend.addKind(kid("b"), NodeColor::brick, at(3));
  legend.addKind(kid("c"), NodeColor::plum, at(4));  // now 6 kinds — full
  CHECK(validate(g, legend, Command{AddKind{kid("seventh"), NodeColor::terracotta}}).has_value());
}

TEST(validate_remove_kind_rejects_while_in_use) {
  LooseGraph g;
  g.createNode(nid("n"), "N", "x", NodeColor::olive, std::nullopt, at(1));
  Legend legend = Legend::seededDefaults(at(1));
  CHECK(validate(g, legend, Command{RemoveKind{kid("learn")}}).has_value());       // olive is worn
  CHECK_FALSE(validate(g, legend, Command{RemoveKind{kid("milestone")}}).has_value());  // gold is free
  CHECK(validate(g, legend, Command{RemoveKind{kid("ghost")}}).has_value());       // no such kind
}

TEST(validate_length_caps_and_recolor_hue_uniqueness) {
  LooseGraph g;
  Legend legend = Legend::seededDefaults(at(1));
  CHECK(validate(g, legend, Command{RenameKind{kid("build"), std::string(25, 'x')}}).has_value());
  CHECK_FALSE(validate(g, legend, Command{RenameKind{kid("build"), std::string(24, 'x')}}).has_value());
  CHECK(validate(g, legend, Command{DescribeKind{kid("build"), std::string(81, 'y')}}).has_value());

  CHECK(validate(g, legend, Command{RecolorKind{kid("build"), NodeColor::olive}}).has_value());  // taken
  CHECK_FALSE(validate(g, legend, Command{RecolorKind{kid("build"), NodeColor::sky}}).has_value());  // free
  CHECK_FALSE(validate(g, legend, Command{RecolorKind{kid("build"), NodeColor::terracotta}}).has_value());  // its own hue
}
