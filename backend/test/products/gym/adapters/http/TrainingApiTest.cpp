#include "test/products/gym/adapters/http/GymApiFixture.h"

#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

using namespace wm;
using namespace wm::fake;
using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::apitest;

// TrainingApi over the fake store: the owner gate, the session lifecycle, the set writes, the log reads, the share.

namespace {
// A store that reads fine and refuses to write. Its failure is NOT InvalidTraining, so it never wears the client's 400.
struct DownRepository : FakeLogRepository {
  using FakeLogRepository::FakeLogRepository;
  void insertSession(const Session&) override { throw std::runtime_error("storage is down"); }
  SetInsertOutcome insertSet(const Set&) override { throw std::runtime_error("storage is down"); }
};

// The freshness tag, read off a reply and fed back into the next request.
std::string tagOf(const drogon::HttpResponsePtr& response) { return response->getHeader("ETag"); }

drogon::HttpResponsePtr readSession(TrainingApi& api, const std::string& session,
                                    const std::string& cookie,
                                    const std::string& ifNoneMatch = "") {
  drogon::HttpRequestPtr request = getRequest("/v1/gym/sessions/" + session, cookie);
  if (!ifNoneMatch.empty()) request->addHeader("If-None-Match", ifNoneMatch);
  return send(api, &TrainingApi::getSession, request, session);
}

// The fix and the delete, as a client sends them: the workout is half the address.
drogon::HttpRequestPtr patchSetRequest(const std::string& session, const std::string& set,
                                       const Json::Value& body, const std::string& cookie = "") {
  drogon::HttpRequestPtr request =
      postRequest("/v1/gym/sessions/" + session + "/sets/" + set, body, cookie);
  request->setMethod(drogon::Patch);
  return request;
}

Json::Value fixBody(double weightKg, int reps) {
  Json::Value body(Json::objectValue);
  body["weightKg"] = weightKg;
  body["reps"] = reps;
  return body;
}
}

TEST(gym_routes_without_a_session_are_401) {
  Harness h;

  drogon::HttpResponsePtr exercises =
      send(h.catalog, &CatalogApi::listExercises, getRequest("/v1/gym/exercises"));
  drogon::HttpResponsePtr lastSets =
      send(h.training, &TrainingApi::lastSets, getRequest("/v1/gym/exercises/last"));
  drogon::HttpResponsePtr start =
      send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody()));
  drogon::HttpResponsePtr append = send(h.training, &TrainingApi::appendSet,
                                        postRequest("/v1/gym/sessions/ses_11111111/sets", setBody()),
                                        "ses_11111111");
  drogon::HttpResponsePtr routines =
      send(h.program, &ProgramApi::listRoutines, getRequest("/v1/gym/routines"));
  drogon::HttpResponsePtr createRoutine =
      send(h.program, &ProgramApi::createRoutine, postRequest("/v1/gym/routines", routineBody()));
  drogon::HttpResponsePtr deleteRoutine =
      send(h.program, &ProgramApi::deleteRoutine, deleteRequest("/v1/gym/routines/rt_11111111"),
           "rt_11111111");
  drogon::HttpResponsePtr createExercise =
      send(h.catalog, &CatalogApi::createExercise, postRequest("/v1/gym/exercises", exerciseBody()));
  drogon::HttpResponsePtr review =
      send(h.training, &TrainingApi::reviewSession, getRequest("/v1/gym/sessions/ses_11111111/review"),
           "ses_11111111");
  drogon::HttpResponsePtr discard =
      send(h.training, &TrainingApi::discardSession, deleteRequest("/v1/gym/sessions/ses_11111111"),
           "ses_11111111");
  drogon::HttpResponsePtr stats = send(h.training, &TrainingApi::stats, getRequest("/v1/gym/stats"));
  drogon::HttpResponsePtr exported =
      send(h.training, &TrainingApi::exportSets, getRequest("/v1/gym/export"));
  drogon::HttpResponsePtr share =
      send(h.training, &TrainingApi::shareSession,
           postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue)),
           "ses_11111111");
  drogon::HttpResponsePtr revoke =
      send(h.training, &TrainingApi::revokeShare, deleteRequest("/v1/gym/sessions/ses_11111111/share"),
           "ses_11111111");
  drogon::HttpResponsePtr rename =
      send(h.catalog, &CatalogApi::renameExercise,
           patchRequest("/v1/gym/exercises/back-squat", renameBody()), "back-squat");
  drogon::HttpResponsePtr record =
      send(h.catalog, &CatalogApi::exerciseRecord, getRequest("/v1/gym/exercises/back-squat/record"),
           "back-squat");
  drogon::HttpResponsePtr fix =
      send(h.training, &TrainingApi::fixSet,
                   patchSetRequest("ses_11111111", "set_11111111", fixBody(80.0, 5)),
                   "ses_11111111", "set_11111111");
  drogon::HttpResponsePtr removeSet =
      send(h.training, &TrainingApi::deleteSet,
                   deleteRequest("/v1/gym/sessions/ses_11111111/sets/set_11111111"),
                   "ses_11111111", "set_11111111");

  CHECK_EQ(exercises->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(exercises)), std::string(R"({"error":"sign in to open your training log"})"));
  // The picker's meta is a read of somebody's LOG under a catalog-shaped path.
  CHECK_EQ(lastSets->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(start->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(append->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(routines->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(createRoutine->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(deleteRoutine->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(createExercise->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(review->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(discard->getStatusCode(), drogon::k401Unauthorized);
  // Only `GET /v1/gym/shared/{token}` is on the other side of the gate.
  CHECK_EQ(stats->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(exported->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(share->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(revoke->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(rename->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(record->getStatusCode(), drogon::k401Unauthorized);
  // The delete answers the gate rather than its own bare 204.
  CHECK_EQ(fix->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(removeSet->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(removeSet)), std::string(R"({"error":"sign in to open your training log"})"));
  CHECK(h.repo.db.sessions.empty());
  CHECK(h.repo.db.sets.empty());
  CHECK(h.repo.db.routineRows.empty());
  CHECK(h.repo.db.customs.empty());
  CHECK(h.repo.db.shares.empty());
}

// The picker's meta line: the LAST set of the block, dated by the SESSION's start, keyed by movement id.
TEST(gym_exercises_last_is_the_final_set_of_each_movement_and_nothing_for_the_rest) {
  Harness h;
  h.signIn("s-live");

  send(h.training, &TrainingApi::startSession,
       postRequest("/v1/gym/sessions", startBody("ses_11111111", 1'700'000'000'000), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets",
                   setBody("set_11111111", "bench-press", 82.5, 1'700'000'060'000), "s-live"),
       "ses_11111111");
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets",
                   setBody("set_11111112", "bench-press", 80.0, 1'700'000'120'000), "s-live"),
       "ses_11111111");
  Json::Value warmup = setBody("set_11111113", "back-squat", 60.0, 1'700'000'180'000);
  warmup["kind"] = "warmup";
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", warmup, "s-live"), "ses_11111111");
  send(h.training, &TrainingApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'300'000), "s-live"),
       "ses_11111111");

  send(h.training, &TrainingApi::startSession,
       postRequest("/v1/gym/sessions", startBody("ses_22222222", (h.clock.now = 1'700'000'400'000)), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_22222222/sets",
                   setBody("set_22222221", "back-squat", 100.0, 1'700'000'460'000), "s-live"),
       "ses_22222222");
  send(h.training, &TrainingApi::finishSession,
       postRequest("/v1/gym/sessions/ses_22222222/finish", finishBody(1'700'000'700'000), "s-live"),
       "ses_22222222");

  send(h.training, &TrainingApi::startSession,
       postRequest("/v1/gym/sessions", startBody("ses_33333333", (h.clock.now = 1'700'001'000'000)), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_33333333/sets",
                   setBody("set_33333331", "bench-press", 140.0, 1'700'001'060'000), "s-live"),
       "ses_33333333");

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::lastSets, getRequest("/v1/gym/exercises/last", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"movements":[)"
                       R"({"at":1700000400000,"exerciseId":"back-squat","reps":8,"weightKg":100.0},)"
                       R"({"at":1700000000000,"exerciseId":"bench-press","reps":8,)"
                       R"("weightKg":80.0}]})"));
}

TEST(gym_exercises_last_is_an_empty_list_before_anything_is_logged) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::lastSets, getRequest("/v1/gym/exercises/last", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"movements":[]})"));
}

TEST(gym_exercises_last_never_carries_another_accounts_line) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 1);

  User other = h.authRepo.createUser(Email{"coach@example.com"}, "coach");
  h.authRepo.insertSession(h.tokens.digestOf("s-other"), other.id, h.clock.now + 1'000'000, "", "",
                           h.clock.now);

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::lastSets, getRequest("/v1/gym/exercises/last", "s-other"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"movements":[]})"));
}

TEST(gym_start_round_trips_the_resolved_session) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"id":"ses_11111111","startedAt":1700000000000})"));

  // A replayed POST answers with the SAME session — no second row, no phantom.
  drogon::HttpResponsePtr replayed =
      send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  CHECK_EQ(dump(bodyOf(replayed)), std::string(R"({"id":"ses_11111111","startedAt":1700000000000})"));
  CHECK_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
}

TEST(gym_start_ahead_of_the_logs_clock_is_400_and_names_the_gap) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::startSession,
           postRequest("/v1/gym/sessions", startBody("ses_11111111", 1'700'000'000'000 + 26 * 60'000),
                       "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"clock-ahead","error":"this device's clock is 26 minutes ahead of )"
                       R"(the log \u2014 a workout cannot start in the future. Check the clock and )"
                       R"(start again."})"));
  CHECK(h.repo.db.sessions.empty());
}

TEST(gym_start_with_an_id_another_account_already_spent_is_409) {
  Harness h;
  h.signIn("s-live");
  // The id is taken by a row this caller can never see.
  h.repo.db.sessions.push_back(Session{sid("ses_11111111"), uid("another-account"), 1'699'000'000'000});

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  // The code is the contract the flush queue branches on; the sentence is for a human reading a log.
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"session-id-taken","error":"that session id is taken"})"));
  REQUIRE_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.sessions[0].user, uid("another-account"));
}

TEST(gym_start_that_will_not_join_is_409_while_a_session_is_open) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.repo.db.sessions.push_back(Session{sid("ses_11111111"), me, 1'700'000'000'000});

  Json::Value backfill = startBody("ses_22222222", 1'699'000'000'000);
  backfill["joinOpenSession"] = false;
  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", backfill, "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  // Its own code: a fresh id changes nothing while a session is open — that workout has to end first.
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"session-already-open","error":"another session is already open"})"));
  CHECK_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
}

// Omitted is the join, so a caller written before the field keeps meaning what it meant.
TEST(gym_start_without_the_field_still_joins_the_open_session) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.repo.db.sessions.push_back(Session{sid("ses_11111111"), me, 1'700'000'000'000});

  drogon::HttpResponsePtr response = send(h.training, &TrainingApi::startSession,
                                          postRequest("/v1/gym/sessions",
                                                      startBody("ses_22222222"), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"id":"ses_11111111","startedAt":1700000000000})"));
  CHECK_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
}

// A string where the boolean belongs is a 400, never a guess: the two Starts differ by which sets land where.
TEST(gym_start_with_a_non_boolean_join_is_400) {
  Harness h;
  h.signIn("s-live");

  Json::Value body = startBody();
  body["joinOpenSession"] = "false";
  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", body, "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that session"})"));
  CHECK(h.repo.db.sessions.empty());
}

TEST(gym_start_with_a_malformed_id_is_400) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response = send(
      h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody("short"), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that session"})"));
  CHECK(h.repo.db.sessions.empty());
}

TEST(gym_start_without_a_started_instant_is_400) {
  Harness h;
  h.signIn("s-live");
  Json::Value body(Json::objectValue);
  body["id"] = "ses_11111111";

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", body, "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that session"})"));
}

TEST(gym_append_round_trips_the_stored_set) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  // rpe is OMITTED when unset; note is always present; the number is the server's.
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"completedAt":1700000060000,"exerciseId":"bench-press",)"
                       R"("id":"set_11111111","kind":"working","note":"","reps":8,)"
                       R"("setNumber":1,"weightKg":82.5})"));
}

TEST(gym_append_carries_kind_rpe_and_note_through) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  Json::Value body = setBody();
  body["kind"] = "warmup";
  body["rpe"] = 8.5;
  body["note"] = "paused reps";

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets", body, "s-live"), "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"completedAt":1700000060000,"exerciseId":"bench-press",)"
                       R"("id":"set_11111111","kind":"warmup","note":"paused reps","reps":8,)"
                       R"("rpe":8.5,"setNumber":1,"weightKg":82.5})"));
}

TEST(gym_append_with_an_unknown_kind_is_400_never_a_silent_downgrade) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  Json::Value body = setBody();
  body["kind"] = "amrap";

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets", body, "s-live"), "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that set"})"));
  CHECK(h.repo.db.sets.empty());
}

// The catalog is storage's to know, so this refusal is the store's fact travelling as a VALUE.
TEST(gym_append_naming_a_movement_no_catalog_holds_is_400_no_such_exercise) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets",
                       setBody("set_11111111", "zercher-squat"), "s-live"),
           "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"unknown-exercise","error":"no such exercise"})"));
  CHECK(h.repo.db.sets.empty());
  REQUIRE_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.sessions[0].finishedAtMs, std::optional<std::uint64_t>{});
}

TEST(gym_append_to_an_unknown_session_is_404) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::appendSet,
           postRequest("/v1/gym/sessions/ses_99999999/sets", setBody(), "s-live"), "ses_99999999");

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"no such session"})"));
}

TEST(gym_append_to_a_finished_session_is_409) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'100'000), "s-live"),
       "ses_11111111");

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"session-finished","error":"that session is finished"})"));
  CHECK(h.repo.db.sets.empty());
}

TEST(gym_append_replayed_into_a_finished_session_returns_the_stored_set) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  drogon::HttpResponsePtr landed =
      send(h.training, &TrainingApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.training, &TrainingApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'100'000), "s-live"),
       "ses_11111111");

  // Replay in any order, any number of times, converging on one row per minted id.
  drogon::HttpResponsePtr replayed =
      send(h.training, &TrainingApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  CHECK_EQ(landed->getStatusCode(), drogon::k200OK);
  CHECK_EQ(replayed->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(replayed)), dump(bodyOf(landed)));
  CHECK_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
}

TEST(gym_append_with_a_set_id_already_spent_elsewhere_is_409) {
  Harness h;
  UserId user = h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  // The id belongs to a row outside this session — another account's, or an earlier workout of this one.
  h.repo.db.sets.push_back(Set{setId("set_11111111"), sid("ses_99999999"), ExerciseId{"bench-press"},
                            1, 142.5, 3, SetKind::working, 9.5, "knee felt off", 1'699'000'000'000});

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"set-id-taken","error":"that set id is already used"})"));
  REQUIRE_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.sets[0].session, sid("ses_99999999"));
  CHECK_EQ(h.repo.db.sets[0].note, std::string("knee felt off"));
  CHECK_EQ(user, h.repo.db.sessions[0].user);
}

TEST(gym_fix_round_trips_the_corrected_set_and_a_replay_reads_it_back) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  drogon::HttpResponsePtr fixed =
      send(h.training, &TrainingApi::fixSet,
                   patchSetRequest("ses_11111111", "set_11111111", fixBody(47.5, 4), "s-live"),
                   "ses_11111111", "set_11111111");
  drogon::HttpResponsePtr replayed =
      send(h.training, &TrainingApi::fixSet,
                   patchSetRequest("ses_11111111", "set_11111111", fixBody(47.5, 4), "s-live"),
                   "ses_11111111", "set_11111111");

  CHECK_EQ(fixed->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(fixed)),
           std::string(R"({"completedAt":1700000060000,"exerciseId":"bench-press",)"
                       R"("id":"set_11111111","kind":"working","note":"","reps":4,)"
                       R"("setNumber":1,"weightKg":47.5})"));
  CHECK_EQ(dump(bodyOf(replayed)), dump(bodyOf(fixed)));
  CHECK_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
}

// `rpe: null` is the one null this write reads as a value: it clears an rpe.
TEST(gym_fix_carries_the_kind_the_note_and_an_rpe_that_can_be_cleared) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  Json::Value logged = setBody();
  logged["rpe"] = 8.5;
  logged["note"] = "felt heavy";
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", logged, "s-live"), "ses_11111111");

  Json::Value toWarmup(Json::objectValue);
  toWarmup["kind"] = "warmup";
  toWarmup["note"] = "";
  drogon::HttpResponsePtr retyped =
      send(h.training, &TrainingApi::fixSet,
                   patchSetRequest("ses_11111111", "set_11111111", toWarmup, "s-live"),
                   "ses_11111111", "set_11111111");
  Json::Value clearRpe(Json::objectValue);
  clearRpe["rpe"] = Json::Value::null;
  drogon::HttpResponsePtr cleared =
      send(h.training, &TrainingApi::fixSet,
                   patchSetRequest("ses_11111111", "set_11111111", clearRpe, "s-live"),
                   "ses_11111111", "set_11111111");

  CHECK_EQ(bodyOf(retyped)["kind"].asString(), std::string("warmup"));
  CHECK_EQ(bodyOf(retyped)["note"].asString(), std::string(""));
  CHECK_EQ(bodyOf(retyped)["rpe"].asDouble(), 8.5);   // untouched: this fix never named it
  CHECK_FALSE(bodyOf(cleared).isMember("rpe"));
  CHECK_EQ(bodyOf(cleared)["kind"].asString(), std::string("warmup"));
}

TEST(gym_a_fix_that_names_nothing_answers_the_stored_row_untouched) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  drogon::HttpResponsePtr logged =
      send(h.training, &TrainingApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  drogon::HttpResponsePtr untouched = send(
      h.training, &TrainingApi::fixSet,
      patchSetRequest("ses_11111111", "set_11111111", Json::Value(Json::objectValue), "s-live"),
      "ses_11111111", "set_11111111");

  CHECK_EQ(untouched->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(untouched)), dump(bodyOf(logged)));
}

// Absent, another account's, and this account's set in a DIFFERENT workout are one 404, byte for byte.
TEST(gym_a_fix_of_a_set_this_workout_does_not_hold_is_404_set_not_found) {
  Harness h;
  h.signIn("s-live");
  h.signIn("s-other");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.training, &TrainingApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'180'000), "s-live"),
       "ses_11111111");
  send(h.training, &TrainingApi::startSession,
       postRequest("/v1/gym/sessions", startBody("ses_22222222", 1'700'001'000'000), "s-live"));

  drogon::HttpResponsePtr absent =
      send(h.training, &TrainingApi::fixSet,
                   patchSetRequest("ses_11111111", "set_99999999", fixBody(80.0, 5), "s-live"),
                   "ses_11111111", "set_99999999");
  drogon::HttpResponsePtr elsewhere =
      send(h.training, &TrainingApi::fixSet,
                   patchSetRequest("ses_22222222", "set_11111111", fixBody(80.0, 5), "s-live"),
                   "ses_22222222", "set_11111111");
  drogon::HttpResponsePtr stranger =
      send(h.training, &TrainingApi::fixSet,
                   patchSetRequest("ses_11111111", "set_11111111", fixBody(80.0, 5), "s-other"),
                   "ses_11111111", "set_11111111");

  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(absent)),
           std::string(R"({"code":"set-not-found","error":"no such set"})"));
  CHECK_EQ(elsewhere->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(elsewhere)), dump(bodyOf(absent)));
  CHECK_EQ(stranger->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(stranger)), dump(bodyOf(absent)));
  CHECK_EQ(h.repo.db.sets[0].weightKg, 82.5);
  CHECK(h.repo.db.kept.empty());
}

// The three fields a correction refuses by name, refused rather than ignored; a value the store cannot hold wears the same word.
TEST(gym_a_fix_naming_a_field_it_may_not_carry_is_400_fix_unreadable) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  Json::Value movement(Json::objectValue);
  movement["exerciseId"] = "back-squat";
  Json::Value instant(Json::objectValue);
  instant["completedAt"] = Json::Value::UInt64(1'700'000'999'000);
  Json::Value number(Json::objectValue);
  number["setNumber"] = 9;
  Json::Value zeroReps(Json::objectValue);
  zeroReps["reps"] = 0;

  for (const Json::Value& refused : {movement, instant, number, zeroReps}) {
    drogon::HttpResponsePtr response =
        send(h.training, &TrainingApi::fixSet,
                     patchSetRequest("ses_11111111", "set_11111111", refused, "s-live"),
                     "ses_11111111", "set_11111111");
    CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(bodyOf(response)),
             std::string(R"({"code":"fix-unreadable","error":"could not read that fix"})"));
  }
  CHECK_EQ(h.repo.db.sets[0], Set(setId("set_11111111"), sid("ses_11111111"),
                               ExerciseId{"bench-press"}, 1, 82.5, 8, SetKind::working,
                               std::nullopt, "", 1'700'000'060'000));
  CHECK(h.repo.db.kept.empty());
}

// The delete: 204 with nothing to say, and 204 again on the retry a lost reply produces.
TEST(gym_deleting_a_set_is_204_and_deleting_it_again_is_204) {
  Harness h;
  h.signIn("s-live");
  h.signIn("s-other");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets",
                   setBody("set_22222222", "bench-press", 85.0, 1'700'000'120'000), "s-live"),
       "ses_11111111");

  drogon::HttpResponsePtr gone = send(
      h.training, &TrainingApi::deleteSet,
      deleteRequest("/v1/gym/sessions/ses_11111111/sets/set_11111111", "s-live"),
      "ses_11111111", "set_11111111");
  drogon::HttpResponsePtr again = send(
      h.training, &TrainingApi::deleteSet,
      deleteRequest("/v1/gym/sessions/ses_11111111/sets/set_11111111", "s-live"),
      "ses_11111111", "set_11111111");
  drogon::HttpResponsePtr stranger = send(
      h.training, &TrainingApi::deleteSet,
      deleteRequest("/v1/gym/sessions/ses_11111111/sets/set_22222222", "s-other"),
      "ses_11111111", "set_22222222");

  CHECK_EQ(gone->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(gone->getBody(), std::string(""));
  CHECK_EQ(again->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(stranger->getStatusCode(), drogon::k204NoContent);
  REQUIRE_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.sets[0].id, setId("set_22222222"));
  REQUIRE_EQ(h.repo.db.kept.size(), static_cast<std::size_t>(1));
  CHECK(h.repo.db.kept[0].deleted);
  CHECK_EQ(h.repo.db.kept[0].set.id, setId("set_11111111"));
}

// A replayed append of a deleted set answers `set-deleted` and not `set-id-taken`: a fresh id would log it back in.
TEST(gym_replaying_the_append_of_a_deleted_set_is_409_set_deleted_and_never_a_re_mint) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.training, &TrainingApi::deleteSet,
               deleteRequest("/v1/gym/sessions/ses_11111111/sets/set_11111111", "s-live"),
               "ses_11111111", "set_11111111");

  drogon::HttpResponsePtr replayed =
      send(h.training, &TrainingApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  CHECK_EQ(replayed->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(replayed)),
           std::string(R"({"code":"set-deleted","error":"that set was deleted"})"));
  CHECK_EQ(h.repo.db.sets, std::vector<Set>{});
  REQUIRE_EQ(h.repo.db.kept.size(), static_cast<std::size_t>(1));
  CHECK(h.repo.db.kept[0].deleted);
}

// A note the column cannot hold is the CLIENT's fault: `text` is UTF-8 end to end and json is not, so it is a terminal 400.
TEST(gym_a_note_the_store_could_never_hold_is_400_on_both_writes_and_never_a_retryable_500) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  const std::string surrogate = "{\"id\":\"set_22222222\",\"exerciseId\":\"bench-press\","
                                "\"weightKg\":82.5,\"reps\":8,\"completedAt\":1700000120000,"
                                "\"note\":\"ok \xED\xA0\x80 bad\"}";
  drogon::HttpRequestPtr logging =
      postRequest("/v1/gym/sessions/ses_11111111/sets", Json::Value(Json::objectValue), "s-live");
  logging->setBody(surrogate);
  drogon::HttpRequestPtr fixing =
      patchSetRequest("ses_11111111", "set_11111111", Json::Value(Json::objectValue), "s-live");
  fixing->setBody(std::string("{\"note\":\"ok \xED\xA0\x80 bad\"}"));

  drogon::HttpResponsePtr logged = send(h.training, &TrainingApi::appendSet, logging, "ses_11111111");
  drogon::HttpResponsePtr fixed =
      send(h.training, &TrainingApi::fixSet, fixing, "ses_11111111", "set_11111111");

  CHECK_EQ(logged->getStatusCode(), drogon::k400BadRequest);
  // "could not read that set" and not "expected json": the body PARSED, and the rule refused it.
  CHECK_EQ(dump(bodyOf(logged)), std::string(R"({"error":"could not read that set"})"));
  CHECK_EQ(fixed->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(fixed)),
           std::string(R"({"code":"fix-unreadable","error":"could not read that fix"})"));
  REQUIRE_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.sets[0].note, std::string(""));
}

TEST(gym_finish_round_trips_and_replays_keep_the_first_instant) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));

  drogon::HttpResponsePtr finished =
      send(h.training, &TrainingApi::finishSession,
           postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'100'000),
                       "s-live"),
           "ses_11111111");
  drogon::HttpResponsePtr replayed =
      send(h.training, &TrainingApi::finishSession,
           postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'200'000),
                       "s-live"),
           "ses_11111111");

  CHECK_EQ(finished->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(finished)),
           std::string(R"({"finishedAt":1700000100000,"id":"ses_11111111",)"
                       R"("startedAt":1700000000000})"));
  CHECK_EQ(replayed->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(replayed)), dump(bodyOf(finished)));
}

TEST(gym_finish_at_a_zero_instant_is_400_and_leaves_the_session_open) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::finishSession,
           postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(0), "s-live"),
           "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that finish"})"));
  // An unset device clock would close the session at 1970, and close is first-writer-wins.
  REQUIRE_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.sessions[0].finishedAtMs, std::optional<std::uint64_t>{});
}

TEST(gym_finish_before_the_session_began_is_400) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::finishSession,
           postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'699'999'000'000),
                       "s-live"),
           "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"error":"a session cannot finish before it began"})"));
  CHECK_EQ(h.repo.db.sessions[0].finishedAtMs, std::optional<std::uint64_t>{});
}

TEST(gym_an_instant_past_the_end_of_time_is_400_on_every_write) {
  Harness h;
  h.signIn("s-live");
  constexpr std::uint64_t past = kMaxInstantMs + 1;
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));

  drogon::HttpResponsePtr start = send(
      h.training, &TrainingApi::startSession,
      postRequest("/v1/gym/sessions", startBody("ses_22222222", past), "s-live"));
  drogon::HttpResponsePtr append =
      send(h.training, &TrainingApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets",
                       setBody("set_11111111", "bench-press", 82.5, past), "s-live"),
           "ses_11111111");
  drogon::HttpResponsePtr finish =
      send(h.training, &TrainingApi::finishSession,
           postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(past), "s-live"),
           "ses_11111111");

  CHECK_EQ(start->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(start)), std::string(R"({"error":"could not read that session"})"));
  CHECK_EQ(append->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(append)), std::string(R"({"error":"could not read that set"})"));
  // The close runs inside the catch, so an overflow reaching to_timestamp() is not a leaked 500.
  CHECK_EQ(finish->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(finish)), std::string(R"({"error":"could not read that finish"})"));
  REQUIRE_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.sessions[0].finishedAtMs, std::optional<std::uint64_t>{});
  CHECK(h.repo.db.sets.empty());
}

TEST(gym_a_storage_failure_on_append_is_never_the_clients_400) {
  Harness h;
  UserId user = h.signIn("s-live");
  FakeGym store;
  DownRepository down{store.db};
  store.db.seed(benchPress());
  store.db.sessions.push_back(Session{sid("ses_11111111"), user, 1'700'000'000'000});
  auto training = std::make_shared<TrainingService>(down, store.program, h.clock, h.tokens);
  TrainingApi api{training, h.auth, "https://windmill.works"};

  // The house exception handler answers 500 "internal error" — a status the flush queue retries.
  bool escaped = false;
  drogon::HttpResponsePtr response;
  try {
    response = send(api, &TrainingApi::appendSet,
                    postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"),
                    "ses_11111111");
  } catch (const std::runtime_error&) {
    escaped = true;
  }

  CHECK(escaped);
  CHECK(response == nullptr);
  CHECK(store.db.sets.empty());
}

TEST(gym_a_storage_failure_on_start_is_never_the_clients_400) {
  Harness h;
  h.signIn("s-live");
  FakeGym store;
  DownRepository down{store.db};
  auto training = std::make_shared<TrainingService>(down, store.program, h.clock, h.tokens);
  TrainingApi api{training, h.auth, "https://windmill.works"};

  bool escaped = false;
  drogon::HttpResponsePtr response;
  try {
    response = send(api, &TrainingApi::startSession,
                    postRequest("/v1/gym/sessions", startBody(), "s-live"));
  } catch (const std::runtime_error&) {
    escaped = true;
  }

  CHECK(escaped);
  CHECK(response == nullptr);
  CHECK(store.db.sessions.empty());
}

TEST(gym_list_sessions_wraps_rows_with_both_counts_the_tonnage_and_the_top_sets_estimate) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets",
                   setBody("set_22222222", "back-squat", 100.0, 1'700'000'120'000), "s-live"),
       "ses_11111111");

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::listSessions, getRequest("/v1/gym/sessions", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  // The facts a log row is drawn from, and this session is still running, so nothing closed it.
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"sessions":[{"closedItself":false,)"
                       R"("exercises":["Back Squat","Bench Press"],"id":"ses_11111111",)"
                       R"("record":false,"setCount":2,"startedAt":1700000000000,)"
                            R"("tonnageKg":1460.0,)"
                       R"("topE1rm":126.7,"topSet":{"reps":8,"weightKg":100.0},)"
                       R"("workingSetCount":2}]})"));
}

TEST(gym_list_sessions_says_which_row_closed_itself_and_omits_an_absent_top_set) {
  Harness h;
  UserId user = h.signIn("s-live");
  // A session the four-hour rule ended: finished at its last set's instant exactly, which is what the row infers from.
  h.repo.db.sessions.push_back(
      Session{sid("ses_11111111"), user, 1'700'000'000'000, 1'700'000'060'000});
  h.repo.db.sets.push_back(Set{setId("set_11111111"), sid("ses_11111111"), ExerciseId{"bench-press"},
                            1, 40.0, 10, SetKind::warmup, std::nullopt, "", 1'700'000'060'000});

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::listSessions, getRequest("/v1/gym/sessions", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  // A ramp-up and nothing else: no working set, so no top set, no estimate, and a tonnage of zero.
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"sessions":[{"closedItself":true,"exercises":["Bench Press"],)"
                       R"("finishedAt":1700000060000,"id":"ses_11111111","record":false,)"
                            R"("setCount":1,)"
                       R"("startedAt":1700000000000,"tonnageKg":0.0,"workingSetCount":0}]})"));
}

// The number on the row is the SESSION's e1RM and not the top set's: three back-offs at 95 × 10 estimate above 100 × 5.
TEST(gym_list_sessions_carries_the_sessions_estimate_not_its_top_sets) {
  Harness h;
  UserId user = h.signIn("s-live");
  h.repo.db.sessions.push_back(
      Session{sid("ses_11111111"), user, 1'700'000'000'000, 1'700'000'300'000});
  h.repo.db.sets.push_back(Set{setId("set_11111111"), sid("ses_11111111"), ExerciseId{"back-squat"},
                            1, 100.0, 5, SetKind::working, std::nullopt, "", 1'700'000'060'000});
  for (int number = 2; number <= 4; ++number)
    h.repo.db.sets.push_back(Set{setId("set_1111111" + std::to_string(number)), sid("ses_11111111"),
                              ExerciseId{"back-squat"}, number, 95.0, 10, SetKind::working,
                              std::nullopt, "",
                              1'700'000'060'000 + static_cast<std::uint64_t>(number) * 1'000});

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::listSessions, getRequest("/v1/gym/sessions", "s-live"));
  drogon::HttpResponsePtr finish =
      send(h.training, &TrainingApi::reviewSession,
           getRequest("/v1/gym/sessions/ses_11111111/review", "s-live"), "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"sessions":[{"closedItself":false,"exercises":["Back Squat"],)"
                       R"("finishedAt":1700000300000,"id":"ses_11111111","record":false,)"
                            R"("setCount":4,)"
                       R"("startedAt":1700000000000,"tonnageKg":3350.0,"topE1rm":126.7,)"
                       R"("topSet":{"reps":5,"weightKg":100.0},"workingSetCount":4}]})"));
  CHECK_EQ(bodyOf(finish)["stats"]["topE1rm"].asDouble(),
           bodyOf(response)["sessions"][0]["topE1rm"].asDouble());
}

TEST(gym_list_sessions_with_a_malformed_cursor_is_400) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpRequestPtr digits = getRequest("/v1/gym/sessions", "s-live");
  digits->setParameter("before", "-5");   // digits-only: a sign, a float, a word are all refused
  digits->setParameter("limit", "10");
  drogon::HttpRequestPtr shape = getRequest("/v1/gym/sessions", "s-live");
  shape->setParameter("before", "1700000000000");
  shape->setParameter("beforeId", "short");   // the tiebreaker half obeys the one id-shape rule
  drogon::HttpRequestPtr halfCursor = getRequest("/v1/gym/sessions", "s-live");
  halfCursor->setParameter("beforeId", "ses_11111111");   // an id with no instant names no row

  drogon::HttpResponsePtr digitsReply = send(h.training, &TrainingApi::listSessions, digits);
  drogon::HttpResponsePtr shapeReply = send(h.training, &TrainingApi::listSessions, shape);
  drogon::HttpResponsePtr halfReply = send(h.training, &TrainingApi::listSessions, halfCursor);

  CHECK_EQ(digitsReply->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(digitsReply)), std::string(R"({"error":"bad cursor"})"));
  CHECK_EQ(shapeReply->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(shapeReply)), std::string(R"({"error":"bad cursor"})"));
  CHECK_EQ(halfReply->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(halfReply)), std::string(R"({"error":"bad cursor"})"));
}

TEST(gym_list_sessions_pages_past_a_tied_start_instant_without_losing_one) {
  Harness h;
  UserId user = h.signIn("s-live");
  // Two workouts that started in the same millisecond: the (startedAt, id) cursor carries both halves.
  h.repo.db.sessions.push_back(Session{sid("ses_aaaaaaa4"), user, 1'700'000'003'000, 1'700'000'004'000});
  h.repo.db.sessions.push_back(Session{sid("ses_aaaaaaa3"), user, 1'700'000'002'000, 1'700'000'004'000});
  h.repo.db.sessions.push_back(Session{sid("ses_aaaaaaa2"), user, 1'700'000'002'000, 1'700'000'004'000});
  h.repo.db.sessions.push_back(Session{sid("ses_aaaaaaa1"), user, 1'700'000'001'000, 1'700'000'004'000});

  drogon::HttpRequestPtr firstPage = getRequest("/v1/gym/sessions", "s-live");
  firstPage->setParameter("limit", "2");
  drogon::HttpResponsePtr one = send(h.training, &TrainingApi::listSessions, firstPage);
  drogon::HttpRequestPtr secondPage = getRequest("/v1/gym/sessions", "s-live");
  secondPage->setParameter("limit", "2");
  secondPage->setParameter("before", "1700000002000");
  secondPage->setParameter("beforeId", "ses_aaaaaaa3");
  drogon::HttpResponsePtr two = send(h.training, &TrainingApi::listSessions, secondPage);

  CHECK_EQ(one->getStatusCode(), drogon::k200OK);
  REQUIRE_EQ(bodyOf(one)["sessions"].size(), 2u);
  CHECK_EQ(bodyOf(one)["sessions"][0]["id"].asString(), std::string("ses_aaaaaaa4"));
  CHECK_EQ(bodyOf(one)["sessions"][1]["id"].asString(), std::string("ses_aaaaaaa3"));
  CHECK_EQ(two->getStatusCode(), drogon::k200OK);
  REQUIRE_EQ(bodyOf(two)["sessions"].size(), 2u);
  CHECK_EQ(bodyOf(two)["sessions"][0]["id"].asString(), std::string("ses_aaaaaaa2"));
  CHECK_EQ(bodyOf(two)["sessions"][1]["id"].asString(), std::string("ses_aaaaaaa1"));
}

TEST(gym_session_detail_wraps_the_session_and_its_sets) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  drogon::HttpResponsePtr response = send(h.training, &TrainingApi::getSession,
                                          getRequest("/v1/gym/sessions/ses_11111111", "s-live"),
                                          "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"session":{"id":"ses_11111111","startedAt":1700000000000},)"
                       R"("sets":[{"completedAt":1700000060000,"exerciseId":"bench-press",)"
                       R"("id":"set_11111111","kind":"working","note":"","reps":8,)"
                       R"("setNumber":1,"weightKg":82.5}]})"));
}

// The freshness tag is stable while the workout is what it was, and moves on anything a poll acts on, a CORRECTION included.
TEST(gym_session_detail_etag_is_stable_replayed_and_moved_by_a_set_a_fix_and_the_finish) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  const std::string first = tagOf(readSession(h.training, "ses_11111111", "s-live"));
  const std::string replayed = tagOf(readSession(h.training, "ses_11111111", "s-live"));
  CHECK_EQ(first.rfind(R"(W/"1700000000000-0-)", 0), std::size_t{0});
  CHECK_EQ(replayed, first);

  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets",
                   setBody("set_22222222", "bench-press", 85.0, 1'700'000'120'000), "s-live"),
       "ses_11111111");
  const std::string grown = tagOf(readSession(h.training, "ses_11111111", "s-live"));
  CHECK(grown != first);

  // This moves one weight and nothing else about the session, which is why the tag folds the sets.
  send(h.training, &TrainingApi::fixSet,
               patchSetRequest("ses_11111111", "set_22222222", fixBody(87.5, 8), "s-live"),
               "ses_11111111", "set_22222222");
  const std::string fixed = tagOf(readSession(h.training, "ses_11111111", "s-live"));
  CHECK(fixed != grown);

  send(h.training, &TrainingApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'180'000), "s-live"),
       "ses_11111111");
  const std::string closed = tagOf(readSession(h.training, "ses_11111111", "s-live"));
  CHECK_EQ(closed.rfind(R"(W/"1700000000000-1700000180000-)", 0), std::size_t{0});
  CHECK(closed != fixed);
}

// A matching If-None-Match answers 304 with no body, and the tag still rides the reply (RFC 9110).
TEST(gym_session_detail_matching_if_none_match_is_304_and_a_new_set_unmatches_it) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  const std::string held = tagOf(readSession(h.training, "ses_11111111", "s-live"));

  drogon::HttpResponsePtr unchanged = readSession(h.training, "ses_11111111", "s-live", held);
  CHECK_EQ(unchanged->getStatusCode(), drogon::k304NotModified);
  CHECK_EQ(tagOf(unchanged), held);
  CHECK_EQ(unchanged->getBody(), std::string(""));
  CHECK_EQ(unchanged->contentType(), drogon::CT_NONE);

  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets",
                   setBody("set_22222222", "bench-press", 85.0, 1'700'000'120'000), "s-live"),
       "ses_11111111");
  drogon::HttpResponsePtr changed = readSession(h.training, "ses_11111111", "s-live", held);
  CHECK_EQ(changed->getStatusCode(), drogon::k200OK);
  CHECK(tagOf(changed) != held);
  CHECK_EQ(bodyOf(changed)["sets"].size(), 2u);
}

TEST(gym_session_detail_a_corrected_set_unmatches_the_tag_the_mirror_is_holding) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  const std::string held = tagOf(readSession(h.training, "ses_11111111", "s-live"));

  send(h.training, &TrainingApi::fixSet,
               patchSetRequest("ses_11111111", "set_11111111", fixBody(80.0, 8), "s-live"),
               "ses_11111111", "set_11111111");
  drogon::HttpResponsePtr polled = readSession(h.training, "ses_11111111", "s-live", held);

  CHECK_EQ(polled->getStatusCode(), drogon::k200OK);
  CHECK(tagOf(polled) != held);
  CHECK_EQ(bodyOf(polled)["sets"][0]["weightKg"].asDouble(), 80.0);
}

// The forms RFC 9110 §13.1.2 allows: the strong-form echo of our weak tag, a comma-separated list, and "*".
TEST(gym_session_detail_if_none_match_reads_the_rfc_9110_forms) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  const std::string held = tagOf(readSession(h.training, "ses_11111111", "s-live"));
  const std::string opaque = held.substr(2);   // the strong form of our weak tag: W/ stripped

  drogon::HttpResponsePtr strong = readSession(h.training, "ses_11111111", "s-live", opaque);
  CHECK_EQ(strong->getStatusCode(), drogon::k304NotModified);
  CHECK_EQ(tagOf(strong), held);

  drogon::HttpResponsePtr listed =
      readSession(h.training, "ses_11111111", "s-live", R"(W/"other", "stale", )" + held);
  CHECK_EQ(listed->getStatusCode(), drogon::k304NotModified);
  CHECK_EQ(tagOf(listed), held);

  drogon::HttpResponsePtr any = readSession(h.training, "ses_11111111", "s-live", "*");
  CHECK_EQ(any->getStatusCode(), drogon::k304NotModified);
  CHECK_EQ(tagOf(any), held);

  drogon::HttpResponsePtr full =
      readSession(h.training, "ses_11111111", "s-live", R"(W/"other", garbage, "1-1700000060000-0")");
  CHECK_EQ(full->getStatusCode(), drogon::k200OK);
  CHECK_EQ(tagOf(full), held);
  CHECK_EQ(bodyOf(full)["sets"].size(), 1u);
}

// startedAt leads the tag: a workout discarded and recreated under the SAME id is a new representation.
TEST(gym_session_detail_recreated_under_the_same_id_never_echoes_the_dead_workouts_tag) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.training, &TrainingApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'180'000), "s-live"),
       "ses_11111111");
  const std::string dead = tagOf(readSession(h.training, "ses_11111111", "s-live"));
  send(h.training, &TrainingApi::discardSession, deleteRequest("/v1/gym/sessions/ses_11111111", "s-live"),
       "ses_11111111");

  send(h.training, &TrainingApi::startSession,
       postRequest("/v1/gym/sessions", startBody("ses_11111111", 1'700'000'030'000), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.training, &TrainingApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'180'000), "s-live"),
       "ses_11111111");
  drogon::HttpResponsePtr recreated = readSession(h.training, "ses_11111111", "s-live", dead);

  CHECK_EQ(recreated->getStatusCode(), drogon::k200OK);
  CHECK_EQ(tagOf(recreated).rfind(R"(W/"1700000030000-1700000180000-)", 0), std::size_t{0});
  // Past `W/"` and the thirteen digits of startedAt the two tags are equal.
  CHECK_EQ(tagOf(recreated).substr(17), dead.substr(17));
}

TEST(gym_session_detail_refusals_carry_no_etag) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr absent = send(h.training, &TrainingApi::getSession,
                                        getRequest("/v1/gym/sessions/ses_99999999", "s-live"),
                                        "ses_99999999");
  drogon::HttpResponsePtr anonymous = send(h.training, &TrainingApi::getSession,
                                           getRequest("/v1/gym/sessions/ses_11111111"),
                                           "ses_11111111");

  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(absent->getHeader("ETag"), std::string(""));
  CHECK_EQ(anonymous->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(anonymous->getHeader("ETag"), std::string(""));
}

TEST(gym_last_answers_the_newest_finished_session_with_its_block) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.training, &TrainingApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'100'000), "s-live"),
       "ses_11111111");
  // The snapshot a start from a routine freezes, placed on the stored row directly.
  h.repo.db.sessions[0].plan = PlanSnapshot{"Bench day", {}};
  send(h.training, &TrainingApi::startSession,
       postRequest("/v1/gym/sessions", startBody("ses_22222222", 1'700'000'110'000), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_22222222/sets",
                   setBody("set_22222222", "bench-press", 100.0, 1'700'000'120'000), "s-live"),
       "ses_22222222");

  drogon::HttpRequestPtr request = getRequest("/v1/gym/last", "s-live");
  request->setParameter("exercise", "bench-press");
  drogon::HttpResponsePtr response = send(h.training, &TrainingApi::lastTime, request);

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  // The movement is echoed so a reply that lands after the lifter has moved on is discardable.
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"exerciseId":"bench-press","routine":"Bench day",)"
                       R"("session":{"finishedAt":1700000100000,"id":"ses_11111111",)"
                       R"("plan":{"entries":[],"routine":"Bench day"},)"
                       R"("startedAt":1700000000000},)"
                       R"("sets":[{"completedAt":1700000060000,"exerciseId":"bench-press",)"
                       R"("id":"set_11111111","kind":"working","note":"","reps":8,)"
                       R"("setNumber":1,"weightKg":82.5}]})"));
}

// An ad-hoc session has no routine to name, and the key is OMITTED rather than sent empty.
TEST(gym_last_omits_the_routine_for_a_session_trained_ad_hoc) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.training, &TrainingApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'100'000), "s-live"),
       "ses_11111111");

  drogon::HttpRequestPtr request = getRequest("/v1/gym/last", "s-live");
  request->setParameter("exercise", "bench-press");
  drogon::HttpResponsePtr response = send(h.training, &TrainingApi::lastTime, request);

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_FALSE(bodyOf(response).isMember("routine"));
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"exerciseId":"bench-press",)"
                       R"("session":{"finishedAt":1700000100000,"id":"ses_11111111",)"
                       R"("startedAt":1700000000000},)"
                       R"("sets":[{"completedAt":1700000060000,"exerciseId":"bench-press",)"
                       R"("id":"set_11111111","kind":"working","note":"","reps":8,)"
                       R"("setNumber":1,"weightKg":82.5}]})"));
}

// The prefill must not end the workout it is prefilling: it answers with the session before and leaves the live one open.
TEST(gym_last_never_closes_the_live_session_it_is_prefilling) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.training, &TrainingApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'100'000), "s-live"),
       "ses_11111111");
  send(h.training, &TrainingApi::startSession,
       postRequest("/v1/gym/sessions", startBody("ses_22222222", 1'700'000'110'000), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_22222222/sets",
                   setBody("set_22222222", "bench-press", 100.0, 1'700'000'120'000), "s-live"),
       "ses_22222222");
  h.clock.now = 1'700'000'120'000 + kAutoCloseMs;   // the live workout reads as idle past the window

  drogon::HttpRequestPtr request = getRequest("/v1/gym/last", "s-live");
  request->setParameter("exercise", "bench-press");
  drogon::HttpResponsePtr prefill = send(h.training, &TrainingApi::lastTime, request);
  drogon::HttpResponsePtr next =
      send(h.training, &TrainingApi::appendSet,
           postRequest("/v1/gym/sessions/ses_22222222/sets",
                       setBody("set_33333333", "bench-press", 102.5, 1'700'000'130'000), "s-live"),
           "ses_22222222");

  CHECK_EQ(prefill->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(prefill)["session"]["id"].asString(), std::string("ses_11111111"));
  CHECK_EQ(h.repo.db.sessions[1].id, sid("ses_22222222"));
  CHECK_EQ(h.repo.db.sessions[1].finishedAtMs, std::optional<std::uint64_t>{});
  CHECK_EQ(next->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(next)["setNumber"].asInt(), 2);
}

// A first-ever movement is answered, not refused: 200 naming the movement and nothing else.
TEST(gym_last_for_a_first_ever_movement_is_a_fact_not_a_fault) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.training, &TrainingApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'100'000), "s-live"),
       "ses_11111111");

  drogon::HttpRequestPtr request = getRequest("/v1/gym/last", "s-live");
  request->setParameter("exercise", "back-squat");
  drogon::HttpResponsePtr response = send(h.training, &TrainingApi::lastTime, request);

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"exerciseId":"back-squat"})"));
}

TEST(gym_last_of_a_movement_no_catalog_holds_is_400_no_such_exercise) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpRequestPtr unknown = getRequest("/v1/gym/last", "s-live");
  unknown->setParameter("exercise", "zercher-squat");
  drogon::HttpRequestPtr unnamed = getRequest("/v1/gym/last", "s-live");

  drogon::HttpResponsePtr unknownReply = send(h.training, &TrainingApi::lastTime, unknown);
  drogon::HttpResponsePtr unnamedReply = send(h.training, &TrainingApi::lastTime, unnamed);

  CHECK_EQ(unknownReply->getStatusCode(), drogon::k400BadRequest);
  // The same fact the write path names, under the same machine word.
  CHECK_EQ(dump(bodyOf(unknownReply)),
           std::string(R"({"code":"unknown-exercise","error":"no such exercise"})"));
  CHECK_EQ(unnamedReply->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(unnamedReply)), std::string(R"({"error":"bad exercise"})"));
}

TEST(gym_last_without_a_session_is_401) {
  Harness h;

  drogon::HttpRequestPtr request = getRequest("/v1/gym/last");
  request->setParameter("exercise", "bench-press");
  drogon::HttpResponsePtr response = send(h.training, &TrainingApi::lastTime, request);

  CHECK_EQ(response->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"sign in to open your training log"})"));
}

TEST(gym_start_from_a_routine_carries_the_frozen_plan_on_every_read) {
  Harness h;
  h.signIn("s-live");
  send(h.program, &ProgramApi::createRoutine, postRequest("/v1/gym/routines", routineBody(), "s-live"));
  Json::Value start = startBody();
  start["routineId"] = "rt_11111111";

  drogon::HttpResponsePtr started =
      send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", start, "s-live"));
  drogon::HttpResponsePtr detail = send(h.training, &TrainingApi::getSession,
                                        getRequest("/v1/gym/sessions/ses_11111111", "s-live"),
                                        "ses_11111111");

  CHECK_EQ(started->getStatusCode(), drogon::k200OK);
  // The snapshot is the SERVER's copy: the routine as a plain string and the plan's numbers, no pointer back.
  CHECK_EQ(dump(bodyOf(started)),
           std::string(R"({"id":"ses_11111111",)"
                       R"("plan":{"entries":[{"exerciseId":"bench-press","reps":5,)"
                       R"("restSeconds":180,"sets":5,"weightKg":82.5}],"routine":"Push A"},)"
                       R"("routineId":"rt_11111111","startedAt":1700000000000})"));
  CHECK_EQ(dump(bodyOf(detail)["session"]), dump(bodyOf(started)));
}

TEST(gym_start_naming_a_routine_this_account_cannot_read_is_404) {
  Harness h;
  h.signIn("s-live");
  h.repo.db.routineRows.push_back(
      Routine{rtId("rt_11111111"), uid("another-account"), "Their plan", 0, {benchEntry()}});
  Json::Value start = startBody();
  start["routineId"] = "rt_11111111";
  Json::Value unknown = startBody("ses_22222222");
  unknown["routineId"] = "rt_99999999";

  drogon::HttpResponsePtr theirs =
      send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", start, "s-live"));
  drogon::HttpResponsePtr missing =
      send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", unknown, "s-live"));

  CHECK_EQ(theirs->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(theirs)), std::string(R"({"error":"no such routine"})"));
  CHECK_EQ(missing->getStatusCode(), drogon::k404NotFound);
  CHECK(h.repo.db.sessions.empty());
}

TEST(gym_start_with_a_non_string_routine_id_is_400) {
  Harness h;
  h.signIn("s-live");
  Json::Value body = startBody();
  body["routineId"] = 7;

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", body, "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that session"})"));
  CHECK(h.repo.db.sessions.empty());
}

namespace {
// A finished session of the Legs day, its sets and the routine behind it, pushed straight in.
void trained(Harness& h, const wm::UserId& caller, const std::string& session,
             std::uint64_t startedAtMs, double weightKg, int reps) {
  const PlanSnapshot plan{"Legs", {PlanEntry{ExerciseId{"back-squat"}, 5, 5, 100.0, 180}}};
  h.repo.db.sessions.push_back(Session{sid(session), caller, startedAtMs, startedAtMs + 3'720'000,
                                    rtId("rt_11111111"), plan});
  for (int number = 1; number <= 4; ++number)
    h.repo.db.sets.push_back(Set{setId("set_" + session.substr(4) + std::to_string(number)),
                              sid(session), ExerciseId{"back-squat"}, number, weightKg, reps,
                              SetKind::working, std::nullopt, "",
                              startedAtMs + static_cast<std::uint64_t>(number) * 60'000});
}
}

TEST(gym_review_carries_the_three_facts_the_record_and_the_band) {
  Harness h;
  UserId caller = h.signIn("s-live");
  h.repo.db.routineRows.push_back(Routine{
      rtId("rt_11111111"), caller, "Legs", 0,
      {RoutineEntry{1, ExerciseId{"back-squat"}, 5, 5, 100.0, 180}}});
  trained(h, caller, "ses_22222222", 1'699'000'000'000, 90, 10);   // e1RM 120 — the mark
  trained(h, caller, "ses_11111111", 1'700'000'000'000, 105, 5);   // e1RM 122.5 — the record

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::reviewSession,
           getRequest("/v1/gym/sessions/ses_11111111/review", "s-live"), "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"against":{"movements":[{"before":{"reps":10,"sets":4,"weightKg":90.0},)"
                       R"("exerciseId":"back-squat","now":{"reps":5,"sets":4,"weightKg":105.0},)"
                       R"("planned":{"reps":5,"sets":5,"weightKg":100.0}}],"routine":"Legs",)"
                       R"("sessionId":"ses_22222222","startedAt":1699000000000},)"
                       // previousAt is the SESSION that set the mark, not the set inside it (domain/Review.h).
                       R"("record":{"exerciseId":"back-squat","kind":"e1rm","previous":120.0,)"
                       R"("previousAt":1699000000000,"reps":5,"value":122.5,"weightKg":105.0},)"
                       R"("slight":false,)"
                       R"("stats":{"durationMs":3720000,"topE1rm":122.5,"workingSets":4}})"));
}

TEST(gym_review_of_an_ordinary_session_omits_every_line_it_did_not_earn) {
  Harness h;
  UserId caller = h.signIn("s-live");
  trained(h, caller, "ses_11111111", 1'700'000'000'000, 105, 5);
  h.repo.db.sessions.back().routine = std::nullopt;   // ad-hoc: nothing to stand against
  h.repo.db.sessions.back().plan = std::nullopt;

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::reviewSession,
           getRequest("/v1/gym/sessions/ses_11111111/review", "s-live"), "ses_11111111");

  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"slight":false,)"
                       R"("stats":{"durationMs":3720000,"topE1rm":122.5,"workingSets":4}})"));
}

TEST(gym_review_of_a_missing_or_anothers_session_is_404) {
  Harness h;
  h.signIn("s-live");
  h.repo.db.sessions.push_back(Session{sid("ses_22222222"), uid("another-account"),
                                    1'700'000'000'000, 1'700'000'003'600});

  drogon::HttpResponsePtr missing =
      send(h.training, &TrainingApi::reviewSession,
           getRequest("/v1/gym/sessions/ses_99999999/review", "s-live"), "ses_99999999");
  drogon::HttpResponsePtr theirs =
      send(h.training, &TrainingApi::reviewSession,
           getRequest("/v1/gym/sessions/ses_22222222/review", "s-live"), "ses_22222222");

  CHECK_EQ(missing->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(missing)), std::string(R"({"error":"no such session"})"));
  CHECK_EQ(theirs->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(theirs)), std::string(R"({"error":"no such session"})"));
}

TEST(gym_discard_is_204_with_no_body_then_404_and_the_sets_go_with_it) {
  Harness h;
  UserId caller = h.signIn("s-live");
  trained(h, caller, "ses_11111111", 1'700'000'000'000, 105, 5);

  drogon::HttpResponsePtr discarded =
      send(h.training, &TrainingApi::discardSession, deleteRequest("/v1/gym/sessions/ses_11111111", "s-live"),
           "ses_11111111");
  drogon::HttpResponsePtr again =
      send(h.training, &TrainingApi::discardSession, deleteRequest("/v1/gym/sessions/ses_11111111", "s-live"),
           "ses_11111111");

  CHECK_EQ(discarded->getStatusCode(), drogon::k204NoContent);
  CHECK(discarded->getBody().empty());
  CHECK_EQ(again->getStatusCode(), drogon::k404NotFound);
  CHECK(h.repo.db.sessions.empty());
  CHECK(h.repo.db.sets.empty());
}

TEST(gym_discard_of_a_running_session_is_409_and_leaves_every_set_where_it_is) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.training, &TrainingApi::appendSet, postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(),
                                              "s-live"),
       "ses_11111111");

  drogon::HttpResponsePtr refused =
      send(h.training, &TrainingApi::discardSession, deleteRequest("/v1/gym/sessions/ses_11111111", "s-live"),
           "ses_11111111");

  CHECK_EQ(refused->getStatusCode(), drogon::k409Conflict);
  // Its own code: no id to re-mint and no body to fix — finish the workout and send it again.
  CHECK_EQ(dump(bodyOf(refused)),
           std::string(R"({"code":"session-open","error":"that session is still running"})"));
  CHECK_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.db.sets.size(), static_cast<std::size_t>(1));
}

TEST(gym_unknown_session_detail_is_404) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response = send(h.training, &TrainingApi::getSession,
                                          getRequest("/v1/gym/sessions/ses_99999999", "s-live"),
                                          "ses_99999999");

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"no such session"})"));
}

// One point per finished session per movement, Epley over it, the standing bests, and the weekly counts.
TEST(gym_stats_answers_a_line_per_movement_and_the_weeks_around_it) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 4);

  drogon::HttpResponsePtr response = send(h.training, &TrainingApi::stats, getRequest("/v1/gym/stats", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  // Every instant in this body is the SESSION's start: the bests, the point they sit on, and the last-trained line.
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"movements":[{"bestE1rm":{"at":1700000000000,"e1rm":104.5,)"
                       R"("reps":8,"weightKg":82.5},)"
                       R"("exerciseId":"bench-press",)"
                       R"("heaviest":{"at":1700000000000,"e1rm":104.5,"reps":8,"weightKg":82.5},)"
                       R"("lastTrainedAt":1700000000000,)"
                       R"("points":[{"at":1700000000000,"e1rm":104.5,"reps":8,"weightKg":82.5}]}],)"
                       R"("weeks":[{"sessions":1,"startedAt":1699833600000,"workingSets":4}]})"));
}

// An account with nothing finished yet answers with the two empty lists rather than a 404 or a zeroed skeleton.
TEST(gym_stats_of_an_untrained_account_is_two_empty_lists) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response = send(h.training, &TrainingApi::stats, getRequest("/v1/gym/stats", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"movements":[],"weeks":[]})"));
}

// The bytes in full: a header row, CRLF between records, and RFC 4180 quoting; a note is never edited.
TEST(gym_export_is_a_csv_attachment_and_quotes_only_what_needs_it) {
  Harness h;
  h.signIn("s-live");
  send(h.training, &TrainingApi::startSession,
       postRequest("/v1/gym/sessions", startBody("ses_11111111", 1'700'000'000'000), "s-live"));
  Json::Value set = setBody("set_11111111", "bench-press", 82.5, 1'700'000'060'000);
  set["note"] = R"(felt heavy, said "again")";
  set["rpe"] = 8.5;
  send(h.training, &TrainingApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", set, "s-live"), "ses_11111111");

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::exportSets, getRequest("/v1/gym/export", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(response->getHeader("Content-Disposition"),
           std::string(R"(attachment; filename="windmill-gym-sets.csv")"));
  CHECK_EQ(std::string(response->getBody()),
           std::string("session_id,started_at,finished_at,routine,set_id,exercise_id,exercise,"
                       "set_number,weight_kg,reps,kind,rpe,note,completed_at\r\n"
                       "ses_11111111,2023-11-14T22:13:20Z,,,set_11111111,bench-press,Bench Press,"
                       R"(1,82.50,8,working,8.5,"felt heavy, said ""again""",)"
                       "2023-11-14T22:14:20Z\r\n"));
}

TEST(gym_export_of_an_empty_log_is_still_a_header_row) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::exportSets, getRequest("/v1/gym/export", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(std::string(response->getBody()),
           std::string("session_id,started_at,finished_at,routine,set_id,exercise_id,exercise,"
                       "set_number,weight_kg,reps,kind,rpe,note,completed_at\r\n"));
}

TEST(gym_share_answers_a_token_and_an_end_and_a_second_tap_answers_the_same_one) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 4);

  drogon::HttpResponsePtr first =
      send(h.training, &TrainingApi::shareSession,
           postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue),
                       "s-live"),
           "ses_11111111");
  drogon::HttpResponsePtr again =
      send(h.training, &TrainingApi::shareSession,
           postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue),
                       "s-live"),
           "ses_11111111");

  CHECK_EQ(first->getStatusCode(), drogon::k200OK);
  CHECK_EQ(again->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(first)), dump(bodyOf(again)));
  CHECK(!bodyOf(first)["token"].asString().empty());
  CHECK_EQ(bodyOf(first)["expiresAt"].asUInt64(), h.clock.now + kShareLifetimeMs);
  CHECK_EQ(h.repo.db.shares.size(), static_cast<std::size_t>(1));
}

// The reply carries the LINK, not just the secret, and the server composes it once for every surface.
TEST(gym_share_answers_the_page_a_coach_opens_and_never_the_json_route) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 4);

  drogon::HttpResponsePtr minted =
      send(h.training, &TrainingApi::shareSession,
           postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue),
                       "s-live"),
           "ses_11111111");

  const std::string url = bodyOf(minted)["url"].asString();
  CHECK_EQ(url, "https://windmill.works/#/gym/shared/" + bodyOf(minted)["token"].asString());
  CHECK(url.find("/v1/") == std::string::npos);
}

TEST(gym_share_adds_a_row_beside_the_session_and_never_touches_it) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 4);
  const Session before = h.repo.db.sessions[0];

  send(h.training, &TrainingApi::shareSession,
       postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue), "s-live"),
       "ses_11111111");

  CHECK_EQ(h.repo.db.sessions[0], before);
  CHECK_EQ(h.repo.db.shares.size(), static_cast<std::size_t>(1));
}

TEST(gym_share_of_a_missing_or_anothers_session_is_404) {
  Harness h;
  const UserId other = h.signIn("s-other");
  h.repo.db.sessions.push_back(Session{SessionId{"ses_22222222"}, other, 1'700'000'000'000,
                                    1'700'003'600'000});
  h.authRepo.insertSession(h.tokens.digestOf("s-live"),
                           h.authRepo.createUser(Email{"lifter@example.com"}, "lifter").id,
                           h.clock.now + 1'000'000, "", "", h.clock.now);

  drogon::HttpResponsePtr absent =
      send(h.training, &TrainingApi::shareSession,
           postRequest("/v1/gym/sessions/ses_99999999/share", Json::Value(Json::objectValue),
                       "s-live"),
           "ses_99999999");
  drogon::HttpResponsePtr theirs =
      send(h.training, &TrainingApi::shareSession,
           postRequest("/v1/gym/sessions/ses_22222222/share", Json::Value(Json::objectValue),
                       "s-live"),
           "ses_22222222");

  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(theirs->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(absent)), dump(bodyOf(theirs)));   // absent and forbidden are one fact
  CHECK(h.repo.db.shares.empty());
}

// The one route in gym that resolves no caller: the token in the path is the whole credential.
TEST(gym_shared_session_needs_no_caller_and_carries_no_id) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 2);
  drogon::HttpResponsePtr minted =
      send(h.training, &TrainingApi::shareSession,
           postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue),
                       "s-live"),
           "ses_11111111");
  const std::string token = bodyOf(minted)["token"].asString();

  drogon::HttpResponsePtr read =
      send(h.training, &TrainingApi::sharedSession, getRequest("/v1/gym/shared/" + token), token);

  CHECK_EQ(read->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(read)),
           std::string(R"({"finishedAt":1700003600000,"sets":[)"
                       R"({"completedAt":1700000060000,"exercise":"Bench Press","kind":"working",)"
                       R"("note":"","reps":8,"setNumber":1,"weightKg":82.5},)"
                       R"({"completedAt":1700000120000,"exercise":"Bench Press","kind":"working",)"
                       R"("note":"","reps":8,"setNumber":2,"weightKg":82.5}],)"
                       R"("startedAt":1700000000000})"));
}

// Revoked, expired and never-minted answer ONE 404, byte for byte, so a token cannot be probed.
TEST(gym_shared_token_that_is_revoked_expired_or_unknown_is_one_404) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 2);
  drogon::HttpResponsePtr minted =
      send(h.training, &TrainingApi::shareSession,
           postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue),
                       "s-live"),
           "ses_11111111");
  const std::string token = bodyOf(minted)["token"].asString();

  drogon::HttpResponsePtr unknown = send(h.training, &TrainingApi::sharedSession,
                                         getRequest("/v1/gym/shared/nobody-minted-this"),
                                         "nobody-minted-this");
  h.clock.now += kShareLifetimeMs + 1;
  drogon::HttpResponsePtr expired =
      send(h.training, &TrainingApi::sharedSession, getRequest("/v1/gym/shared/" + token), token);
  send(h.training, &TrainingApi::revokeShare, deleteRequest("/v1/gym/sessions/ses_11111111/share", "s-live"),
       "ses_11111111");
  drogon::HttpResponsePtr revoked =
      send(h.training, &TrainingApi::sharedSession, getRequest("/v1/gym/shared/" + token), token);

  CHECK_EQ(unknown->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(expired->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(revoked->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(unknown)), std::string(R"({"error":"no such session"})"));
  CHECK_EQ(dump(bodyOf(expired)), dump(bodyOf(unknown)));
  CHECK_EQ(dump(bodyOf(revoked)), dump(bodyOf(unknown)));
}

TEST(gym_revoke_answers_204_and_a_second_revoke_is_the_same_fact_as_never_having_shared) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 2);
  send(h.training, &TrainingApi::shareSession,
       postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue), "s-live"),
       "ses_11111111");

  drogon::HttpResponsePtr first =
      send(h.training, &TrainingApi::revokeShare,
           deleteRequest("/v1/gym/sessions/ses_11111111/share", "s-live"), "ses_11111111");
  drogon::HttpResponsePtr again =
      send(h.training, &TrainingApi::revokeShare,
           deleteRequest("/v1/gym/sessions/ses_11111111/share", "s-live"), "ses_11111111");

  CHECK_EQ(first->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(again->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(again)), std::string(R"({"error":"no such session"})"));
  CHECK(h.repo.db.shares.empty());
  CHECK_EQ(h.repo.db.sessions.size(), static_cast<std::size_t>(1));   // the workout itself is untouched
}
