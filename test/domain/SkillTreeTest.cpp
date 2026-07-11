#include "domain/SkillTree.h"
#include "test/testing.h"

#include <string>

using namespace wm;

static NodeId nid(const char* s) { return NodeId{std::string(s)}; }

static NodeSpec spec(const char* id, NodeColor color, std::vector<NodeId> prereqs) {
  NodeSpec node;
  node.id = nid(id);
  node.label = id;
  node.icon = "icon";
  node.color = color;
  node.prerequisites = std::move(prereqs);
  return node;
}

static bool threw_invalid(const TreeData& data) {
  try {
    SkillTree tree(data);
    return false;
  } catch (const InvalidTree&) {
    return true;
  }
}

TEST(skilltree_indexes_edges_roots_children) {
  TreeData data;
  data.id = TreeId{std::string("t")};
  data.title = "T";
  data.nodes = {
    spec("root", NodeColor::gold, {}),
    spec("a", NodeColor::sky, {nid("root")}),
    spec("b", NodeColor::sky, {nid("a")}),
  };
  SkillTree tree(data);

  CHECK_EQ(tree.roots().size(), 1u);
  CHECK_EQ(tree.roots()[0]->id, nid("root"));
  CHECK_EQ(tree.edges().size(), 2u);
  CHECK_EQ(tree.childrenOf(nid("root")).size(), 1u);
  CHECK_EQ(tree.childrenOf(nid("root"))[0]->id, nid("a"));
  CHECK_EQ(tree.parentsOf(nid("b")).size(), 1u);
  CHECK_EQ(tree.parentsOf(nid("b"))[0]->id, nid("a"));
  CHECK_EQ(tree.topoOrder().size(), 3u);
  CHECK_EQ(tree.topoOrder()[0], nid("root"));
}

TEST(skilltree_rejects_duplicate_id) {
  TreeData data;
  data.id = TreeId{std::string("t")};
  data.nodes = {spec("x", NodeColor::sky, {}), spec("x", NodeColor::sky, {})};
  CHECK(threw_invalid(data));
}

TEST(skilltree_rejects_unknown_prerequisite) {
  TreeData data;
  data.id = TreeId{std::string("t")};
  data.nodes = {spec("a", NodeColor::sky, {nid("ghost")})};
  CHECK(threw_invalid(data));
}

TEST(skilltree_rejects_cycle) {
  TreeData data;
  data.id = TreeId{std::string("t")};
  data.nodes = {
    spec("a", NodeColor::sky, {nid("b")}),
    spec("b", NodeColor::sky, {nid("a")}),
  };
  CHECK(threw_invalid(data));
}
