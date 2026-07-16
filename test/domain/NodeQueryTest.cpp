#include "domain/NodeQuery.h"

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
