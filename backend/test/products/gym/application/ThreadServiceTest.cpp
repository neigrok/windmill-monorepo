#include "test/products/gym/application/GymServiceFixture.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::servicetest;

// --- The threads export: an archive, and archives have no ceiling ------------------------------

// THE EXPORT IS NOT A SCREEN. Its outcomes used to be stamped from the LIST read, which stops at
// kThreadList — so a lifter's oldest conversations exported with a blank outcome while the app's own
// read of the very same thread said `applied · 4 · Push A`, under a route whose comment promises
// nothing omitted. Every thread carries its outcome now, however many there are.
TEST(a_thread_past_the_list_ceiling_still_exports_the_outcome_the_app_shows_it) {
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
      changesBetween({benchEntry()}, {RoutineEntry{1, ExerciseId{"bench-press"}, 5, 5, 90.0, 180}})});

  const std::vector<ExportedThreadTurn> exported = h.threads.exportedThreadTurns(uid());

  CHECK_EQ(exported.size(), static_cast<std::size_t>(kThreadList) + 1);
  CHECK_EQ(exported[0].threadId, std::string("thr_probe1000"));
  CHECK_EQ(exported[0].outcome, std::string("applied"));
  CHECK_EQ(exported[0].changes, std::string("4"));
  CHECK_EQ(exported[0].routine, std::string("Push A"));
  // And it is the same sentence the thread's own read gives — which is the whole of the complaint.
  CHECK_EQ(toString(outcomeOf(*h.threads.thread(uid(), ThreadId{"thr_probe1000"})).kind),
           std::string("applied"));
}

// A THREAD WITH NO TURNS IS REAL, AND IT IS IN THE FILE. The row is committed before the model runs,
// so one exists for the whole of every in-flight ask and stays if the process died before the answer
// came back. It is listed on screen and it is the lifter's to delete, so an export that dropped it
// would be quietly smaller than the list under a route promising nothing omitted.
TEST(a_conversation_whose_run_never_answered_exports_as_itself_with_nothing_under_it) {
  Harness h;
  h.repo.db.threadRows.push_back(AskThread{ThreadId{"thr_orphan01"}, uid(),
                                        "a question whose run never came back", 1'700'000'009'000,
                                        1'700'000'009'000, {}, {}});

  const std::vector<ExportedThreadTurn> exported = h.threads.exportedThreadTurns(uid());

  REQUIRE(exported.size() == 1u);
  CHECK_EQ(exported[0].threadId, std::string("thr_orphan01"));
  CHECK_EQ(exported[0].title, std::string("a question whose run never came back"));
  CHECK_EQ(exported[0].outcome, std::string("read-only"));
  CHECK_EQ(exported[0].changes, std::string(""));
  CHECK_EQ(exported[0].turnNumber, std::string(""));
  CHECK_EQ(exported[0].from, std::string(""));
  CHECK_EQ(exported[0].text, std::string(""));
  CHECK_EQ(exported[0].saidAt, std::string(""));
  // The same thread the list read carries, so the two doors agree about what this account holds.
  CHECK_EQ(h.threads.threads(uid()).size(), 1u);
}
