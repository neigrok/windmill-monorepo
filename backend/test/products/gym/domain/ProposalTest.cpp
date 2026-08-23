#include "products/gym/domain/Proposal.h"

#include "test/testing.h"

#include <functional>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using namespace wm::gym;

namespace {
RoutineEntry line(int position, const char* movement, int sets = 5, std::optional<int> reps = 5,
                  std::optional<double> weightKg = 82.5,
                  std::optional<int> restSeconds = 180) {
  return RoutineEntry{position, ExerciseId{movement}, sets, reps, weightKg, restSeconds};
}

Routine pushA(std::vector<RoutineEntry> entries, int revision = 1) {
  return Routine{RoutineId{"rt_00000001"}, wm::UserId{"u1"}, "Push A",
                 0,                        std::move(entries), std::nullopt,
                 revision};
}

ProposalHead head(ProposalIntent intent = ProposalIntent::revise, int changes = 1) {
  return ProposalHead{ProposalId{"prop_0001"},
                      RoutineId{"rt_00000001"},
                      wm::UserId{"u1"},
                      intent,
                      ProposalState::pending,
                      ProposalSource{ProposalDoor::mcp, "", ""},
                      "Heavier triples.",
                      changes,
                      1'700'000'000'000ull,
                      std::nullopt};
}

bool rejects(const std::function<void()>& build) {
  try {
    build();
    return false;
  } catch (const InvalidTraining&) {
    return true;
  }
}
}

TEST(classify_calls_the_log_a_record_whatever_it_touches) {
  CHECK_EQ(classify(Subject::log, Standing::fresh), Mutation::record);
  CHECK_EQ(classify(Subject::log, Standing::existing), Mutation::record);
}

TEST(classify_calls_bringing_something_into_being_a_record) {
  CHECK_EQ(classify(Subject::program, Standing::fresh), Mutation::record);
  CHECK_EQ(classify(Subject::catalog, Standing::fresh), Mutation::record);
}

TEST(classify_calls_changing_what_already_stands_an_intent) {
  CHECK_EQ(classify(Subject::program, Standing::existing), Mutation::intent);
  CHECK_EQ(classify(Subject::catalog, Standing::existing), Mutation::intent);
}

TEST(changes_between_names_every_kind_and_puts_removals_last) {
  const std::vector<RoutineEntry> base{line(1, "bench-press"), line(2, "overhead-press", 3, 8, 45),
                                       line(3, "cable-fly", 3, 12, 22.5)};
  const std::vector<RoutineEntry> proposed{line(1, "bench-press", 5, 3, 87.5),
                                           line(2, "overhead-press", 3, 8, 47.5),
                                           line(3, "incline-db-press", 3, 10, 24)};
  const std::vector<RoutineChange> changes = changesBetween(base, proposed);

  CHECK_EQ(changes.size(), std::size_t(4));
  CHECK_EQ(changes[0].kind, ChangeKind::retargeted);
  CHECK_EQ(changes[0].exercise, ExerciseId{"bench-press"});
  CHECK_EQ(changes[0].before, std::optional<EntryTargets>(EntryTargets{5, 5, 82.5, 180}));
  CHECK_EQ(changes[0].after, std::optional<EntryTargets>(EntryTargets{5, 3, 87.5, 180}));
  CHECK_EQ(changes[1].kind, ChangeKind::retargeted);
  CHECK_EQ(changes[2].kind, ChangeKind::added);
  CHECK_EQ(changes[2].exercise, ExerciseId{"incline-db-press"});
  CHECK_EQ(changes[2].before, std::optional<EntryTargets>());
  CHECK_EQ(changes[2].after, std::optional<EntryTargets>(EntryTargets{3, 10, 24, 180}));
  CHECK_EQ(changes[3].kind, ChangeKind::removed);
  CHECK_EQ(changes[3].exercise, ExerciseId{"cable-fly"});
  CHECK_EQ(changes[3].position, 4);
  CHECK_EQ(changes[3].after, std::optional<EntryTargets>());
}

TEST(changes_between_keeps_an_untouched_line_and_does_not_count_it) {
  const std::vector<RoutineEntry> base{line(1, "bench-press"), line(2, "cable-fly", 3, 12, 22.5)};
  const std::vector<RoutineEntry> proposed{line(1, "bench-press"),
                                           line(2, "cable-fly", 3, 12, 25.0)};
  const std::vector<RoutineChange> changes = changesBetween(base, proposed);

  CHECK_EQ(changes.size(), std::size_t(2));
  CHECK_EQ(changes[0].kind, ChangeKind::kept);
  CHECK_EQ(changes[1].kind, ChangeKind::retargeted);
  CHECK_EQ(countedChanges(base, changes, "Push A", "Push A"), 1);
  // A rename counts as a change.
  CHECK_EQ(countedChanges(base, changes, "Push A", "Push A — heavy"), 2);
}

TEST(changes_between_matches_a_repeated_movement_line_by_line) {
  const std::vector<RoutineEntry> base{line(1, "bench-press", 5, 5, 100),
                                       line(2, "bench-press", 3, 8, 80)};
  const std::vector<RoutineEntry> proposed{line(1, "bench-press", 5, 5, 100),
                                           line(2, "bench-press", 3, 8, 85)};
  const std::vector<RoutineChange> changes = changesBetween(base, proposed);

  CHECK_EQ(changes.size(), std::size_t(2));
  CHECK_EQ(changes[0].kind, ChangeKind::kept);
  CHECK_EQ(changes[1].kind, ChangeKind::retargeted);
  CHECK_EQ(changes[1].before, std::optional<EntryTargets>(EntryTargets{3, 8, 80, 180}));
}

TEST(changes_between_an_empty_document_removes_every_line) {
  const std::vector<RoutineEntry> base{line(1, "bench-press"), line(2, "cable-fly", 3, 12, 22.5)};
  const std::vector<RoutineChange> changes = changesBetween(base, {});

  CHECK_EQ(changes.size(), std::size_t(2));
  CHECK_EQ(changes[0].kind, ChangeKind::removed);
  CHECK_EQ(changes[1].kind, ChangeKind::removed);
  CHECK_EQ(countedChanges(base, changes, "Push A", "Push A"), 2);
}

TEST(counted_changes_counts_a_run_the_proposal_reorders) {
  const std::vector<RoutineEntry> base{line(1, "bench-press"), line(2, "overhead-press", 3, 8, 45)};
  const std::vector<RoutineEntry> swapped{line(1, "overhead-press", 3, 8, 45),
                                          line(2, "bench-press")};
  const std::vector<RoutineChange> changes = changesBetween(base, swapped);

  CHECK_EQ(changes.size(), std::size_t(2));
  CHECK_EQ(changes[0].kind, ChangeKind::kept);
  CHECK_EQ(changes[1].kind, ChangeKind::kept);
  CHECK_EQ(countedChanges(base, changes, "Push A", "Push A"), 1);
  const std::vector<RoutineEntry> document =
      documentOf(RoutineProposal{head(ProposalIntent::revise, 1), 1, "Push A", "Push A", changes});
  CHECK_EQ(document[0].exercise, ExerciseId{"overhead-press"});
  CHECK_EQ(document[1].exercise, ExerciseId{"bench-press"});
}

TEST(counted_changes_does_not_read_a_removal_or_an_insertion_as_a_reorder) {
  const std::vector<RoutineEntry> base{line(1, "bench-press"), line(2, "overhead-press", 3, 8, 45),
                                       line(3, "cable-fly", 3, 12, 22.5)};
  const std::vector<RoutineEntry> shorter{line(1, "bench-press"), line(2, "cable-fly", 3, 12, 22.5)};
  const std::vector<RoutineEntry> longer{line(1, "bench-press"),
                                         line(2, "incline-db-press", 3, 10, 24),
                                         line(3, "overhead-press", 3, 8, 45),
                                         line(4, "cable-fly", 3, 12, 22.5)};

  CHECK_EQ(countedChanges(base, changesBetween(base, shorter), "Push A", "Push A"), 1);
  CHECK_EQ(countedChanges(base, changesBetween(base, longer), "Push A", "Push A"), 1);
}

TEST(is_replay_of_matches_the_document_and_ignores_what_the_store_decided) {
  const std::vector<RoutineEntry> base{line(1, "bench-press")};
  const RoutineProposal minted{head(), 1, "Push A", "Push A",
                               changesBetween(base, {line(1, "bench-press", 5, 3, 87.5)})};

  CHECK(isReplayOf(minted, minted));
  // What the STORE decided since.
  RoutineProposal moved = minted;
  moved.head.state = ProposalState::dismissed;
  moved.head.settledAtMs = 1'700'000'060'000ull;
  moved.changes[0].loggedSets = 41;
  CHECK(isReplayOf(moved, minted));
  // What the CALLER sent: a different document, summary and base.
  CHECK_FALSE(isReplayOf(minted, RoutineProposal{head(), 1, "Push A", "Push A",
                                                 changesBetween(base, {line(1, "bench-press", 5, 3,
                                                                            90.0)})}));
  RoutineProposal retold = minted;
  retold.head.summary = "Deload week.";
  CHECK_FALSE(isReplayOf(minted, retold));
  CHECK_FALSE(isReplayOf(minted, RoutineProposal{head(), 2, "Push A", "Push A", minted.changes}));
  CHECK_FALSE(
      isReplayOf(minted, RoutineProposal{head(), 1, "Push A", "Push A — heavy", minted.changes}));
}

TEST(document_of_reads_the_rows_up_to_the_first_removal_and_renumbers_them) {
  const std::vector<RoutineEntry> base{line(1, "bench-press"), line(2, "cable-fly", 3, 12, 22.5)};
  const std::vector<RoutineEntry> proposed{line(1, "bench-press", 5, 3, 87.5),
                                           line(2, "incline-db-press", 3, 10, 24)};
  const RoutineProposal proposal{head(ProposalIntent::revise, 3), 1, "Push A", "Push A",
                                 changesBetween(base, proposed)};

  const std::vector<RoutineEntry> document = documentOf(proposal);
  CHECK_EQ(document.size(), std::size_t(2));
  CHECK_EQ(document[0].position, 1);
  CHECK_EQ(document[0].exercise, ExerciseId{"bench-press"});
  CHECK_EQ(document[0].targetWeightKg, std::optional<double>(87.5));
  CHECK_EQ(document[1].position, 2);
  CHECK_EQ(document[1].exercise, ExerciseId{"incline-db-press"});
}

TEST(applied_to_moves_the_document_the_name_and_the_revision_and_nothing_else) {
  const Routine base = pushA({line(1, "bench-press"), line(2, "cable-fly", 3, 12, 22.5)}, 4);
  const RoutineProposal proposal{
      head(ProposalIntent::revise, 2), 4, "Push A", "Push A — heavy",
      changesBetween(base.entries, {line(1, "bench-press", 5, 3, 87.5)})};

  const Routine applied = appliedTo(base, proposal);
  CHECK_EQ(applied.id, base.id);
  CHECK_EQ(applied.user, base.user);
  CHECK_EQ(applied.position, base.position);
  CHECK_EQ(applied.name, std::string("Push A — heavy"));
  CHECK_EQ(applied.revision, 5);
  CHECK_EQ(applied.entries.size(), std::size_t(1));
  CHECK_EQ(applied.entries[0].targetWeightKg, std::optional<double>(87.5));
}

TEST(proposal_refuses_what_it_could_never_be_applied_as) {
  const std::vector<RoutineEntry> base{line(1, "bench-press")};
  const std::vector<RoutineChange> ok = changesBetween(base, {line(1, "bench-press", 5, 3, 87.5)});

  CHECK(rejects([&] { RoutineProposal{head(), 1, "Push A", "Push A", {}}; }));
  CHECK(rejects([&] {
    ProposalHead bad = head();
    bad.id = ProposalId{"no"};   // under the eight bytes the id shape asks for
    RoutineProposal{bad, 1, "Push A", "Push A", ok};
  }));
  CHECK(rejects([&] { RoutineProposal{head(), 0, "Push A", "Push A", ok}; }));
  CHECK(rejects([&] { RoutineProposal{head(), 1, "Push A", "   ", ok}; }));
  CHECK(rejects(
      [&] { RoutineProposal{head(), 1, "Push A", std::string(kMaxNameLength + 1, 'x'), ok}; }));
  // A revision that leaves no line is not a revision; a removal that leaves one is not a removal.
  CHECK(rejects([&] {
    RoutineProposal{head(), 1, "Push A", "Push A", changesBetween(base, {})};
  }));
  CHECK(rejects([&] {
    RoutineProposal{head(ProposalIntent::remove), 1, "Push A", "Push A", ok};
  }));
}

TEST(proposal_refuses_a_removed_line_in_the_middle_of_the_run) {
  std::vector<RoutineChange> scrambled{
      RoutineChange{1, ChangeKind::removed, ExerciseId{"cable-fly"},
                    EntryTargets{3, 12, 22.5, 180}, std::nullopt, 0},
      RoutineChange{2, ChangeKind::kept, ExerciseId{"bench-press"}, EntryTargets{5, 5, 82.5, 180},
                    EntryTargets{5, 5, 82.5, 180}, 0}};
  CHECK(rejects([&] { RoutineProposal{head(), 1, "Push A", "Push A", scrambled}; }));
}

TEST(stored_words_round_trip_and_clamp_toward_the_safe_reading) {
  CHECK_EQ(proposalIntentFromStored(toString(ProposalIntent::remove)), ProposalIntent::remove);
  CHECK_EQ(proposalStateFromStored(toString(ProposalState::applied)), ProposalState::applied);
  CHECK_EQ(proposalStateFromStored(toString(ProposalState::pending)), ProposalState::pending);
  CHECK_EQ(proposalDoorFromStored(toString(ProposalDoor::ask)), ProposalDoor::ask);
  CHECK_EQ(proposalStateFromStored("something-2027"), ProposalState::superseded);
  CHECK_EQ(proposalIntentFromStored("something-2027"), ProposalIntent::revise);
}
