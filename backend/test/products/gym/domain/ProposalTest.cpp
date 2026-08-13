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

// ---- The rule: record or intent -----------------------------------------------------------

// The whole predicate, all four quadrants, because a rule stated as a function is only a rule while
// every case it decides is pinned. The log is what already happened, so a write to it is a record
// however it arrives — and that is true even for the correction, which has no tool at any level for
// a different reason entirely.
TEST(classify_calls_the_log_a_record_whatever_it_touches) {
  CHECK_EQ(classify(Subject::log, Standing::fresh), Mutation::record);
  CHECK_EQ(classify(Subject::log, Standing::existing), Mutation::record);
}

// Bringing a new day of the program — or a new movement — into being takes nothing away, and the
// lifter reads it, edits it or deletes it the moment it appears.
TEST(classify_calls_bringing_something_into_being_a_record) {
  CHECK_EQ(classify(Subject::program, Standing::fresh), Mutation::record);
  CHECK_EQ(classify(Subject::catalog, Standing::fresh), Mutation::record);
}

// The one quadrant the whole ledger exists for: changing or removing something that already stands
// outside the log speaks to a tired future person in a room where the conversation that caused it
// is gone.
TEST(classify_calls_changing_what_already_stands_an_intent) {
  CHECK_EQ(classify(Subject::program, Standing::existing), Mutation::intent);
  CHECK_EQ(classify(Subject::catalog, Standing::existing), Mutation::intent);
}

// ---- The diff ------------------------------------------------------------------------------

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
  // The removals come last, which is what makes the rows readable as the document they describe.
  CHECK_EQ(changes[3].kind, ChangeKind::removed);
  CHECK_EQ(changes[3].exercise, ExerciseId{"cable-fly"});
  CHECK_EQ(changes[3].position, 4);
  CHECK_EQ(changes[3].after, std::optional<EntryTargets>());
}

// A line the proposal leaves alone is stored, because the rows are the DOCUMENT as well as the
// diff — and it is not a change, which is what `Apply all N` has to count.
TEST(changes_between_keeps_an_untouched_line_and_does_not_count_it) {
  const std::vector<RoutineEntry> base{line(1, "bench-press"), line(2, "cable-fly", 3, 12, 22.5)};
  const std::vector<RoutineEntry> proposed{line(1, "bench-press"),
                                           line(2, "cable-fly", 3, 12, 25.0)};
  const std::vector<RoutineChange> changes = changesBetween(base, proposed);

  CHECK_EQ(changes.size(), std::size_t(2));
  CHECK_EQ(changes[0].kind, ChangeKind::kept);
  CHECK_EQ(changes[1].kind, ChangeKind::retargeted);
  CHECK_EQ(countedChanges(base, changes, "Push A", "Push A"), 1);
  // A rename is one more thing the lifter is agreeing to, so it counts.
  CHECK_EQ(countedChanges(base, changes, "Push A", "Push A — heavy"), 2);
}

// Bench heavy then bench back-off is two lines naming one movement, which is the whole reason a
// routine's key is its position. Matching first-unmatched-first is what keeps them two.
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

// A removal proposal is the whole plan as removed rows, so the diff screen draws exactly what goes.
TEST(changes_between_an_empty_document_removes_every_line) {
  const std::vector<RoutineEntry> base{line(1, "bench-press"), line(2, "cable-fly", 3, 12, 22.5)};
  const std::vector<RoutineChange> changes = changesBetween(base, {});

  CHECK_EQ(changes.size(), std::size_t(2));
  CHECK_EQ(changes[0].kind, ChangeKind::removed);
  CHECK_EQ(changes[1].kind, ChangeKind::removed);
  CHECK_EQ(countedChanges(base, changes, "Push A", "Push A"), 2);
}

// THE REORDER, which the rows express by their order and in no other way. Every line is `kept` —
// nothing about their numbers moved — and the proposal is still a real change to the program,
// because a day is trained top to bottom. Counting it zero is what made "move squats to the front"
// come back as *that document is what the routine already says*, a refusal that was simply untrue.
TEST(counted_changes_counts_a_run_the_proposal_reorders) {
  const std::vector<RoutineEntry> base{line(1, "bench-press"), line(2, "overhead-press", 3, 8, 45)};
  const std::vector<RoutineEntry> swapped{line(1, "overhead-press", 3, 8, 45),
                                          line(2, "bench-press")};
  const std::vector<RoutineChange> changes = changesBetween(base, swapped);

  CHECK_EQ(changes.size(), std::size_t(2));
  CHECK_EQ(changes[0].kind, ChangeKind::kept);
  CHECK_EQ(changes[1].kind, ChangeKind::kept);
  CHECK_EQ(countedChanges(base, changes, "Push A", "Push A"), 1);
  // And the document an Apply writes is the new order, which is what makes the count honest.
  const std::vector<RoutineEntry> document =
      documentOf(RoutineProposal{head(ProposalIntent::revise, 1), 1, "Push A", "Push A", changes});
  CHECK_EQ(document[0].exercise, ExerciseId{"overhead-press"});
  CHECK_EQ(document[1].exercise, ExerciseId{"bench-press"});
}

// The other half of that rule, and the case that would make it noise if it were wrong: a line taken
// out of the MIDDLE is not a reorder. What follows it closes up, the survivors are still in the
// order the base holds them, and `Apply all 1` names the one thing the lifter is agreeing to.
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

// ---- The replay, and the id that is spent on something else ---------------------------------

// The rule the store leans on to tell a lost reply from a second idea. Everything the caller sent is
// compared; nothing the store decided is. Without it a resent id answers a NEW document with the
// OLD proposal and a receipt reading "this proposal is waiting in the lifter's app" — the agent has
// just told its human it proposed a deload, and what waits is somebody else's idea.
TEST(is_replay_of_matches_the_document_and_ignores_what_the_store_decided) {
  const std::vector<RoutineEntry> base{line(1, "bench-press")};
  const RoutineProposal minted{head(), 1, "Push A", "Push A",
                               changesBetween(base, {line(1, "bench-press", 5, 3, 87.5)})};

  CHECK(isReplayOf(minted, minted));
  // What the STORE decided since: the lifter settled it, and the read counted logged sets onto it.
  RoutineProposal moved = minted;
  moved.head.state = ProposalState::dismissed;
  moved.head.settledAtMs = 1'700'000'060'000ull;
  moved.changes[0].loggedSets = 41;
  CHECK(isReplayOf(moved, minted));
  // What the CALLER sent: a different document, a different summary, a different base.
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

// ---- The document, and what applying makes true ---------------------------------------------

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

// Everything the base decides stays the base's — the id, the owner, where the day sits in the week
// — so a diff about bench press cannot reshuffle the routines screen. The revision moves, because
// applying is a write like the lifter's own.
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

// ---- What a proposal refuses to be ----------------------------------------------------------

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

// The rows are the document as well as the diff, and that reading is only safe while the removals
// come last. The entity is what guarantees it rather than every reader checking.
TEST(proposal_refuses_a_removed_line_in_the_middle_of_the_run) {
  std::vector<RoutineChange> scrambled{
      RoutineChange{1, ChangeKind::removed, ExerciseId{"cable-fly"},
                    EntryTargets{3, 12, 22.5, 180}, std::nullopt, 0},
      RoutineChange{2, ChangeKind::kept, ExerciseId{"bench-press"}, EntryTargets{5, 5, 82.5, 180},
                    EntryTargets{5, 5, 82.5, 180}, 0}};
  CHECK(rejects([&] { RoutineProposal{head(), 1, "Push A", "Push A", scrambled}; }));
}

// ---- The stored words ------------------------------------------------------------------------

// Clamped on read so a word written by a newer deploy cannot crash an older reader, and clamped
// toward the SAFE reading: an unknown state is settled rather than pending, so nothing a reader
// cannot name is ever offered to a lifter as a live tap.
TEST(stored_words_round_trip_and_clamp_toward_the_safe_reading) {
  CHECK_EQ(proposalIntentFromStored(toString(ProposalIntent::remove)), ProposalIntent::remove);
  CHECK_EQ(proposalStateFromStored(toString(ProposalState::applied)), ProposalState::applied);
  CHECK_EQ(proposalStateFromStored(toString(ProposalState::pending)), ProposalState::pending);
  CHECK_EQ(proposalDoorFromStored(toString(ProposalDoor::ask)), ProposalDoor::ask);
  CHECK_EQ(proposalStateFromStored("something-2027"), ProposalState::superseded);
  CHECK_EQ(proposalIntentFromStored("something-2027"), ProposalIntent::revise);
}
