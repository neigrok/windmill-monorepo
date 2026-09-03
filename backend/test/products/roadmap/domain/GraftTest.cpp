#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Graft.h"
#include "test/testing.h"

#include <string>
#include <vector>

using namespace wm;

namespace {

NodeId nid(const char* s) { return NodeId{std::string(s)}; }
Hlc at(std::uint64_t ms) { return Hlc{ms, 0, "a"}; }

// a -> n, c -> n, n -> d; b stands alone.
LooseGraph seeded() {
  LooseGraph g;
  for (const char* id : {"a", "b", "c", "n", "d"})
    g.createNode(nid(id), id, "", NodeColor::sky, std::nullopt, at(1));
  g.addEdge(nid("a"), nid("n"), at(1));
  g.addEdge(nid("c"), nid("n"), at(1));
  g.addEdge(nid("n"), nid("d"), at(1));
  return g;
}

NodeSpec spec(const char* id, std::vector<const char*> prerequisites) {
  NodeSpec s;
  s.id = nid(id);
  s.label = id;
  for (const char* p : prerequisites) s.prerequisites.push_back(nid(p));
  return s;
}

}

TEST(graft_merge_keeps_the_edge_the_document_left_out_and_names_it) {
  LooseGraph g = seeded();
  Graft graft;
  graft.document.nodes = {spec("n", {"a", "b"})};

  const GraftFootprint footprint = footprintOf(g, graft);
  CHECK_EQ(footprint.keptEdges, (std::vector<Edge>{{nid("c"), nid("n")}}));
  CHECK(footprint.replacedEdges.empty());
  CHECK(footprint.tombstonedNodes.empty());
  CHECK(footprint.tombstonedEdges.empty());

  g.join(graftState(g, graft, at(2)));
  CHECK_EQ(g.nodeView(nid("n"))->prerequisites, (std::vector<NodeId>{nid("a"), nid("b"), nid("c")}));
  CHECK(g.edgePresent(nid("n"), nid("d")));  // an outgoing edge is never one of n's prerequisites
}

TEST(graft_replace_removes_the_unnamed_edge_and_a_later_merge_re_add_wins) {
  LooseGraph g = seeded();
  Graft graft;
  graft.document.nodes = {spec("n", {"a", "b"})};
  graft.prerequisites = PrerequisiteMode::replace;

  const GraftFootprint footprint = footprintOf(g, graft);
  CHECK(footprint.keptEdges.empty());
  CHECK_EQ(footprint.replacedEdges, (std::vector<Edge>{{nid("c"), nid("n")}}));

  g.join(graftState(g, graft, at(2)));
  CHECK_FALSE(g.edgePresent(nid("c"), nid("n")));
  CHECK_EQ(g.nodeView(nid("n"))->prerequisites, (std::vector<NodeId>{nid("a"), nid("b")}));
  CHECK(g.edgePresent(nid("n"), nid("d")));
  CHECK_EQ(g.lifeOf(Edge{nid("c"), nid("n")})->removedAt, at(2));

  Graft again;
  again.document.nodes = {spec("n", {"c"})};
  g.join(graftState(g, again, at(3)));
  CHECK_EQ(g.nodeView(nid("n"))->prerequisites, (std::vector<NodeId>{nid("a"), nid("b"), nid("c")}));
}

TEST(graft_replace_leaves_new_nodes_and_nodes_not_in_the_batch_alone) {
  LooseGraph g = seeded();
  Graft graft;
  graft.document.nodes = {spec("x", {"a"})};
  graft.prerequisites = PrerequisiteMode::replace;

  const GraftFootprint footprint = footprintOf(g, graft);
  CHECK(footprint.keptEdges.empty());
  CHECK(footprint.replacedEdges.empty());

  g.join(graftState(g, graft, at(2)));
  CHECK_EQ(g.nodeView(nid("n"))->prerequisites, (std::vector<NodeId>{nid("a"), nid("c")}));
  CHECK_EQ(g.nodeView(nid("x"))->prerequisites, (std::vector<NodeId>{nid("a")}));
}

TEST(graft_tombstone_removes_the_node_and_every_edge_touching_it_at_the_one_stamp) {
  LooseGraph g = seeded();
  Graft graft;
  graft.document.nodes = {spec("b", {"a"})};
  graft.tombstones = {nid("n"), nid("n"), nid("ghost")};  // a repeat and a stranger count for nothing

  const GraftFootprint footprint = footprintOf(g, graft);
  CHECK_EQ(footprint.tombstonedNodes, (std::vector<NodeId>{nid("n")}));
  CHECK_EQ(footprint.tombstonedEdges,
           (std::vector<Edge>{{nid("a"), nid("n")}, {nid("c"), nid("n")}, {nid("n"), nid("d")}}));
  CHECK(footprint.keptEdges.empty());

  const GraphState frame = graftState(g, graft, at(2));
  for (const EdgeStateEntry& edge : frame.edges)
    if (edge.removedAt.isSet()) CHECK_EQ(edge.removedAt, at(2));

  g.join(frame);
  CHECK_FALSE(g.hasNode(nid("n")));
  CHECK(g.isTombstoned(nid("n")));
  CHECK_FALSE(g.hasNode(nid("ghost")));
  CHECK_FALSE(g.edgePresent(nid("a"), nid("n")));
  CHECK_FALSE(g.edgePresent(nid("c"), nid("n")));
  CHECK_FALSE(g.edgePresent(nid("n"), nid("d")));
  CHECK(g.edgePresent(nid("a"), nid("b")));
  CHECK(g.hasNode(nid("d")));
  CHECK(g.danglingEdges().empty());
}

TEST(graft_state_never_adds_an_edge_onto_a_node_it_tombstones) {
  LooseGraph g = seeded();
  Graft graft;
  graft.document.nodes = {spec("x", {"n"})};
  graft.tombstones = {nid("n")};

  g.join(graftState(g, graft, at(2)));
  CHECK(g.hasNode(nid("x")));
  CHECK_FALSE(g.edgePresent(nid("n"), nid("x")));
  CHECK(g.danglingEdges().empty());
}

TEST(graft_admission_is_judged_on_what_the_graft_leaves_behind) {
  LooseGraph g;
  for (std::size_t i = 0; i < kMaxNodes; ++i)
    g.createNode(NodeId{"n" + std::to_string(i)}, "N", "", NodeColor::sky, std::nullopt, at(1));

  Graft grows;
  grows.document.nodes = {spec("extra", {})};
  const std::optional<Admission> refused = admit(g, grows);
  REQUIRE(refused.has_value());
  CHECK_EQ(refused->reason, std::string("this tree would hold 10001 nodes, max 10000 — split it across "
                                        "roadmaps, or delete what it has outgrown"));

  Graft swaps = grows;
  swaps.tombstones = {nid("n0")};
  CHECK_FALSE(admit(g, swaps).has_value());
}
