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

// A candidate that passes every gate. Each test below spoils exactly one of those facts.
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
  REQUIRE_EQ(decision.content.steps.size(), std::size_t{1});
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
  // A clock that stepped backwards, or a rehearsal asOf in the past: unsigned lateness must not wrap into an eternity.
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
  // Simultaneously too late, just-active, brand new and empty: the ledger records the first reason.
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
  REQUIRE_EQ(decision.content.steps.size(), std::size_t{kMaxSteps});
  CHECK_EQ(decision.content.steps[0].id, NodeId{"one"});
  CHECK_EQ(decision.content.steps[1].id, NodeId{"two"});
  CHECK_EQ(decision.content.steps[2].id, NodeId{"three"});
  CHECK_EQ(decision.content.steps[0].color, NodeColor::olive);
  CHECK_EQ(decision.content.steps[2].color, NodeColor::brick);
}

TEST(a_withheld_week_still_records_how_much_was_waiting) {
  // How many people who DID have steps ready were held back, and why — countable only if taken before the gates.
  ReminderCandidate candidate = sendable();
  candidate.trees = {tree("t_a", "Learn to sail", kNow - 20 * kDay,
                          {step("one"), step("two"), step("three"), step("four")})};
  candidate.lastActiveAtMs = kNow - 1000;

  const ReminderDecision decision = decide(candidate, kNow);

  CHECK_EQ(decision.outcome, ReminderOutcome::skip);
  CHECK_EQ(decision.reason, SkipReason::recentlyActive);
  CHECK_EQ(decision.content.readyCount, 4);
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
  // It counts TREES.
  CHECK_EQ(otherTreesPhrase(0), std::string(""));
  CHECK_EQ(otherTreesPhrase(1), std::string("1 other tree has steps ready"));
  CHECK_EQ(otherTreesPhrase(3), std::string("3 other trees have steps ready"));
}

// Readiness reads the completed set the board reads: a node that opens a tree follows that tree.
TEST(a_step_behind_a_node_that_opens_a_complete_tree_is_ready) {
  const auto node = [](const char* id, NodeColor color, const char* opens, std::vector<NodeId> prerequisites) {
    NodeSpec spec;
    spec.id = NodeId{std::string(id)};
    spec.label = std::string("Label ") + id;
    spec.color = color;
    spec.opens = TreeId{std::string(opens)};
    spec.prerequisites = std::move(prerequisites);
    return spec;
  };
  const auto summary = [](const std::vector<TreeReadiness>& readiness) {
    std::vector<std::string> lines;
    for (const TreeReadiness& tree : readiness) {
      std::string line = tree.id.str() + " \"" + tree.title + "\" active " + std::to_string(tree.lastActivityAtMs) + " " +
                         std::to_string(tree.done) + "/" + std::to_string(tree.total) + " ready";
      for (const ReadyStep& ready : tree.ready)
        line += " " + ready.id.str() + ":" + ready.label + ":" + std::string(toString(ready.color));
      lines.push_back(line);
    }
    return lines;
  };
  LoadedTree main;
  main.data.id = TreeId{"t_main"};
  main.data.title = "Ideas";
  main.data.nodes = {node("idea", NodeColor::gold, "t_sub", {}), node("after", NodeColor::olive, "", {NodeId{"idea"}}),
                     node("later", NodeColor::sky, "", {NodeId{"after"}})};
  main.updatedAt = 100;
  main.lastMarkedAt = 50;
  LoadedTree sub;
  sub.data.id = TreeId{"t_sub"};
  sub.data.title = "Worked";
  sub.data.nodes = {node("s", NodeColor::plum, "", {})};
  sub.updatedAt = 10;
  sub.lastMarkedAt = 200;

  main.progress.completed = {NodeId{"idea"}};
  CHECK_EQ(summary(readinessOf({main, sub})),
           (std::vector<std::string>{"t_main \"Ideas\" active 100 0/3 ready idea:Label idea:gold",
                                     "t_sub \"Worked\" active 200 0/1 ready s:Label s:plum"}));

  main.progress.completed = {};
  sub.progress.completed = {NodeId{"s"}};
  CHECK_EQ(summary(readinessOf({main, sub})),
           (std::vector<std::string>{"t_main \"Ideas\" active 100 1/3 ready after:Label after:olive",
                                     "t_sub \"Worked\" active 200 1/1 ready"}));
}

TEST(a_tree_that_cannot_be_validated_has_nothing_ready_and_keeps_its_counts) {
  LoadedTree dangling;
  dangling.data.id = TreeId{"t_dangling"};
  dangling.data.title = "Dangling";
  NodeSpec root;
  root.id = NodeId{"root"};
  root.label = "Root";
  NodeSpec orphan;
  orphan.id = NodeId{"orphan"};
  orphan.label = "Orphan";
  orphan.prerequisites = {NodeId{"nowhere"}};
  dangling.data.nodes = {root, orphan};
  dangling.progress.completed = {NodeId{"root"}};
  dangling.updatedAt = 7;

  const std::vector<TreeReadiness> readiness = readinessOf({dangling});

  REQUIRE_EQ(readiness.size(), 1u);
  CHECK_EQ(readiness[0].id, TreeId{"t_dangling"});
  CHECK_EQ(readiness[0].title, std::string("Dangling"));
  CHECK_EQ(readiness[0].lastActivityAtMs, 7u);
  CHECK_EQ(readiness[0].total, 2);
  CHECK_EQ(readiness[0].done, 1);
  CHECK(readiness[0].ready.empty());
}
