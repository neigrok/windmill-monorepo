#include "test/products/gym/application/GymServiceFixture.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::servicetest;

TEST(a_thread_past_the_list_ceiling_still_reads_by_id_with_the_outcome_the_app_shows_it) {
  Harness h;
  h.create(h.pushAWrite());
  const std::uint64_t opened = 1'700'000'000'000ull;
  for (int number = 0; number <= kThreadList; ++number) {
    const std::string id = "thr_probe" + std::to_string(1000 + number);
    h.repo.db.threadRows.push_back(AskThread{ThreadId{id}, uid(), "question " + id,
                                          opened + static_cast<std::uint64_t>(number),
                                          opened + static_cast<std::uint64_t>(number),
                                          {ThreadTurn{true, "question " + id, opened}},
                                          {}});
  }
  // The OLDEST thread — the one the newest-first list read drops — is the one that applied.
  h.repo.db.proposalRows.push_back(RoutineProposal{
      ProposalHead{ProposalId{"prop_00000001"}, rtId(), uid(), ProposalIntent::revise,
                   ProposalState::applied,
                   ProposalSource{ProposalDoor::ask, "", "", ThreadId{"thr_probe1000"}}, "", 4,
                   opened, std::nullopt},
      1, "Push A", "Push A",
      changesBetween({benchEntry()}, {RoutineEntry{1, ExerciseId{"bench-press"}, straight(5, 5, 90.0), 180}})});

  const std::optional<AskThread> oldest = h.threads.thread(uid(), ThreadId{"thr_probe1000"});

  CHECK_EQ(h.threads.threads(uid()).size(), static_cast<std::size_t>(kThreadList));
  REQUIRE(oldest.has_value());
  CHECK_EQ(outcomeOf(*oldest),
           (ThreadOutcome{ThreadOutcomeKind::applied, 4, rtId(), "Push A"}));
}

TEST(a_conversation_whose_run_never_answered_is_listed_as_itself_and_reads_as_read_only) {
  Harness h;
  const AskThread orphan{ThreadId{"thr_orphan01"}, uid(), "a question whose run never came back",
                         1'700'000'009'000, 1'700'000'009'000, {}, {}};
  h.repo.db.threadRows.push_back(orphan);

  CHECK_EQ(h.threads.threads(uid()), std::vector<AskThread>{orphan});
  CHECK_EQ(h.threads.thread(uid(), ThreadId{"thr_orphan01"}), std::optional<AskThread>{orphan});
  CHECK_EQ(outcomeOf(*h.threads.thread(uid(), ThreadId{"thr_orphan01"})),
           (ThreadOutcome{ThreadOutcomeKind::readOnly, 0, std::nullopt, ""}));
}
