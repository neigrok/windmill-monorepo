#include "test/products/gym/adapters/http/GymApiFixture.h"

#include <cstdint>
#include <cstdlib>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::fake;
using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::apitest;

// ProgramApi: routines and the proposal ledger read over the fake store; what a door's write leaves, read over GymDoor.

TEST(gym_routines_list_and_read_the_whole_document) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  h.repo.db.routineRows.push_back(Routine{rtId("rt_11111111"), caller, "Push A", 0, {benchEntry()}});
  h.repo.db.createdRoutines["rt_11111111"] = FakeGymStore::Created{1'700'000'000'000, std::nullopt, 1};

  drogon::HttpResponsePtr listed =
      send(h.program, &ProgramApi::listRoutines, getRequest("/v1/gym/routines", "s-live"));
  drogon::HttpResponsePtr one = send(h.program, &ProgramApi::getRoutine,
                                     getRequest("/v1/gym/routines/rt_11111111", "s-live"),
                                     "rt_11111111");

  CHECK_EQ(listed->getStatusCode(), drogon::k200OK);
  // Entries come back NUMBERED, one object per set, and the optionals ride only when they are stored.
  CHECK_EQ(dump(bodyOf(listed)),
           std::string(R"({"routines":[{"entries":[{"exerciseId":"bench-press","position":1,"restSeconds":180,)"
                       R"("sets":[{"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5}]}],)"
                       R"("id":"rt_11111111","name":"Push A","position":0,"revision":1}]})"));
  // The single read is the list's row plus the day's own history, which the LIST does not carry.
  CHECK_EQ(one->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(one)),
           std::string(R"({"entries":[{"exerciseId":"bench-press","position":1,"restSeconds":180,)"
                       R"("sets":[{"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5}]}],)"
                       R"("history":[{"at":1700000000000,"kind":"created","movements":1}],)"
                       R"("id":"rt_11111111","name":"Push A","position":0,"revision":1})"));
}

// The Lower A ramp — five sets, no two alike — reads back set by set, byte for byte.
TEST(gym_a_ramp_reads_back_set_by_set) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  h.repo.db.routineRows.push_back(Routine{rtId("rt_11111111"), caller, "Lower A", 0,
                                          {RoutineEntry{1, ExerciseId{"back-squat"}, ramp(), 180}}});

  drogon::HttpResponsePtr one = send(h.program, &ProgramApi::getRoutine,
                                     getRequest("/v1/gym/routines/rt_11111111", "s-live"),
                                     "rt_11111111");

  CHECK_EQ(one->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(one)["entries"]),
           std::string(R"([{"exerciseId":"back-squat","position":1,"restSeconds":180,)"
                       R"("sets":[{"reps":5,"weightKg":60.0},{"reps":5,"weightKg":80.0},)"
                       R"({"reps":3,"weightKg":90.0},{"reps":1,"weightKg":100.0},)"
                       R"({"reps":5,"weightKg":80.0}]}])"));
}

TEST(gym_routine_entry_omissions_ride_the_read_as_omissions) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  h.repo.db.routineRows.push_back(
      Routine{rtId("rt_11111111"), caller, "Push A", 0,
              {benchEntry(), RoutineEntry{2, ExerciseId{"back-squat"}, straight(3, 8, std::nullopt), std::nullopt}}});

  drogon::HttpResponsePtr listed =
      send(h.program, &ProgramApi::listRoutines, getRequest("/v1/gym/routines", "s-live"));

  CHECK_EQ(listed->getStatusCode(), drogon::k200OK);
  // A set with no weightKg means "whatever you did last time", and no restSeconds the client's own default.
  CHECK_EQ(dump(bodyOf(listed)),
           std::string(R"({"routines":[{"entries":[{"exerciseId":"bench-press","position":1,"restSeconds":180,)"
                       R"("sets":[{"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5}]},)"
                       R"({"exerciseId":"back-squat","position":2,"sets":[{"reps":8},{"reps":8},)"
                       R"({"reps":8}]}],)"
                       R"("id":"rt_11111111","name":"Push A","position":0,"revision":1}]})"));
}

// A set's reps are omitted on the way out exactly as they came in — never null, never a zero. A set
// of nothing at all, `{}`, is a legal set: max reps at last time's load.
TEST(gym_a_set_with_no_rep_target_omits_it_in_and_out) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  Json::Value body = routineBody();
  Json::Value dip(Json::objectValue);
  dip["exerciseId"] = "dip";
  dip["sets"] = setsBody(straight(3, std::nullopt, std::nullopt));
  body["entries"] = Json::Value(Json::arrayValue);
  body["entries"].append(dip);
  REQUIRE(!h.call("create_routine", body).isError);
  REQUIRE(h.door.start(h.user, SessionStart{sid("ses_11111111"), 1'700'000'000'000, true, rtId("rt_11111111")})
              .session);

  drogon::HttpResponsePtr routine =
      send(h.programApi, &ProgramApi::getRoutine, getRequest("/v1/gym/routines/rt_11111111", "s-door"), "rt_11111111");
  drogon::HttpResponsePtr detail = send(h.trainingApi, &TrainingApi::getSession,
                                        getRequest("/v1/gym/sessions/ses_11111111", "s-door"), "ses_11111111");

  CHECK_EQ(routine->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(routine)["entries"]),
           std::string(R"([{"exerciseId":"dip","position":1,"sets":[{},{},{}]}])"));
  CHECK_EQ(detail->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(detail)["session"]),
           std::string(R"({"id":"ses_11111111","plan":{"entries":[{"exerciseId":"dip",)"
                       R"("sets":[{},{},{}]}],"routine":"Push A"},"routineId":"rt_11111111",)"
                       R"("startedAt":1700000000000})"));
  // An explicit null reads as the same absence, and the read omits the field rather than echoing it.
  Json::Value nulled = body;
  nulled["id"] = "rt_22222222";
  nulled["entries"][0]["sets"][0]["reps"] = Json::nullValue;
  nulled["entries"][0]["sets"][1]["weightKg"] = Json::nullValue;
  REQUIRE(!h.call("create_routine", nulled).isError);
  drogon::HttpResponsePtr sentNull =
      send(h.programApi, &ProgramApi::getRoutine, getRequest("/v1/gym/routines/rt_22222222", "s-door"), "rt_22222222");
  CHECK_EQ(sentNull->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(sentNull)["entries"]), dump(bodyOf(routine)["entries"]));
  CHECK(h.failures.messages.empty());
}

TEST(gym_a_routine_saves_with_an_open_line_and_the_plan_freezes_it_open) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  Json::Value body = routineBody();
  Json::Value open(Json::objectValue);
  open["exerciseId"] = "dip";
  body["entries"].append(open);
  REQUIRE(!h.call("create_routine", body).isError);
  REQUIRE(h.door.start(h.user, SessionStart{sid("ses_11111111"), 1'700'000'000'000, true, rtId("rt_11111111")})
              .session);

  drogon::HttpResponsePtr routine =
      send(h.programApi, &ProgramApi::getRoutine, getRequest("/v1/gym/routines/rt_11111111", "s-door"), "rt_11111111");
  drogon::HttpResponsePtr detail = send(h.trainingApi, &TrainingApi::getSession,
                                        getRequest("/v1/gym/sessions/ses_11111111", "s-door"), "ses_11111111");

  CHECK_EQ(routine->getStatusCode(), drogon::k200OK);
  // The open line carries no `sets` key at all — never an empty array.
  CHECK_EQ(dump(bodyOf(routine)["entries"]),
           std::string(R"([{"exerciseId":"bench-press","position":1,"restSeconds":180,)"
                       R"("sets":[{"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5}]},)"
                       R"({"exerciseId":"dip","position":2}])"));
  CHECK_EQ(detail->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(detail)["session"]["plan"]),
           std::string(R"({"entries":[{"exerciseId":"bench-press","restSeconds":180,)"
                       R"("sets":[{"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5}]},{"exerciseId":"dip"}],)"
                       R"("routine":"Push A"})"));
  // A `sets` of null is the same open line as no `sets` at all.
  Json::Value nulled = body;
  nulled["id"] = "rt_22222222";
  nulled["entries"][1]["sets"] = Json::nullValue;
  REQUIRE(!h.call("create_routine", nulled).isError);
  drogon::HttpResponsePtr sentNull =
      send(h.programApi, &ProgramApi::getRoutine, getRequest("/v1/gym/routines/rt_22222222", "s-door"), "rt_22222222");
  CHECK_EQ(sentNull->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(sentNull)["entries"]), dump(bodyOf(routine)["entries"]));
  CHECK(h.failures.messages.empty());
}

TEST(gym_another_accounts_routine_is_404_on_every_route) {
  Harness h;
  h.signIn("s-live");
  h.repo.db.routineRows.push_back(
      Routine{rtId("rt_11111111"), uid("another-account"), "Their plan", 0, {benchEntry()}});

  drogon::HttpResponsePtr read = send(h.program, &ProgramApi::getRoutine,
                                      getRequest("/v1/gym/routines/rt_11111111", "s-live"),
                                      "rt_11111111");
  drogon::HttpResponsePtr listed =
      send(h.program, &ProgramApi::listRoutines, getRequest("/v1/gym/routines", "s-live"));

  CHECK_EQ(read->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(read)), std::string(R"({"error":"no such routine"})"));
  CHECK_EQ(dump(bodyOf(listed)), std::string(R"({"routines":[]})"));
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
  return RoutineEntry{1, ExerciseId{"bench-press"}, straight(5, reps, weightKg), 180};
}
}

// `changes` are the rows a lifter reads; `changeCount` is what the button counts. Each side of a
// retargeted row carries the WHOLE scheme, so the sheet draws two complete lines, not a field.
TEST(gym_a_proposal_reads_as_a_typed_row_level_diff) {
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
                       R"("changes":[{"after":{"restSeconds":180,"sets":[{"reps":3,"weightKg":87.5},)"
                       R"({"reps":3,"weightKg":87.5},{"reps":3,"weightKg":87.5},)"
                       R"({"reps":3,"weightKg":87.5},{"reps":3,"weightKg":87.5}]},)"
                       R"("before":{"restSeconds":180,"sets":[{"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5}]},)"
                       R"("exerciseId":"bench-press","kind":"retargeted",)"
                       R"("position":1}],"createdAt":1700000000000,"id":"prop_11111111",)"
                       R"("intent":"revise","name":"Push A","routineId":"rt_11111111",)"
                       R"("source":{"door":"mcp"},"state":"pending","summary":"Heavier triples."})"));
}

// Moving ONE set of a ramp is one retargeted row, and each side of it carries the whole five-set
// scheme: the sheet draws the ramp before and the ramp after, never a lone fourth set.
TEST(gym_a_proposal_moving_one_set_of_a_ramp_is_one_row_carrying_both_whole_schemes) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  REQUIRE_EQ(h.door.createRoutine(h.user,
                                     RoutineWrite{rtId("rt_11111111"), "Lower A", 0,
                                                  {RoutineEntry{1, ExerciseId{"back-squat"}, ramp(), 180}}},
                                     ProposalDoor::mcp).error, RoutineWriteError::none);
  std::vector<SetTarget> heavier = ramp();
  heavier[3] = SetTarget{1, 102.5};
  const ProposalMintOutcome minted = h.door.propose(
      h.user, ProposalWrite{ProposalId{"prop_11111111"}, rtId("rt_11111111"), std::nullopt,
                            "A heavier single.",
                            {RoutineEntry{1, ExerciseId{"back-squat"}, heavier, 180}},
                            ProposalSource{ProposalDoor::mcp, "", ""}});
  REQUIRE(minted.error == ProposalMintError::none);

  drogon::HttpResponsePtr read =
      send(h.programApi, &ProgramApi::getProposal, getRequest("/v1/gym/proposals/prop_11111111", "s-door"),
           "prop_11111111");

  CHECK_EQ(read->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(read)),
           std::string(R"({"baseName":"Lower A","baseRevision":1,"changeCount":1,)"
                       R"("changes":[{"after":{"restSeconds":180,"sets":[{"reps":5,"weightKg":60.0},)"
                       R"({"reps":5,"weightKg":80.0},{"reps":3,"weightKg":90.0},)"
                       R"({"reps":1,"weightKg":102.5},{"reps":5,"weightKg":80.0}]},)"
                       R"("before":{"restSeconds":180,"sets":[{"reps":5,"weightKg":60.0},)"
                       R"({"reps":5,"weightKg":80.0},{"reps":3,"weightKg":90.0},)"
                       R"({"reps":1,"weightKg":100.0},{"reps":5,"weightKg":80.0}]},)"
                       R"("exerciseId":"back-squat","kind":"retargeted","position":1}],)"
                       R"("createdAt":1700000000000,"id":"prop_11111111","intent":"revise",)"
                       R"("name":"Lower A","routineId":"rt_11111111","source":{"door":"mcp"},)"
                       R"("state":"pending","summary":"A heavier single."})"));
  CHECK(h.failures.messages.empty());
}

// The lifter's rewrite arrives from a phone: it moves the revision and supersedes the proposal the apply then refuses.
TEST(gym_a_routine_the_lifter_rewrote_refuses_the_proposal_that_predates_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  REQUIRE_EQ(h.door.createRoutine(h.user, RoutineWrite{rtId("rt_11111111"), "Push A", 0, {benchEntry()}},
                                     ProposalDoor::mcp).error, RoutineWriteError::none);
  REQUIRE(h.door.propose(h.user, ProposalWrite{ProposalId{"prop_11111111"}, rtId("rt_11111111"), std::nullopt,
                                                  "Heavier triples.", {benchAt(87.5, 3)},
                                                  ProposalSource{ProposalDoor::mcp, "", ""}})
              .error == ProposalMintError::none);
  Json::Value rewritten(Json::objectValue);
  rewritten["entries"] = Json::Value(Json::arrayValue);
  rewritten["entries"].append(entryBody());
  rewritten["entries"][0]["sets"] = setsBody(straight(5, 5, 85.0));
  GymDoor::requireOk(h.admit(h.user, {GymDoor::delta("routine", "rt_11111111", rewritten)}));
  Json::Value apply(Json::objectValue);
  apply["proposalId"] = "prop_11111111";

  const Json::Value refused = h.door.command(h.user, "gym.applyProposal", apply);

  CHECK_EQ(GymDoor::refusal(refused), std::string("proposal-superseded"));
  drogon::HttpResponsePtr routine =
      send(h.programApi, &ProgramApi::getRoutine, getRequest("/v1/gym/routines/rt_11111111", "s-door"),
           "rt_11111111");
  CHECK_EQ(dump(bodyOf(routine)["entries"][0]["sets"]), dump(setsBody(straight(5, 5, 85.0))));
  CHECK_EQ(bodyOf(routine)["revision"].asInt(), 2);
  drogon::HttpResponsePtr history = send(
      h.programApi, &ProgramApi::listProposals,
      getRequest("/v1/gym/proposals?routineId=rt_11111111", "s-door"));
  CHECK_EQ(bodyOf(history)["proposals"][0]["state"].asString(), std::string("superseded"));
  CHECK(h.failures.messages.empty());
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
  drogon::HttpResponsePtr listed =
      send(h.program, &ProgramApi::listProposals, getRequest("/v1/gym/proposals", "s-live"));

  CHECK_EQ(read->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(read)), std::string(R"({"error":"no such proposal"})"));
  CHECK_EQ(bodyOf(listed)["proposals"].size(), 0u);
}

TEST(gym_every_proposal_route_refuses_a_caller_with_no_session) {
  Harness h;

  CHECK_EQ(send(h.program, &ProgramApi::listProposals, getRequest("/v1/gym/proposals"))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.program, &ProgramApi::getProposal, getRequest("/v1/gym/proposals/prop_11111111"),
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

// `changeCount` is the unit the review's button, the card and the receipt all count: a ROW of the
// document that is not `kept`, plus one for a renamed routine — never a field, so a row that moves
// three targets is one change, and the kept rows the sheet collapses to "and N lines unchanged"
// count for nothing. The head and the whole document carry the same number.
TEST(gym_change_count_is_rows_that_are_not_kept_plus_a_rename_never_fields) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  const std::vector<RoutineEntry> base{
      RoutineEntry{1, ExerciseId{"bench-press"}, straight(5, 5, 82.5), 180},
      RoutineEntry{2, ExerciseId{"back-squat"}, straight(3, 8, 100.0), 240},
      RoutineEntry{3, ExerciseId{"dip"}, straight(3, std::nullopt, std::nullopt), 120}};
  REQUIRE_EQ(h.door.createRoutine(h.user, RoutineWrite{rtId("rt_11111111"), "Push A", 0, base},
                                     ProposalDoor::mcp).error, RoutineWriteError::none);
  // One row moving its whole scheme and its rest, two kept, and a rename.
  const std::vector<RoutineEntry> proposed{
      RoutineEntry{1, ExerciseId{"bench-press"}, straight(5, 3, 90.0), 240},
      RoutineEntry{2, ExerciseId{"back-squat"}, straight(3, 8, 100.0), 240},
      RoutineEntry{3, ExerciseId{"dip"}, straight(3, std::nullopt, std::nullopt), 120}};
  const ProposalMintOutcome minted = h.door.propose(
      h.user, ProposalWrite{ProposalId{"prop_11111111"}, rtId("rt_11111111"), "Push A — heavy",
                            "Heavier triples.", proposed,
                            ProposalSource{ProposalDoor::mcp, "", ""}});
  REQUIRE(minted.error == ProposalMintError::none);

  const Json::Value whole = bodyOf(send(h.programApi, &ProgramApi::getProposal,
                                        getRequest("/v1/gym/proposals/prop_11111111", "s-door"),
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
  const Json::Value heads = bodyOf(send(h.programApi, &ProgramApi::listProposals,
                                        getRequest("/v1/gym/proposals", "s-door")));
  CHECK_EQ(heads["proposals"][0]["changeCount"].asInt(), whole["changeCount"].asInt());

  // The same document with no rename: the moved scheme and rest are still ONE change.
  const ProposalMintOutcome fieldsOnly = h.door.propose(
      h.user, ProposalWrite{ProposalId{"prop_22222222"}, rtId("rt_11111111"), std::nullopt,
                            "Heavier triples.", proposed,
                            ProposalSource{ProposalDoor::mcp, "", ""}});
  REQUIRE(fieldsOnly.error == ProposalMintError::none);
  const Json::Value one = bodyOf(send(h.programApi, &ProgramApi::getProposal,
                                      getRequest("/v1/gym/proposals/prop_22222222", "s-door"),
                                      "prop_22222222"));
  CHECK_EQ(one["changeCount"].asInt(), 1);
  CHECK_EQ(dump(one["changes"][0]["before"]),
           std::string(R"({"restSeconds":180,"sets":[{"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5}]})"));
  CHECK_EQ(dump(one["changes"][0]["after"]),
           std::string(R"({"restSeconds":240,"sets":[{"reps":3,"weightKg":90.0},{"reps":3,"weightKg":90.0},)"
                       R"({"reps":3,"weightKg":90.0},{"reps":3,"weightKg":90.0},)"
                       R"({"reps":3,"weightKg":90.0}]})"));

  // Added and removed rows are one change each; the kept row still none.
  const std::vector<RoutineEntry> reshaped{
      RoutineEntry{1, ExerciseId{"bench-press"}, straight(5, 5, 82.5), 180},
      RoutineEntry{2, ExerciseId{"dip"}, straight(3, std::nullopt, std::nullopt), 120},
      RoutineEntry{3, ExerciseId{"back-squat"}, straight(3, 8, 100.0), 240},
      RoutineEntry{4, ExerciseId{"bench-press"}, straight(3, 10, 60.0), 90}};
  const ProposalMintOutcome addedOne = h.door.propose(
      h.user, ProposalWrite{ProposalId{"prop_33333333"}, rtId("rt_11111111"), std::nullopt,
                            "A second bench line.", reshaped,
                            ProposalSource{ProposalDoor::mcp, "", ""}});
  REQUIRE(addedOne.error == ProposalMintError::none);
  const Json::Value reordered = bodyOf(send(h.programApi, &ProgramApi::getProposal,
                                            getRequest("/v1/gym/proposals/prop_33333333", "s-door"),
                                            "prop_33333333"));
  int rowsMoved = 0;
  for (const Json::Value& row : reordered["changes"])
    if (row["kind"].asString() != "kept") ++rowsMoved;
  CHECK_EQ(rowsMoved, 1);   // the added line; the three kept lines in a new order are a reorder
  CHECK_EQ(reordered["changeCount"].asInt(), rowsMoved + 1);   // + one for the reorder of the run
  CHECK(h.failures.messages.empty());
}
