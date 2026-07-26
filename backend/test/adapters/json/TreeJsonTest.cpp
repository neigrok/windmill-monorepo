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

  TreeData back = treeFromJson(parse(dump(toJson(data))), TreeId{"t"});
  CHECK_EQ(back.nodes.size(), 1u);
  CHECK_EQ(back.nodes[0].description, std::string("notes"));
  CHECK_EQ(back.nodes[0].links.size(), 2u);
  CHECK_EQ(back.nodes[0].links[0], (Link{"Doc", "https://d"}));
  CHECK_EQ(back.nodes[0].links[1].url, std::string("https://e"));
}

TEST(a_bare_url_string_parses_as_a_labelless_link) {
  std::vector<Link> links = linksFromJson(parse("[\"https://x\", {\"url\": \"https://y\", \"label\": \"Y\"}]"));
  CHECK_EQ(links.size(), 2u);
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

  TreeData back = treeFromJson(parse(dump(toJson(data))), TreeId{"t"});
  CHECK_EQ(back.nodes.size(), 1u);
  CHECK_EQ(back.nodes[0].order, std::string("a7"));
}
