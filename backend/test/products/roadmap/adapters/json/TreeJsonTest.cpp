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

// The overlay answers as a lattice frame — one stamped register per node — because that is
// everything a replica needs to join it. Two clocks ride each row and they are not
// interchangeable: `at` is the stamp the marking replica minted and the only thing that decides
// what wins, `markedAt` is the server's own receipt instant and the only one a person may be
// shown (GRAPH_SYNC_DESIGN.md §12).
TEST(the_progress_overlay_answers_as_stamped_registers) {
  Progress progress;
  progress.record(nid("a"), ProgressMark{ProgressStatus::complete, at(500, "r_phone"), 1700000000000ull});
  progress.record(nid("b"), ProgressMark{ProgressStatus::active, at(600, "r_tab"), 1700000600000ull});

  Json::Value root = toJson(progress);

  REQUIRE_EQ(root["marks"].size(), 2u);
  CHECK_EQ(root["marks"][0]["node"].asString(), std::string("a"));
  CHECK_EQ(root["marks"][0]["status"].asString(), std::string("complete"));
  CHECK_EQ(root["marks"][0]["at"].asString(), std::string("500:0:r_phone"));
  CHECK_EQ(root["marks"][0]["markedAt"].asUInt64(), 1700000000000ull);
  CHECK_EQ(root["marks"][1]["node"].asString(), std::string("b"));
  CHECK_EQ(root["marks"][1]["status"].asString(), std::string("active"));
  CHECK_EQ(root["marks"][1]["at"].asString(), std::string("600:0:r_tab"));
}

// A cleared mark is a VALUE, not an absence: it must ride the wire like any other register, or a
// replica that cleared a step on another device would never learn of the clear and would keep
// re-asserting its own stale `complete` forever.
TEST(a_cleared_register_is_carried_not_omitted) {
  Progress progress;
  progress.record(nid("a"), ProgressMark{ProgressStatus::none, at(700, "r_phone"), 1700000000000ull});

  Json::Value root = toJson(progress);

  REQUIRE_EQ(root["marks"].size(), 1u);
  CHECK_EQ(root["marks"][0]["node"].asString(), std::string("a"));
  CHECK_EQ(root["marks"][0]["status"].asString(), std::string("none"));
}

// `record` is the only way into the overlay precisely so the projections cannot drift from the
// registers. Re-marking a node must move it between the sets, never leave it in two.
TEST(recording_over_a_node_moves_it_between_the_projected_sets) {
  Progress progress;
  progress.record(nid("a"), ProgressMark{ProgressStatus::active, at(500), 1});
  progress.record(nid("a"), ProgressMark{ProgressStatus::complete, at(600), 2});
  progress.record(nid("b"), ProgressMark{ProgressStatus::complete, at(600), 2});
  progress.record(nid("b"), ProgressMark{ProgressStatus::none, at(700), 3});

  CHECK_EQ(progress.completed, (std::set<NodeId>{nid("a")}));
  CHECK_EQ(progress.inProgress, (std::set<NodeId>{}));
  CHECK_EQ(progress.cleared, (std::set<NodeId>{nid("b")}));
  CHECK_EQ(progress.marks.size(), 2u);
  CHECK_EQ(progress.marks.at(nid("a")).status, ProgressStatus::complete);
}
