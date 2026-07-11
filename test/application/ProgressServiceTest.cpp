#include "application/ProgressService.h"
#include "domain/SkillTree.h"
#include "test/application/Fakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

namespace {

SkillTree chain() {
  TreeData data;
  data.id = tid();
  data.title = "T";
  NodeSpec r;
  r.id = nid("r"); r.label = "r"; r.icon = "i"; r.color = NodeColor::gold;
  NodeSpec a;
  a.id = nid("a"); a.label = "a"; a.icon = "i"; a.color = NodeColor::sky; a.prerequisites = {nid("r")};
  data.nodes = {r, a};
  return SkillTree(data);
}

}

TEST(progress_records_complete_but_flags_unmet_prerequisites) {
  FakeProgressRepository repo;
  ProgressService service(repo);
  SkillTree tree = chain();

  ProgressOutcome outcome = service.setStatus(tree, tid(), uid(), nid("a"), ProgressStatus::complete, at(1));
  CHECK_EQ(outcome.status, ProgressStatus::complete);
  CHECK_FALSE(outcome.prerequisitesMet);

  Progress progress = service.progressOf(tid(), uid());
  CHECK_EQ(progress.completed.count(nid("a")), 1u);  // recorded despite the advisory miss
}

TEST(progress_complete_with_met_prerequisites) {
  FakeProgressRepository repo;
  ProgressService service(repo);
  SkillTree tree = chain();

  service.setStatus(tree, tid(), uid(), nid("r"), ProgressStatus::complete, at(1));
  ProgressOutcome outcome = service.setStatus(tree, tid(), uid(), nid("a"), ProgressStatus::complete, at(2));
  CHECK(outcome.prerequisitesMet);
}

TEST(progress_none_clears_the_entry) {
  FakeProgressRepository repo;
  ProgressService service(repo);
  SkillTree tree = chain();

  service.setStatus(tree, tid(), uid(), nid("a"), ProgressStatus::active, at(1));
  CHECK_EQ(service.progressOf(tid(), uid()).inProgress.count(nid("a")), 1u);

  service.setStatus(tree, tid(), uid(), nid("a"), ProgressStatus::none, at(2));
  Progress progress = service.progressOf(tid(), uid());
  CHECK_EQ(progress.inProgress.count(nid("a")), 0u);
  CHECK_EQ(progress.completed.count(nid("a")), 0u);
}
