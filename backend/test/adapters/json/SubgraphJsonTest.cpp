#include "products/roadmap/adapters/json/SubgraphJson.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Subgraph.h"
#include "test/testing.h"

using namespace wm;

static NodeId nid(const char* s) { return NodeId{std::string(s)}; }
static Hlc at(std::uint64_t ms, const char* actor = "u_1#r_a") { return Hlc{ms, 0, actor}; }

// Serialize → dump → parse → deserialize, the exact path a frame takes over the socket.
static Subgraph roundTrip(const Subgraph& subgraph) {
  return subgraphFromJson(parse(dump(toJson(subgraph))));
}

TEST(subgraph_envelope_has_the_wire_shape) {
  Subgraph subgraph;
  subgraph.treeId = TreeId{"t1"};
  subgraph.frameId = "f_1";
  subgraph.actor = "u_1#r_a";
  subgraph.gestures = {Gesture{"g1", "createNode", "Renderer"}};

  Json::Value json = toJson(subgraph);
  CHECK_EQ(json["t"].asString(), std::string("subgraph"));
  CHECK_EQ(json["v"].asInt(), 1);
  CHECK_EQ(json["intent"].asString(), std::string("live"));
  CHECK_EQ(json["treeId"].asString(), std::string("t1"));
  CHECK(json.isMember("nodes"));
  CHECK(json.isMember("edges"));
  CHECK(json.isMember("kinds"));
  CHECK_EQ(json["gestures"][0]["kind"].asString(), std::string("createNode"));
}

TEST(live_subgraph_round_trips_exactly) {
  Subgraph subgraph;
  subgraph.treeId = TreeId{"t1"};
  subgraph.frameId = "f_1";
  subgraph.actor = "u_1#r_a";
  subgraph.intent = SubgraphIntent::live;

  LooseGraph graph;
  graph.createNode(nid("a"), "A", "zap", NodeColor::sky, Vec2{1, 2}, at(5));
  graph.createNode(nid("root"), "Root", "sprout", NodeColor::gold, std::nullopt, at(4));
  graph.addEdge(nid("root"), nid("a"), at(6));
  subgraph.graph = graph.exportState();
  subgraph.legend = Legend::seededDefaults(at(1)).exportState();
  subgraph.gestures = {Gesture{"g1", "createNode", "A"}};

  CHECK(roundTrip(subgraph) == subgraph);
}

TEST(title_round_trips) {
  Subgraph subgraph;
  subgraph.treeId = TreeId{"t1"};
  subgraph.frameId = "f_1";
  subgraph.actor = "u_1#r_a";
  subgraph.title = Lww<std::string>{"My Roadmap", at(9)};

  Subgraph back = roundTrip(subgraph);
  CHECK(back.title.has_value());
  CHECK_EQ(back.title->value, std::string("My Roadmap"));
  CHECK(back == subgraph);
}

TEST(full_delta_round_trips_with_coverage) {
  LooseGraph source;
  source.createNode(nid("a"), "A", "zap", NodeColor::sky, std::nullopt, at(2));
  source.addEdge(nid("a"), nid("a"), at(3));
  Legend legend = Legend::seededDefaults(at(1));

  Subgraph delta = deltaBetween(source.exportState(), legend.exportState(), VersionVector{});
  delta.treeId = TreeId{"t1"};
  delta.frameId = "d_1";
  delta.actor = "srv";

  Subgraph back = roundTrip(delta);
  CHECK(back.intent == SubgraphIntent::delta);
  CHECK(back.coverage.has_value());
  CHECK(back == delta);
}

TEST(masked_delta_round_trips_its_unset_stamps) {
  LooseGraph source;
  source.createNode(nid("a"), "A", "zap", NodeColor::sky, std::nullopt, at(1));
  source.setColor(nid("a"), NodeColor::brick, at(5));  // a later field the peer has not seen

  VersionVector peer;
  peer.observe(Hlc{3, 0, "u_1#r_a"});  // covers the create, not the recolor

  Subgraph delta = deltaBetween(source.exportState(), LegendState{}, peer);
  delta.treeId = TreeId{"t1"};
  delta.frameId = "d_2";
  delta.actor = "srv";

  CHECK_EQ(delta.graph.nodes.size(), 1u);
  CHECK_EQ(delta.graph.nodes[0].createdAt, Hlc{});  // masked to no-information
  Subgraph back = roundTrip(delta);
  CHECK(back == delta);  // the unset "0:0:" stamps survive the round trip
}

TEST(subscribe_delta_against_a_caught_up_vector_is_empty) {
  LooseGraph graph;
  graph.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(5));
  Legend legend = Legend::seededDefaults(at(1));
  VersionVector full = frontier(graph.exportState(), legend.exportState());

  // Serialize the frontier the way a caught-up client sends it, then parse it back through the codec.
  Json::Value vectorJson(Json::objectValue);
  for (const auto& [actor, mark] : full.marks) vectorJson[actor] = toString(mark);
  VersionVector parsed = versionVectorFromJson(vectorJson);

  Subgraph delta = deltaBetween(graph.exportState(), legend.exportState(), parsed);
  CHECK_EQ(delta.graph.nodes.size(), 0u);
  CHECK_EQ(delta.graph.edges.size(), 0u);
  CHECK_EQ(delta.legend.kinds.size(), 0u);
}

TEST(subscribe_delta_against_an_empty_vector_is_the_whole_state) {
  LooseGraph graph;
  graph.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(5));
  Legend legend = Legend::seededDefaults(at(1));

  VersionVector empty = versionVectorFromJson(Json::Value(Json::objectValue));
  Subgraph delta = deltaBetween(graph.exportState(), legend.exportState(), empty);
  delta.treeId = TreeId{"t1"};
  delta.frameId = "delta-1";
  CHECK(delta.intent == SubgraphIntent::delta);
  CHECK(delta.coverage.has_value());
  CHECK_EQ(delta.graph.nodes.size(), 1u);

  // The subscribe response round-trips over the wire and reconstructs the state on join.
  Subgraph back = subgraphFromJson(parse(dump(toJson(delta))));
  LooseGraph rebuilt;
  rebuilt.join(back.graph);
  CHECK(rebuilt.hasNode(nid("a")));
  CHECK(back.coverage.has_value());
}

TEST(parse_tolerates_a_minimal_frame) {
  Json::Value minimal(Json::objectValue);
  minimal["treeId"] = "t1";
  minimal["frameId"] = "f_1";
  minimal["actor"] = "u_1#r_a";
  minimal["intent"] = "live";

  Subgraph subgraph = subgraphFromJson(minimal);
  CHECK_EQ(subgraph.treeId, TreeId{"t1"});
  CHECK_EQ(subgraph.graph.nodes.size(), 0u);
  CHECK_EQ(subgraph.graph.edges.size(), 0u);
  CHECK_EQ(subgraph.legend.kinds.size(), 0u);
  CHECK_EQ(subgraph.gestures.size(), 0u);
  CHECK_FALSE(subgraph.title.has_value());
  CHECK_FALSE(subgraph.coverage.has_value());
}
