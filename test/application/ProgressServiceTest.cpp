#include "application/ProgressService.h"
#include "test/application/Fakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

// A single chain r -> a: node "a" has "r" as its one prerequisite, node "r" has none.
// The advisory check reads only these prerequisite lists, so a bare vector stands in for
// a whole tree — and works even where a SkillTree could not be built (a cyclic graph).
namespace {
const std::vector<NodeId> noPrereqs{};
const std::vector<NodeId> aPrereqs{nid("r")};
}

TEST(progress_records_complete_but_flags_unmet_prerequisites) {
  FakeProgressRepository repo;
  ProgressService service(repo);

  ProgressOutcome outcome = service.setStatus(aPrereqs, tid(), uid(), nid("a"), ProgressStatus::complete, at(1));
  CHECK_EQ(outcome.status, ProgressStatus::complete);
  CHECK_FALSE(outcome.prerequisitesMet);

  Progress progress = service.progressOf(tid(), uid());
  CHECK_EQ(progress.completed.count(nid("a")), 1u);  // recorded despite the advisory miss
}

TEST(progress_complete_with_met_prerequisites) {
  FakeProgressRepository repo;
  ProgressService service(repo);

  service.setStatus(noPrereqs, tid(), uid(), nid("r"), ProgressStatus::complete, at(1));
  ProgressOutcome outcome = service.setStatus(aPrereqs, tid(), uid(), nid("a"), ProgressStatus::complete, at(2));
  CHECK(outcome.prerequisitesMet);
}

TEST(progress_none_clears_the_entry) {
  FakeProgressRepository repo;
  ProgressService service(repo);

  service.setStatus(aPrereqs, tid(), uid(), nid("a"), ProgressStatus::active, at(1));
  CHECK_EQ(service.progressOf(tid(), uid()).inProgress.count(nid("a")), 1u);

  service.setStatus(aPrereqs, tid(), uid(), nid("a"), ProgressStatus::none, at(2));
  Progress progress = service.progressOf(tid(), uid());
  CHECK_EQ(progress.inProgress.count(nid("a")), 0u);
  CHECK_EQ(progress.completed.count(nid("a")), 0u);
}
