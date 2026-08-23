#include "products/roadmap/domain/SkillTree.h"
#include "products/roadmap/domain/TreeHealth.h"
#include "test/testing.h"

#include <string>

using namespace wm;

static NodeId nid(const char* s) { return NodeId{std::string(s)}; }

static NodeSpec spec(const char* id, std::vector<NodeId> prereqs) {
  NodeSpec node;
  node.id = nid(id);
  node.label = id;
  node.icon = "icon";
  node.color = NodeColor::sky;
  node.prerequisites = std::move(prereqs);
  return node;
}

TEST(health_counts_redundant_and_cross_branch) {
  TreeData data;
  data.id = TreeId{std::string("t")};
  data.title = "T";
  data.nodes = {
    spec("a", {}),
    spec("b", {nid("a")}),
    spec("c", {nid("b"), nid("a")}),  // a -> c is redundant (a reaches c through b)
  };
  SkillTree tree(data);

  Health health = TreeHealth::assess(tree);
  CHECK_EQ(health.nodeCount, 3);
  CHECK_EQ(health.edgeCount, 3);
  CHECK_EQ(health.crossBranch, 1);
  CHECK_EQ(health.redundant, 1);
  CHECK_EQ(health.avgInDegree, 1.0);
  CHECK_EQ(health.score, 67);
}

TEST(health_of_clean_chain_scores_full) {
  TreeData data;
  data.id = TreeId{std::string("t")};
  data.title = "T";
  data.nodes = {spec("a", {}), spec("b", {nid("a")}), spec("c", {nid("b")})};
  SkillTree tree(data);

  Health health = TreeHealth::assess(tree);
  CHECK_EQ(health.crossBranch, 0);
  CHECK_EQ(health.redundant, 0);
  CHECK_EQ(health.score, 100);
}

// Health's redundant count rides the same work budget as tidy's pass; skipped means 0.
TEST(health_skips_the_redundant_pass_when_the_edges_blow_the_budget) {
  TreeData data;
  data.id = TreeId{std::string("t")};
  data.title = "Dense";
  for (int i = 0; i < 200; ++i) {
    std::vector<NodeId> prereqs;
    for (int p = 0; p < i; ++p) prereqs.push_back(nid(("n" + std::to_string(p)).c_str()));
    data.nodes.push_back(spec(("n" + std::to_string(i)).c_str(), std::move(prereqs)));
  }
  SkillTree tree(data);

  Health health = TreeHealth::assess(tree);
  CHECK_EQ(health.nodeCount, 200);
  CHECK_EQ(health.edgeCount, 19900);
  CHECK_EQ(health.redundant, 0);
}
