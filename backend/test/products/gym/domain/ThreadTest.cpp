#include "products/gym/domain/Thread.h"

#include "test/testing.h"

#include <string>
#include <vector>

using namespace wm::gym;

namespace {

ThreadProposal minted(const char* id, ProposalState state, int changes,
                      const char* routine = "rt_00000001", const char* name = "Push A",
                      std::uint64_t at = 1'700'000'000'000ull) {
  return ThreadProposal{ProposalId{id}, state, changes, RoutineId{routine}, name, at};
}

AskThread thread(std::vector<ThreadProposal> minted) {
  return AskThread{ThreadId{"thr_00000001"},
                   wm::UserId{"u1"},
                   "Bench has been stuck at 82.5 for three weeks. What do you see?",
                   1'700'000'000'000ull,
                   1'700'000'100'000ull,
                   {},
                   std::move(minted)};
}

}  // namespace

TEST(a_thread_carries_the_first_message_exactly_as_it_was_sent) {
  const std::string typed = "  Bench “stuck” at 82.5 — 3 weeks 💀, what now?\nAnd my squat?  ";
  AskThread held = thread({});
  held.title = typed;
  CHECK_EQ(held.title, typed);
}

TEST(a_thread_that_proposed_nothing_is_read_only) {
  const ThreadOutcome outcome = outcomeOf(thread({}));
  CHECK(outcome.kind == ThreadOutcomeKind::readOnly);
  CHECK_EQ(outcome.changes, 0);
  CHECK_FALSE(outcome.routine.has_value());
  CHECK_EQ(toString(outcome.kind), std::string("read-only"));
}

TEST(an_applied_thread_counts_what_landed_and_names_the_routine_it_landed_on) {
  const ThreadOutcome outcome =
      outcomeOf(thread({minted("prop_0001", ProposalState::applied, 3),
                        minted("prop_0002", ProposalState::applied, 1)}));
  CHECK(outcome.kind == ThreadOutcomeKind::applied);
  CHECK_EQ(outcome.changes, 4);
  CHECK(outcome.routine == RoutineId{"rt_00000001"});
  CHECK_EQ(outcome.routineName, std::string("Push A"));
}

TEST(a_dismissed_thread_counts_what_was_dismissed_and_says_nothing_about_why) {
  const ThreadOutcome outcome =
      outcomeOf(thread({minted("prop_0001", ProposalState::dismissed, 4)}));
  CHECK(outcome.kind == ThreadOutcomeKind::dismissed);
  CHECK_EQ(outcome.changes, 4);
  CHECK(outcome.routine == RoutineId{"rt_00000001"});
  CHECK_EQ(outcome.routineName, std::string("Push A"));
}

TEST(a_thread_whose_proposal_is_still_waiting_is_neither_read_only_nor_settled) {
  const ThreadOutcome outcome =
      outcomeOf(thread({minted("prop_0001", ProposalState::pending, 2)}));
  CHECK(outcome.kind == ThreadOutcomeKind::proposed);
  CHECK_EQ(outcome.changes, 2);
}

TEST(a_thread_the_routine_outran_is_superseded_rather_than_dismissed) {
  const ThreadOutcome outcome =
      outcomeOf(thread({minted("prop_0001", ProposalState::superseded, 5)}));
  CHECK(outcome.kind == ThreadOutcomeKind::superseded);
  CHECK_EQ(outcome.changes, 5);
}

TEST(the_ladder_prefers_what_landed_then_what_waits_then_what_was_turned_down) {
  CHECK(outcomeOf(thread({minted("prop_0001", ProposalState::superseded, 9),
                          minted("prop_0002", ProposalState::dismissed, 9),
                          minted("prop_0003", ProposalState::pending, 9),
                          minted("prop_0004", ProposalState::applied, 2)}))
            .kind == ThreadOutcomeKind::applied);
  CHECK(outcomeOf(thread({minted("prop_0001", ProposalState::superseded, 9),
                          minted("prop_0002", ProposalState::dismissed, 9),
                          minted("prop_0003", ProposalState::pending, 2)}))
            .kind == ThreadOutcomeKind::proposed);
  CHECK(outcomeOf(thread({minted("prop_0001", ProposalState::superseded, 9),
                          minted("prop_0002", ProposalState::dismissed, 2)}))
            .kind == ThreadOutcomeKind::dismissed);
}

TEST(the_count_is_over_the_state_that_named_the_outcome_and_no_other) {
  const ThreadOutcome outcome =
      outcomeOf(thread({minted("prop_0001", ProposalState::applied, 3),
                        minted("prop_0002", ProposalState::dismissed, 2),
                        minted("prop_0003", ProposalState::superseded, 7)}));
  CHECK(outcome.kind == ThreadOutcomeKind::applied);
  CHECK_EQ(outcome.changes, 3);
}

TEST(changes_across_two_routines_keep_the_count_and_drop_the_name) {
  const ThreadOutcome outcome =
      outcomeOf(thread({minted("prop_0001", ProposalState::applied, 4),
                        minted("prop_0002", ProposalState::applied, 2, "rt_00000002", "Legs")}));
  CHECK(outcome.kind == ThreadOutcomeKind::applied);
  CHECK_EQ(outcome.changes, 6);
  CHECK_FALSE(outcome.routine.has_value());
  CHECK_EQ(outcome.routineName, std::string(""));
}

TEST(a_third_proposal_after_the_routine_changed_is_still_counted) {
  const ThreadOutcome outcome =
      outcomeOf(thread({minted("prop_0001", ProposalState::applied, 4),
                        minted("prop_0002", ProposalState::applied, 2, "rt_00000002", "Legs"),
                        minted("prop_0003", ProposalState::applied, 5)}));
  CHECK(outcome.kind == ThreadOutcomeKind::applied);
  CHECK_EQ(outcome.changes, 11);
  CHECK_FALSE(outcome.routine.has_value());
  CHECK_EQ(outcome.routineName, std::string(""));
}

TEST(a_dismissed_row_counts_every_proposal_that_was_dismissed) {
  const ThreadOutcome outcome =
      outcomeOf(thread({minted("prop_0001", ProposalState::dismissed, 4),
                        minted("prop_0002", ProposalState::dismissed, 2, "rt_00000002", "Legs"),
                        minted("prop_0003", ProposalState::dismissed, 5)}));
  CHECK(outcome.kind == ThreadOutcomeKind::dismissed);
  CHECK_EQ(outcome.changes, 11);
  CHECK_FALSE(outcome.routine.has_value());
}

TEST(three_proposals_on_one_routine_keep_both_the_count_and_the_name) {
  const ThreadOutcome outcome =
      outcomeOf(thread({minted("prop_0001", ProposalState::applied, 4),
                        minted("prop_0002", ProposalState::applied, 2),
                        minted("prop_0003", ProposalState::applied, 5)}));
  CHECK_EQ(outcome.changes, 11);
  CHECK(outcome.routine.has_value());
  CHECK_EQ(outcome.routine->str(), std::string("rt_00000001"));
  CHECK_EQ(outcome.routineName, std::string("Push A"));
}

TEST(every_outcome_has_one_stored_word_and_they_do_not_collide) {
  CHECK_EQ(toString(ThreadOutcomeKind::readOnly), std::string("read-only"));
  CHECK_EQ(toString(ThreadOutcomeKind::proposed), std::string("proposed"));
  CHECK_EQ(toString(ThreadOutcomeKind::applied), std::string("applied"));
  CHECK_EQ(toString(ThreadOutcomeKind::dismissed), std::string("dismissed"));
  CHECK_EQ(toString(ThreadOutcomeKind::superseded), std::string("superseded"));
}
