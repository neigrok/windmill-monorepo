#include "test/products/gym/application/GymServiceFixture.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::servicetest;

// ---- routines: the plan, written as one whole document ------------------------------------

TEST(create_routine_stores_the_document_and_reads_it_back) {
  Harness h;

  RoutineWriteOutcome created = h.create(h.pushAWrite({benchEntry(1), RoutineEntry{2, ExerciseId{"back-squat"}, 3, 8,
                                                       std::nullopt, std::nullopt}}));

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(*created.routine,
           Routine(rtId(), uid(), "Push A", 0,
                   {benchEntry(1),
                    RoutineEntry{2, ExerciseId{"back-squat"}, 3, 8, std::nullopt, std::nullopt}}));
  // Never trained yet, and that absence is the routines screen's own sentence.
  CHECK_EQ(created.routine->lastTrainedAtMs, std::optional<std::uint64_t>());
  CHECK_EQ(h.program.routine(uid(), rtId()), created.routine);
  CHECK_EQ(h.program.routine(uid("u2"), rtId()), std::optional<Routine>());
}

// The id is the idempotency key here exactly as it is for a session: a create that lost its reply
// and was sent again reads back what landed, and never appends a second copy of every line.
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

// The catalog is storage's to know, so the refusal is born there and travels as a value — the same
// fact a set naming an unknown movement gets. The whole document is one transaction, so a refused
// line leaves no half-written routine behind.
TEST(create_routine_naming_a_movement_no_catalog_holds_is_unknown_exercise) {
  Harness h;

  RoutineWriteOutcome created = h.create(h.pushAWrite({benchEntry(1), RoutineEntry{2, ExerciseId{"zercher-squat"}, 3, 8,
                                                       std::nullopt, std::nullopt}}));

  CHECK(created.error == RoutineWriteError::unknownExercise);
  CHECK_FALSE(created.routine.has_value());
  CHECK(h.repo.db.routineRows.empty());
  CHECK_EQ(h.program.routines(uid()), std::vector<Routine>{});
}

// The same scope the set write is held to, on the other door a movement id can travel through: a
// plan may not name another lifter's private movement either, or the routines screen would print
// their movement name every time it drew this day of the program — and the replace must not be the
// way around the create's refusal, since both halves write the same whole document.
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
  // The revision moves on a write that changes the document, which is what a proposal is minted
  // against and superseded by (domain/Proposal.h).
  CHECK_EQ(*replaced.routine,
           Routine(rtId(), uid(), "Push A2", 0,
                   {RoutineEntry{1, ExerciseId{"back-squat"}, 4, 6, 100.0, 240}, benchEntry(2)},
                   std::nullopt, 2));
  // A reorder, an insertion and a deletion are one write: the lines have no identity to churn.
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

// The routines screen's order: most recently trained first, the never-trained after them rather
// than above them, and the instant is the store's own aggregate over the log — not a column anyone
// writes, so it cannot fall out of step with the sessions it describes.
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

// A routine built at the kitchen table is savable while it is still incomplete: the open line is
// stored as naming nothing and FREEZES as naming nothing, so the session it starts asks at the rack
// rather than reading a target nobody typed. It is the difference between `3 × 5` and `you decide`,
// and the snapshot is where it would have been lost.
TEST(a_routine_saves_with_an_open_line_and_freezes_it_open) {
  Harness h;
  h.repo.db.seed(Exercise{ExerciseId{"barbell-row"}, "Barbell Row", Pattern::pull, Equipment::barbell,
                       2.5, false});
  RoutineWriteOutcome created =
      h.create(h.pushAWrite({benchEntry(1), RoutineEntry{2, ExerciseId{"barbell-row"}, std::nullopt,
                                                         std::nullopt, std::nullopt, std::nullopt}}));
  // UNTESTED until its first session, and that is an absence rather than a flag: it needs nothing
  // written to become true and nothing unwritten to stop being true.
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
  // And the first session is what ends it — the badge is off the moment the day is trained, with
  // nothing to write and nothing that could be left standing after a discard.
  CHECK_EQ(h.program.routines(uid())[0].lastTrainedAtMs,
           std::optional<std::uint64_t>(h.clock.now));
  h.training.finish(uid(), sid("ses_00000001"), h.clock.now + 1);
  h.training.discard(uid(), sid("ses_00000001"));
  CHECK_EQ(h.program.routines(uid())[0].lastTrainedAtMs, std::optional<std::uint64_t>());
}

// The day's own history, and the row §M30 draws at the bottom of it: when it was built, by whom,
// and how many movements it was built with. The lifter's own hand names no door, and that absence
// is what the screen reads as `created by you`.
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
  // Another account's routine has no history at all, which is the one fact every read here gives.
  CHECK(h.program.routineHistory(uid("u2"), rtId()).empty());
}

// A day an AGENT typed says so. `create_routine` is a real door onto this table — a routine that
// does not exist yet takes nothing away, so it lands immediately rather than as a proposal — and a
// history that said `created by you` about it would be putting words in a lifter's mouth.
TEST(a_routine_an_agent_created_names_the_door_it_came_through) {
  Harness h;
  h.program.createRoutine(uid(), h.pushAWrite(), ProposalDoor::mcp);

  const std::vector<RoutineEvent> history = h.program.routineHistory(uid(), rtId());

  REQUIRE_EQ(history.size(), static_cast<std::size_t>(1));
  CHECK_EQ(history[0].door, std::optional<ProposalDoor>(ProposalDoor::mcp));
}

// ---- the proposal ledger ----------------------------------------------------------------------

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

// ONE list, both kinds of row: every proposal ever minted against the day, newest first, and the
// creation row under them. A screen handed two lists would merge them itself, three surfaces three
// ways.
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
  // The one it replaced is still here — superseded, dated, and part of the program's past.
  CHECK_EQ(history[1].proposal->id, ProposalId{"prop_00000001"});
  CHECK(history[1].proposal->state == ProposalState::superseded);
  CHECK(history[2].kind == RoutineEventKind::created);
  CHECK_EQ(history[2].movements, std::optional<int>(1));
}

// The mint's whole promise: a typed diff against the routine as it stands, frozen at its revision,
// and NOTHING written to the program.
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

// A document a plan could not hold is refused at the MINT, through the Routine constructor, so a
// proposal a lifter reads and cannot apply never reaches their screen.
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

// THE TAP, and the two things it has to be: atomic, and against the base the diff was computed
// from. The routine takes the whole document or none of it, and the proposal becomes a dated record.
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
  // It stays in the routine's history rather than disappearing.
  CHECK_EQ(h.program.proposals(uid(), ProposalQuery{rtId(), false}).size(),
           static_cast<std::size_t>(1));
  CHECK(h.program.proposals(uid(), ProposalQuery{rtId(), true}).empty());
}

// THE LINE THIS WHOLE WAVE TURNS ON. The mid-session "Save 87.5 to Push A" is a full
// read-modify-write PUT, and before the revision existed it would have left a proposal standing
// against a document that was gone. Now the lifter's own hand supersedes it, and the tap refuses.
TEST(a_lifter_rewriting_the_routine_supersedes_a_proposal_rather_than_merging_it) {
  Harness h;
  h.create(h.pushAWrite());
  h.program.propose(uid(), proposalFor({benchAt(87.5, 3)}));
  h.clock.now += 60'000;

  h.program.replaceRoutine(uid(), rtId(),
                           h.pushAWrite({benchAt(85.0)}, "rt_00000001", "Push A"));
  ProposalSettleOutcome tapped = h.program.apply(uid(), ProposalId{"prop_00000001"});

  CHECK(tapped.error == ProposalSettleError::superseded);
  CHECK_EQ(tapped.routine, std::optional<Routine>());
  // The lifter's own numbers stand, untouched by the diff that was waiting.
  CHECK_EQ(h.program.routine(uid(), rtId())->entries[0].targetWeightKg, std::optional<double>(85.0));
  CHECK_EQ(h.program.routine(uid(), rtId())->revision, 2);
  // And the superseded proposal is a dated record on the routine rather than a row that vanished.
  const std::vector<ProposalHead> history = h.program.proposals(uid(), ProposalQuery{rtId(), false});
  REQUIRE_EQ(history.size(), static_cast<std::size_t>(1));
  CHECK_EQ(history[0].state, ProposalState::superseded);
  CHECK_EQ(history[0].settledAtMs, std::optional<std::uint64_t>(h.clock.now));
}

// THE OTHER HALF OF THAT RULE, and without it the rule is a card that dies for nothing. A PUT that
// lands the bytes already standing — a routine editor saving on close, the mid-session save writing
// the whole document back to change one weight it did not change — destroyed no base, so it moves no
// revision and settles nothing. Where the day sits in the week is not part of any proposal either:
// an apply keeps the base's own position, so dragging a routine up the list leaves the card waiting.
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
  // And the tap it was minted for still lands, because nothing about its base moved.
  CHECK(h.program.apply(uid(), ProposalId{"prop_00000001"}).error == ProposalSettleError::none);
  CHECK_EQ(h.program.routine(uid(), rtId())->entries[0].targetWeightKg, std::optional<double>(87.5));
  CHECK_EQ(h.program.routine(uid(), rtId())->position, 3);
}

// A resent id carrying a DIFFERENT document is not a replay, and answering it with the stored
// proposal would throw this one away while telling the caller something of theirs is waiting. It is
// refused as a value, nothing is written, and the proposal already standing is untouched.
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
  // The identical document under that id still replays, which is what the id is for.
  CHECK(replayed.error == ProposalMintError::none);
  REQUIRE(replayed.proposal.has_value());
  CHECK_EQ(replayed.proposal->head.id, ProposalId{"prop_00000001"});
}

// A day is trained top to bottom, so moving a movement to the front is a real change to the program
// — and the rows say it by their order alone. It used to be refused as "that document is what the
// routine already says", which was false about the one thing the refusal claimed to know.
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
  // And the tap writes the order the lifter read.
  CHECK(h.program.apply(uid(), ProposalId{"prop_00000001"}).error == ProposalSettleError::none);
  CHECK_EQ(h.program.routine(uid(), rtId())->entries[0].exercise, ExerciseId{"back-squat"});
  CHECK_EQ(h.program.routine(uid(), rtId())->entries[1].exercise, ExerciseId{"bench-press"});
}

// Applying one proposal moves the routine, so every OTHER proposal waiting on it is now against a
// base that is gone — settled the same way the lifter's own write settles them.
TEST(applying_one_proposal_supersedes_every_other_waiting_on_that_routine) {
  Harness h;
  h.create(h.pushAWrite());
  h.program.propose(uid(), proposalFor({benchAt(87.5, 3)}, "prop_00000001"));
  // A second door's proposal on the same routine: pending beside the first rather than superseding
  // it, because the pending rule is per (routine, door, connection).
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

// No reason is asked for, nothing changes, and it stays in the routine's history in case the lifter
// wants it back.
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

// A settle asked for what it already did is a REPLAY and answers 200 with the stored row, so a
// double tap on a slow connection cannot report a failure. Asked for the OTHER decision, it refuses.
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

// Every proposal read and write is owner-scoped, and absent is byte-identical to another account's.
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
  // And their plan is exactly where it was.
  CHECK_EQ(h.program.routine(uid("u2"), rtId("rt_00000002"))->entries[0].targetWeightKg,
           std::optional<double>(82.5));
}

// Applying a removal takes the day out of the program — and the history goes with it, because a day
// that has left has no editor to draw a History section in.
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
  // The frozen copy survives the plan it was taken from — the log still says what the workout was.
  CHECK_EQ(h.training.detail(uid(), sid("ses_00000001"))->session.plan->routineName,
           std::string("Push A"));
}
