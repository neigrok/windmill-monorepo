#include "products/gym/adapters/postgres/PgAskThreadRepository.h"
#include "products/gym/adapters/postgres/PgProgramRepository.h"

// The in-memory twin is included for the thread export alone: both renderings are asserted to match.
#include "test/products/gym/Fakes.h"
#include "test/products/gym/adapters/postgres/PgGymFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <cstdlib>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// Ask's threads against a real server.
using namespace wm::gym;
using namespace wm::gym::pgtest;

// The title is the first message VERBATIM, and a second ask into the same conversation does not rename it.
TEST(pg_gym_a_thread_is_titled_by_its_first_message_and_keeps_every_turn_as_sent) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository repo{wm::pgTestPool()};
  const std::string typed = "Bench \xE2\x80\x9Cstuck\xE2\x80\x9D at 82.5 \xE2\x80\x94 3 weeks, why?";

  openedAt(repo, "thr_pg000001", typed);
  said(repo, "thr_pg000001", typed, "Your top set has not moved.");
  // A second ask into the same conversation: the title is passed and ignored.
  openedAt(repo, "thr_pg000001", "something else entirely", kNow + 1'000);
  said(repo, "thr_pg000001", "and the squat?", "That one is moving.", kNow + 1'000);

  const std::optional<AskThread> held = repo.thread(wm::UserId{kUser}, ThreadId{"thr_pg000001"});
  REQUIRE(held.has_value());
  CHECK_EQ(held->title, typed);
  CHECK_EQ(held->createdAtMs, kNow);
  CHECK_EQ(held->askedAtMs, kNow + 1'000);
  REQUIRE_EQ(held->turns.size(), 4u);
  CHECK_EQ(held->turns[0], (ThreadTurn{true, typed, kNow}));
  CHECK_EQ(held->turns[1], (ThreadTurn{false, "Your top set has not moved.", kNow}));
  CHECK_EQ(held->turns[2], (ThreadTurn{true, "and the squat?", kNow + 1'000}));
  CHECK_EQ(held->turns[3], (ThreadTurn{false, "That one is moving.", kNow + 1'000}));
}

// The id is a primary key across every account: one somebody else holds is refused, never appended to.
TEST(pg_gym_a_thread_id_another_account_holds_is_refused_and_their_words_stay_theirs) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository repo{wm::pgTestPool()};
  openedAt(repo, "thr_pg000001", "mine");
  said(repo, "thr_pg000001", "mine", "answered");

  const ThreadOpenOutcome theirs =
      repo.openThread(wm::UserId{kOther}, ThreadId{"thr_pg000001"}, "yours", kNow);
  CHECK(theirs.error == ThreadOpenError::idTaken);
  CHECK_FALSE(theirs.thread.has_value());
  // …and the read gives them the same nothing an absent id would.
  CHECK_EQ(repo.thread(wm::UserId{kOther}, ThreadId{"thr_pg000001"}), std::optional<AskThread>());
  CHECK(repo.threads(wm::UserId{kOther}).empty());
  CHECK_EQ(repo.thread(wm::UserId{kUser}, ThreadId{"thr_pg000001"})->turns.size(), 2u);
}

// A thread whose run never answered is taken back whole, but only while it holds no turns.
TEST(pg_gym_an_empty_thread_is_discarded_and_one_with_turns_is_not) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository repo{wm::pgTestPool()};
  openedAt(repo, "thr_pg000001", "never answered");
  openedAt(repo, "thr_pg000002", "answered once");
  said(repo, "thr_pg000002", "answered once", "here you go");

  repo.discardEmptyThread(wm::UserId{kUser}, ThreadId{"thr_pg000001"});
  repo.discardEmptyThread(wm::UserId{kUser}, ThreadId{"thr_pg000002"});

  CHECK_EQ(repo.thread(wm::UserId{kUser}, ThreadId{"thr_pg000001"}), std::optional<AskThread>());
  REQUIRE(repo.thread(wm::UserId{kUser}, ThreadId{"thr_pg000002"}).has_value());
}

// The list: newest asked first, each row carrying the routine's name as it now stands.
TEST(pg_gym_the_thread_list_is_newest_first_and_carries_what_each_one_proposed) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository repo{wm::pgTestPool()};
  PgProgramRepository program{wm::pgTestPool()};
  inserted(program, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  openedAt(repo, "thr_pg000001", "older");
  said(repo, "thr_pg000001", "older", "answered");
  openedAt(repo, "thr_pg000002", "newer", kNow + 1'000);
  said(repo, "thr_pg000002", "newer", "answered", kNow + 1'000);
  program.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)},
                                 ProposalDoor::ask, kUser, ThreadId{"thr_pg000002"}));

  const std::vector<AskThread> listed = repo.threads(wm::UserId{kUser});
  REQUIRE_EQ(listed.size(), 2u);
  CHECK_EQ(listed[0].id, ThreadId{"thr_pg000002"});
  CHECK_EQ(listed[1].id, ThreadId{"thr_pg000001"});
  // The list carries no turns — the titles and the outcomes are what a list prints.
  CHECK(listed[0].turns.empty());
  REQUIRE_EQ(listed[0].minted.size(), 1u);
  CHECK_EQ(listed[0].minted[0].id, ProposalId{"prop_pg00001"});
  CHECK_EQ(listed[0].minted[0].routineName, std::string("Push A"));
  CHECK(outcomeOf(listed[0]).kind == ThreadOutcomeKind::proposed);
  CHECK(listed[1].minted.empty());
  CHECK(outcomeOf(listed[1]).kind == ThreadOutcomeKind::readOnly);
}

// Deleting a conversation leaves the change it minted standing in the routine's history.
TEST(pg_gym_deleting_a_thread_leaves_the_change_it_applied_in_the_routines_history) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository repo{wm::pgTestPool()};
  PgProgramRepository program{wm::pgTestPool()};
  inserted(program, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  openedAt(repo, "thr_pg000001", "Bench has been stuck at 82.5 for three weeks. What do you see?");
  said(repo, "thr_pg000001", "Bench has been stuck at 82.5 for three weeks. What do you see?",
       "Try heavier triples.");
  program.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)},
                                 ProposalDoor::ask, kUser, ThreadId{"thr_pg000001"}));
  const Routine becomes = routineAt("rt_pg000001", "Push A", {benchAt(87.5, 3)});
  REQUIRE(program.applyRevision(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, becomes, kNow).error ==
          ProposalSettleError::none);

  CHECK(repo.deleteThread(wm::UserId{kUser}, ThreadId{"thr_pg000001"}));

  // The conversation is gone, turns and all.
  CHECK_EQ(repo.thread(wm::UserId{kUser}, ThreadId{"thr_pg000001"}), std::optional<AskThread>());
  CHECK(repo.threads(wm::UserId{kUser}).empty());
  const std::vector<RoutineEvent> history =
      program.routineHistory(wm::UserId{kUser}, RoutineId{"rt_pg000001"});
  REQUIRE_EQ(history.size(), 2u);
  CHECK(history[0].kind == RoutineEventKind::proposal);
  REQUIRE(history[0].proposal.has_value());
  CHECK(history[0].proposal->state == ProposalState::applied);
  CHECK_EQ(history[0].proposal->changes, 1);
  CHECK(history[0].proposal->source.door == ProposalDoor::ask);
  CHECK_FALSE(history[0].proposal->source.thread.has_value());
  const std::optional<Routine> standing = program.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"});
  REQUIRE(standing.has_value());
  CHECK_EQ(standing->entries, std::vector<RoutineEntry>{benchAt(87.5, 3)});
  // Deleting it twice is not a second deletion, and another account's is nobody's.
  CHECK_FALSE(repo.deleteThread(wm::UserId{kUser}, ThreadId{"thr_pg000001"}));
}

// The export: one row per turn, every rendering Postgres's, asserted against the in-memory twin.
TEST(pg_gym_the_thread_export_is_one_row_per_turn_and_matches_the_in_memory_twin) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository repo{wm::pgTestPool()};
  openedAt(repo, "thr_pg000001", "why is my bench, uh, \"stuck\"?");
  said(repo, "thr_pg000001", "why is my bench, uh, \"stuck\"?", "Your top set has not moved.");
  openedAt(repo, "thr_pg000002", "and the squat?", kNow + 1'000);
  said(repo, "thr_pg000002", "and the squat?", "That one is moving.", kNow + 1'000);

  fake::FakeGym twin;
  twin.db.threadRows.push_back(
      AskThread{ThreadId{"thr_pg000001"}, wm::UserId{kUser}, "why is my bench, uh, \"stuck\"?",
                kNow, kNow,
                {ThreadTurn{true, "why is my bench, uh, \"stuck\"?", kNow},
                 ThreadTurn{false, "Your top set has not moved.", kNow}},
                {}});
  twin.db.threadRows.push_back(AskThread{ThreadId{"thr_pg000002"}, wm::UserId{kUser}, "and the squat?",
                                      kNow + 1'000, kNow + 1'000,
                                      {ThreadTurn{true, "and the squat?", kNow + 1'000},
                                       ThreadTurn{false, "That one is moving.", kNow + 1'000}},
                                      {}});

  const std::vector<ExportedThreadTurn> exported = repo.exportedThreadTurns(wm::UserId{kUser});
  CHECK_EQ(exported, twin.threads.exportedThreadTurns(wm::UserId{kUser}));
  REQUIRE_EQ(exported.size(), 4u);
  CHECK_EQ(exported[0].threadId, std::string("thr_pg000001"));
  CHECK_EQ(exported[0].turnNumber, std::string("1"));
  CHECK_EQ(exported[0].from, std::string("lifter"));
  // The turn as sent, quotes and all — nothing on the way through edits what a lifter typed.
  CHECK_EQ(exported[0].text, std::string("why is my bench, uh, \"stuck\"?"));
  // The column a lifter reads names the room; the wire's `from` enum stays "ask".
  CHECK_EQ(exported[1].from, std::string("coach"));
  CHECK_EQ(exported[2].threadId, std::string("thr_pg000002"));
  // The outcome is not the store's to render.
  CHECK_EQ(exported[0].outcome, std::string(""));
  CHECK_EQ(exported[0].changes, std::string(""));
}

// A thread with no turns is in the file with the turn columns empty: the join is a LEFT one.
TEST(pg_gym_a_thread_whose_run_never_answered_is_still_in_the_export) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository repo{wm::pgTestPool()};
  openedAt(repo, "thr_pg000001", "a question whose run never came back");
  openedAt(repo, "thr_pg000002", "answered once", kNow + 1'000);
  said(repo, "thr_pg000002", "answered once", "here you go", kNow + 1'000);

  fake::FakeGym twin;
  twin.db.threadRows.push_back(AskThread{ThreadId{"thr_pg000001"}, wm::UserId{kUser},
                                      "a question whose run never came back", kNow, kNow, {}, {}});
  twin.db.threadRows.push_back(AskThread{ThreadId{"thr_pg000002"}, wm::UserId{kUser}, "answered once",
                                      kNow + 1'000, kNow + 1'000,
                                      {ThreadTurn{true, "answered once", kNow + 1'000},
                                       ThreadTurn{false, "here you go", kNow + 1'000}},
                                      {}});

  const std::vector<ExportedThreadTurn> exported = repo.exportedThreadTurns(wm::UserId{kUser});
  CHECK_EQ(exported, twin.threads.exportedThreadTurns(wm::UserId{kUser}));
  REQUIRE_EQ(exported.size(), 3u);
  CHECK_EQ(exported[0].threadId, std::string("thr_pg000001"));
  CHECK_EQ(exported[0].title, std::string("a question whose run never came back"));
  CHECK_EQ(exported[0].turnNumber, std::string(""));
  CHECK_EQ(exported[0].from, std::string(""));
  CHECK_EQ(exported[0].text, std::string(""));
  CHECK_EQ(exported[0].saidAt, std::string(""));
  CHECK_EQ(exported[1].threadId, std::string("thr_pg000002"));
  CHECK_EQ(exported[1].turnNumber, std::string("1"));
  CHECK_EQ(repo.threads(wm::UserId{kUser}).size(), 2u);
}

// `allThreads` is the archive's read and has no ceiling, oldest first, carrying what each one minted.
TEST(pg_gym_every_thread_is_read_for_the_archive_past_the_lists_own_ceiling) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository repo{wm::pgTestPool()};
  PgProgramRepository program{wm::pgTestPool()};
  inserted(program, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  for (int number = 0; number <= kThreadList; ++number) {
    const std::string id = "thr_pg" + std::string(6 - std::to_string(number).size(), '0') +
                           std::to_string(number);
    openedAt(repo, id, "question " + id, kNow + static_cast<std::uint64_t>(number));
  }
  program.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)},
                                 ProposalDoor::ask, kUser, ThreadId{"thr_pg000000"}));

  const std::vector<AskThread> every = repo.allThreads(wm::UserId{kUser});

  CHECK_EQ(repo.threads(wm::UserId{kUser}).size(), static_cast<std::size_t>(kThreadList));
  CHECK_EQ(every.size(), static_cast<std::size_t>(kThreadList) + 1);
  // Oldest first — and the oldest is exactly the one the newest-first list read drops.
  CHECK_EQ(every[0].id, ThreadId{"thr_pg000000"});
  REQUIRE_EQ(every[0].minted.size(), 1u);
  CHECK_EQ(every[0].minted[0].routineName, std::string("Push A"));
  CHECK(outcomeOf(every[0]).kind == ThreadOutcomeKind::proposed);
}
