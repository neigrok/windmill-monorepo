#include "products/roadmap/domain/NodeQuery.h"

#include "test/testing.h"

using namespace wm;

static NodeId nid(const char* s) { return NodeId{std::string(s)}; }
static KindId kid(const char* s) { return KindId{std::string(s)}; }

static NodeSpec node(const char* id, const char* label, NodeColor color, const char* description = "") {
  NodeSpec n;
  n.id = nid(id);
  n.label = label;
  n.color = color;
  n.description = description;
  return n;
}

static TreeData sampleTree() {
  TreeData tree;
  tree.id = TreeId{"t"};
  tree.nodes = {
    node("renderer", "WebGL2 Renderer", NodeColor::sky, "hand-rolled GL"),
    node("camera", "Pan & Zoom", NodeColor::sky, "inertia and easing"),
    node("domain", "DAG Domain", NodeColor::brick, "validation core"),
  };
  tree.kinds = {Kind{kid("frontend"), NodeColor::sky, "Frontend", ""},
                Kind{kid("backend"), NodeColor::brick, "Backend", ""}};
  return tree;
}

TEST(select_nodes_by_color) {
  NodeFilter filter;
  filter.color = NodeColor::sky;
  std::vector<NodeSpec> matches = selectNodes(sampleTree(), filter);
  CHECK_EQ(matches.size(), 2u);
  CHECK_EQ(matches[0].id, nid("renderer"));
  CHECK_EQ(matches[1].id, nid("camera"));
}

TEST(select_nodes_by_kind_resolves_through_the_legend) {
  NodeFilter filter;
  filter.kind = kid("backend");
  std::vector<NodeSpec> matches = selectNodes(sampleTree(), filter);
  CHECK_EQ(matches.size(), 1u);
  CHECK_EQ(matches[0].id, nid("domain"));
}

TEST(select_nodes_by_an_unknown_kind_matches_nothing) {
  NodeFilter filter;
  filter.kind = kid("ghost");
  CHECK_EQ(selectNodes(sampleTree(), filter).size(), 0u);
}

TEST(select_nodes_by_substring_is_case_insensitive_over_label_and_description) {
  NodeFilter byLabel;
  byLabel.query = "renderer";  // lower-case matches "WebGL2 Renderer"
  std::vector<NodeSpec> labelMatches = selectNodes(sampleTree(), byLabel);
  CHECK_EQ(labelMatches.size(), 1u);
  CHECK_EQ(labelMatches[0].id, nid("renderer"));

  NodeFilter byDescription;
  byDescription.query = "INERTIA";  // upper-case matches the "inertia and easing" description
  std::vector<NodeSpec> descriptionMatches = selectNodes(sampleTree(), byDescription);
  CHECK_EQ(descriptionMatches.size(), 1u);
  CHECK_EQ(descriptionMatches[0].id, nid("camera"));
}

TEST(select_nodes_ands_every_criterion) {
  NodeFilter filter;
  filter.color = NodeColor::sky;
  filter.query = "zoom";  // only "Pan & Zoom" is both sky and matches
  std::vector<NodeSpec> matches = selectNodes(sampleTree(), filter);
  CHECK_EQ(matches.size(), 1u);
  CHECK_EQ(matches[0].id, nid("camera"));
}

TEST(select_nodes_with_an_empty_filter_returns_all) {
  CHECK_EQ(selectNodes(sampleTree(), NodeFilter{}).size(), 3u);
}

static std::vector<std::string> ids(const std::vector<NodeSpec>& nodes) {
  std::vector<std::string> out;
  for (const NodeSpec& node : nodes) out.push_back(node.id.str());
  return out;
}

// The id is the handle every edit is aimed by, so a query that IS an id is a caller naming the
// node it already means. The tree is deliberately in another order: the ranking decides, not the
// input.
static TreeData rankableTree() {
  TreeData tree;
  tree.id = TreeId{"t"};
  tree.nodes = {
    node("delta", "Delta", NodeColor::sky, "supersedes alpha"),  // description only
    node("gamma", "Alpha rising", NodeColor::sky),               // label
    node("pre-alpha", "Prelude", NodeColor::sky),                // id substring
    node("alpha-two", "Second", NodeColor::sky),                 // id prefix
    node("alpha", "First", NodeColor::sky),                      // the exact id
  };
  return tree;
}

TEST(select_nodes_matches_the_id_and_ranks_an_exact_one_first) {
  NodeFilter filter;
  filter.query = "alpha";
  CHECK_EQ(ids(selectNodes(rankableTree(), filter)),
           (std::vector<std::string>{"alpha", "alpha-two", "gamma", "pre-alpha", "delta"}));

  NodeFilter shouted;
  shouted.query = "ALPHA";  // the id is matched case-insensitively, like the rest
  CHECK_EQ(ids(selectNodes(rankableTree(), shouted)),
           (std::vector<std::string>{"alpha", "alpha-two", "gamma", "pre-alpha", "delta"}));

  NodeFilter narrowed;
  narrowed.query = "alpha";
  narrowed.color = NodeColor::brick;  // every criterion still ANDs; nothing here is brick
  CHECK_EQ(selectNodes(rankableTree(), narrowed).size(), 0u);
}

TEST(select_nodes_keeps_the_trees_order_within_one_rank) {
  TreeData tree;
  tree.nodes = {node("second", "B", NodeColor::sky, "mentions alpha"),
                node("first", "A", NodeColor::sky, "mentions alpha")};
  NodeFilter filter;
  filter.query = "alpha";
  CHECK_EQ(ids(selectNodes(tree, filter)), (std::vector<std::string>{"second", "first"}));

  CHECK_EQ(ids(selectNodes(tree, NodeFilter{})), (std::vector<std::string>{"second", "first"}));
}
