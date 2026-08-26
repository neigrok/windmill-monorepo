#include "test/products/gym/adapters/http/GymApiFixture.h"

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>

using namespace wm;
using namespace wm::fake;
using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::apitest;

// ProgramApi over the fake store: routines as one document over four routes, and the proposal ledger.

TEST(gym_routines_round_trip_the_whole_document) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr created = send(h.program, &ProgramApi::createRoutine,
                                         postRequest("/v1/gym/routines", routineBody(), "s-live"));
  drogon::HttpResponsePtr listed =
      send(h.program, &ProgramApi::listRoutines, getRequest("/v1/gym/routines", "s-live"));
  drogon::HttpResponsePtr one = send(h.program, &ProgramApi::getRoutine,
                                     getRequest("/v1/gym/routines/rt_11111111", "s-live"),
                                     "rt_11111111");

  CHECK_EQ(created->getStatusCode(), drogon::k200OK);
  // Entries come back NUMBERED, and the two optionals ride only when they were sent.
  CHECK_EQ(dump(bodyOf(created)),
           std::string(R"({"entries":[{"exerciseId":"bench-press","position":1,"restSeconds":180,)"
                       R"("targetReps":5,"targetSets":5,"targetWeightKg":82.5}],)"
                       R"("id":"rt_11111111","name":"Push A","position":0,"revision":1})"));
  CHECK_EQ(dump(bodyOf(listed)), R"({"routines":[)" + dump(bodyOf(created)) + R"(]})");
  // The single read is the create's reply plus the day's own history, which the LIST does not carry.
  CHECK_EQ(dump(bodyOf(one)),
           std::string(R"({"entries":[{"exerciseId":"bench-press","position":1,"restSeconds":180,)"
                       R"("targetReps":5,"targetSets":5,"targetWeightKg":82.5}],)"
                       R"("history":[{"at":1700000000000,"kind":"created","movements":1}],)"
                       R"("id":"rt_11111111","name":"Push A","position":0,"revision":1})"));
}

TEST(gym_routine_entry_omissions_ride_the_reply_as_omissions) {
  Harness h;
  h.signIn("s-live");
  Json::Value body = routineBody();
  Json::Value bare(Json::objectValue);
  bare["exerciseId"] = "back-squat";
  bare["targetSets"] = 3;
  bare["targetReps"] = 8;
  body["entries"].append(bare);

  drogon::HttpResponsePtr created =
      send(h.program, &ProgramApi::createRoutine, postRequest("/v1/gym/routines", body, "s-live"));

  CHECK_EQ(created->getStatusCode(), drogon::k200OK);
  // No targetWeightKg means "whatever you did last time", and no restSeconds the client's own default.
  CHECK_EQ(dump(bodyOf(created)),
           std::string(R"({"entries":[{"exerciseId":"bench-press","position":1,"restSeconds":180,)"
                       R"("targetReps":5,"targetSets":5,"targetWeightKg":82.5},)"
                       R"({"exerciseId":"back-squat","position":2,"targetReps":8,"targetSets":3}],)"
                       R"("id":"rt_11111111","name":"Push A","position":0,"revision":1})"));
}

// targetReps is omitted on the way out exactly as it was on the way in — never null, never a zero.
TEST(gym_a_routine_line_with_no_rep_target_omits_it_in_and_out) {
  Harness h;
  h.signIn("s-live");
  h.repo.db.seed(Exercise{ExerciseId{"chin-up"}, "Chin-up", Pattern::pull, Equipment::bodyweight, 2.5,
                       false});
  Json::Value body = routineBody();
  Json::Value chinUp(Json::objectValue);
  chinUp["exerciseId"] = "chin-up";
  chinUp["targetSets"] = 3;
  body["entries"] = Json::Value(Json::arrayValue);
  body["entries"].append(chinUp);

  drogon::HttpResponsePtr created =
      send(h.program, &ProgramApi::createRoutine, postRequest("/v1/gym/routines", body, "s-live"));
  Json::Value start = startBody();
  start["routineId"] = "rt_11111111";
  drogon::HttpResponsePtr started =
      send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", start, "s-live"));

  CHECK_EQ(created->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(created)),
           std::string(R"({"entries":[{"exerciseId":"chin-up","position":1,"targetSets":3}],)"
                       R"("id":"rt_11111111","name":"Push A","position":0,"revision":1})"));
  CHECK_EQ(started->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(started)),
           std::string(R"({"id":"ses_11111111","plan":{"entries":[{"exerciseId":"chin-up",)"
                       R"("sets":3}],"routine":"Push A"},"routineId":"rt_11111111",)"
                       R"("startedAt":1700000000000})"));
  // An explicit null reads as the same absence, and the reply omits the field rather than echoing it.
  Json::Value nulled = body;
  nulled["id"] = "rt_22222222";
  nulled["entries"][0]["targetReps"] = Json::nullValue;
  drogon::HttpResponsePtr sentNull =
      send(h.program, &ProgramApi::createRoutine, postRequest("/v1/gym/routines", nulled, "s-live"));
  CHECK_EQ(sentNull->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(sentNull)["entries"]), dump(bodyOf(created)["entries"]));
}

TEST(gym_a_routine_saves_with_an_open_line_and_the_plan_freezes_it_open) {
  Harness h;
  h.signIn("s-live");
  h.repo.db.seed(Exercise{ExerciseId{"barbell-row"}, "Barbell Row", Pattern::pull, Equipment::barbell,
                       2.5, false});
  Json::Value body = routineBody();
  Json::Value open(Json::objectValue);
  open["exerciseId"] = "barbell-row";
  body["entries"].append(open);

  drogon::HttpResponsePtr created =
      send(h.program, &ProgramApi::createRoutine, postRequest("/v1/gym/routines", body, "s-live"));
  Json::Value start = startBody();
  start["routineId"] = "rt_11111111";
  drogon::HttpResponsePtr started =
      send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", start, "s-live"));

  CHECK_EQ(created->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(created)),
           std::string(R"({"entries":[{"exerciseId":"bench-press","position":1,"restSeconds":180,)"
                       R"("targetReps":5,"targetSets":5,"targetWeightKg":82.5},)"
                       R"({"exerciseId":"barbell-row","position":2}],)"
                       R"("id":"rt_11111111","name":"Push A","position":0,"revision":1})"));
  CHECK_EQ(started->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(started)["plan"]),
           std::string(R"({"entries":[{"exerciseId":"bench-press","reps":5,"restSeconds":180,)"
                       R"("sets":5,"weightKg":82.5},{"exerciseId":"barbell-row"}],)"
                       R"("routine":"Push A"})"));
}

TEST(gym_a_routine_line_with_reps_but_no_sets_is_400) {
  Harness h;
  h.signIn("s-live");
  Json::Value body = routineBody();
  body["entries"][0].removeMember("targetSets");

  drogon::HttpResponsePtr response =
      send(h.program, &ProgramApi::createRoutine, postRequest("/v1/gym/routines", body, "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that routine"})"));
  CHECK(h.repo.db.routineRows.empty());
}

TEST(gym_create_routine_with_an_id_another_account_holds_is_409) {
  Harness h;
  h.signIn("s-live");
  h.repo.db.routineRows.push_back(
      Routine{rtId("rt_11111111"), uid("another-account"), "Their plan", 0, {benchEntry()}});

  drogon::HttpResponsePtr response = send(h.program, &ProgramApi::createRoutine,
                                          postRequest("/v1/gym/routines", routineBody(), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"routine-id-taken","error":"that routine id is taken"})"));
  REQUIRE_EQ(h.repo.db.routineRows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.routineRows[0].name, std::string("Their plan"));
}

TEST(gym_create_routine_naming_a_movement_no_catalog_holds_is_400_no_such_exercise) {
  Harness h;
  h.signIn("s-live");
  Json::Value body = routineBody();
  body["entries"].append(entryBody("zercher-squat"));

  drogon::HttpResponsePtr response =
      send(h.program, &ProgramApi::createRoutine, postRequest("/v1/gym/routines", body, "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"unknown-exercise","error":"no such exercise"})"));
  CHECK(h.repo.db.routineRows.empty());
}

TEST(gym_a_routine_that_could_not_be_stored_as_written_is_400) {
  Harness h;
  h.signIn("s-live");
  Json::Value empty = routineBody();
  empty["entries"] = Json::Value(Json::arrayValue);
  Json::Value nameless = routineBody();
  nameless["name"] = "";
  Json::Value tooLong = routineBody();
  tooLong["name"] = std::string(kMaxNameLength + 1, 'x');
  Json::Value badId = routineBody("short");
  Json::Value badEntry = routineBody();
  badEntry["entries"][0]["targetSets"] = 21;
  Json::Value badType = routineBody();
  badType["entries"][0]["targetReps"] = "five";

  for (const Json::Value& body : {empty, nameless, tooLong, badId, badEntry, badType}) {
    drogon::HttpResponsePtr response =
        send(h.program, &ProgramApi::createRoutine, postRequest("/v1/gym/routines", body, "s-live"));
    CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that routine"})"));
  }
  CHECK(h.repo.db.routineRows.empty());
}

// A key the entry schema never declared is REFUSED, never dropped.
TEST(gym_a_routine_entry_key_the_schema_never_declared_is_400_and_nothing_lands) {
  Harness h;
  h.signIn("s-live");
  Json::Value misspelled = routineBody();
  misspelled["entries"][0].removeMember("targetReps");
  misspelled["entries"][0]["targetRepsl"] = 5;

  drogon::HttpResponsePtr response =
      send(h.program, &ProgramApi::createRoutine, postRequest("/v1/gym/routines", misspelled, "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that routine"})"));
  CHECK(h.repo.db.routineRows.empty());
}

// A PUT naming a revision the day has moved past is refused; one naming no revision keeps landing.
TEST(gym_replace_routine_naming_a_stale_revision_is_409_and_writes_nothing) {
  Harness h;
  h.signIn("s-live");
  send(h.program, &ProgramApi::createRoutine, postRequest("/v1/gym/routines", routineBody(), "s-live"));
  Json::Value first = routineBody("rt_11111111", "Push A2");        // revision 1 → 2
  first["revision"] = 1;
  Json::Value stale = routineBody("rt_11111111", "Push A3");        // still names revision 1
  stale["revision"] = 1;
  Json::Value unnamed = routineBody("rt_11111111", "Push A4");      // names none: lands

  drogon::HttpResponsePtr moved = send(h.program, &ProgramApi::replaceRoutine,
                                       putRequest("/v1/gym/routines/rt_11111111", first, "s-live"), "rt_11111111");
  drogon::HttpResponsePtr refused = send(h.program, &ProgramApi::replaceRoutine,
                                         putRequest("/v1/gym/routines/rt_11111111", stale, "s-live"), "rt_11111111");
  drogon::HttpResponsePtr blind = send(h.program, &ProgramApi::replaceRoutine,
                                       putRequest("/v1/gym/routines/rt_11111111", unnamed, "s-live"), "rt_11111111");

  CHECK_EQ(moved->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(moved)["revision"].asInt(), 2);
  CHECK_EQ(refused->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(refused)),
           std::string(R"({"code":"routine-stale","error":"that routine changed since you read it )"
                       R"(\u2014 reload it and save again"})"));
  CHECK_EQ(blind->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(blind)["name"].asString(), std::string("Push A4"));
  CHECK_EQ(bodyOf(blind)["revision"].asInt(), 3);

  // A REPLAY of a revision-named PUT whose bytes already stand reads back what landed.
  Json::Value replayed = routineBody("rt_11111111", "Push A4");
  replayed["revision"] = 2;                                                       // stale by now, identical body
  drogon::HttpResponsePtr again = send(h.program, &ProgramApi::replaceRoutine,
                                       putRequest("/v1/gym/routines/rt_11111111", replayed, "s-live"), "rt_11111111");
  CHECK_EQ(again->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(again)["revision"].asInt(), 3);
}

TEST(gym_replace_routine_rewrites_it_and_a_missing_one_is_404) {
  Harness h;
  h.signIn("s-live");
  send(h.program, &ProgramApi::createRoutine, postRequest("/v1/gym/routines", routineBody(), "s-live"));
  Json::Value rewritten = routineBody("rt_11111111", "Push A2");
  rewritten["entries"][0] = entryBody("back-squat", 4, 6);

  drogon::HttpResponsePtr replaced =
      send(h.program, &ProgramApi::replaceRoutine,
           putRequest("/v1/gym/routines/rt_11111111", rewritten, "s-live"), "rt_11111111");
  drogon::HttpResponsePtr missing =
      send(h.program, &ProgramApi::replaceRoutine,
           putRequest("/v1/gym/routines/rt_99999999", rewritten, "s-live"), "rt_99999999");

  CHECK_EQ(replaced->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(replaced)),
           std::string(R"({"entries":[{"exerciseId":"back-squat","position":1,"restSeconds":180,)"
                       R"("targetReps":6,"targetSets":4,"targetWeightKg":82.5}],)"
                       R"("id":"rt_11111111","name":"Push A2","position":0,"revision":2})"));
  CHECK_EQ(missing->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(missing)), std::string(R"({"error":"no such routine"})"));
  CHECK_EQ(h.repo.db.routineRows.size(), static_cast<std::size_t>(1));
}

TEST(gym_another_accounts_routine_is_404_on_every_route) {
  Harness h;
  h.signIn("s-live");
  h.repo.db.routineRows.push_back(
      Routine{rtId("rt_11111111"), uid("another-account"), "Their plan", 0, {benchEntry()}});

  drogon::HttpResponsePtr read = send(h.program, &ProgramApi::getRoutine,
                                      getRequest("/v1/gym/routines/rt_11111111", "s-live"),
                                      "rt_11111111");
  drogon::HttpResponsePtr removed = send(h.program, &ProgramApi::deleteRoutine,
                                         deleteRequest("/v1/gym/routines/rt_11111111", "s-live"),
                                         "rt_11111111");
  drogon::HttpResponsePtr listed =
      send(h.program, &ProgramApi::listRoutines, getRequest("/v1/gym/routines", "s-live"));

  CHECK_EQ(read->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(read)), std::string(R"({"error":"no such routine"})"));
  CHECK_EQ(removed->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(listed)), std::string(R"({"routines":[]})"));
  CHECK_EQ(h.repo.db.routineRows.size(), static_cast<std::size_t>(1));
}

TEST(gym_delete_routine_is_204_with_no_body_and_then_404) {
  Harness h;
  h.signIn("s-live");
  send(h.program, &ProgramApi::createRoutine, postRequest("/v1/gym/routines", routineBody(), "s-live"));

  drogon::HttpResponsePtr removed = send(h.program, &ProgramApi::deleteRoutine,
                                         deleteRequest("/v1/gym/routines/rt_11111111", "s-live"),
                                         "rt_11111111");
  drogon::HttpResponsePtr again = send(h.program, &ProgramApi::deleteRoutine,
                                       deleteRequest("/v1/gym/routines/rt_11111111", "s-live"),
                                       "rt_11111111");

  CHECK_EQ(removed->getStatusCode(), drogon::k204NoContent);
  CHECK(removed->getBody().empty());
  CHECK_EQ(again->getStatusCode(), drogon::k404NotFound);
  CHECK(h.repo.db.routineRows.empty());
}

namespace {
RoutineProposal proposedFor(const UserId& owner, std::vector<RoutineEntry> becomes,
                            const std::string& id = "prop_11111111", int baseRevision = 1) {
  const std::vector<RoutineEntry> base{benchEntry()};
  std::vector<RoutineChange> changes = changesBetween(base, becomes);
  return RoutineProposal{ProposalHead{ProposalId{id}, rtId("rt_11111111"), owner,
                                      ProposalIntent::revise, ProposalState::pending,
                                      ProposalSource{ProposalDoor::mcp, "", ""},
                                      "Heavier triples.",
                                      countedChanges(base, changes, "Push A", "Push A"),
                                      1'700'000'000'000ull, std::nullopt},
                         baseRevision, "Push A", "Push A", std::move(changes)};
}

RoutineEntry benchAt(double weightKg, int reps) {
  return RoutineEntry{1, ExerciseId{"bench-press"}, 5, reps, weightKg, 180};
}
}

// `changes` are the rows a lifter reads; `changeCount` is what the button counts.
TEST(gym_a_proposal_reads_as_a_typed_field_level_diff) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  h.repo.db.routineRows.push_back(Routine{rtId("rt_11111111"), caller, "Push A", 0, {benchEntry()}});
  h.repo.db.proposalRows.push_back(proposedFor(caller, {benchAt(87.5, 3)}));

  drogon::HttpResponsePtr read =
      send(h.program, &ProgramApi::getProposal, getRequest("/v1/gym/proposals/prop_11111111", "s-live"),
           "prop_11111111");

  CHECK_EQ(read->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(read)),
           std::string(R"({"baseName":"Push A","baseRevision":1,)"
                       R"("changeCount":1,)"
                       R"("changes":[{"after":{"reps":3,"restSeconds":180,"sets":5,)"
                       R"("weightKg":87.5},"before":{"reps":5,"restSeconds":180,"sets":5,)"
                       R"("weightKg":82.5},"exerciseId":"bench-press","kind":"retargeted",)"
                       R"("position":1}],"createdAt":1700000000000,"id":"prop_11111111",)"
                       R"("intent":"revise","name":"Push A","routineId":"rt_11111111",)"
                       R"("source":{"door":"mcp"},"state":"pending","summary":"Heavier triples."})"));
}

TEST(gym_applying_a_proposal_writes_the_whole_document_and_settles_the_card) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  h.repo.db.routineRows.push_back(Routine{rtId("rt_11111111"), caller, "Push A", 0, {benchEntry()}});
  h.repo.db.proposalRows.push_back(proposedFor(caller, {benchAt(87.5, 3)}));

  drogon::HttpResponsePtr applied =
      send(h.program, &ProgramApi::applyProposal,
           postRequest("/v1/gym/proposals/prop_11111111/apply", Json::Value(Json::objectValue),
                       "s-live"),
           "prop_11111111");

  CHECK_EQ(applied->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(applied)["proposal"]["state"].asString(), std::string("applied"));
  CHECK_EQ(bodyOf(applied)["proposal"]["settledAt"].asUInt64(), h.clock.now);
  CHECK_EQ(bodyOf(applied)["routine"]["revision"].asInt(), 2);
  CHECK_EQ(bodyOf(applied)["routine"]["entries"][0]["targetWeightKg"].asDouble(), 87.5);
  CHECK_EQ(bodyOf(applied)["routine"]["entries"][0]["targetReps"].asInt(), 3);
}

TEST(gym_a_routine_the_lifter_rewrote_refuses_the_proposal_that_predates_it) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  send(h.program, &ProgramApi::createRoutine, postRequest("/v1/gym/routines", routineBody(), "s-live"));
  h.repo.db.proposalRows.push_back(proposedFor(caller, {benchAt(87.5, 3)}));

  Json::Value rewritten = routineBody("rt_11111111", "Push A");
  rewritten["entries"][0]["targetWeightKg"] = 85.0;
  send(h.program, &ProgramApi::replaceRoutine,
       putRequest("/v1/gym/routines/rt_11111111", rewritten, "s-live"), "rt_11111111");
  drogon::HttpResponsePtr refused =
      send(h.program, &ProgramApi::applyProposal,
           postRequest("/v1/gym/proposals/prop_11111111/apply", Json::Value(Json::objectValue),
                       "s-live"),
           "prop_11111111");

  CHECK_EQ(refused->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(bodyOf(refused)["code"].asString(), std::string("proposal-superseded"));
  drogon::HttpResponsePtr routine =
      send(h.program, &ProgramApi::getRoutine, getRequest("/v1/gym/routines/rt_11111111", "s-live"),
           "rt_11111111");
  CHECK_EQ(bodyOf(routine)["entries"][0]["targetWeightKg"].asDouble(), 85.0);
  CHECK_EQ(bodyOf(routine)["revision"].asInt(), 2);
  drogon::HttpResponsePtr history = send(
      h.program, &ProgramApi::listProposals,
      getRequest("/v1/gym/proposals?routineId=rt_11111111", "s-live"));
  CHECK_EQ(bodyOf(history)["proposals"][0]["state"].asString(), std::string("superseded"));
}

// Asking again for the SAME decision replays 200; the other one is 409.
TEST(gym_dismissing_a_proposal_changes_nothing_and_the_other_decision_is_refused) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  h.repo.db.routineRows.push_back(Routine{rtId("rt_11111111"), caller, "Push A", 0, {benchEntry()}});
  h.repo.db.proposalRows.push_back(proposedFor(caller, {benchAt(87.5, 3)}));

  drogon::HttpResponsePtr dismissed =
      send(h.program, &ProgramApi::dismissProposal,
           postRequest("/v1/gym/proposals/prop_11111111/dismiss", Json::Value(Json::objectValue),
                       "s-live"),
           "prop_11111111");
  drogon::HttpResponsePtr again =
      send(h.program, &ProgramApi::dismissProposal,
           postRequest("/v1/gym/proposals/prop_11111111/dismiss", Json::Value(Json::objectValue),
                       "s-live"),
           "prop_11111111");
  drogon::HttpResponsePtr applied =
      send(h.program, &ProgramApi::applyProposal,
           postRequest("/v1/gym/proposals/prop_11111111/apply", Json::Value(Json::objectValue),
                       "s-live"),
           "prop_11111111");

  CHECK_EQ(dismissed->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(dismissed)["proposal"]["state"].asString(), std::string("dismissed"));
  CHECK_EQ(again->getStatusCode(), drogon::k200OK);   // the replayed tap is not a failure
  CHECK_EQ(applied->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(bodyOf(applied)["code"].asString(), std::string("proposal-settled"));
  CHECK_EQ(h.repo.db.routineRows[0].entries[0].targetWeightKg, std::optional<double>(82.5));
  CHECK_EQ(h.repo.db.routineRows[0].revision, 1);
}

TEST(gym_another_accounts_proposal_is_404_on_every_route) {
  Harness h;
  h.signIn("s-live");
  h.repo.db.routineRows.push_back(
      Routine{rtId("rt_11111111"), uid("another-account"), "Their plan", 0, {benchEntry()}});
  h.repo.db.proposalRows.push_back(proposedFor(uid("another-account"), {benchAt(87.5, 3)}));

  drogon::HttpResponsePtr read =
      send(h.program, &ProgramApi::getProposal, getRequest("/v1/gym/proposals/prop_11111111", "s-live"),
           "prop_11111111");
  drogon::HttpResponsePtr applied =
      send(h.program, &ProgramApi::applyProposal,
           postRequest("/v1/gym/proposals/prop_11111111/apply", Json::Value(Json::objectValue),
                       "s-live"),
           "prop_11111111");
  drogon::HttpResponsePtr listed =
      send(h.program, &ProgramApi::listProposals, getRequest("/v1/gym/proposals", "s-live"));

  CHECK_EQ(read->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(read)), std::string(R"({"error":"no such proposal"})"));
  CHECK_EQ(applied->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(bodyOf(listed)["proposals"].size(), 0u);
  CHECK_EQ(h.repo.db.routineRows[0].entries[0].targetWeightKg, std::optional<double>(82.5));
}

TEST(gym_every_proposal_route_refuses_a_caller_with_no_session) {
  Harness h;

  CHECK_EQ(send(h.program, &ProgramApi::listProposals, getRequest("/v1/gym/proposals"))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.program, &ProgramApi::getProposal, getRequest("/v1/gym/proposals/prop_11111111"),
                "prop_11111111")
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.program, &ProgramApi::applyProposal,
                postRequest("/v1/gym/proposals/prop_11111111/apply", Json::Value(Json::objectValue)),
                "prop_11111111")
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.program, &ProgramApi::dismissProposal,
                postRequest("/v1/gym/proposals/prop_11111111/dismiss",
                            Json::Value(Json::objectValue)),
                "prop_11111111")
               ->getStatusCode(),
           drogon::k401Unauthorized);
}

TEST(gym_the_routines_list_carries_the_proposal_waiting_on_a_day_of_the_program) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  h.repo.db.routineRows.push_back(Routine{rtId("rt_11111111"), caller, "Push A", 0, {benchEntry()}});

  drogon::HttpResponsePtr quiet =
      send(h.program, &ProgramApi::listRoutines, getRequest("/v1/gym/routines", "s-live"));
  h.repo.db.proposalRows.push_back(proposedFor(caller, {benchAt(87.5, 3)}));
  drogon::HttpResponsePtr waiting =
      send(h.program, &ProgramApi::listRoutines, getRequest("/v1/gym/routines", "s-live"));

  CHECK(bodyOf(quiet)["routines"][0]["pendingProposal"].isNull());
  CHECK_EQ(dump(bodyOf(waiting)["routines"][0]["pendingProposal"]),
           std::string(R"({"changeCount":1,"createdAt":1700000000000,"id":"prop_11111111",)"
                       R"("intent":"revise","routineId":"rt_11111111","source":{"door":"mcp"},)"
                       R"("state":"pending","summary":"Heavier triples."})"));
}

// The superseded refusal: one code, three true sentences, and the store says which. A newer
// proposal from the same door replaced it (and still did after the routine moved); the routine
// moved under it; or it was superseded before the reason was recorded.
TEST(gym_the_superseded_refusal_says_why_on_apply_and_on_dismiss) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  h.repo.db.routineRows.push_back(Routine{rtId("rt_11111111"), caller, "Push A", 0, {benchEntry()}});
  h.repo.db.proposalRows.push_back(proposedFor(caller, {benchAt(87.5, 3)}, "prop_11111111"));
  h.repo.db.proposalRows.push_back(proposedFor(caller, {benchAt(87.5, 3)}, "prop_33333333"));
  h.repo.db.proposalRows.back().head.state = ProposalState::superseded;   // a legacy row, no reason
  h.repo.db.proposalRows.back().head.settledAtMs = 1'700'000'000'000ull;
  const auto apply = [&](const std::string& id) {
    return send(h.program, &ProgramApi::applyProposal,
                postRequest("/v1/gym/proposals/" + id + "/apply", Json::Value(Json::objectValue),
                            "s-live"),
                id);
  };
  const auto dismiss = [&](const std::string& id) {
    return send(h.program, &ProgramApi::dismissProposal,
                postRequest("/v1/gym/proposals/" + id + "/dismiss", Json::Value(Json::objectValue),
                            "s-live"),
                id);
  };
  const auto refused = [&](const drogon::HttpResponsePtr& response) {
    CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
    CHECK_EQ(bodyOf(response)["code"].asString(), std::string("proposal-superseded"));
    return bodyOf(response)["error"].asString();
  };

  CHECK_EQ(refused(apply("prop_33333333")),
           std::string("this proposal was superseded before it was applied"));
  CHECK_EQ(refused(dismiss("prop_33333333")),
           std::string("this proposal was superseded before it was turned down"));

  // The same door and connection mints again: the first is replaced, and says so.
  h.programService->propose(caller, ProposalWrite{ProposalId{"prop_22222222"}, rtId("rt_11111111"),
                                                  std::nullopt, "Heavier still.", {benchAt(90.0, 3)},
                                                  ProposalSource{ProposalDoor::mcp, "", ""}});
  CHECK_EQ(refused(apply("prop_11111111")),
           std::string("a newer proposal replaced this one, so it was not applied"));
  CHECK_EQ(refused(dismiss("prop_11111111")),
           std::string("a newer proposal replaced this one, so it was not turned down"));

  // The replacement lands and the routine moves: the replaced one STILL says replaced, the legacy
  // row now says the routine moved, because the revision no longer matches.
  CHECK_EQ(apply("prop_22222222")->getStatusCode(), drogon::k200OK);
  CHECK_EQ(refused(apply("prop_11111111")),
           std::string("a newer proposal replaced this one, so it was not applied"));
  CHECK_EQ(refused(dismiss("prop_11111111")),
           std::string("a newer proposal replaced this one, so it was not turned down"));
  CHECK_EQ(refused(apply("prop_33333333")),
           std::string("that routine changed after this proposal was written, so it was not applied"));
  CHECK_EQ(refused(dismiss("prop_33333333")),
           std::string("that routine changed after this proposal was written, so it was not turned down"));

  // A pending proposal the lifter's own rewrite outran: the routine moved.
  h.repo.db.proposalRows.push_back(proposedFor(caller, {benchAt(95.0, 3)}, "prop_44444444", 2));
  Json::Value rewritten = routineBody("rt_11111111", "Push A");
  rewritten["entries"][0]["targetWeightKg"] = 85.0;
  send(h.program, &ProgramApi::replaceRoutine,
       putRequest("/v1/gym/routines/rt_11111111", rewritten, "s-live"), "rt_11111111");
  CHECK_EQ(refused(apply("prop_44444444")),
           std::string("that routine changed after this proposal was written, so it was not applied"));
  CHECK_EQ(refused(dismiss("prop_44444444")),
           std::string("that routine changed after this proposal was written, so it was not turned down"));
}

// `changeCount` is the unit the review's button, the card and the receipt all count: a ROW of the
// document that is not `kept`, plus one for a renamed routine — never a field, so a row that moves
// three targets is one change, and the kept rows the sheet collapses to "and N lines unchanged"
// count for nothing. The head and the whole document carry the same number.
TEST(gym_change_count_is_rows_that_are_not_kept_plus_a_rename_never_fields) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  h.repo.db.seed(Exercise{ExerciseId{"chin-up"}, "Chin-up", Pattern::pull, Equipment::bodyweight, 2.5,
                          false});
  const std::vector<RoutineEntry> base{
      RoutineEntry{1, ExerciseId{"bench-press"}, 5, 5, 82.5, 180},
      RoutineEntry{2, ExerciseId{"back-squat"}, 3, 8, 100.0, 240},
      RoutineEntry{3, ExerciseId{"chin-up"}, 3, std::nullopt, std::nullopt, 120}};
  h.repo.db.routineRows.push_back(Routine{rtId("rt_11111111"), caller, "Push A", 0, base});
  // One row moving three fields, one kept, one removed, one added, and a rename.
  const std::vector<RoutineEntry> proposed{
      RoutineEntry{1, ExerciseId{"bench-press"}, 5, 3, 90.0, 240},
      RoutineEntry{2, ExerciseId{"back-squat"}, 3, 8, 100.0, 240},
      RoutineEntry{3, ExerciseId{"chin-up"}, 3, std::nullopt, std::nullopt, 120}};
  const ProposalMintOutcome minted = h.programService->propose(
      caller, ProposalWrite{ProposalId{"prop_11111111"}, rtId("rt_11111111"), "Push A — heavy",
                            "Heavier triples.", proposed,
                            ProposalSource{ProposalDoor::mcp, "", ""}});
  REQUIRE(minted.error == ProposalMintError::none);

  const Json::Value whole = bodyOf(send(h.program, &ProgramApi::getProposal,
                                        getRequest("/v1/gym/proposals/prop_11111111", "s-live"),
                                        "prop_11111111"));
  int notKept = 0;
  int kept = 0;
  for (const Json::Value& row : whole["changes"]) (row["kind"].asString() == "kept" ? kept : notKept)++;
  CHECK_EQ(kept, 2);
  CHECK_EQ(notKept, 1);
  CHECK_EQ(whole["changes"].size(), 3u);   // the rows are the document: kept rows travel
  CHECK_EQ(whole["changes"][0]["kind"].asString(), std::string("retargeted"));
  CHECK_EQ(whole["changeCount"].asInt(), notKept + 1);   // + the rename, one change with no row
  CHECK_EQ(whole["changeCount"].asInt(), 2);
  const Json::Value heads = bodyOf(send(h.program, &ProgramApi::listProposals,
                                        getRequest("/v1/gym/proposals", "s-live")));
  CHECK_EQ(heads["proposals"][0]["changeCount"].asInt(), whole["changeCount"].asInt());

  // The same document with no rename: the three moved fields are still ONE change.
  h.repo.db.proposalRows.clear();
  const ProposalMintOutcome fieldsOnly = h.programService->propose(
      caller, ProposalWrite{ProposalId{"prop_22222222"}, rtId("rt_11111111"), std::nullopt,
                            "Heavier triples.", proposed,
                            ProposalSource{ProposalDoor::mcp, "", ""}});
  REQUIRE(fieldsOnly.error == ProposalMintError::none);
  const Json::Value one = bodyOf(send(h.program, &ProgramApi::getProposal,
                                      getRequest("/v1/gym/proposals/prop_22222222", "s-live"),
                                      "prop_22222222"));
  CHECK_EQ(one["changeCount"].asInt(), 1);
  CHECK_EQ(one["changes"][0]["before"]["reps"].asInt(), 5);
  CHECK_EQ(one["changes"][0]["after"]["reps"].asInt(), 3);
  CHECK_EQ(one["changes"][0]["after"]["weightKg"].asDouble(), 90.0);
  CHECK_EQ(one["changes"][0]["after"]["restSeconds"].asInt(), 240);

  // Added and removed rows are one change each; the kept row still none.
  h.repo.db.proposalRows.clear();
  const std::vector<RoutineEntry> reshaped{
      RoutineEntry{1, ExerciseId{"bench-press"}, 5, 5, 82.5, 180},
      RoutineEntry{2, ExerciseId{"chin-up"}, 3, std::nullopt, std::nullopt, 120},
      RoutineEntry{3, ExerciseId{"back-squat"}, 3, 8, 100.0, 240},
      RoutineEntry{4, ExerciseId{"bench-press"}, 3, 10, 60.0, 90}};
  const ProposalMintOutcome addedOne = h.programService->propose(
      caller, ProposalWrite{ProposalId{"prop_33333333"}, rtId("rt_11111111"), std::nullopt,
                            "A second bench line.", reshaped,
                            ProposalSource{ProposalDoor::mcp, "", ""}});
  REQUIRE(addedOne.error == ProposalMintError::none);
  const Json::Value reordered = bodyOf(send(h.program, &ProgramApi::getProposal,
                                            getRequest("/v1/gym/proposals/prop_33333333", "s-live"),
                                            "prop_33333333"));
  int rowsMoved = 0;
  for (const Json::Value& row : reordered["changes"])
    if (row["kind"].asString() != "kept") ++rowsMoved;
  CHECK_EQ(rowsMoved, 1);   // the added line; the three kept lines in a new order are a reorder
  CHECK_EQ(reordered["changeCount"].asInt(), rowsMoved + 1);   // + one for the reorder of the run
}
