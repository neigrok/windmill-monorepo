#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Subgraph.h"
#include "test/testing.h"

using namespace wm;

static NodeId nid(const char* s) { return NodeId{std::string(s)}; }
static KindId kid(const char* s) { return KindId{std::string(s)}; }
static Hlc at(std::uint64_t ms, const char* actor = "a") { return Hlc{ms, 0, actor}; }

TEST(hlc_text_round_trips_including_the_unset_sentinel) {
  Hlc stamp{1770000000123ull, 7, "u_42#r_8f31c2"};
  CHECK_EQ(parseHlc(toString(stamp)), stamp);
  CHECK_EQ(toString(Hlc{}), std::string("0:0:"));
  CHECK_EQ(parseHlc("0:0:"), Hlc{});
  CHECK_FALSE(parseHlc("0:0:").isSet());
}

TEST(hlc_clock_ticks_are_strictly_monotone_even_when_wall_time_goes_backward) {
  HlcClock clock("a");
  Hlc first = clock.tick(100);
  Hlc second = clock.tick(100);   // same wall ms → counter advances
  Hlc third = clock.tick(50);     // wall ms went backward → still dominates
  Hlc fourth = clock.tick(200);   // wall ms jumps forward → counter resets, still dominates
  CHECK(second > first);
  CHECK(third > second);
  CHECK(fourth > third);
  CHECK_EQ(fourth.physicalMs, 200ull);
  CHECK_EQ(fourth.counter, 0u);
}

TEST(hlc_clock_observe_makes_the_next_tick_dominate_the_observed_stamp) {
  HlcClock clock("a");
  Hlc remote{5000, 3, "b"};
  clock.observe(remote);
  Hlc next = clock.tick(10);  // local wall time is far behind the observed stamp
  CHECK(next > remote);       // the receive rule: a write after seeing a tombstone beats it
}

TEST(distinct_replica_actors_never_tie) {
  HlcClock tabOne("u_42#r_aaa");
  HlcClock tabTwo("u_42#r_bbb");
  Hlc a = tabOne.tick(100);
  Hlc b = tabTwo.tick(100);   // same user, same wall ms, different replica nonce
  CHECK_FALSE(a == b);        // the uniqueness precondition holds across tabs
}

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
  graph.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(4));
  graph.addEdge(nid("a"), nid("a"), at(7, "b"));
  Legend legend = Legend::seededDefaults(at(2, "c"));

  VersionVector front = frontier(graph.exportState(), legend.exportState());
  CHECK(front.covers(Hlc{4, 0, "a"}));
  CHECK(front.covers(Hlc{7, 0, "b"}));
  CHECK(front.covers(Hlc{2, 0, "c"}));
  CHECK_FALSE(front.covers(Hlc{8, 0, "b"}));
}

TEST(delta_against_empty_reconstructs_the_whole_state) {
  LooseGraph source;
  source.createNode(nid("a"), "A", "x", NodeColor::sky, Vec2{1, 2}, at(1));
  source.createNode(nid("b"), "B", "y", NodeColor::gold, std::nullopt, at(2));
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
  source.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  Legend legend = Legend::seededDefaults(at(1));
  VersionVector full = frontier(source.exportState(), legend.exportState());

  Subgraph delta = deltaBetween(source.exportState(), legend.exportState(), full);
  CHECK_EQ(delta.graph.nodes.size(), 0u);
  CHECK_EQ(delta.graph.edges.size(), 0u);
  CHECK_EQ(delta.legend.kinds.size(), 0u);
}

TEST(delta_masks_fields_the_peer_already_covers) {
  LooseGraph source;
  source.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  source.setColor(nid("a"), NodeColor::brick, at(5));  // a later field the peer has not seen

  VersionVector peer;
  peer.observe(Hlc{3, 0, "a"});  // covers the create (t=1), not the recolor (t=5)

  Subgraph delta = deltaBetween(source.exportState(), Legend{}.exportState(), peer);
  CHECK_EQ(delta.graph.nodes.size(), 1u);
  const NodeStateEntry& node = delta.graph.nodes[0];
  CHECK_EQ(node.id, nid("a"));
  CHECK_EQ(node.createdAt, Hlc{});             // covered → masked to no-information
  CHECK_EQ(node.labelAt, Hlc{});               // covered → masked
  CHECK_EQ(node.colorAt, (Hlc{5, 0, "a"}));    // uncovered → carried
  CHECK_EQ(node.color, NodeColor::brick);
}

// The order register must ride anti-entropy exactly like color: frontier observes orderAt,
// nodeUncovered detects it, maskNode carries it. Miss any one and a reorder converges only via
// a full graft, never a delta — so this asserts the whole trio through one masked delta.
TEST(delta_carries_an_order_write_the_peer_has_not_yet_seen) {
  LooseGraph source;
  source.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
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
  CHECK_EQ(delta.graph.nodes.size(), 1u);
  const NodeStateEntry& node = delta.graph.nodes[0];
  CHECK_EQ(node.createdAt, Hlc{});         // covered → masked to no-information
  CHECK_EQ(node.colorAt, Hlc{});           // covered → masked
  CHECK_EQ(node.orderAt, at(5));           // uncovered → carried on the delta
  CHECK_EQ(node.order, std::string("a5"));
  CHECK(delta.coverage->covers(at(5)));    // frontier folded the order stamp into coverage

  LooseGraph target;                        // a peer holding only the create reconciles in one join
  target.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  target.join(delta.graph);
  CHECK_EQ(target.exportNode(nid("a"))->order, std::string("a5"));
}

TEST(two_divergent_replicas_reconcile_to_the_full_join_in_one_exchange) {
  LooseGraph baseGraph;
  baseGraph.createNode(nid("root"), "Root", "x", NodeColor::sky, std::nullopt, at(1));
  GraphState base = baseGraph.exportState();
  Legend baseLegend = Legend::seededDefaults(at(1));
  LegendState baseLegendState = baseLegend.exportState();

  // Replica X: renames root late, adds a node, adds a kind.
  LooseGraph xGraph(base);
  xGraph.setLabel(nid("root"), "Root-X", at(30, "x"));
  xGraph.createNode(nid("x1"), "X1", "x", NodeColor::gold, std::nullopt, at(31, "x"));
  Legend xLegend(baseLegendState);
  xLegend.addKind(kid("infra"), NodeColor::sky, at(32, "x"));

  // Replica Y: deletes root, builds a child under it offline, relabels a kind.
  LooseGraph yGraph(base);
  yGraph.deleteNode(nid("root"), at(20, "y"));
  yGraph.createNode(nid("y1"), "Y1", "x", NodeColor::plum, std::nullopt, at(21, "y"));
  yGraph.addEdge(nid("root"), nid("y1"), at(22, "y"));
  Legend yLegend(baseLegendState);
  yLegend.setLabel(kid("build"), "Build-Y", at(23, "y"));

  // The truth: a replica that simply joins both full states.
  LooseGraph truthGraph(base);
  truthGraph.join(xGraph.exportState());
  truthGraph.join(yGraph.exportState());
  Legend truthLegend(baseLegendState);
  truthLegend.join(xLegend.exportState());
  truthLegend.join(yLegend.exportState());

  // Anti-entropy: each computes the delta the other is missing, against original frontiers.
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

  // And the product principle holds through the reconciliation: root is deleted, yet the
  // child built under it offline survives and is one re-add from resurrection.
  CHECK_FALSE(xGraph.hasNode(nid("root")));
  CHECK(xGraph.hasNode(nid("y1")));
  CHECK_EQ(xGraph.presentEdges().size(), 1u);
}

TEST(joining_a_delta_advances_the_receiver_to_cover_it) {
  LooseGraph source;
  source.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(5, "s"));
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
