#include "test/products/gym/application/GymServiceFixture.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::servicetest;

TEST(create_routine_stores_the_document_and_reads_it_back) {
  Harness h;

  RoutineWriteOutcome created = h.create(h.pushAWrite({benchEntry(1), RoutineEntry{2, ExerciseId{"back-squat"}, 3, 8,
                                                       std::nullopt, std::nullopt}}));

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(*created.routine,
           Routine(rtId(), uid(), "Push A", 0,
                   {benchEntry(1),
                    RoutineEntry{2, ExerciseId{"back-squat"}, 3, 8, std::nullopt, std::nullopt}}));
  CHECK_EQ(created.routine->lastTrainedAtMs, std::optional<std::uint64_t>());
  CHECK_EQ(h.program.routine(uid(), rtId()), created.routine);
  CHECK_EQ(h.program.routine(uid("u2"), rtId()), std::optional<Routine>());
}

TEST(create_routine_replay_returns_the_stored_routine_untouched) {
  Harness h;
  RoutineWriteOutcome first = h.create(h.pushAWrite());

  RoutineWriteOutcome replayed = h.create(h.pushAWrite({benchEntry(1), benchEntry(2)}, "rt_00000001", "Renamed mid-flight"));

  CHECK(replayed.error == RoutineWriteError::none);
  CHECK_EQ(*replayed.routine, *first.routine);
  CHECK_EQ(h.repo.db.routineRows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.routineRows[0].entries.size(), static_cast<std::size_t>(1));
}

TEST(create_routine_with_an_id_another_account_holds_is_id_taken) {
  Harness h;
  h.repo.db.routineRows.push_back(Routine{rtId(), uid("u2"), "Their plan", 0, {benchEntry()}});

  RoutineWriteOutcome created = h.create(h.pushAWrite());

  CHECK(created.error == RoutineWriteError::idTaken);
  CHECK_FALSE(created.routine.has_value());   // never the stranger's plan, not even to say it exists
  CHECK_EQ(h.repo.db.routineRows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.routineRows[0].name, std::string("Their plan"));
  CHECK_EQ(h.program.routine(uid(), rtId()), std::optional<Routine>());
}

// The whole document is one transaction, so a refused line leaves no half-written routine behind.
TEST(create_routine_naming_a_movement_no_catalog_holds_is_unknown_exercise) {
  Harness h;

  RoutineWriteOutcome created = h.create(h.pushAWrite({benchEntry(1), RoutineEntry{2, ExerciseId{"zercher-squat"}, 3, 8,
                                                       std::nullopt, std::nullopt}}));

  CHECK(created.error == RoutineWriteError::unknownExercise);
  CHECK_FALSE(created.routine.has_value());
  CHECK(h.repo.db.routineRows.empty());
  CHECK_EQ(h.program.routines(uid()), std::vector<Routine>{});
}

TEST(a_routine_entry_naming_another_accounts_private_movement_is_unknown_exercise) {
  Harness h;
  h.repo.db.seedCustom(uid("u2"), Exercise{ExerciseId{"ex_22222222"}, "Their Zercher Squat",
                                        Pattern::squat, Equipment::barbell, 2.5, true});
  const RoutineEntry theirs{1, ExerciseId{"ex_22222222"}, 3, 8, 60.0, 120};

  RoutineWriteOutcome created = h.create(h.pushAWrite({theirs}));
  h.create(h.pushAWrite());
  RoutineWriteOutcome replaced = h.program.replaceRoutine(uid(), rtId(), h.pushAWrite({theirs}));

  CHECK(created.error == RoutineWriteError::unknownExercise);
  CHECK_FALSE(created.routine.has_value());
  CHECK(replaced.error == RoutineWriteError::unknownExercise);
  CHECK_FALSE(replaced.routine.has_value());
  REQUIRE_EQ(h.repo.db.routineRows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.routineRows[0].entries, std::vector<RoutineEntry>{benchEntry()});
}

TEST(replace_routine_rewrites_the_whole_document) {
  Harness h;
  h.create(h.pushAWrite());

  RoutineWriteOutcome replaced = h.program.replaceRoutine(
      uid(), rtId(),
      h.pushAWrite({RoutineEntry{1, ExerciseId{"back-squat"}, 4, 6, 100.0, 240}, benchEntry(2)},
                   "rt_00000001", "Push A2"));

  CHECK(replaced.error == RoutineWriteError::none);
  // The revision moves on a write that changes the document (domain/Proposal.h).
  CHECK_EQ(*replaced.routine,
           Routine(rtId(), uid(), "Push A2", 0,
                   {RoutineEntry{1, ExerciseId{"back-squat"}, 4, 6, 100.0, 240}, benchEntry(2)},
                   std::nullopt, 2));
  CHECK_EQ(h.repo.db.routineRows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.program.routine(uid(), rtId()), replaced.routine);
}

TEST(replace_of_a_missing_or_anothers_routine_is_the_same_not_found) {
  Harness h;
  h.repo.db.routineRows.push_back(Routine{rtId("rt_00000002"), uid("u2"), "Their plan", 0,
                                       {benchEntry()}});

  RoutineWriteOutcome missing = h.program.replaceRoutine(uid(), rtId(), h.pushAWrite());
  RoutineWriteOutcome theirs = h.program.replaceRoutine(
      uid(), rtId("rt_00000002"), h.pushAWrite({benchEntry()}, "rt_00000002", "Mine now"));

  CHECK(missing.error == RoutineWriteError::notFound);
  CHECK(theirs.error == RoutineWriteError::notFound);
  CHECK_EQ(h.repo.db.routineRows[0].name, std::string("Their plan"));
  CHECK_EQ(h.repo.db.routineRows[0].user, uid("u2"));
}

TEST(delete_routine_takes_the_pointer_off_every_session_that_ran_it_and_leaves_the_snapshot) {
  Harness h;
  h.create(h.pushAWrite());
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  h.training.finish(uid(), sid("ses_00000001"), h.clock.now + 1);

  CHECK_FALSE(h.program.deleteRoutine(uid("u2"), rtId()));   // another account cannot reach it
  CHECK(h.program.deleteRoutine(uid(), rtId()));
  CHECK_FALSE(h.program.deleteRoutine(uid(), rtId()));       // and it is gone, not gone twice

  std::optional<SessionDetail> detail = h.training.detail(uid(), sid("ses_00000001"));
  REQUIRE(detail.has_value());
  CHECK_EQ(detail->session.routine, std::optional<RoutineId>());
  CHECK_EQ(detail->session.plan,
           std::optional<PlanSnapshot>(PlanSnapshot{
               "Push A", {PlanEntry{ExerciseId{"bench-press"}, 5, 5, 82.5, 180}}}));
  CHECK_EQ(h.program.routines(uid()), std::vector<Routine>{});
}

TEST(routines_list_is_most_recently_trained_first_with_the_untrained_last) {
  Harness h;
  h.create(h.pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  h.create(h.pushAWrite({benchEntry()}, "rt_00000002", "Pull A"));
  h.create(h.pushAWrite({benchEntry()}, "rt_00000003", "Legs"));
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000002");
  h.training.finish(uid(), sid("ses_00000001"), h.clock.now + 1);
  const std::uint64_t later = h.clock.now + 10'000;
  h.startFrom(later, "ses_00000002", "rt_00000001");
  h.training.finish(uid(), sid("ses_00000002"), later + 1);

  std::vector<Routine> listed = h.program.routines(uid());

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(3));
  CHECK_EQ(listed[0].name, std::string("Push A"));
  CHECK_EQ(listed[0].lastTrainedAtMs, std::optional<std::uint64_t>(later));
  CHECK_EQ(listed[1].name, std::string("Pull A"));
  CHECK_EQ(listed[1].lastTrainedAtMs, std::optional<std::uint64_t>(h.clock.now));
  CHECK_EQ(listed[2].name, std::string("Legs"));
  CHECK_EQ(listed[2].lastTrainedAtMs, std::optional<std::uint64_t>());
  CHECK_EQ(h.program.routines(uid("u2")), std::vector<Routine>{});
}

TEST(a_routine_saves_with_an_open_line_and_freezes_it_open) {
  Harness h;
  h.repo.db.seed(Exercise{ExerciseId{"barbell-row"}, "Barbell Row", Pattern::pull, Equipment::barbell,
                       2.5, false});
  RoutineWriteOutcome created =
      h.create(h.pushAWrite({benchEntry(1), RoutineEntry{2, ExerciseId{"barbell-row"}, std::nullopt,
                                                         std::nullopt, std::nullopt, std::nullopt}}));
  const std::optional<std::uint64_t> beforeItRan = h.program.routines(uid())[0].lastTrainedAtMs;

  StartOutcome started = h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(created.routine->entries[1].targetSets, std::optional<int>());
  CHECK_EQ(started.session->plan,
           std::optional<PlanSnapshot>(PlanSnapshot{
               "Push A",
               {PlanEntry{ExerciseId{"bench-press"}, 5, 5, 82.5, 180},
                PlanEntry{ExerciseId{"barbell-row"}, std::nullopt, std::nullopt, std::nullopt,
                          std::nullopt}}}));
  CHECK_EQ(beforeItRan, std::optional<std::uint64_t>());
  CHECK_EQ(h.program.routines(uid())[0].lastTrainedAtMs,
           std::optional<std::uint64_t>(h.clock.now));
  h.training.finish(uid(), sid("ses_00000001"), h.clock.now + 1);
  h.training.discard(uid(), sid("ses_00000001"));
  CHECK_EQ(h.program.routines(uid())[0].lastTrainedAtMs, std::optional<std::uint64_t>());
}

// The lifter's own hand names no door, and that absence is what reads as `created by you`.
TEST(a_routine_built_by_hand_carries_its_creation_in_its_history) {
  Harness h;
  h.create(h.pushAWrite({benchEntry(1), RoutineEntry{2, ExerciseId{"back-squat"}, 3, 8,
                                                     std::nullopt, std::nullopt}}));

  const std::vector<RoutineEvent> history = h.program.routineHistory(uid(), rtId());

  REQUIRE_EQ(history.size(), static_cast<std::size_t>(1));
  CHECK(history[0].kind == RoutineEventKind::created);
  CHECK_EQ(history[0].atMs, h.clock.now);
  CHECK_EQ(history[0].door, std::optional<ProposalDoor>());
  CHECK_EQ(history[0].movements, std::optional<int>(2));
  CHECK_EQ(history[0].proposal, std::optional<ProposalHead>());
  CHECK(h.program.routineHistory(uid("u2"), rtId()).empty());
}

TEST(a_routine_an_agent_created_names_the_door_it_came_through) {
  Harness h;
  h.program.createRoutine(uid(), h.pushAWrite(), ProposalDoor::mcp);

  const std::vector<RoutineEvent> history = h.program.routineHistory(uid(), rtId());

  REQUIRE_EQ(history.size(), static_cast<std::size_t>(1));
  CHECK_EQ(history[0].door, std::optional<ProposalDoor>(ProposalDoor::mcp));
}

namespace {
ProposalWrite proposalFor(std::vector<RoutineEntry> entries, std::string id = "prop_00000001",
                          std::optional<std::string> name = std::nullopt) {
  return ProposalWrite{ProposalId{std::move(id)},
                       rtId(),
                       std::move(name),
                       "Heavier triples.",
                       std::move(entries),
                       ProposalSource{ProposalDoor::mcp, "", ""}};
}

RoutineEntry benchAt(double weightKg, int reps = 5, int position = 1) {
  return RoutineEntry{position, ExerciseId{"bench-press"}, 5, reps, weightKg, 180};
}
}

TEST(a_routines_history_holds_its_proposals_and_its_creation_in_one_list) {
  Harness h;
  h.create(h.pushAWrite());
  h.program.propose(uid(), proposalFor({benchAt(87.5, 3)}));
  h.clock.now += 1'000;
  h.program.propose(uid(), proposalFor({benchAt(90.0, 3)}, "prop_00000002"));

  const std::vector<RoutineEvent> history = h.program.routineHistory(uid(), rtId());

  REQUIRE_EQ(history.size(), static_cast<std::size_t>(3));
  CHECK(history[0].kind == RoutineEventKind::proposal);
  CHECK_EQ(history[0].proposal->id, ProposalId{"prop_00000002"});
  CHECK(history[0].proposal->state == ProposalState::pending);
  CHECK_EQ(history[1].proposal->id, ProposalId{"prop_00000001"});
  CHECK(history[1].proposal->state == ProposalState::superseded);
  CHECK(history[2].kind == RoutineEventKind::created);
  CHECK_EQ(history[2].movements, std::optional<int>(1));
}

TEST(a_proposal_is_minted_against_the_routine_and_changes_nothing) {
  Harness h;
  h.create(h.pushAWrite());
  const std::vector<Routine> before = h.repo.db.routineRows;

  ProposalMintOutcome minted = h.program.propose(uid(), proposalFor({benchAt(87.5, 3)}));

  REQUIRE(minted.proposal.has_value());
  CHECK(minted.error == ProposalMintError::none);
  CHECK_EQ(h.repo.db.routineRows, before);
  CHECK_EQ(minted.proposal->head.state, ProposalState::pending);
  CHECK_EQ(minted.proposal->head.intent, ProposalIntent::revise);
  CHECK_EQ(minted.proposal->baseRevision, 1);
  CHECK_EQ(minted.proposal->baseName, std::string("Push A"));
  CHECK_EQ(minted.proposal->proposedName, std::string("Push A"));   // absent name keeps the one it has
  CHECK_EQ(minted.proposal->head.changes, 1);
  REQUIRE_EQ(minted.proposal->changes.size(), static_cast<std::size_t>(1));
  CHECK_EQ(minted.proposal->changes[0].kind, ChangeKind::retargeted);
  CHECK_EQ(minted.proposal->changes[0].before,
           std::optional<EntryTargets>(EntryTargets{5, 5, 82.5, 180}));
  CHECK_EQ(minted.proposal->changes[0].after,
           std::optional<EntryTargets>(EntryTargets{5, 3, 87.5, 180}));
}

TEST(a_proposal_that_could_not_be_stored_as_a_plan_is_refused_before_it_is_minted) {
  Harness h;
  h.create(h.pushAWrite());

  bool refused = false;
  try {
    h.program.propose(uid(), proposalFor({}));   // a routine with no movement is not a plan
  } catch (const InvalidTraining&) {
    refused = true;
  }

  CHECK(refused);
  CHECK(h.repo.db.proposalRows.empty());
}

TEST(a_proposal_naming_a_routine_this_account_cannot_read_is_the_one_absent_fact) {
  Harness h;
  h.repo.db.routineRows.push_back(Routine{rtId(), uid("u2"), "Their plan", 0, {benchEntry()}});

  ProposalMintOutcome minted = h.program.propose(uid(), proposalFor({benchAt(87.5)}));

  CHECK(minted.error == ProposalMintError::unknownRoutine);
  CHECK_EQ(minted.proposal, std::optional<RoutineProposal>());
}

TEST(applying_a_proposal_writes_the_whole_document_and_dates_the_record) {
  Harness h;
  h.create(h.pushAWrite());
  h.program.propose(uid(), proposalFor({benchAt(87.5, 3), RoutineEntry{2, ExerciseId{"back-squat"},
                                                                      3, 8, 100.0, 180}},
                                       "prop_00000001", "Push A — heavy"));
  h.clock.now += 60'000;

  ProposalSettleOutcome tapped = h.program.apply(uid(), ProposalId{"prop_00000001"});

  REQUIRE(tapped.proposal.has_value());
  REQUIRE(tapped.routine.has_value());
  CHECK(tapped.error == ProposalSettleError::none);
  CHECK_EQ(tapped.proposal->head.state, ProposalState::applied);
  CHECK_EQ(tapped.proposal->head.settledAtMs, std::optional<std::uint64_t>(h.clock.now));
  CHECK_EQ(tapped.routine->name, std::string("Push A — heavy"));
  CHECK_EQ(tapped.routine->revision, 2);
  REQUIRE_EQ(tapped.routine->entries.size(), static_cast<std::size_t>(2));
  CHECK_EQ(tapped.routine->entries[0].targetWeightKg, std::optional<double>(87.5));
  CHECK_EQ(tapped.routine->entries[1].exercise, ExerciseId{"back-squat"});
  CHECK_EQ(h.program.proposals(uid(), ProposalQuery{rtId(), false}).size(),
           static_cast<std::size_t>(1));
  CHECK(h.program.proposals(uid(), ProposalQuery{rtId(), true}).empty());
}

TEST(a_lifter_rewriting_the_routine_supersedes_a_proposal_rather_than_merging_it) {
  Harness h;
  h.create(h.pushAWrite());
  h.program.propose(uid(), proposalFor({benchAt(87.5, 3)}));
  h.clock.now += 60'000;

  h.program.replaceRoutine(uid(), rtId(),
                           h.pushAWrite({benchAt(85.0)}, "rt_00000001", "Push A"));
  ProposalSettleOutcome tapped = h.program.apply(uid(), ProposalId{"prop_00000001"});

  CHECK(tapped.error == ProposalSettleError::routineMoved);
  CHECK_EQ(tapped.routine, std::optional<Routine>());
  CHECK_EQ(h.program.routine(uid(), rtId())->entries[0].targetWeightKg, std::optional<double>(85.0));
  CHECK_EQ(h.program.routine(uid(), rtId())->revision, 2);
  const std::vector<ProposalHead> history = h.program.proposals(uid(), ProposalQuery{rtId(), false});
  REQUIRE_EQ(history.size(), static_cast<std::size_t>(1));
  CHECK_EQ(history[0].state, ProposalState::superseded);
  CHECK_EQ(history[0].settledAtMs, std::optional<std::uint64_t>(h.clock.now));
  // The same fact on the other door: turning it down is refused for the same reason.
  CHECK(h.program.dismiss(uid(), ProposalId{"prop_00000001"}).error ==
        ProposalSettleError::routineMoved);
}

// Three reasons a proposal is past settling, told apart by the store and never guessed: the one
// a newer proposal from the same door replaced (`superseded_by` names it) says so even after the
// routine ALSO moved; the one the routine's own move superseded says the routine moved; a row
// superseded before the reason was recorded, with the revision unmoved, says only that.
TEST(a_replaced_proposal_says_so_even_after_the_routine_also_moved) {
  Harness h;
  h.create(h.pushAWrite());
  h.program.propose(uid(), proposalFor({benchAt(87.5, 3)}, "prop_00000001"));
  h.clock.now += 60'000;
  h.program.propose(uid(), proposalFor({benchAt(90.0, 3)}, "prop_00000002"));   // same door: replaces

  CHECK(h.program.apply(uid(), ProposalId{"prop_00000001"}).error == ProposalSettleError::replaced);
  CHECK(h.program.dismiss(uid(), ProposalId{"prop_00000001"}).error == ProposalSettleError::replaced);
  // The second one lands, so the routine moves; the first is STILL the replaced one.
  h.clock.now += 60'000;
  CHECK(h.program.apply(uid(), ProposalId{"prop_00000002"}).error == ProposalSettleError::none);
  CHECK_EQ(h.program.routine(uid(), rtId())->revision, 2);
  CHECK(h.program.apply(uid(), ProposalId{"prop_00000001"}).error == ProposalSettleError::replaced);
  CHECK(h.program.dismiss(uid(), ProposalId{"prop_00000001"}).error == ProposalSettleError::replaced);
}

TEST(a_proposal_superseded_before_the_reason_was_recorded_says_only_that) {
  Harness h;
  h.create(h.pushAWrite());
  h.program.propose(uid(), proposalFor({benchAt(87.5, 3)}, "prop_00000001"));
  // A legacy row: settled as superseded with no `superseded_by`, the routine still at its revision.
  for (RoutineProposal& held : h.repo.db.proposalRows) {
    held.head.state = ProposalState::superseded;
    held.head.settledAtMs = h.clock.now;
  }

  CHECK(h.program.apply(uid(), ProposalId{"prop_00000001"}).error == ProposalSettleError::superseded);
  CHECK(h.program.dismiss(uid(), ProposalId{"prop_00000001"}).error == ProposalSettleError::superseded);
  // Once the routine moves, that same legacy row reads as the routine having changed.
  h.program.replaceRoutine(uid(), rtId(), h.pushAWrite({benchAt(85.0)}, "rt_00000001", "Push A"));
  CHECK(h.program.apply(uid(), ProposalId{"prop_00000001"}).error == ProposalSettleError::routineMoved);
  CHECK(h.program.dismiss(uid(), ProposalId{"prop_00000001"}).error == ProposalSettleError::routineMoved);
}

// A PUT of the bytes already standing, or a move in the week, changes no revision and settles nothing.
TEST(a_put_that_changes_neither_the_document_nor_the_name_leaves_a_pending_proposal_standing) {
  Harness h;
  h.create(h.pushAWrite());
  h.program.propose(uid(), proposalFor({benchAt(87.5, 3)}));
  h.clock.now += 60'000;

  h.program.replaceRoutine(uid(), rtId(), h.pushAWrite());                              // identical
  h.program.replaceRoutine(uid(), rtId(), RoutineWrite{rtId(), "Push A", 3, {benchEntry()}});

  CHECK_EQ(h.program.routine(uid(), rtId())->revision, 1);
  CHECK_EQ(h.program.routine(uid(), rtId())->position, 3);
  const std::vector<ProposalHead> waiting = h.program.proposals(uid(), ProposalQuery{rtId(), true});
  REQUIRE_EQ(waiting.size(), static_cast<std::size_t>(1));
  CHECK_EQ(waiting[0].state, ProposalState::pending);
  CHECK(h.program.apply(uid(), ProposalId{"prop_00000001"}).error == ProposalSettleError::none);
  CHECK_EQ(h.program.routine(uid(), rtId())->entries[0].targetWeightKg, std::optional<double>(87.5));
  CHECK_EQ(h.program.routine(uid(), rtId())->position, 3);
}

TEST(a_spent_proposal_id_carrying_a_different_document_is_refused_rather_than_replayed) {
  Harness h;
  h.create(h.pushAWrite());
  h.program.propose(uid(), proposalFor({benchAt(87.5, 3)}));

  ProposalMintOutcome second = h.program.propose(uid(), proposalFor({benchAt(60.0, 12)}));
  ProposalMintOutcome replayed = h.program.propose(uid(), proposalFor({benchAt(87.5, 3)}));

  CHECK(second.error == ProposalMintError::idReused);
  CHECK_EQ(second.proposal, std::optional<RoutineProposal>());
  REQUIRE_EQ(h.repo.db.proposalRows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.proposalRows[0].changes[0].after,
           std::optional<EntryTargets>(EntryTargets{5, 3, 87.5, 180}));
  CHECK_EQ(h.repo.db.proposalRows[0].head.state, ProposalState::pending);
  CHECK(replayed.error == ProposalMintError::none);
  REQUIRE(replayed.proposal.has_value());
  CHECK_EQ(replayed.proposal->head.id, ProposalId{"prop_00000001"});
}

TEST(a_proposal_that_only_reorders_the_day_is_minted_rather_than_called_no_change) {
  Harness h;
  h.create(h.pushAWrite({benchEntry(),
                                               RoutineEntry{2, ExerciseId{"back-squat"}, 3, 8,
                                                            100.0, 180}}));

  ProposalMintOutcome minted = h.program.propose(
      uid(), proposalFor({RoutineEntry{1, ExerciseId{"back-squat"}, 3, 8, 100.0, 180},
                          benchEntry(2)}));

  REQUIRE(minted.proposal.has_value());
  CHECK(minted.error == ProposalMintError::none);
  CHECK_EQ(minted.proposal->head.changes, 1);
  CHECK_EQ(minted.proposal->changes[0].kind, ChangeKind::kept);
  CHECK_EQ(minted.proposal->changes[1].kind, ChangeKind::kept);
  CHECK(h.program.apply(uid(), ProposalId{"prop_00000001"}).error == ProposalSettleError::none);
  CHECK_EQ(h.program.routine(uid(), rtId())->entries[0].exercise, ExerciseId{"back-squat"});
  CHECK_EQ(h.program.routine(uid(), rtId())->entries[1].exercise, ExerciseId{"bench-press"});
}

TEST(applying_one_proposal_supersedes_every_other_waiting_on_that_routine) {
  Harness h;
  h.create(h.pushAWrite());
  h.program.propose(uid(), proposalFor({benchAt(87.5, 3)}, "prop_00000001"));
  // Pending is per (routine, door, connection), so a second door's proposal stands beside the first.
  h.repo.db.proposalRows.push_back(
      RoutineProposal{ProposalHead{ProposalId{"prop_00000002"}, rtId(), uid(),
                                   ProposalIntent::revise, ProposalState::pending,
                                   ProposalSource{ProposalDoor::ask, "", ""}, "", 1, h.clock.now,
                                   std::nullopt},
                      1, "Push A", "Push A", changesBetween({benchEntry()}, {benchAt(90.0)})});
  h.clock.now += 60'000;

  h.program.apply(uid(), ProposalId{"prop_00000001"});

  const std::vector<ProposalHead> history = h.program.proposals(uid(), ProposalQuery{rtId(), false});
  REQUIRE_EQ(history.size(), static_cast<std::size_t>(2));
  CHECK(h.program.proposals(uid(), ProposalQuery{rtId(), true}).empty());
  for (const ProposalHead& head : history)
    CHECK(head.state == ProposalState::applied || head.state == ProposalState::superseded);
}

TEST(dismissing_a_proposal_changes_nothing_and_keeps_it_in_the_history) {
  Harness h;
  h.create(h.pushAWrite());
  h.program.propose(uid(), proposalFor({benchAt(87.5, 3)}));
  const std::vector<Routine> before = h.repo.db.routineRows;
  h.clock.now += 60'000;

  ProposalSettleOutcome dismissed = h.program.dismiss(uid(), ProposalId{"prop_00000001"});

  REQUIRE(dismissed.proposal.has_value());
  CHECK(dismissed.error == ProposalSettleError::none);
  CHECK_EQ(dismissed.proposal->head.state, ProposalState::dismissed);
  CHECK_EQ(dismissed.proposal->head.settledAtMs, std::optional<std::uint64_t>(h.clock.now));
  CHECK_EQ(dismissed.routine, std::optional<Routine>());
  CHECK_EQ(h.repo.db.routineRows, before);
}

TEST(a_settled_proposal_replays_its_own_decision_and_refuses_the_other_one) {
  Harness h;
  h.create(h.pushAWrite());
  h.program.propose(uid(), proposalFor({benchAt(87.5, 3)}));
  h.program.apply(uid(), ProposalId{"prop_00000001"});

  ProposalSettleOutcome again = h.program.apply(uid(), ProposalId{"prop_00000001"});
  ProposalSettleOutcome other = h.program.dismiss(uid(), ProposalId{"prop_00000001"});

  CHECK(again.error == ProposalSettleError::none);
  REQUIRE(again.proposal.has_value());
  CHECK_EQ(again.proposal->head.state, ProposalState::applied);
  CHECK_EQ(h.program.routine(uid(), rtId())->revision, 2);   // and it did not apply twice
  CHECK(other.error == ProposalSettleError::settled);
}

TEST(a_proposal_of_another_account_is_the_same_fact_as_no_proposal_at_all) {
  Harness h;
  h.repo.db.routineRows.push_back(Routine{rtId("rt_00000002"), uid("u2"), "Their plan", 0,
                                       {benchEntry()}});
  h.repo.db.proposalRows.push_back(
      RoutineProposal{ProposalHead{ProposalId{"prop_00000001"}, rtId("rt_00000002"), uid("u2"),
                                   ProposalIntent::revise, ProposalState::pending,
                                   ProposalSource{ProposalDoor::mcp, "", ""}, "", 1, h.clock.now,
                                   std::nullopt},
                      1, "Their plan", "Their plan",
                      changesBetween({benchEntry()}, {benchAt(90.0)})});

  CHECK_EQ(h.program.proposal(uid(), ProposalId{"prop_00000001"}),
           std::optional<RoutineProposal>());
  CHECK(h.program.proposals(uid(), ProposalQuery{std::nullopt, false}).empty());
  CHECK(h.program.apply(uid(), ProposalId{"prop_00000001"}).error ==
        ProposalSettleError::notFound);
  CHECK(h.program.dismiss(uid(), ProposalId{"prop_00000001"}).error ==
        ProposalSettleError::notFound);
  CHECK_EQ(h.program.routine(uid("u2"), rtId("rt_00000002"))->entries[0].targetWeightKg,
           std::optional<double>(82.5));
}

TEST(applying_a_removal_takes_the_day_out_and_leaves_the_log_alone) {
  Harness h;
  h.create(h.pushAWrite());
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  h.training.finish(uid(), sid("ses_00000001"), h.clock.now + 1);
  h.program.proposeRemoval(uid(), ProposalId{"prop_00000001"}, rtId(), "Not trained in months.",
                           ProposalSource{ProposalDoor::mcp, "", ""});
  h.clock.now += 60'000;

  ProposalSettleOutcome tapped = h.program.apply(uid(), ProposalId{"prop_00000001"});

  REQUIRE(tapped.proposal.has_value());
  CHECK(tapped.error == ProposalSettleError::none);
  CHECK_EQ(tapped.proposal->head.state, ProposalState::applied);
  CHECK_EQ(tapped.routine, std::optional<Routine>());
  CHECK_EQ(h.program.routine(uid(), rtId()), std::optional<Routine>());
  CHECK_EQ(h.training.detail(uid(), sid("ses_00000001"))->session.plan->routineName,
           std::string("Push A"));
}
