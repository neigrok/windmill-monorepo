#include "products/roadmap/domain/Reminders.h"
#include "test/testing.h"

#include <cstdint>
#include <string>
#include <vector>

using namespace wm;

namespace {

constexpr std::uint64_t kNow = 1'700'000'000'000;
constexpr std::uint64_t kDay = 24ull * 60 * 60 * 1000;

ReadyStep step(const char* id, NodeColor color = NodeColor::sky) {
  return ReadyStep{NodeId{std::string(id)}, id, color};
}

TreeReadiness tree(const char* id, const char* title, std::uint64_t lastActivityAtMs,
                   std::vector<ReadyStep> ready) {
  TreeReadiness readiness;
  readiness.id = TreeId{std::string(id)};
  readiness.title = title;
  readiness.lastActivityAtMs = lastActivityAtMs;
  readiness.total = 10;
  readiness.done = 4;
  readiness.ready = std::move(ready);
  return readiness;
}

// A candidate that passes every gate: the slot just came round, the person has been away a
// fortnight, the account is months old, and one tree has something waiting. Each test below
// spoils exactly one of those facts.
ReminderCandidate sendable() {
  ReminderCandidate candidate;
  candidate.user = UserId{"u1"};
  candidate.slotDate = "2026-07-28";
  candidate.slotInstantMs = kNow - 60'000;
  candidate.lastActiveAtMs = kNow - 14 * kDay;
  candidate.accountCreatedAtMs = kNow - 90 * kDay;
  candidate.trees = {tree("t_a", "Learn to sail", kNow - 20 * kDay, {step("rigging")})};
  return candidate;
}

}

TEST(a_ready_tree_earns_a_send) {
  const ReminderDecision decision = decide(sendable(), kNow);

  CHECK_EQ(decision.outcome, ReminderOutcome::send);
  CHECK_EQ(decision.reason, SkipReason::none);
  CHECK_EQ(decision.content.treeId, TreeId{"t_a"});
  CHECK_EQ(decision.content.treeTitle, std::string("Learn to sail"));
  CHECK_EQ(decision.content.total, 10);
  CHECK_EQ(decision.content.done, 4);
  CHECK_EQ(decision.content.readyCount, 1);
  CHECK_EQ(decision.content.steps.size(), std::size_t{1});
  CHECK_EQ(decision.content.steps[0].id, NodeId{"rigging"});
  CHECK_EQ(decision.content.otherReadyTrees, 0);
}

TEST(a_slot_the_box_slept_through_is_abandoned) {
  ReminderCandidate candidate = sendable();
  candidate.slotInstantMs = kNow - kMaxLatenessMs - 1;

  const ReminderDecision decision = decide(candidate, kNow);

  CHECK_EQ(decision.outcome, ReminderOutcome::skip);
  CHECK_EQ(decision.reason, SkipReason::tooLate);
  CHECK_EQ(decision.content.steps.size(), std::size_t{0});
}

TEST(a_slot_exactly_at_the_lateness_edge_is_still_served) {
  ReminderCandidate candidate = sendable();
  candidate.slotInstantMs = kNow - kMaxLatenessMs;

  CHECK_EQ(decide(candidate, kNow).outcome, ReminderOutcome::send);
}

TEST(a_slot_that_has_not_arrived_yet_is_never_late) {
  // A clock that stepped backwards, or a rehearsal asOf in the past: unsigned lateness must not
  // wrap into an eternity and abandon everyone.
  ReminderCandidate candidate = sendable();
  candidate.slotInstantMs = kNow + 5 * kDay;

  CHECK_EQ(decide(candidate, kNow).outcome, ReminderOutcome::send);
}

TEST(someone_who_was_just_here_is_left_alone) {
  ReminderCandidate candidate = sendable();
  candidate.lastActiveAtMs = kNow - kActiveWindowMs + 1;

  const ReminderDecision decision = decide(candidate, kNow);

  CHECK_EQ(decision.outcome, ReminderOutcome::skip);
  CHECK_EQ(decision.reason, SkipReason::recentlyActive);
}

TEST(activity_older_than_the_window_does_not_hold_a_reminder_back) {
  ReminderCandidate candidate = sendable();
  candidate.lastActiveAtMs = kNow - kActiveWindowMs;

  CHECK_EQ(decide(candidate, kNow).outcome, ReminderOutcome::send);
}

TEST(a_never_seen_account_is_not_treated_as_recently_active) {
  ReminderCandidate candidate = sendable();
  candidate.lastActiveAtMs = 0;

  CHECK_EQ(decide(candidate, kNow).outcome, ReminderOutcome::send);
}

TEST(a_first_week_account_is_left_to_settle_in) {
  ReminderCandidate candidate = sendable();
  candidate.accountCreatedAtMs = kNow - kGraceMs + 1;

  const ReminderDecision decision = decide(candidate, kNow);

  CHECK_EQ(decision.outcome, ReminderOutcome::skip);
  CHECK_EQ(decision.reason, SkipReason::inGrace);
}

TEST(grace_ends_exactly_a_week_after_the_account_was_born) {
  ReminderCandidate candidate = sendable();
  candidate.accountCreatedAtMs = kNow - kGraceMs;

  CHECK_EQ(decide(candidate, kNow).outcome, ReminderOutcome::send);
}

TEST(an_unknown_birthday_is_not_treated_as_grace) {
  ReminderCandidate candidate = sendable();
  candidate.accountCreatedAtMs = 0;
  candidate.trees = {tree("t_a", "Learn to sail", kNow - 20 * kDay, {})};

  const ReminderDecision decision = decide(candidate, kNow);

  CHECK_EQ(decision.outcome, ReminderOutcome::skip);
  CHECK_EQ(decision.reason, SkipReason::noReadySteps);
}

TEST(a_tree_with_nothing_reachable_is_never_mailed_about) {
  ReminderCandidate candidate = sendable();
  candidate.trees = {tree("t_a", "Learn to sail", kNow - 20 * kDay, {}),
                     tree("t_b", "Ship the thing", kNow - 2 * kDay, {})};

  const ReminderDecision decision = decide(candidate, kNow);

  CHECK_EQ(decision.outcome, ReminderOutcome::skip);
  CHECK_EQ(decision.reason, SkipReason::noReadySteps);
}

TEST(a_user_with_no_trees_at_all_is_skipped_for_emptiness) {
  ReminderCandidate candidate = sendable();
  candidate.trees.clear();

  const ReminderDecision decision = decide(candidate, kNow);

  CHECK_EQ(decision.outcome, ReminderOutcome::skip);
  CHECK_EQ(decision.reason, SkipReason::noReadySteps);
}

TEST(the_gates_fire_in_order_so_lateness_beats_every_other_reason) {
  // Simultaneously too late, just-active, brand new and empty. The ledger must record the reason
  // the sweep actually stopped at, which is the first one.
  ReminderCandidate candidate;
  candidate.user = UserId{"u1"};
  candidate.slotInstantMs = kNow - 3 * kDay;
  candidate.lastActiveAtMs = kNow - 1000;
  candidate.accountCreatedAtMs = kNow - 1000;

  CHECK_EQ(decide(candidate, kNow).reason, SkipReason::tooLate);

  candidate.slotInstantMs = kNow - 60'000;
  CHECK_EQ(decide(candidate, kNow).reason, SkipReason::recentlyActive);

  candidate.lastActiveAtMs = kNow - 30 * kDay;
  CHECK_EQ(decide(candidate, kNow).reason, SkipReason::inGrace);

  candidate.accountCreatedAtMs = kNow - 30 * kDay;
  CHECK_EQ(decide(candidate, kNow).reason, SkipReason::noReadySteps);
}

TEST(the_featured_tree_is_the_most_recently_worked_one_that_has_something_ready) {
  ReminderCandidate candidate = sendable();
  candidate.trees = {
      tree("t_stale", "Stale", kNow - 40 * kDay, {step("a")}),
      tree("t_fresh", "Fresh", kNow - 9 * kDay, {step("b"), step("c")}),
      // Worked most recently of all, but nothing is reachable — it cannot be the feature.
      tree("t_blocked", "Blocked", kNow - 4 * kDay, {}),
  };

  const ReminderDecision decision = decide(candidate, kNow);

  CHECK_EQ(decision.outcome, ReminderOutcome::send);
  CHECK_EQ(decision.content.treeId, TreeId{"t_fresh"});
  CHECK_EQ(decision.content.readyCount, 2);
  CHECK_EQ(decision.content.otherReadyTrees, 1);
}

TEST(a_tie_on_recency_falls_to_the_smaller_id_so_the_choice_never_wobbles) {
  ReminderCandidate candidate = sendable();
  candidate.trees = {tree("t_zzz", "Zed", kNow - 5 * kDay, {step("a")}),
                     tree("t_aaa", "Ay", kNow - 5 * kDay, {step("b")})};

  const ReminderDecision decision = decide(candidate, kNow);

  CHECK_EQ(decision.content.treeId, TreeId{"t_aaa"});
  CHECK_EQ(decision.content.otherReadyTrees, 1);
}

TEST(the_mail_names_at_most_three_steps_and_counts_the_rest) {
  ReminderCandidate candidate = sendable();
  candidate.trees = {tree("t_a", "Learn to sail", kNow - 20 * kDay,
                          {step("one", NodeColor::olive), step("two", NodeColor::gold),
                           step("three", NodeColor::brick), step("four", NodeColor::plum),
                           step("five", NodeColor::sky)})};

  const ReminderDecision decision = decide(candidate, kNow);

  CHECK_EQ(decision.content.readyCount, 5);
  CHECK_EQ(decision.content.steps.size(), std::size_t{kMaxSteps});
  CHECK_EQ(decision.content.steps[0].id, NodeId{"one"});
  CHECK_EQ(decision.content.steps[1].id, NodeId{"two"});
  CHECK_EQ(decision.content.steps[2].id, NodeId{"three"});
  CHECK_EQ(decision.content.steps[0].color, NodeColor::olive);
  CHECK_EQ(decision.content.steps[2].color, NodeColor::brick);
}

TEST(a_withheld_week_still_records_how_much_was_waiting) {
  // The ledger's sharpest question: how many people who DID have steps ready did we hold back,
  // and why. It can only be answered if the count is taken before the gates rather than after.
  ReminderCandidate candidate = sendable();
  candidate.trees = {tree("t_a", "Learn to sail", kNow - 20 * kDay,
                          {step("one"), step("two"), step("three"), step("four")})};
  candidate.lastActiveAtMs = kNow - 1000;

  const ReminderDecision decision = decide(candidate, kNow);

  CHECK_EQ(decision.outcome, ReminderOutcome::skip);
  CHECK_EQ(decision.reason, SkipReason::recentlyActive);
  CHECK_EQ(decision.content.readyCount, 4);
  // And nothing else: a skipped week names no tree, because no tree was ever featured in a mail.
  CHECK_EQ(decision.content.treeId, TreeId{});
  CHECK_EQ(decision.content.steps.size(), std::size_t{0});
  CHECK_EQ(decision.content.otherReadyTrees, 0);
}

TEST(a_week_withheld_for_emptiness_records_a_count_of_nothing) {
  ReminderCandidate candidate = sendable();
  candidate.trees = {tree("t_a", "Learn to sail", kNow - 20 * kDay, {})};

  const ReminderDecision decision = decide(candidate, kNow);

  CHECK_EQ(decision.reason, SkipReason::noReadySteps);
  CHECK_EQ(decision.content.readyCount, 0);
}

TEST(the_ledger_vocabulary_is_the_whole_set_of_reasons) {
  CHECK_EQ(std::string(skipReasonName(SkipReason::none)), std::string("ok"));
  CHECK_EQ(std::string(skipReasonName(SkipReason::tooLate)), std::string("too-late"));
  CHECK_EQ(std::string(skipReasonName(SkipReason::recentlyActive)), std::string("recently-active"));
  CHECK_EQ(std::string(skipReasonName(SkipReason::inGrace)), std::string("in-grace"));
  CHECK_EQ(std::string(skipReasonName(SkipReason::noReadySteps)), std::string("no-ready-steps"));
  CHECK_EQ(std::string(skipReasonName(SkipReason::loadFailed)), std::string("load-failed"));
}

TEST(the_counted_sentences_own_their_plurals) {
  CHECK_EQ(readyPhrase(1), std::string("1 step"));
  CHECK_EQ(readyPhrase(2), std::string("2 steps"));
  CHECK_EQ(readyPhrase(0), std::string("0 steps"));
}

TEST(the_remainder_counts_only_the_steps_the_mail_had_no_room_to_name) {
  CHECK_EQ(remainderPhrase(kMaxSteps), std::string(""));
  CHECK_EQ(remainderPhrase(kMaxSteps - 1), std::string(""));
  CHECK_EQ(remainderPhrase(kMaxSteps + 1), std::string("…and 1 more on this tree"));
  CHECK_EQ(remainderPhrase(kMaxSteps + 4), std::string("…and 4 more on this tree"));
}

TEST(the_other_trees_line_names_its_unit_out_loud) {
  // It counts TREES. The wording it replaced counted trees and read as steps, which is the one
  // way a quiet line at the foot of an email can be actively misleading.
  CHECK_EQ(otherTreesPhrase(0), std::string(""));
  CHECK_EQ(otherTreesPhrase(1), std::string("1 other tree has steps ready"));
  CHECK_EQ(otherTreesPhrase(3), std::string("3 other trees have steps ready"));
}

TEST(arming_defaults_to_nobody) {
  const ReminderArming dark;

  CHECK_FALSE(dark.enabled);
  CHECK_EQ(dark.allowlist.size(), std::size_t{0});
  CHECK_FALSE(dark.allows(UserId{"u1"}));
}

TEST(an_empty_allowlist_arms_nobody_even_when_the_engine_is_enabled) {
  const ReminderArming armed(true, "");

  CHECK(armed.enabled);
  CHECK_EQ(armed.allowlist.size(), std::size_t{0});
  CHECK_FALSE(armed.allows(UserId{"u1"}));
}

TEST(the_allowlist_alone_arms_nobody_while_the_engine_is_dark) {
  const ReminderArming dark(false, "u1,u2");

  CHECK_EQ(dark.allowlist.size(), std::size_t{2});
  CHECK_FALSE(dark.allows(UserId{"u1"}));
}

TEST(the_allowlist_forgives_the_shapes_a_pasted_uuid_arrives_in) {
  const ReminderArming armed(true, " 3F2A-ONE , u2,, u3 ,");

  CHECK_EQ(armed.allowlist.size(), std::size_t{3});
  CHECK(armed.allows(UserId{"3f2a-one"}));
  CHECK(armed.allows(UserId{"3F2A-ONE"}));
  CHECK(armed.allows(UserId{"u2"}));
  CHECK(armed.allows(UserId{"u3"}));
  CHECK_FALSE(armed.allows(UserId{"u4"}));
  CHECK_FALSE(armed.allows(UserId{""}));
}
