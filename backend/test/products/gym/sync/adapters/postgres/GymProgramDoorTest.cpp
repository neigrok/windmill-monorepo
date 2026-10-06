#include "test/products/gym/sync/adapters/postgres/GymDoorFixture.h"
#include "platform/adapters/json/JsonText.h"
#include "test/testing.h"

#include <cstdint>
#include <cstdlib>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::doortest;

namespace {

RoutineWrite pushAWrite(std::vector<RoutineEntry> entries = {benchEntry()}, std::string id = "rt_00000001",
                        std::string name = "Push A") {
  return RoutineWrite{rtId(std::move(id)), std::move(name), 0, std::move(entries)};
}

// The lifter's own hand names no door, as a routine a phone creates.
RoutineWriteOutcome createByHand(Harness& h, const UserId& owner, const RoutineWrite& incoming) {
  return h.door.createRoutine(owner, incoming, std::nullopt);
}

StartOutcome startFrom(Harness& h, std::uint64_t ms, std::string id, std::string routine) {
  return h.door.start(h.user, SessionStart{sid(std::move(id)), ms, true, rtId(std::move(routine))});
}

ProposalWrite proposalFor(std::vector<RoutineEntry> entries, std::string id = "prop_00000001",
                          std::optional<std::string> name = std::nullopt) {
  return ProposalWrite{ProposalId{std::move(id)},
                       rtId(),
                       std::move(name),
                       "Heavier triples.",
                       std::move(entries),
                       ProposalSource{ProposalDoor::mcp, "", ""}};
}

// The bench line under a scheme of the test's choosing; benchEntry() is the one it starts from.
RoutineEntry bench(std::vector<SetTarget> sets, int position = 1) {
  return RoutineEntry{position, ExerciseId{"bench-press"}, std::move(sets), 180};
}

// The arguments of the two commands a phone pushes when the lifter taps Apply or Dismiss.
Json::Value proposalArgs(const char* proposal) {
  Json::Value args(Json::objectValue);
  args["proposalId"] = proposal;
  return args;
}

}

TEST(create_routine_stores_the_document_and_reads_it_back) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;

  RoutineWriteOutcome created = createByHand(h, h.user, pushAWrite(
      {benchEntry(1),
       RoutineEntry{2, ExerciseId{"back-squat"}, straight(3, 8, std::nullopt), std::nullopt}}));

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(*created.routine,
           Routine(rtId(), h.user, "Push A", 0,
                   {benchEntry(1),
                    RoutineEntry{2, ExerciseId{"back-squat"}, straight(3, 8, std::nullopt), std::nullopt}}));
  CHECK_EQ(created.routine->lastTrainedAtMs, std::optional<std::uint64_t>());
  CHECK_EQ(h.repo.program.routine(h.user, rtId()), created.routine);
  CHECK_EQ(h.repo.program.routine(h.other, rtId()), std::optional<Routine>());
}

TEST(create_routine_replay_returns_the_stored_routine_untouched) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  RoutineWriteOutcome first = createByHand(h, h.user, pushAWrite());

  RoutineWriteOutcome replayed =
      createByHand(h, h.user, pushAWrite({benchEntry(1), benchEntry(2)}, "rt_00000001", "Renamed mid-flight"));

  CHECK(replayed.error == RoutineWriteError::none);
  CHECK_EQ(*replayed.routine, *first.routine);
  CHECK_EQ(h.repo.program.routines(h.user), std::vector<Routine>{Routine(rtId(), h.user, "Push A", 0, {benchEntry()})});
}

TEST(create_routine_with_an_id_another_account_holds_is_id_taken) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  createByHand(h, h.other, RoutineWrite{rtId(), "Their plan", 0, {benchEntry()}});

  RoutineWriteOutcome created = createByHand(h, h.user, pushAWrite());

  CHECK(created.error == RoutineWriteError::idTaken);
  CHECK_FALSE(created.routine.has_value());   // never the stranger's plan, not even to say it exists
  CHECK_EQ(h.repo.program.routines(h.other),
           std::vector<Routine>{Routine(rtId(), h.other, "Their plan", 0, {benchEntry()})});
  CHECK_EQ(h.repo.program.routine(h.user, rtId()), std::optional<Routine>());
}

// The whole document is one write, so a refused line leaves no half-written routine behind.
TEST(create_routine_naming_a_movement_no_catalog_holds_is_unknown_exercise) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;

  RoutineWriteOutcome created = createByHand(h, h.user, pushAWrite(
      {benchEntry(1),
       RoutineEntry{2, ExerciseId{"zercher-squat"}, straight(3, 8, std::nullopt), std::nullopt}}));

  CHECK(created.error == RoutineWriteError::unknownExercise);
  CHECK_FALSE(created.routine.has_value());
  CHECK_EQ(h.repo.program.routines(h.user), std::vector<Routine>{});
  CHECK_EQ(h.repo.program.routines(h.other), std::vector<Routine>{});
}

// The create a tool makes and the edit a phone pushes through /v1/sync refuse alike.
TEST(a_routine_entry_naming_another_accounts_private_movement_is_unknown_exercise) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.door.createExercise(h.other, ExerciseWrite{ExerciseId{"ex_22222222"}, "Their Zercher Squat",
                                                  Pattern::squat, Equipment::barbell, 2.5});
  const RoutineEntry theirs{1, ExerciseId{"ex_22222222"}, straight(3, 8, 60.0), 120};

  RoutineWriteOutcome created = createByHand(h, h.user, pushAWrite({theirs}));
  createByHand(h, h.user, pushAWrite());
  Json::Value edit(Json::objectValue);
  edit["entries"] = parse(R"([{"exerciseId":"ex_22222222","restSeconds":120,"sets":[{"reps":8,"weightKg":60},{"reps":8,"weightKg":60},{"reps":8,"weightKg":60}]}])");
  const Json::Value replaced = h.admit(h.user, {GymDoor::delta("routine", "rt_00000001", edit)});

  CHECK(created.error == RoutineWriteError::unknownExercise);
  CHECK_FALSE(created.routine.has_value());
  CHECK_EQ(GymDoor::refusal(replaced), std::string("unknown-exercise"));
  CHECK_EQ(h.repo.program.routines(h.user), std::vector<Routine>{Routine(rtId(), h.user, "Push A", 0, {benchEntry()})});
}

// A phone deletes the routine through /v1/sync; the sessions that ran it keep their snapshot.
TEST(delete_routine_takes_the_pointer_off_every_session_that_ran_it_and_leaves_the_snapshot) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  createByHand(h, h.user, pushAWrite());
  startFrom(h, h.clock.now, "ses_00000001", "rt_00000001");
  h.door.finish(h.user, sid("ses_00000001"), h.clock.now + 1);
  const Json::Value death = GymDoor::delta("routine", "rt_00000001", Json::Value(Json::objectValue), false, true);

  // Another account's delete is answered and changes nothing; the owner's lands once, and again is a no-op.
  CHECK_EQ(GymDoor::refusal(h.admit(h.other, {death})), std::string());
  CHECK_EQ(h.repo.program.routine(h.user, rtId()), std::optional<Routine>(Routine(rtId(), h.user, "Push A", 0, {benchEntry()}, h.clock.now)));
  h.kill(h.user, "routine", "rt_00000001");
  CHECK_EQ(GymDoor::refusal(h.admit(h.user, {death})), std::string());

  std::optional<SessionDetail> detail = h.training.detail(h.user, sid("ses_00000001"));
  REQUIRE(detail.has_value());
  CHECK_EQ(detail->session.routine, std::optional<RoutineId>());
  CHECK_EQ(detail->session.plan,
           std::optional<PlanSnapshot>(PlanSnapshot{
               "Push A", {PlanEntry{ExerciseId{"bench-press"}, straight(5, 5, 82.5), 180}}}));
  CHECK_EQ(h.repo.program.routines(h.user), std::vector<Routine>{});
}

TEST(routines_list_is_most_recently_trained_first_with_the_untrained_last) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  createByHand(h, h.user, pushAWrite({benchEntry()}, "rt_00000001", "Push A"));
  createByHand(h, h.user, pushAWrite({benchEntry()}, "rt_00000002", "Pull A"));
  createByHand(h, h.user, pushAWrite({benchEntry()}, "rt_00000003", "Legs"));
  startFrom(h, h.clock.now, "ses_00000001", "rt_00000002");
  h.door.finish(h.user, sid("ses_00000001"), h.clock.now + 1);
  const std::uint64_t later = h.clock.now + 10'000;
  startFrom(h, later, "ses_00000002", "rt_00000001");
  h.door.finish(h.user, sid("ses_00000002"), later + 1);

  std::vector<Routine> listed = h.repo.program.routines(h.user);

  CHECK_EQ(listed, (std::vector<Routine>{
                       Routine(rtId("rt_00000001"), h.user, "Push A", 0, {benchEntry()}, later),
                       Routine(rtId("rt_00000002"), h.user, "Pull A", 0, {benchEntry()}, h.clock.now),
                       Routine(rtId("rt_00000003"), h.user, "Legs", 0, {benchEntry()})}));
  CHECK_EQ(h.repo.program.routines(h.other), std::vector<Routine>{});
}

TEST(a_routine_saves_with_an_open_line_and_freezes_it_open) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  RoutineWriteOutcome created = createByHand(
      h, h.user, pushAWrite({benchEntry(1), RoutineEntry{2, ExerciseId{"barbell-row"}, {}, std::nullopt}}));
  const std::optional<std::uint64_t> beforeItRan = h.repo.program.routines(h.user)[0].lastTrainedAtMs;

  StartOutcome started = startFrom(h, h.clock.now, "ses_00000001", "rt_00000001");

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(created.routine->entries[1].sets, std::vector<SetTarget>{});
  CHECK_EQ(started.session->plan,
           std::optional<PlanSnapshot>(PlanSnapshot{
               "Push A",
               {PlanEntry{ExerciseId{"bench-press"}, straight(5, 5, 82.5), 180},
                PlanEntry{ExerciseId{"barbell-row"}, {}, std::nullopt}}}));
  CHECK_EQ(beforeItRan, std::optional<std::uint64_t>());
  CHECK_EQ(h.repo.program.routines(h.user)[0].lastTrainedAtMs, std::optional<std::uint64_t>(h.clock.now));
  h.door.finish(h.user, sid("ses_00000001"), h.clock.now + 1);
  h.door.discard(h.user, sid("ses_00000001"));
  CHECK_EQ(h.repo.program.routines(h.user)[0].lastTrainedAtMs, std::optional<std::uint64_t>());
}

// The lifter's own hand names no door, and that absence is what reads as `created by you`.
TEST(a_routine_built_by_hand_carries_its_creation_in_its_history) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  createByHand(h, h.user, pushAWrite(
      {benchEntry(1),
       RoutineEntry{2, ExerciseId{"back-squat"}, straight(3, 8, std::nullopt), std::nullopt}}));

  const std::vector<RoutineEvent> history = h.repo.program.routineHistory(h.user, rtId());

  REQUIRE_EQ(history.size(), static_cast<std::size_t>(1));
  CHECK(history[0].kind == RoutineEventKind::created);
  CHECK_EQ(history[0].atMs, h.clock.now);
  CHECK_EQ(history[0].door, std::optional<ProposalDoor>());
  CHECK_EQ(history[0].movements, std::optional<int>(2));
  CHECK_EQ(history[0].proposal, std::optional<ProposalHead>());
  CHECK(h.repo.program.routineHistory(h.other, rtId()).empty());
}

TEST(a_routine_an_agent_created_names_the_door_it_came_through) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.door.createRoutine(h.user, pushAWrite(), ProposalDoor::mcp);

  const std::vector<RoutineEvent> history = h.repo.program.routineHistory(h.user, rtId());

  REQUIRE_EQ(history.size(), static_cast<std::size_t>(1));
  CHECK_EQ(history[0].door, std::optional<ProposalDoor>(ProposalDoor::mcp));
}

TEST(a_routines_history_holds_its_proposals_and_its_creation_in_one_list) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  createByHand(h, h.user, pushAWrite());
  h.door.propose(h.user, proposalFor({bench(straight(5, 3, 87.5))}));
  h.clock.now += 1'000;
  h.door.propose(h.user, proposalFor({bench(straight(5, 3, 90.0))}, "prop_00000002"));

  const std::vector<RoutineEvent> history = h.repo.program.routineHistory(h.user, rtId());

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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  createByHand(h, h.user, pushAWrite());
  const std::vector<Routine> before = h.repo.program.routines(h.user);

  ProposalMintOutcome minted = h.door.propose(h.user, proposalFor({bench(straight(5, 3, 87.5))}));

  REQUIRE(minted.proposal.has_value());
  CHECK(minted.error == ProposalMintError::none);
  CHECK_EQ(h.repo.program.routines(h.user), before);
  CHECK_EQ(minted.proposal->head.state, ProposalState::pending);
  CHECK_EQ(minted.proposal->head.intent, ProposalIntent::revise);
  CHECK_EQ(minted.proposal->baseRevision, 1);
  CHECK_EQ(minted.proposal->baseName, std::string("Push A"));
  CHECK_EQ(minted.proposal->proposedName, std::string("Push A"));   // absent name keeps the one it has
  CHECK_EQ(minted.proposal->head.changes, 1);
  REQUIRE_EQ(minted.proposal->changes.size(), static_cast<std::size_t>(1));
  CHECK_EQ(minted.proposal->changes[0].kind, ChangeKind::retargeted);
  CHECK_EQ(minted.proposal->changes[0].before,
           std::optional<EntryTargets>(EntryTargets{straight(5, 5, 82.5), 180}));
  CHECK_EQ(minted.proposal->changes[0].after,
           std::optional<EntryTargets>(EntryTargets{straight(5, 3, 87.5), 180}));
}

TEST(a_proposal_that_could_not_be_stored_as_a_plan_is_refused_before_it_is_minted) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  createByHand(h, h.user, pushAWrite());

  bool refused = false;
  try {
    h.door.propose(h.user, proposalFor({}));   // a routine with no movement is not a plan
  } catch (const InvalidTraining&) {
    refused = true;
  }

  CHECK(refused);
  CHECK(h.repo.program.proposalHeads(h.user, ProposalQuery{std::nullopt, false}).empty());
}

TEST(a_proposal_naming_a_routine_this_account_cannot_read_is_the_one_absent_fact) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  createByHand(h, h.other, RoutineWrite{rtId(), "Their plan", 0, {benchEntry()}});

  ProposalMintOutcome minted = h.door.propose(h.user, proposalFor({bench(straight(5, 5, 87.5))}));

  CHECK(minted.error == ProposalMintError::unknownRoutine);
  CHECK_EQ(minted.proposal, std::optional<RoutineProposal>());
}

// A proposal a newer one from the same door replaced refuses the lifter's tap as replaced, even after the routine ALSO moved.
TEST(a_replaced_proposal_says_so_even_after_the_routine_also_moved) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  createByHand(h, h.user, pushAWrite());
  h.door.propose(h.user, proposalFor({bench(straight(5, 3, 87.5))}, "prop_00000001"));
  h.clock.now += 60'000;
  h.door.propose(h.user, proposalFor({bench(straight(5, 3, 90.0))}, "prop_00000002"));   // same door: replaces
  const std::string replaced = R"({"code":"proposal-superseded","detail":{"reason":"replaced"},"s":"refused"})";

  CHECK_EQ(dump(h.door.command(h.user, "gym.applyProposal", proposalArgs("prop_00000001"))), replaced);
  CHECK_EQ(dump(h.door.command(h.user, "gym.dismissProposal", proposalArgs("prop_00000001"))), replaced);
  // The second one lands, so the routine moves; the first is STILL the replaced one.
  h.clock.now += 60'000;
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.applyProposal", proposalArgs("prop_00000002"))),
           std::string());
  CHECK_EQ(h.repo.program.routine(h.user, rtId())->revision, 2);
  CHECK_EQ(dump(h.door.command(h.user, "gym.applyProposal", proposalArgs("prop_00000001"))), replaced);
  CHECK_EQ(dump(h.door.command(h.user, "gym.dismissProposal", proposalArgs("prop_00000001"))), replaced);
}

TEST(a_spent_proposal_id_carrying_a_different_document_is_refused_rather_than_replayed) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  createByHand(h, h.user, pushAWrite());
  ProposalMintOutcome first = h.door.propose(h.user, proposalFor({bench(straight(5, 3, 87.5))}));

  ProposalMintOutcome second = h.door.propose(h.user, proposalFor({bench(straight(5, 12, 60.0))}));
  ProposalMintOutcome replayed = h.door.propose(h.user, proposalFor({bench(straight(5, 3, 87.5))}));

  CHECK(second.error == ProposalMintError::idReused);
  CHECK_EQ(second.proposal, std::optional<RoutineProposal>());
  CHECK_EQ(h.repo.program.proposal(h.user, ProposalId{"prop_00000001"}), first.proposal);
  CHECK_EQ(first.proposal->changes[0].after,
           std::optional<EntryTargets>(EntryTargets{straight(5, 3, 87.5), 180}));
  CHECK_EQ(first.proposal->head.state, ProposalState::pending);
  CHECK(replayed.error == ProposalMintError::none);
  CHECK_EQ(replayed.proposal, first.proposal);
}

TEST(a_proposal_that_only_reorders_the_day_is_minted_rather_than_called_no_change) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  createByHand(h, h.user, pushAWrite(
      {benchEntry(), RoutineEntry{2, ExerciseId{"back-squat"}, straight(3, 8, 100.0), 180}}));

  ProposalMintOutcome minted = h.door.propose(
      h.user, proposalFor({RoutineEntry{1, ExerciseId{"back-squat"}, straight(3, 8, 100.0), 180},
                           benchEntry(2)}));

  REQUIRE(minted.proposal.has_value());
  CHECK(minted.error == ProposalMintError::none);
  CHECK_EQ(minted.proposal->head.changes, 1);
  CHECK_EQ(minted.proposal->changes[0].kind, ChangeKind::kept);
  CHECK_EQ(minted.proposal->changes[1].kind, ChangeKind::kept);
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.applyProposal", proposalArgs("prop_00000001"))),
           std::string());
  CHECK_EQ(h.repo.program.routine(h.user, rtId())->entries[0].exercise, ExerciseId{"back-squat"});
  CHECK_EQ(h.repo.program.routine(h.user, rtId())->entries[1].exercise, ExerciseId{"bench-press"});
}

TEST(a_proposal_of_another_account_is_the_same_fact_as_no_proposal_at_all) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  createByHand(h, h.other, RoutineWrite{rtId("rt_00000002"), "Their plan", 0, {benchEntry()}});
  ProposalWrite theirs = proposalFor({bench(straight(5, 5, 90.0))});
  theirs.routine = rtId("rt_00000002");
  REQUIRE(h.door.propose(h.other, theirs).proposal.has_value());
  const std::string absent = R"({"code":"unknown-record","s":"refused"})";

  CHECK_EQ(h.repo.program.proposal(h.user, ProposalId{"prop_00000001"}), std::optional<RoutineProposal>());
  CHECK(h.repo.program.proposalHeads(h.user, ProposalQuery{std::nullopt, false}).empty());
  CHECK_EQ(dump(h.door.command(h.user, "gym.applyProposal", proposalArgs("prop_00000001"))), absent);
  CHECK_EQ(dump(h.door.command(h.user, "gym.dismissProposal", proposalArgs("prop_00000001"))), absent);
  CHECK_EQ(h.repo.program.routine(h.other, rtId("rt_00000002"))->entries[0].sets, straight(5, 5, 82.5));
}

TEST(applying_a_removal_takes_the_day_out_and_leaves_the_log_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  createByHand(h, h.user, pushAWrite());
  startFrom(h, h.clock.now, "ses_00000001", "rt_00000001");
  h.door.finish(h.user, sid("ses_00000001"), h.clock.now + 1);
  h.door.proposeRemoval(h.user, ProposalId{"prop_00000001"}, rtId(), "Not trained in months.",
                           ProposalSource{ProposalDoor::mcp, "", ""});
  h.clock.now += 60'000;

  const Json::Value tapped = h.door.command(h.user, "gym.applyProposal", proposalArgs("prop_00000001"));

  CHECK_EQ(GymDoor::refusal(tapped), std::string());
  CHECK_EQ(h.repo.program.routine(h.user, rtId()), std::optional<Routine>());
  CHECK_EQ(h.repo.program.proposalHeads(h.user, ProposalQuery{std::nullopt, false}), std::vector<ProposalHead>{});
  CHECK_EQ(h.training.detail(h.user, sid("ses_00000001"))->session.plan->routineName, std::string("Push A"));
}
