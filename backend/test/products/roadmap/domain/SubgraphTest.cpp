#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Subgraph.h"
#include "test/testing.h"

using namespace wm;

static NodeId nid(const char* s) { return NodeId{std::string(s)}; }
static KindId kid(const char* s) { return KindId{std::string(s)}; }
static Hlc at(std::uint64_t ms, const char* actor = "a") { return Hlc{ms, 0, actor}; }

TEST(version_vector_observe_and_cover) {
  VersionVector vector;
  vector.observe(Hlc{5, 0, "a"});
  vector.observe(Hlc{2, 0, "a"});  // lower — no effect
  vector.observe(Hlc{9, 0, "b"});
  CHECK(vector.covers(Hlc{5, 0, "a"}));
  CHECK(vector.covers(Hlc{3, 0, "a"}));
  CHECK_FALSE(vector.covers(Hlc{6, 0, "a"}));
  CHECK_FALSE(vector.covers(Hlc{1, 0, "c"}));  // unseen actor
  CHECK(vector.covers(Hlc{}));                 // the unset sentinel is always covered
}

TEST(frontier_folds_every_stamp_a_state_carries) {
  LooseGraph graph;
  graph.createNode(nid("a"), "A", "x", NodeColor::sky, at(4));
  graph.addEdge(nid("a"), nid("a"), at(7, "b"));
  Legend legend = Legend::seededDefaults(at(2, "c"));

  VersionVector front = frontier(graph.exportState(), legend.exportState());
  CHECK(front.covers(Hlc{4, 0, "a"}));
  CHECK(front.covers(Hlc{7, 0, "b"}));
  CHECK(front.covers(Hlc{2, 0, "c"}));
  CHECK_FALSE(front.covers(Hlc{8, 0, "b"}));
}

TEST(a_frames_frontier_folds_its_title_and_guide_beside_its_graph_and_legend) {
  LooseGraph graph;
  graph.createNode(nid("a"), "A", "x", NodeColor::sky, at(4));
  Subgraph frame;
  frame.graph = graph.exportState();
  frame.legend = Legend::seededDefaults(at(2, "c")).exportState();
  frame.title = Lww<std::string>{"Sailing", at(6, "b")};
  frame.guide = Lww<std::string>{"Rig before you sail", at(9)};

  VersionVector expected;
  expected.marks = {{"a", at(9)}, {"b", at(6, "b")}, {"c", at(2, "c")}};
  CHECK(frontier(frame) == expected);
}

// A frame carries no stamp while no node, edge or kind entry of it and neither tree register holds a set one: an
// entry's id and its unstamped values count for nothing. One set stamp anywhere is a write the frame asks for.
TEST(a_frame_carries_no_stamp_until_one_entry_or_tree_register_holds_a_set_one) {
  Subgraph bare;
  bare.graph.nodes = {NodeStateEntry{.id = nid("a"), .label = "Unstamped"}};
  bare.graph.edges = {EdgeStateEntry{Edge{nid("a"), nid("b")}, {}, {}}};
  KindStateEntry kind;
  kind.id = KindId{"k"};
  bare.legend.kinds = {kind};
  Subgraph ordered = bare;
  ordered.graph.nodes[0].orderAt = at(1);
  Subgraph unlinked = bare;
  unlinked.graph.edges[0].removedAt = at(1);
  Subgraph ranked = bare;
  ranked.legend.kinds[0].rankAt = at(1);
  Subgraph titled = bare;
  titled.title = Lww<std::string>{"Title", at(1)};
  Subgraph guided = bare;
  guided.guide = Lww<std::string>{"Guide", at(1)};

  CHECK(Subgraph{}.carriesNoStamp());
  CHECK(bare.carriesNoStamp());
  CHECK_FALSE(ordered.carriesNoStamp());
  CHECK_FALSE(unlinked.carriesNoStamp());
  CHECK_FALSE(ranked.carriesNoStamp());
  CHECK_FALSE(titled.carriesNoStamp());
  CHECK_FALSE(guided.carriesNoStamp());
}

TEST(delta_against_empty_reconstructs_the_whole_state) {
  LooseGraph source;
  source.createNode(nid("a"), "A", "x", NodeColor::sky, at(1));
  source.createNode(nid("b"), "B", "y", NodeColor::gold, at(2));
  source.addEdge(nid("a"), nid("b"), at(3));
  Legend legend = Legend::seededDefaults(at(1));

  Subgraph delta = deltaBetween(source.exportState(), legend.exportState(), VersionVector{});
  CHECK(delta.intent == SubgraphIntent::delta);
  CHECK(delta.coverage.has_value());

  LooseGraph rebuilt;
  rebuilt.join(delta.graph);
  Legend rebuiltLegend;
  rebuiltLegend.join(delta.legend);
  CHECK(rebuilt.exportState() == source.exportState());
  CHECK(rebuiltLegend.exportState() == legend.exportState());
}

TEST(delta_against_full_frontier_is_empty) {
  LooseGraph source;
  source.createNode(nid("a"), "A", "x", NodeColor::sky, at(1));
  Legend legend = Legend::seededDefaults(at(1));
  VersionVector full = frontier(source.exportState(), legend.exportState());

  Subgraph delta = deltaBetween(source.exportState(), legend.exportState(), full);
  CHECK_EQ(delta.graph.nodes.size(), 0u);
  CHECK_EQ(delta.graph.edges.size(), 0u);
  CHECK_EQ(delta.legend.kinds.size(), 0u);
}

TEST(delta_masks_fields_the_peer_already_covers) {
  LooseGraph source;
  source.createNode(nid("a"), "A", "x", NodeColor::sky, at(1));
  source.setColor(nid("a"), NodeColor::brick, at(5));  // a later field the peer has not seen

  VersionVector peer;
  peer.observe(Hlc{3, 0, "a"});  // covers the create (t=1), not the recolor (t=5)

  Subgraph delta = deltaBetween(source.exportState(), Legend{}.exportState(), peer);
  REQUIRE_EQ(delta.graph.nodes.size(), 1u);
  const NodeStateEntry& node = delta.graph.nodes[0];
  CHECK_EQ(node.id, nid("a"));
  CHECK_EQ(node.createdAt, Hlc{});             // covered → masked to no-information
  CHECK_EQ(node.labelAt, Hlc{});               // covered → masked
  CHECK_EQ(node.colorAt, (Hlc{5, 0, "a"}));    // uncovered → carried
  CHECK_EQ(node.color, NodeColor::brick);
}

// The order register rides anti-entropy exactly like color: frontier observes orderAt, nodeUncovered detects it, maskNode carries it.
TEST(delta_carries_an_order_write_the_peer_has_not_yet_seen) {
  LooseGraph source;
  source.createNode(nid("a"), "A", "x", NodeColor::sky, at(1));
  GraphState orderWrite;  // no domain command sets order — it arrives as a register join
  NodeStateEntry entry;
  entry.id = nid("a");
  entry.order = "a5";
  entry.orderAt = at(5);
  orderWrite.nodes.push_back(entry);
  source.join(orderWrite);

  VersionVector peer;
  peer.observe(at(3));  // covers the create (t=1), not the order write (t=5)

  Subgraph delta = deltaBetween(source.exportState(), Legend{}.exportState(), peer);
  REQUIRE_EQ(delta.graph.nodes.size(), 1u);
  const NodeStateEntry& node = delta.graph.nodes[0];
  CHECK_EQ(node.createdAt, Hlc{});         // covered → masked to no-information
  CHECK_EQ(node.colorAt, Hlc{});           // covered → masked
  CHECK_EQ(node.orderAt, at(5));           // uncovered → carried on the delta
  CHECK_EQ(node.order, std::string("a5"));
  CHECK(delta.coverage->covers(at(5)));    // frontier folded the order stamp into coverage

  LooseGraph target;                        // a peer holding only the create reconciles in one join
  target.createNode(nid("a"), "A", "x", NodeColor::sky, at(1));
  target.join(delta.graph);
  CHECK_EQ(target.exportNode(nid("a"))->order, std::string("a5"));
}

TEST(delta_carries_opens_to_a_peer_that_has_not_seen_the_write_and_masks_it_once_covered) {
  LooseGraph source;
  source.createNode(nid("a"), "A", "x", NodeColor::sky, at(1));
  source.setOpens(nid("a"), TreeId{"t_sailing"}, at(5));

  VersionVector behind;
  behind.observe(at(3));  // covers the create (t=1), not the pointer (t=5)
  Subgraph delta = deltaBetween(source.exportState(), Legend{}.exportState(), behind);
  NodeStateEntry pointerOnly;
  pointerOnly.id = nid("a");
  pointerOnly.opens = TreeId{"t_sailing"};
  pointerOnly.opensAt = at(5);
  CHECK(delta.graph == (GraphState{{pointerOnly}, {}}));
  CHECK(delta.coverage->covers(at(5)));  // the frontier folded the pointer's stamp into coverage

  LooseGraph target;  // a peer holding only the create reconciles in one join
  target.createNode(nid("a"), "A", "x", NodeColor::sky, at(1));
  target.join(delta.graph);
  CHECK(target.exportState() == source.exportState());

  VersionVector caughtUp;
  caughtUp.observe(at(5));
  CHECK(deltaBetween(source.exportState(), Legend{}.exportState(), caughtUp).graph == GraphState{});

  source.setLabel(nid("a"), "A, renamed", at(7));  // a later write to another register
  NodeStateEntry renameOnly;
  renameOnly.id = nid("a");
  renameOnly.label = "A, renamed";
  renameOnly.labelAt = at(7);
  CHECK(deltaBetween(source.exportState(), Legend{}.exportState(), caughtUp).graph == (GraphState{{renameOnly}, {}}));
}

TEST(a_readers_view_says_which_tree_no_node_opens_and_drops_an_entry_left_with_nothing_to_say) {
  NodeStateEntry door;
  door.id = nid("door");
  door.label = "Door";
  door.createdAt = door.labelAt = at(1);
  door.opens = TreeId{"t_sailing"};
  door.opensAt = at(5);
  NodeStateEntry pointerOnly;  // what a delta or a live frame carries when only the pointer moved
  pointerOnly.id = nid("gate");
  pointerOnly.opens = TreeId{"t_rowing"};
  pointerOnly.opensAt = at(6);
  const EdgeStateEntry edge{Edge{nid("door"), nid("gate")}, at(2), Hlc{}};

  NodeStateEntry withheld = door;
  withheld.opens = TreeId{};
  withheld.opensAt = Hlc{};
  CHECK(readerView(GraphState{{door, pointerOnly}, {edge}}) == (GraphState{{withheld}, {edge}}));

  TreeData document;
  document.id = TreeId{"t"};
  document.title = "T";
  NodeSpec spec;
  spec.id = nid("door");
  spec.label = "Door";
  spec.opens = TreeId{"t_sailing"};
  document.nodes = {spec};
  const TreeData read = readerView(document);
  REQUIRE_EQ(read.nodes.size(), 1u);
  CHECK_EQ(read.nodes[0].id, nid("door"));
  CHECK_EQ(read.nodes[0].label, std::string("Door"));
  CHECK_EQ(read.nodes[0].opens, TreeId{});
  CHECK_EQ(read.title, std::string("T"));
}

TEST(two_divergent_replicas_reconcile_to_the_full_join_in_one_exchange) {
  LooseGraph baseGraph;
  baseGraph.createNode(nid("root"), "Root", "x", NodeColor::sky, at(1));
  GraphState base = baseGraph.exportState();
  Legend baseLegend = Legend::seededDefaults(at(1));
  LegendState baseLegendState = baseLegend.exportState();

  LooseGraph xGraph(base);
  xGraph.setLabel(nid("root"), "Root-X", at(30, "x"));
  xGraph.createNode(nid("x1"), "X1", "x", NodeColor::gold, at(31, "x"));
  Legend xLegend(baseLegendState);
  xLegend.addKind(kid("infra"), NodeColor::sky, at(32, "x"));

  LooseGraph yGraph(base);
  yGraph.deleteNode(nid("root"), at(20, "y"));
  yGraph.createNode(nid("y1"), "Y1", "x", NodeColor::plum, at(21, "y"));
  yGraph.addEdge(nid("root"), nid("y1"), at(22, "y"));
  Legend yLegend(baseLegendState);
  yLegend.setLabel(kid("build"), "Build-Y", at(23, "y"));

  LooseGraph truthGraph(base);
  truthGraph.join(xGraph.exportState());
  truthGraph.join(yGraph.exportState());
  Legend truthLegend(baseLegendState);
  truthLegend.join(xLegend.exportState());
  truthLegend.join(yLegend.exportState());

  VersionVector vX = frontier(xGraph.exportState(), xLegend.exportState());
  VersionVector vY = frontier(yGraph.exportState(), yLegend.exportState());
  Subgraph forY = deltaBetween(xGraph.exportState(), xLegend.exportState(), vY);
  Subgraph forX = deltaBetween(yGraph.exportState(), yLegend.exportState(), vX);

  xGraph.join(forX.graph);   xLegend.join(forX.legend);
  yGraph.join(forY.graph);   yLegend.join(forY.legend);

  CHECK(xGraph.exportState() == truthGraph.exportState());
  CHECK(yGraph.exportState() == truthGraph.exportState());
  CHECK(xLegend.exportState() == truthLegend.exportState());
  CHECK(yLegend.exportState() == truthLegend.exportState());

  CHECK_FALSE(xGraph.hasNode(nid("root")));
  CHECK(xGraph.hasNode(nid("y1")));
  CHECK_EQ(xGraph.presentEdges().size(), 1u);
}

TEST(joining_a_delta_advances_the_receiver_to_cover_it) {
  LooseGraph source;
  source.createNode(nid("a"), "A", "x", NodeColor::sky, at(5, "s"));
  Legend legend = Legend::seededDefaults(at(1, "s"));

  LooseGraph peer;
  Legend peerLegend;
  Subgraph delta = deltaBetween(source.exportState(), legend.exportState(),
                                frontier(peer.exportState(), peerLegend.exportState()));
  peer.join(delta.graph);
  peerLegend.join(delta.legend);

  VersionVector after = frontier(peer.exportState(), peerLegend.exportState());
  CHECK(after.covers(Hlc{5, 0, "s"}));                 // the receiver now covers the source's writes
  CHECK(delta.coverage->covers(Hlc{5, 0, "s"}));       // and the delta's stated coverage matches
}
