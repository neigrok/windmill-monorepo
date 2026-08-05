#include "products/roadmap/application/ProgressService.h"
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

TEST(progress_clear_persists_as_a_tombstone_row) {
  FakeProgressRepository repo;
  ProgressService service(repo);

  service.setStatus(aPrereqs, tid(), uid(), nid("a"), ProgressStatus::complete, at(1));
  service.setStatus(aPrereqs, tid(), uid(), nid("a"), ProgressStatus::none, at(2));

  auto entry = repo.byKey.find(FakeProgressRepository::key(tid(), uid(), nid("a")));
  CHECK(entry != repo.byKey.end());  // the clear is a stored LWW value, not a row delete
  CHECK_EQ(entry->second.status, ProgressStatus::none);
  CHECK_EQ(entry->second.at, at(2));

  // And the tombstone is VISIBLE on load — a client's reconcile must be able to tell
  // "cleared" from "never marked", or it resurrects the clear with a stale local mark.
  Progress loaded = repo.load(tid(), uid());
  CHECK(loaded.completed.empty());
  CHECK(loaded.inProgress.empty());
  CHECK_EQ(loaded.cleared.size(), 1u);
  CHECK(loaded.cleared.count(nid("a")) == 1);
}

TEST(progress_stale_mark_cannot_resurrect_a_cleared_node) {
  FakeProgressRepository repo;
  ProgressService service(repo);

  service.setStatus(aPrereqs, tid(), uid(), nid("a"), ProgressStatus::complete, at(1));
  service.setStatus(aPrereqs, tid(), uid(), nid("a"), ProgressStatus::none, at(3));
  service.setStatus(aPrereqs, tid(), uid(), nid("a"), ProgressStatus::complete, at(2));  // stale replay

  Progress progress = service.progressOf(tid(), uid());
  CHECK_EQ(progress.completed.count(nid("a")), 0u);
  CHECK_EQ(progress.inProgress.count(nid("a")), 0u);
}
