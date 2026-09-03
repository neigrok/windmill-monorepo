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

static NodeSpec colored(const char* id, NodeColor color, std::vector<NodeId> prereqs) {
  NodeSpec node = spec(id, std::move(prereqs));
  node.color = color;
  return node;
}

// a(sky) -> b(sky), a -> c(plum), c -> d(plum), b -> d: d's trunk parent is c, so b -> d is the
// one edge joining two colour-derived branches.
static TreeData twoBranches(bool reviewExempt) {
  TreeData data;
  data.id = TreeId{std::string("t")};
  data.title = "T";
  data.nodes = {
    colored("a", NodeColor::sky, {}),
    colored("b", NodeColor::sky, {nid("a")}),
    colored("c", NodeColor::plum, {nid("a")}),
    colored("d", NodeColor::plum, {nid("c"), nid("b")}),
  };
  data.kinds = {Kind{KindId{std::string("build")}, NodeColor::sky, "Build", "", false},
                Kind{KindId{std::string("review")}, NodeColor::plum, "Review", "", reviewExempt}};
  return data;
}

TEST(health_counts_an_edge_between_colour_branches_as_cross_branch) {
  Health health = TreeHealth::assess(SkillTree(twoBranches(false)));
  CHECK_EQ(health.edgeCount, 4);
  CHECK_EQ(health.crossBranch, 1);
  CHECK_EQ(health.crossBranchExempt, 0);
  CHECK_EQ(health.redundant, 0);
  CHECK_EQ(health.score, 85);
}

TEST(health_leaves_an_edge_touching_an_exempt_kind_out_of_the_cross_branch_count) {
  Health health = TreeHealth::assess(SkillTree(twoBranches(true)));
  CHECK_EQ(health.edgeCount, 4);
  CHECK_EQ(health.crossBranch, 0);
  CHECK_EQ(health.crossBranchExempt, 1);
  CHECK_EQ(health.score, 100);

  TreeData skySide = twoBranches(false);  // the sky endpoint of b -> d is enough on its own
  skySide.kinds[0].crossBranchExempt = true;
  Health either = TreeHealth::assess(SkillTree(skySide));
  CHECK_EQ(either.crossBranch, 0);
  CHECK_EQ(either.crossBranchExempt, 1);
}

// a(sky) -> s(sky), a -> p(plum), p -> d(plum), s -> d, p -> e(gold), s -> e: d and e both elect
// their p parent (same hue for d; the smaller id for e), so s -> d and s -> e are the two edges
// joining branches. d wears the exempt kind, e does not.
TEST(health_scores_over_the_edges_that_weigh_something) {
  TreeData data;
  data.id = TreeId{std::string("t")};
  data.title = "T";
  data.nodes = {
    colored("a", NodeColor::sky, {}),
    colored("s", NodeColor::sky, {nid("a")}),
    colored("p", NodeColor::plum, {nid("a")}),
    colored("d", NodeColor::plum, {nid("p"), nid("s")}),
    colored("e", NodeColor::gold, {nid("p"), nid("s")}),
  };
  data.kinds = {Kind{KindId{std::string("build")}, NodeColor::sky, "Build", "", false},
                Kind{KindId{std::string("review")}, NodeColor::plum, "Review", "", true},
                Kind{KindId{std::string("ship")}, NodeColor::gold, "Ship", "", false}};
  Health health = TreeHealth::assess(SkillTree(data));
  CHECK_EQ(health.edgeCount, 6);  // every live edge, the exempt one included
  CHECK_EQ(health.crossBranch, 1);
  CHECK_EQ(health.crossBranchExempt, 1);
  CHECK_EQ(health.redundant, 0);
  CHECK_EQ(health.score, 88);  // 100 × (1 − 0.6 × 1/5): the exempt edge is out of the denominator too
}
