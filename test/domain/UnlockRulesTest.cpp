#include "domain/SkillTree.h"
#include "domain/UnlockRules.h"
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
