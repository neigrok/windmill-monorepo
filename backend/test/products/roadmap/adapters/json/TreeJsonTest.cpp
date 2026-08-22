#include "products/roadmap/adapters/json/TreeJson.h"

#include "products/roadmap/domain/LooseGraph.h"
#include "test/testing.h"

using namespace wm;

static NodeId nid(const char* s) { return NodeId{std::string(s)}; }
static Hlc at(std::uint64_t ms, const char* actor = "u") { return Hlc{ms, 0, actor}; }

TEST(node_description_and_links_survive_the_document_codec) {
  TreeData data;
  data.id = TreeId{"t"};
  NodeSpec node;
  node.id = nid("a");
  node.label = "A";
  node.description = "notes";
  node.links = {Link{"Doc", "https://d"}, Link{"", "https://e"}};
  data.nodes.push_back(node);

  TreeData back = treeFromJson(parse(dump(toJson(data))), TreeId{"t"}).value();
  REQUIRE_EQ(back.nodes.size(), 1u);
  CHECK_EQ(back.nodes[0].description, std::string("notes"));
  REQUIRE_EQ(back.nodes[0].links.size(), 2u);
  CHECK_EQ(back.nodes[0].links[0], (Link{"Doc", "https://d"}));
  CHECK_EQ(back.nodes[0].links[1].url, std::string("https://e"));
}

TEST(a_bare_url_string_parses_as_a_labelless_link) {
  std::vector<Link> links = linksFromJson(parse("[\"https://x\", {\"url\": \"https://y\", \"label\": \"Y\"}]"));
  REQUIRE_EQ(links.size(), 2u);
  CHECK_EQ(links[0], (Link{"", "https://x"}));
  CHECK_EQ(links[1], (Link{"Y", "https://y"}));
}

TEST(graph_state_round_trips_description_and_links_with_stamps) {
  LooseGraph g;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  g.setDescription(nid("a"), "body", at(2));
  g.setLinks(nid("a"), {Link{"PR", "https://p"}}, at(3));

  GraphState reloaded = graphStateFromJson(parse(dump(toJson(g.exportState()))));
  CHECK(reloaded == g.exportState());  // full lattice, stamps included — the persistence gate
}

TEST(graph_state_round_trips_the_order_register_with_its_stamp) {
  LooseGraph g;
  g.createNode(nid("a"), "A", "x", NodeColor::sky, std::nullopt, at(1));
  GraphState orderWrite;
  NodeStateEntry entry; entry.id = nid("a"); entry.order = "a3"; entry.orderAt = at(4);
  orderWrite.nodes.push_back(entry);
  g.join(orderWrite);

  GraphState reloaded = graphStateFromJson(parse(dump(toJson(g.exportState()))));
  CHECK(reloaded == g.exportState());  // order + orderAt survive the wire codec exactly
  CHECK_EQ(reloaded.nodes[0].order, std::string("a3"));
}

TEST(tree_document_round_trips_the_order_key) {
  TreeData data;
  data.id = TreeId{"t"};
  NodeSpec node;
  node.id = nid("a");
  node.label = "A";
  node.order = "a7";
  data.nodes.push_back(node);

  TreeData back = treeFromJson(parse(dump(toJson(data))), TreeId{"t"}).value();
  REQUIRE_EQ(back.nodes.size(), 1u);
  CHECK_EQ(back.nodes[0].order, std::string("a7"));
}

// A root that parsed but is not an object throws on every keyed read jsoncpp does — the decoder
// answers the mismatch rather than raising it past the handler as a 500.
TEST(tree_from_json_refuses_a_non_object_root) {
  CHECK_FALSE(treeFromJson(parse("[]"), TreeId{"t"}).has_value());
  CHECK_FALSE(treeFromJson(parse("\"hello\""), TreeId{"t"}).has_value());
  CHECK_FALSE(treeFromJson(parse("5"), TreeId{"t"}).has_value());
  CHECK(treeFromJson(parse("{}"), TreeId{"t"}).has_value());
}

// The overlay used to answer with three id arrays and nothing else, so a reader learned WHICH
// steps were marked and never WHEN — and the web's activity feed, having only its own browser's
// stamps, filed every step finished on another device under "Earlier". `markedAt` is the server's
// own clock, the one instant that survives the device the mark was made on.
TEST(the_progress_overlay_carries_the_instant_the_server_recorded_each_mark) {
  Progress progress;
  progress.completed = {nid("a")};
  progress.inProgress = {nid("b")};
  progress.cleared = {nid("c")};
  progress.markedAt = {{nid("a"), 1700000000000ull}, {nid("b"), 1700000600000ull}};

  Json::Value root = toJson(progress);

  REQUIRE_EQ(root["completed"].size(), 1u);
  CHECK_EQ(root["completed"][0].asString(), std::string("a"));
  REQUIRE_EQ(root["inProgress"].size(), 1u);
  CHECK_EQ(root["inProgress"][0].asString(), std::string("b"));
  REQUIRE_EQ(root["cleared"].size(), 1u);
  CHECK_EQ(root["cleared"][0].asString(), std::string("c"));
  CHECK_EQ(root["markedAt"]["a"].asUInt64(), 1700000000000ull);
  CHECK_EQ(root["markedAt"]["b"].asUInt64(), 1700000600000ull);
  CHECK_EQ(root["markedAt"].isMember("c"), false);  // a tombstone we hold no instant for stays absent
}

// An overlay from somewhere that keeps no times — an authored document's seed statuses, a fake in
// a test — answers with the key present and empty, never absent: a reader must not have to tell
// "this server is too old to say" apart from "nothing here was ever marked".
TEST(an_overlay_with_no_instants_still_carries_the_markedAt_object) {
  Progress progress;
  progress.completed = {nid("a")};

  Json::Value root = toJson(progress);

  CHECK_EQ(root.isMember("markedAt"), true);
  CHECK_EQ(root["markedAt"].isObject(), true);
  CHECK_EQ(root["markedAt"].empty(), true);
}
