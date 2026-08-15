#include "products/roadmap/domain/SkillTree.h"
#include "products/roadmap/domain/UnlockRules.h"
#include "test/testing.h"

#include <string>

using namespace wm;

static NodeId nid(const char* s) { return NodeId{std::string(s)}; }

static SkillTree chain() {
  TreeData data;
  data.id = TreeId{std::string("t")};
  data.title = "T";
  NodeSpec r, a, b;
  r.id = nid("r"); r.label = "r"; r.icon = "i"; r.color = NodeColor::gold;
  a.id = nid("a"); a.label = "a"; a.icon = "i"; a.color = NodeColor::sky; a.prerequisites = {nid("r")};
  b.id = nid("b"); b.label = "b"; b.icon = "i"; b.color = NodeColor::sky; b.prerequisites = {nid("a")};
  data.nodes = {r, a, b};
  return SkillTree(data);
}

TEST(unlock_states_from_progress) {
  SkillTree tree = chain();
  Progress progress;
  progress.completed = {nid("r")};

  auto states = UnlockRules::derive(tree, progress);
  CHECK_EQ(states.at(nid("r")), NodeState::complete);
  CHECK_EQ(states.at(nid("a")), NodeState::available);
  CHECK_EQ(states.at(nid("b")), NodeState::locked);
}

TEST(unlock_in_progress_beats_availability) {
  SkillTree tree = chain();
  Progress progress;
  progress.completed = {nid("r"), nid("a")};
  progress.inProgress = {nid("b")};

  auto states = UnlockRules::derive(tree, progress);
  CHECK_EQ(states.at(nid("r")), NodeState::complete);
  CHECK_EQ(states.at(nid("a")), NodeState::complete);
  CHECK_EQ(states.at(nid("b")), NodeState::active);
}

TEST(unlock_derives_over_a_bare_node_list_the_same_as_over_a_tree) {
  SkillTree tree = chain();
  Progress progress;
  progress.completed = {nid("r")};
  progress.inProgress = {nid("a")};

  CHECK(UnlockRules::derive(tree.nodes(), progress) == UnlockRules::derive(tree, progress));
}

TEST(unlock_a_prerequisite_naming_no_node_locks_its_dependant) {
  NodeSpec r, a;
  r.id = nid("r"); r.label = "r";
  a.id = nid("a"); a.label = "a"; a.prerequisites = {nid("ghost")};
  Progress progress;
  progress.completed = {nid("r")};

  auto states = UnlockRules::derive(std::vector<NodeSpec>{r, a}, progress);
  CHECK_EQ(states.size(), 2u);
  CHECK_EQ(states.at(nid("r")), NodeState::complete);
  CHECK_EQ(states.at(nid("a")), NodeState::locked);
}

TEST(unlock_a_cycle_locks_every_member_and_nothing_else) {
  NodeSpec r, a, b;
  r.id = nid("r"); r.label = "r";
  a.id = nid("a"); a.label = "a"; a.prerequisites = {nid("r"), nid("b")};
  b.id = nid("b"); b.label = "b"; b.prerequisites = {nid("a")};

  auto states = UnlockRules::derive(std::vector<NodeSpec>{r, a, b}, Progress{});
  CHECK_EQ(states.size(), 3u);
  CHECK_EQ(states.at(nid("r")), NodeState::available);
  CHECK_EQ(states.at(nid("a")), NodeState::locked);
  CHECK_EQ(states.at(nid("b")), NodeState::locked);
}
