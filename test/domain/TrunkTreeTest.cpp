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

// r(gold) -> a(sky), b(sky); a -> c(sky), d(sky); b -> d  (d has parents a and b)
static SkillTree fixture() {
  TreeData data;
  data.id = TreeId{std::string("t")};
  data.title = "T";
  data.nodes = {
    spec("r", NodeColor::gold, {}),
    spec("a", NodeColor::sky, {nid("r")}),
    spec("b", NodeColor::sky, {nid("r")}),
    spec("c", NodeColor::sky, {nid("a")}),
    spec("d", NodeColor::sky, {nid("a"), nid("b")}),
  };
  return SkillTree(data);
}

TEST(trunk_center_and_primary_parents) {
  SkillTree tree = fixture();
  const TrunkTree& trunk = tree.trunk();
  CHECK(trunk.centerId() == std::optional<NodeId>(nid("r")));
  CHECK(trunk.primaryParentOf(nid("r")) == std::nullopt);
  CHECK(trunk.primaryParentOf(nid("a")) == std::optional<NodeId>(nid("r")));
  CHECK(trunk.primaryParentOf(nid("d")) == std::optional<NodeId>(nid("a")));  // ties to shallowest then smallest id
}

TEST(trunk_branch_assignment) {
  SkillTree tree = fixture();
  const TrunkTree& trunk = tree.trunk();
  CHECK_EQ(trunk.branchOf(nid("r")), nid("r"));
  CHECK_EQ(trunk.branchOf(nid("a")), nid("a"));
  CHECK_EQ(trunk.branchOf(nid("b")), nid("b"));
  CHECK_EQ(trunk.branchOf(nid("c")), nid("a"));
  CHECK_EQ(trunk.branchOf(nid("d")), nid("a"));
  CHECK_EQ(trunk.branchRoots().size(), 3u);
}

TEST(trunk_edge_kinds) {
  SkillTree tree = fixture();
  const TrunkTree& trunk = tree.trunk();
  CHECK_EQ(trunk.edgeKind(nid("r"), nid("a")), EdgeKind::trunk);
  CHECK_EQ(trunk.edgeKind(nid("a"), nid("c")), EdgeKind::trunk);
  CHECK_EQ(trunk.edgeKind(nid("a"), nid("d")), EdgeKind::trunk);
  CHECK_EQ(trunk.edgeKind(nid("b"), nid("d")), EdgeKind::cross_branch);
}

TEST(trunk_leaf_counts) {
  SkillTree tree = fixture();
  const TrunkTree& trunk = tree.trunk();
  CHECK_EQ(trunk.leafCountOf(nid("r")), 3);
  CHECK_EQ(trunk.leafCountOf(nid("a")), 2);
  CHECK_EQ(trunk.leafCountOf(nid("b")), 1);
  CHECK_EQ(trunk.leafCountOf(nid("c")), 1);
}
