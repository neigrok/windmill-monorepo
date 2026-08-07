#include "products/gym/adapters/http/GymApi.h"

#include "platform/adapters/json/JsonText.h"
#include "products/gym/adapters/json/TrainingJson.h"
#include "test/platform/Fakes.h"
#include "test/products/gym/Fakes.h"
#include "test/testing.h"

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

namespace {

// The fake repository enforces the SAME rules as the SQL (PK no-op, one-open refusal, max+1
// numbering), so what the wire assertions below pin down is exactly what the live server says.

// A store that reads fine and refuses to write — a dropped connection, a statement timeout, a
// deadlock. Its failure is NOT InvalidTraining, and the whole point of the narrowed catch is that
// this can never come back wearing the client's 400.
struct DownRepository : FakeTrainingRepository {
  void insertSession(const Session&) override { throw std::runtime_error("storage is down"); }
  SetInsertOutcome insertSet(const Set&) override { throw std::runtime_error("storage is down"); }
};

struct Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, "https://windmill.works");
  FakeTrainingRepository repo;
  std::shared_ptr<LogService> log = std::make_shared<LogService>(repo, clock, tokens);
  GymApi api{log, auth, "https://windmill.works"};

  Harness() {
    repo.seed(benchPress());
    repo.seed(backSquat());
  }

  UserId signIn(const std::string& sessionSecret) {
    User user = authRepo.createUser(Email{"sam@example.com"}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock.now + 1'000'000, "", "",
                           clock.now);
    return user.id;
  }
};

drogon::HttpRequestPtr getRequest(const std::string& path, const std::string& session = "") {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Get);
  request->setPath(path);
  if (!session.empty()) request->addCookie("wm_session", session);
  return request;
}

drogon::HttpRequestPtr postRequest(const std::string& path, const Json::Value& body,
                                   const std::string& session = "") {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Post);
  request->setPath(path);
  request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  request->setBody(dump(body));
  if (!session.empty()) request->addCookie("wm_session", session);
  return request;
}

Json::Value startBody(const std::string& id = "ses_11111111",
                      std::uint64_t startedAt = 1'700'000'000'000) {
  Json::Value body(Json::objectValue);
  body["id"] = id;
  body["startedAt"] = Json::Value::UInt64(startedAt);
  return body;
}

Json::Value setBody(const std::string& id = "set_11111111",
                    const std::string& exercise = "bench-press", double weightKg = 82.5,
                    std::uint64_t completedAt = 1'700'000'060'000) {
  Json::Value body(Json::objectValue);
  body["id"] = id;
  body["exerciseId"] = exercise;
  body["weightKg"] = weightKg;
  body["reps"] = 8;
  body["completedAt"] = Json::Value::UInt64(completedAt);
  return body;
}

Json::Value finishBody(std::uint64_t finishedAt) {
  Json::Value body(Json::objectValue);
  body["finishedAt"] = Json::Value::UInt64(finishedAt);
  return body;
}

drogon::HttpRequestPtr putRequest(const std::string& path, const Json::Value& body,
                                  const std::string& session = "") {
  drogon::HttpRequestPtr request = postRequest(path, body, session);
  request->setMethod(drogon::Put);
  return request;
}

drogon::HttpRequestPtr deleteRequest(const std::string& path, const std::string& session = "") {
  drogon::HttpRequestPtr request = getRequest(path, session);
  request->setMethod(drogon::Delete);
  return request;
}

// One line of a plan, as a client sends it: entries carry no position — the order IS the order.
Json::Value entryBody(const std::string& exercise = "bench-press", int targetSets = 5,
                      int targetReps = 5) {
  Json::Value entry(Json::objectValue);
  entry["exerciseId"] = exercise;
  entry["targetSets"] = targetSets;
  entry["targetReps"] = targetReps;
  entry["targetWeightKg"] = 82.5;
  entry["restSeconds"] = 180;
  return entry;
}

Json::Value routineBody(const std::string& id = "rt_11111111", const std::string& name = "Push A") {
  Json::Value body(Json::objectValue);
  body["id"] = id;
  body["name"] = name;
  body["position"] = 0;
  Json::Value entries(Json::arrayValue);
  entries.append(entryBody());
  body["entries"] = entries;
  return body;
}

Json::Value exerciseBody(const std::string& id = "ex_11111111",
                         const std::string& name = "Zercher Squat") {
  Json::Value body(Json::objectValue);
  body["id"] = id;
  body["name"] = name;
  body["pattern"] = "squat";
  body["equipment"] = "barbell";
  return body;
}

drogon::HttpResponsePtr send(GymApi& api, void (GymApi::*handler)(const drogon::HttpRequestPtr&,
                                                                  HttpCallback&&),
                             const drogon::HttpRequestPtr& request) {
  drogon::HttpResponsePtr captured;
  (api.*handler)(request, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

drogon::HttpResponsePtr send(GymApi& api,
                             void (GymApi::*handler)(const drogon::HttpRequestPtr&, HttpCallback&&,
                                                     const std::string&),
                             const drogon::HttpRequestPtr& request, const std::string& id) {
  drogon::HttpResponsePtr captured;
  (api.*handler)(request, [&](const drogon::HttpResponsePtr& response) { captured = response; },
                 id);
  return captured;
}

Json::Value bodyOf(const drogon::HttpResponsePtr& response) { return *response->getJsonObject(); }

// A whole finished workout driven through the wire, which is what the three reads added at the
// bottom of this file are asked about — nothing there reaches past a handler into the store.
void trainedThrough(Harness& h, const std::string& cookie, const std::string& session,
                    std::uint64_t startedAt, int sets) {
  send(h.api, &GymApi::startSession,
       postRequest("/v1/gym/sessions", startBody(session, startedAt), cookie));
  for (int number = 1; number <= sets; ++number)
    send(h.api, &GymApi::appendSet,
         postRequest("/v1/gym/sessions/" + session + "/sets",
                     setBody("set_" + session.substr(4) + std::to_string(number), "bench-press",
                             82.5, startedAt + static_cast<std::uint64_t>(number) * 60'000),
                     cookie),
         session);
  send(h.api, &GymApi::finishSession,
       postRequest("/v1/gym/sessions/" + session + "/finish", finishBody(startedAt + 3'600'000),
                   cookie),
       session);
}

}

// ---- the owner gate -----------------------------------------------------------------------

TEST(gym_routes_without_a_session_are_401) {
  Harness h;

  drogon::HttpResponsePtr exercises =
      send(h.api, &GymApi::listExercises, getRequest("/v1/gym/exercises"));
  drogon::HttpResponsePtr start =
      send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody()));
  drogon::HttpResponsePtr append = send(h.api, &GymApi::appendSet,
                                        postRequest("/v1/gym/sessions/ses_11111111/sets", setBody()),
                                        "ses_11111111");
  drogon::HttpResponsePtr routines =
      send(h.api, &GymApi::listRoutines, getRequest("/v1/gym/routines"));
  drogon::HttpResponsePtr createRoutine =
      send(h.api, &GymApi::createRoutine, postRequest("/v1/gym/routines", routineBody()));
  drogon::HttpResponsePtr deleteRoutine =
      send(h.api, &GymApi::deleteRoutine, deleteRequest("/v1/gym/routines/rt_11111111"),
           "rt_11111111");
  drogon::HttpResponsePtr createExercise =
      send(h.api, &GymApi::createExercise, postRequest("/v1/gym/exercises", exerciseBody()));
  drogon::HttpResponsePtr review =
      send(h.api, &GymApi::reviewSession, getRequest("/v1/gym/sessions/ses_11111111/review"),
           "ses_11111111");
  drogon::HttpResponsePtr discard =
      send(h.api, &GymApi::discardSession, deleteRequest("/v1/gym/sessions/ses_11111111"),
           "ses_11111111");
  drogon::HttpResponsePtr stats = send(h.api, &GymApi::stats, getRequest("/v1/gym/stats"));
  drogon::HttpResponsePtr exported =
      send(h.api, &GymApi::exportSets, getRequest("/v1/gym/export"));
  drogon::HttpResponsePtr share =
      send(h.api, &GymApi::shareSession,
           postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue)),
           "ses_11111111");
  drogon::HttpResponsePtr revoke =
      send(h.api, &GymApi::revokeShare, deleteRequest("/v1/gym/sessions/ses_11111111/share"),
           "ses_11111111");

  CHECK_EQ(exercises->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(exercises)), std::string(R"({"error":"sign in to open your training log"})"));
  CHECK_EQ(start->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(append->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(routines->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(createRoutine->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(deleteRoutine->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(createExercise->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(review->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(discard->getStatusCode(), drogon::k401Unauthorized);
  // The share's two owner-scoped doors and the two long reads sit on this side of the gate with
  // everything else. Only `GET /v1/gym/shared/{token}` is on the other side, and it is the only
  // handler in this class that never asks who is calling.
  CHECK_EQ(stats->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(exported->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(share->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(revoke->getStatusCode(), drogon::k401Unauthorized);
  CHECK(h.repo.sessions.empty());
  CHECK(h.repo.sets.empty());
  CHECK(h.repo.routineRows.empty());
  CHECK(h.repo.customs.empty());
  CHECK(h.repo.shares.empty());
}

// ---- the catalog --------------------------------------------------------------------------

TEST(gym_exercises_lists_the_catalog_in_pattern_then_name_order) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::listExercises, getRequest("/v1/gym/exercises", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"exercises":[)"
                       R"({"custom":false,"equipment":"barbell","id":"bench-press",)"
                       R"("name":"Bench Press","pattern":"press","stepKg":2.5},)"
                       R"({"custom":false,"equipment":"barbell","id":"back-squat",)"
                       R"("name":"Back Squat","pattern":"squat","stepKg":2.5}]})"));
}

// ---- start: the idempotent door -----------------------------------------------------------

TEST(gym_start_round_trips_the_resolved_session) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"id":"ses_11111111","startedAt":1700000000000})"));

  // A replayed POST answers with the SAME session — no second row, no phantom.
  drogon::HttpResponsePtr replayed =
      send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  CHECK_EQ(dump(bodyOf(replayed)), std::string(R"({"id":"ses_11111111","startedAt":1700000000000})"));
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
}

TEST(gym_start_with_an_id_another_account_already_spent_is_409) {
  Harness h;
  h.signIn("s-live");
  // The id is taken by a row this caller can never see. The old reply was 200 for a session the
  // store never accepted — every set into it 404'd, forever, and the client never learned why.
  h.repo.sessions.push_back(Session{sid("ses_11111111"), uid("another-account"), 1'699'000'000'000});

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  // The code is the contract the flush queue branches on; the sentence is for a human reading a
  // log. A client that told the three 409s apart by their wording degraded to "terminal, reason
  // unknown" the first time one was reworded — and dropped a set it should have re-minted an id for.
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"session-id-taken","error":"that session id is taken"})"));
  REQUIRE_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.sessions[0].user, uid("another-account"));
}

TEST(gym_start_that_will_not_join_is_409_while_a_session_is_open) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.repo.sessions.push_back(Session{sid("ses_11111111"), me, 1'700'000'000'000});

  Json::Value backfill = startBody("ses_22222222", 1'699'000'000'000);
  backfill["joinOpenSession"] = false;
  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", backfill, "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  // Its own code, because its repair is neither of the other two 409s': a fresh id changes nothing
  // while a session is open — the open workout has to end first, then the same body is sent again.
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"session-already-open","error":"another session is already open"})"));
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
}

// Omitted is the join, so every caller written before the field keeps meaning what it meant — and
// the handoff (§11.3) keeps working: a second device's Start continues the open workout.
TEST(gym_start_without_the_field_still_joins_the_open_session) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.repo.sessions.push_back(Session{sid("ses_11111111"), me, 1'700'000'000'000});

  drogon::HttpResponsePtr response = send(h.api, &GymApi::startSession,
                                          postRequest("/v1/gym/sessions",
                                                      startBody("ses_22222222"), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"id":"ses_11111111","startedAt":1700000000000})"));
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
}

// A string where the boolean belongs is a 400, never a guess: the two Starts differ by which sets
// land in which workout, so the one thing this field may not do is default quietly on a typo.
TEST(gym_start_with_a_non_boolean_join_is_400) {
  Harness h;
  h.signIn("s-live");

  Json::Value body = startBody();
  body["joinOpenSession"] = "false";
  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", body, "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that session"})"));
  CHECK(h.repo.sessions.empty());
}

TEST(gym_start_with_a_malformed_id_is_400) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response = send(
      h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody("short"), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that session"})"));
  CHECK(h.repo.sessions.empty());
}

TEST(gym_start_without_a_started_instant_is_400) {
  Harness h;
  h.signIn("s-live");
  Json::Value body(Json::objectValue);
  body["id"] = "ses_11111111";

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", body, "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that session"})"));
}

// ---- append: the durable set write --------------------------------------------------------

TEST(gym_append_round_trips_the_stored_set) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::appendSet,
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
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  Json::Value body = setBody();
  body["kind"] = "warmup";
  body["rpe"] = 8.5;
  body["note"] = "paused reps";

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::appendSet,
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
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  Json::Value body = setBody();
  body["kind"] = "amrap";

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets", body, "s-live"), "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that set"})"));
  CHECK(h.repo.sets.empty());
}

// The catalog is storage's to know, so this refusal is the store's fact travelling as a VALUE
// through the port. It used to be a pqxx::foreign_key_violation caught at the wire, which the fake
// could only imitate by throwing InvalidTraining — so under test the path said "could not read that
// set" while the live server said "no such exercise", and nothing pinned either sentence.
TEST(gym_append_naming_a_movement_no_catalog_holds_is_400_no_such_exercise) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets",
                       setBody("set_11111111", "zercher-squat"), "s-live"),
           "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"unknown-exercise","error":"no such exercise"})"));
  CHECK(h.repo.sets.empty());
  REQUIRE_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.sessions[0].finishedAtMs, std::optional<std::uint64_t>{});
}

TEST(gym_append_to_an_unknown_session_is_404) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::appendSet,
           postRequest("/v1/gym/sessions/ses_99999999/sets", setBody(), "s-live"), "ses_99999999");

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"no such session"})"));
}

TEST(gym_append_to_a_finished_session_is_409) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'100'000), "s-live"),
       "ses_11111111");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"session-finished","error":"that session is finished"})"));
  CHECK(h.repo.sets.empty());
}

TEST(gym_append_replayed_into_a_finished_session_returns_the_stored_set) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  drogon::HttpResponsePtr landed =
      send(h.api, &GymApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.api, &GymApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'100'000), "s-live"),
       "ses_11111111");

  // The queue's whole premise: replay in any order, any number of times, converging on one row per
  // minted id. A set that ALREADY landed must not be told 409 just because the session has since
  // closed — the 409 answers new ids only, and the queue drops those on purpose.
  drogon::HttpResponsePtr replayed =
      send(h.api, &GymApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  CHECK_EQ(landed->getStatusCode(), drogon::k200OK);
  CHECK_EQ(replayed->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(replayed)), dump(bodyOf(landed)));
  CHECK_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
}

TEST(gym_append_with_a_set_id_already_spent_elsewhere_is_409) {
  Harness h;
  UserId user = h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  // The id belongs to a row outside this session — another account's, or this account's own
  // earlier workout. Either way the reply used to be 200 carrying THAT row, so a stranger's note
  // and weight came back and the caller's set was silently dropped.
  h.repo.sets.push_back(Set{setId("set_11111111"), sid("ses_99999999"), ExerciseId{"bench-press"},
                            1, 142.5, 3, SetKind::working, 9.5, "knee felt off", 1'699'000'000'000});

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"set-id-taken","error":"that set id is already used"})"));
  REQUIRE_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.sets[0].session, sid("ses_99999999"));
  CHECK_EQ(h.repo.sets[0].note, std::string("knee felt off"));
  CHECK_EQ(user, h.repo.sessions[0].user);
}

// ---- finish -------------------------------------------------------------------------------

TEST(gym_finish_round_trips_and_replays_keep_the_first_instant) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));

  drogon::HttpResponsePtr finished =
      send(h.api, &GymApi::finishSession,
           postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'100'000),
                       "s-live"),
           "ses_11111111");
  drogon::HttpResponsePtr replayed =
      send(h.api, &GymApi::finishSession,
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
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::finishSession,
           postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(0), "s-live"),
           "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that finish"})"));
  // An unset device clock closed the session permanently at 1970 — first-writer-wins made it
  // unrepairable. The refusal is the repair: nothing was written.
  REQUIRE_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.sessions[0].finishedAtMs, std::optional<std::uint64_t>{});
}

TEST(gym_finish_before_the_session_began_is_400) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::finishSession,
           postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'699'999'000'000),
                       "s-live"),
           "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"error":"a session cannot finish before it began"})"));
  CHECK_EQ(h.repo.sessions[0].finishedAtMs, std::optional<std::uint64_t>{});
}

// ---- the instant ceiling: one rule, all three instants ------------------------------------

TEST(gym_an_instant_past_the_end_of_time_is_400_on_every_write) {
  Harness h;
  h.signIn("s-live");
  constexpr std::uint64_t past = kMaxInstantMs + 1;
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));

  drogon::HttpResponsePtr start = send(
      h.api, &GymApi::startSession,
      postRequest("/v1/gym/sessions", startBody("ses_22222222", past), "s-live"));
  drogon::HttpResponsePtr append =
      send(h.api, &GymApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets",
                       setBody("set_11111111", "bench-press", 82.5, past), "s-live"),
           "ses_11111111");
  drogon::HttpResponsePtr finish =
      send(h.api, &GymApi::finishSession,
           postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(past), "s-live"),
           "ses_11111111");

  CHECK_EQ(start->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(start)), std::string(R"({"error":"could not read that session"})"));
  CHECK_EQ(append->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(append)), std::string(R"({"error":"could not read that set"})"));
  // This one used to be the leaked 500: the close ran outside the catch, and the overflow reached
  // to_timestamp() as an uncaught pqxx error.
  CHECK_EQ(finish->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(finish)), std::string(R"({"error":"could not read that finish"})"));
  REQUIRE_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.sessions[0].finishedAtMs, std::optional<std::uint64_t>{});
  CHECK(h.repo.sets.empty());
}

// ---- storage failures wear the server's status, never the client's -------------------------

TEST(gym_a_storage_failure_on_append_is_never_the_clients_400) {
  Harness h;
  UserId user = h.signIn("s-live");
  DownRepository down;
  down.seed(benchPress());
  down.sessions.push_back(Session{sid("ses_11111111"), user, 1'700'000'000'000});
  auto log = std::make_shared<LogService>(down, h.clock, h.tokens);
  GymApi api{log, h.auth, "https://windmill.works"};

  // The house exception handler answers 500 "internal error" — a status the flush queue retries,
  // where the old 400 told it to drop the lifter's set forever.
  bool escaped = false;
  drogon::HttpResponsePtr response;
  try {
    response = send(api, &GymApi::appendSet,
                    postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"),
                    "ses_11111111");
  } catch (const std::runtime_error&) {
    escaped = true;
  }

  CHECK(escaped);
  CHECK(response == nullptr);
  CHECK(down.sets.empty());
}

TEST(gym_a_storage_failure_on_start_is_never_the_clients_400) {
  Harness h;
  h.signIn("s-live");
  DownRepository down;
  auto log = std::make_shared<LogService>(down, h.clock, h.tokens);
  GymApi api{log, h.auth, "https://windmill.works"};

  bool escaped = false;
  drogon::HttpResponsePtr response;
  try {
    response = send(api, &GymApi::startSession,
                    postRequest("/v1/gym/sessions", startBody(), "s-live"));
  } catch (const std::runtime_error&) {
    escaped = true;
  }

  CHECK(escaped);
  CHECK(response == nullptr);
  CHECK(down.sessions.empty());
}

// ---- the log reads ------------------------------------------------------------------------

TEST(gym_list_sessions_wraps_summaries_with_counts_names_and_the_top_set) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets",
                   setBody("set_22222222", "back-squat", 100.0, 1'700'000'120'000), "s-live"),
       "ses_11111111");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::listSessions, getRequest("/v1/gym/sessions", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  // The row's four facts: how many sets, which movements, the heaviest working set in it, and
  // whether the four-hour rule ended it — this one is still running, so nothing ended it.
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"sessions":[{"closedItself":false,)"
                       R"("exercises":["Back Squat","Bench Press"],"id":"ses_11111111",)"
                       R"("setCount":2,"startedAt":1700000000000,)"
                       R"("topSet":{"reps":8,"weightKg":100.0}}]})"));
}

// The log row G8 draws: `Legs closed on its own` under a session nobody finished, and no top set at
// all for one holding nothing but a ramp-up. Both are absences with a sentence behind them.
TEST(gym_list_sessions_says_which_row_closed_itself_and_omits_an_absent_top_set) {
  Harness h;
  UserId user = h.signIn("s-live");
  // A session the four-hour rule ended, in the state that rule leaves behind: finished at its last
  // set's instant exactly. Nothing else writes that, which is why the row can infer it.
  h.repo.sessions.push_back(
      Session{sid("ses_11111111"), user, 1'700'000'000'000, 1'700'000'060'000});
  h.repo.sets.push_back(Set{setId("set_11111111"), sid("ses_11111111"), ExerciseId{"bench-press"},
                            1, 40.0, 10, SetKind::warmup, std::nullopt, "", 1'700'000'060'000});

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::listSessions, getRequest("/v1/gym/sessions", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"sessions":[{"closedItself":true,"exercises":["Bench Press"],)"
                       R"("finishedAt":1700000060000,"id":"ses_11111111","setCount":1,)"
                       R"("startedAt":1700000000000}]})"));
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

  drogon::HttpResponsePtr digitsReply = send(h.api, &GymApi::listSessions, digits);
  drogon::HttpResponsePtr shapeReply = send(h.api, &GymApi::listSessions, shape);
  drogon::HttpResponsePtr halfReply = send(h.api, &GymApi::listSessions, halfCursor);

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
  // Two workouts that started in the same millisecond — a bulk import's coarse stamps, or an
  // offline replay. On a bare `started_at <` cursor the tie-mate below the page edge is in no
  // page, ever; the (startedAt, id) cursor carries both halves, so the walk sees all four.
  h.repo.sessions.push_back(Session{sid("ses_aaaaaaa4"), user, 1'700'000'003'000, 1'700'000'004'000});
  h.repo.sessions.push_back(Session{sid("ses_aaaaaaa3"), user, 1'700'000'002'000, 1'700'000'004'000});
  h.repo.sessions.push_back(Session{sid("ses_aaaaaaa2"), user, 1'700'000'002'000, 1'700'000'004'000});
  h.repo.sessions.push_back(Session{sid("ses_aaaaaaa1"), user, 1'700'000'001'000, 1'700'000'004'000});

  drogon::HttpRequestPtr firstPage = getRequest("/v1/gym/sessions", "s-live");
  firstPage->setParameter("limit", "2");
  drogon::HttpResponsePtr one = send(h.api, &GymApi::listSessions, firstPage);
  drogon::HttpRequestPtr secondPage = getRequest("/v1/gym/sessions", "s-live");
  secondPage->setParameter("limit", "2");
  secondPage->setParameter("before", "1700000002000");
  secondPage->setParameter("beforeId", "ses_aaaaaaa3");
  drogon::HttpResponsePtr two = send(h.api, &GymApi::listSessions, secondPage);

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
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  drogon::HttpResponsePtr response = send(h.api, &GymApi::getSession,
                                          getRequest("/v1/gym/sessions/ses_11111111", "s-live"),
                                          "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"session":{"id":"ses_11111111","startedAt":1700000000000},)"
                       R"("sets":[{"completedAt":1700000060000,"exerciseId":"bench-press",)"
                       R"("id":"set_11111111","kind":"working","note":"","reps":8,)"
                       R"("setNumber":1,"weightKg":82.5}]})"));
}

// ---- last time: the prefill read ----------------------------------------------------------

TEST(gym_last_answers_the_newest_finished_session_with_its_block) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.api, &GymApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'100'000), "s-live"),
       "ses_11111111");
  // The snapshot a start from a routine freezes, placed on the stored row directly so this test
  // stays about the prefill reply — and it rides that reply as the object it is.
  h.repo.sessions[0].plan = PlanSnapshot{"Bench day", {}};
  // Today's live session benches heavier. It is the today list, not last time.
  send(h.api, &GymApi::startSession,
       postRequest("/v1/gym/sessions", startBody("ses_22222222", 1'700'000'110'000), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_22222222/sets",
                   setBody("set_22222222", "bench-press", 100.0, 1'700'000'120'000), "s-live"),
       "ses_22222222");

  drogon::HttpRequestPtr request = getRequest("/v1/gym/last", "s-live");
  request->setParameter("exercise", "bench-press");
  drogon::HttpResponsePtr response = send(h.api, &GymApi::lastTime, request);

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  // The movement is echoed so a reply that lands after the lifter has moved on is discardable; the
  // routine is the name that session was trained under, which is what the card's cross-routine
  // suffix says out loud.
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"exerciseId":"bench-press","routine":"Bench day",)"
                       R"("session":{"finishedAt":1700000100000,"id":"ses_11111111",)"
                       R"("plan":{"entries":[],"routine":"Bench day"},)"
                       R"("startedAt":1700000000000},)"
                       R"("sets":[{"completedAt":1700000060000,"exerciseId":"bench-press",)"
                       R"("id":"set_11111111","kind":"working","note":"","reps":8,)"
                       R"("setNumber":1,"weightKg":82.5}]})"));
}

// An ad-hoc session has no routine to name, and the key is OMITTED rather than sent empty: the card
// draws its cross-routine suffix from the presence of the word, so an empty string would print a
// day of the program that never existed.
TEST(gym_last_omits_the_routine_for_a_session_trained_ad_hoc) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.api, &GymApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'100'000), "s-live"),
       "ses_11111111");

  drogon::HttpRequestPtr request = getRequest("/v1/gym/last", "s-live");
  request->setParameter("exercise", "bench-press");
  drogon::HttpResponsePtr response = send(h.api, &GymApi::lastTime, request);

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

// The prefill is fired on every movement change, so it must not be the thing that ends the workout
// it is prefilling. A device whose clock runs behind stamps its sets past the auto-close window;
// the read answers with the session before, leaves the live one open, and the next set still lands.
TEST(gym_last_never_closes_the_live_session_it_is_prefilling) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.api, &GymApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'100'000), "s-live"),
       "ses_11111111");
  send(h.api, &GymApi::startSession,
       postRequest("/v1/gym/sessions", startBody("ses_22222222", 1'700'000'110'000), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_22222222/sets",
                   setBody("set_22222222", "bench-press", 100.0, 1'700'000'120'000), "s-live"),
       "ses_22222222");
  h.clock.now = 1'700'000'120'000 + kAutoCloseMs;   // the live workout reads as idle past the window

  drogon::HttpRequestPtr request = getRequest("/v1/gym/last", "s-live");
  request->setParameter("exercise", "bench-press");
  drogon::HttpResponsePtr prefill = send(h.api, &GymApi::lastTime, request);
  drogon::HttpResponsePtr next =
      send(h.api, &GymApi::appendSet,
           postRequest("/v1/gym/sessions/ses_22222222/sets",
                       setBody("set_33333333", "bench-press", 102.5, 1'700'000'130'000), "s-live"),
           "ses_22222222");

  CHECK_EQ(prefill->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(prefill)["session"]["id"].asString(), std::string("ses_11111111"));
  CHECK_EQ(h.repo.sessions[1].id, sid("ses_22222222"));
  CHECK_EQ(h.repo.sessions[1].finishedAtMs, std::optional<std::uint64_t>{});
  CHECK_EQ(next->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(next)["setNumber"].asInt(), 2);
}

// A first-ever movement is answered, not refused: 200 naming the movement and nothing else. A 404
// would say the movement does not exist, which is a different and false thing.
TEST(gym_last_for_a_first_ever_movement_is_a_fact_not_a_fault) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.api, &GymApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'100'000), "s-live"),
       "ses_11111111");

  drogon::HttpRequestPtr request = getRequest("/v1/gym/last", "s-live");
  request->setParameter("exercise", "back-squat");
  drogon::HttpResponsePtr response = send(h.api, &GymApi::lastTime, request);

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"exerciseId":"back-squat"})"));
}

TEST(gym_last_of_a_movement_no_catalog_holds_is_400_no_such_exercise) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpRequestPtr unknown = getRequest("/v1/gym/last", "s-live");
  unknown->setParameter("exercise", "zercher-squat");
  drogon::HttpRequestPtr unnamed = getRequest("/v1/gym/last", "s-live");

  drogon::HttpResponsePtr unknownReply = send(h.api, &GymApi::lastTime, unknown);
  drogon::HttpResponsePtr unnamedReply = send(h.api, &GymApi::lastTime, unnamed);

  CHECK_EQ(unknownReply->getStatusCode(), drogon::k400BadRequest);
  // The same fact the write path names, under the same machine word: the movement has to be
  // resolved against GET /v1/gym/exercises first.
  CHECK_EQ(dump(bodyOf(unknownReply)),
           std::string(R"({"code":"unknown-exercise","error":"no such exercise"})"));
  CHECK_EQ(unnamedReply->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(unnamedReply)), std::string(R"({"error":"bad exercise"})"));
}

TEST(gym_last_without_a_session_is_401) {
  Harness h;

  drogon::HttpRequestPtr request = getRequest("/v1/gym/last");
  request->setParameter("exercise", "bench-press");
  drogon::HttpResponsePtr response = send(h.api, &GymApi::lastTime, request);

  CHECK_EQ(response->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"sign in to open your training log"})"));
}

// ---- routines: the whole document, over four routes ----------------------------------------

TEST(gym_routines_round_trip_the_whole_document) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr created = send(h.api, &GymApi::createRoutine,
                                         postRequest("/v1/gym/routines", routineBody(), "s-live"));
  drogon::HttpResponsePtr listed =
      send(h.api, &GymApi::listRoutines, getRequest("/v1/gym/routines", "s-live"));
  drogon::HttpResponsePtr one = send(h.api, &GymApi::getRoutine,
                                     getRequest("/v1/gym/routines/rt_11111111", "s-live"),
                                     "rt_11111111");

  CHECK_EQ(created->getStatusCode(), drogon::k200OK);
  // Entries come back NUMBERED — the client sends order and reads back position — and the two
  // optionals ride only when they were sent. lastTrainedAt is absent: it has never been trained.
  CHECK_EQ(dump(bodyOf(created)),
           std::string(R"({"entries":[{"exerciseId":"bench-press","position":1,"restSeconds":180,)"
                       R"("targetReps":5,"targetSets":5,"targetWeightKg":82.5}],)"
                       R"("id":"rt_11111111","name":"Push A","position":0})"));
  CHECK_EQ(dump(bodyOf(listed)), R"({"routines":[)" + dump(bodyOf(created)) + R"(]})");
  CHECK_EQ(dump(bodyOf(one)), dump(bodyOf(created)));
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
      send(h.api, &GymApi::createRoutine, postRequest("/v1/gym/routines", body, "s-live"));

  CHECK_EQ(created->getStatusCode(), drogon::k200OK);
  // No targetWeightKg means "whatever you did last time" and no restSeconds means the client's own
  // default: a zero in either would read as a real target the lifter never set.
  CHECK_EQ(dump(bodyOf(created)),
           std::string(R"({"entries":[{"exerciseId":"bench-press","position":1,"restSeconds":180,)"
                       R"("targetReps":5,"targetSets":5,"targetWeightKg":82.5},)"
                       R"({"exerciseId":"back-squat","position":2,"targetReps":8,"targetSets":3}],)"
                       R"("id":"rt_11111111","name":"Push A","position":0})"));
}

// `Chin-up 3 × max` on the wire. targetReps is the third omission that MEANS something, and it is
// omitted on the way out exactly as it was on the way in — never null, and never a zero a client
// would draw as a target. The frozen plan carries the same absence onto the session.
TEST(gym_a_routine_line_with_no_rep_target_omits_it_in_and_out) {
  Harness h;
  h.signIn("s-live");
  h.repo.seed(Exercise{ExerciseId{"chin-up"}, "Chin-up", Pattern::pull, Equipment::bodyweight, 2.5,
                       false});
  Json::Value body = routineBody();
  Json::Value chinUp(Json::objectValue);
  chinUp["exerciseId"] = "chin-up";
  chinUp["targetSets"] = 3;
  body["entries"] = Json::Value(Json::arrayValue);
  body["entries"].append(chinUp);

  drogon::HttpResponsePtr created =
      send(h.api, &GymApi::createRoutine, postRequest("/v1/gym/routines", body, "s-live"));
  Json::Value start = startBody();
  start["routineId"] = "rt_11111111";
  drogon::HttpResponsePtr started =
      send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", start, "s-live"));

  CHECK_EQ(created->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(created)),
           std::string(R"({"entries":[{"exerciseId":"chin-up","position":1,"targetSets":3}],)"
                       R"("id":"rt_11111111","name":"Push A","position":0})"));
  CHECK_EQ(started->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(started)),
           std::string(R"({"id":"ses_11111111","plan":{"entries":[{"exerciseId":"chin-up",)"
                       R"("sets":3}],"routine":"Push A"},"routineId":"rt_11111111",)"
                       R"("startedAt":1700000000000})"));
  // An explicit null reads as the same absence every other optional on this wire reads it as, and
  // the reply still omits the field rather than echoing the null back.
  Json::Value nulled = body;
  nulled["id"] = "rt_22222222";
  nulled["entries"][0]["targetReps"] = Json::nullValue;
  drogon::HttpResponsePtr sentNull =
      send(h.api, &GymApi::createRoutine, postRequest("/v1/gym/routines", nulled, "s-live"));
  CHECK_EQ(sentNull->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(sentNull)["entries"]), dump(bodyOf(created)["entries"]));
}

TEST(gym_create_routine_with_an_id_another_account_holds_is_409) {
  Harness h;
  h.signIn("s-live");
  h.repo.routineRows.push_back(
      Routine{rtId("rt_11111111"), uid("another-account"), "Their plan", 0, {benchEntry()}});

  drogon::HttpResponsePtr response = send(h.api, &GymApi::createRoutine,
                                          postRequest("/v1/gym/routines", routineBody(), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"routine-id-taken","error":"that routine id is taken"})"));
  REQUIRE_EQ(h.repo.routineRows.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.routineRows[0].name, std::string("Their plan"));
}

TEST(gym_create_routine_naming_a_movement_no_catalog_holds_is_400_no_such_exercise) {
  Harness h;
  h.signIn("s-live");
  Json::Value body = routineBody();
  body["entries"].append(entryBody("zercher-squat"));

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::createRoutine, postRequest("/v1/gym/routines", body, "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  // The same fact the set write names, under the same machine word — the entry has to be resolved
  // against GET /v1/gym/exercises before a plan can hold it.
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"unknown-exercise","error":"no such exercise"})"));
  CHECK(h.repo.routineRows.empty());
}

// One sentence for every way a routine is unstorable as written, and nothing lands for any of them.
TEST(gym_a_routine_that_could_not_be_stored_as_written_is_400) {
  Harness h;
  h.signIn("s-live");
  Json::Value empty = routineBody();
  empty["entries"] = Json::Value(Json::arrayValue);
  Json::Value nameless = routineBody();
  nameless["name"] = "";
  Json::Value tooLong = routineBody();
  tooLong["name"] = std::string(81, 'x');
  Json::Value badId = routineBody("short");
  Json::Value badEntry = routineBody();
  badEntry["entries"][0]["targetSets"] = 21;
  Json::Value badType = routineBody();
  badType["entries"][0]["targetReps"] = "five";

  for (const Json::Value& body : {empty, nameless, tooLong, badId, badEntry, badType}) {
    drogon::HttpResponsePtr response =
        send(h.api, &GymApi::createRoutine, postRequest("/v1/gym/routines", body, "s-live"));
    CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that routine"})"));
  }
  CHECK(h.repo.routineRows.empty());
}

// A key the entry schema never declared is REFUSED, never dropped — the rule the tool surface
// publishes as `additionalProperties: false` and the composite tool host enforces on a call's
// arguments, reaching one level down into the line. `targetRepsl: 5` used to read clean: the entry
// stored no rep target at all, the reply said the routine had saved, and the target the lifter
// typed was gone from a plan they will train off for months.
TEST(gym_a_routine_entry_key_the_schema_never_declared_is_400_and_nothing_lands) {
  Harness h;
  h.signIn("s-live");
  Json::Value misspelled = routineBody();
  misspelled["entries"][0].removeMember("targetReps");
  misspelled["entries"][0]["targetRepsl"] = 5;

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::createRoutine, postRequest("/v1/gym/routines", misspelled, "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that routine"})"));
  CHECK(h.repo.routineRows.empty());
}

TEST(gym_replace_routine_rewrites_it_and_a_missing_one_is_404) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::createRoutine, postRequest("/v1/gym/routines", routineBody(), "s-live"));
  Json::Value rewritten = routineBody("rt_11111111", "Push A2");
  rewritten["entries"][0] = entryBody("back-squat", 4, 6);

  drogon::HttpResponsePtr replaced =
      send(h.api, &GymApi::replaceRoutine,
           putRequest("/v1/gym/routines/rt_11111111", rewritten, "s-live"), "rt_11111111");
  drogon::HttpResponsePtr missing =
      send(h.api, &GymApi::replaceRoutine,
           putRequest("/v1/gym/routines/rt_99999999", rewritten, "s-live"), "rt_99999999");

  CHECK_EQ(replaced->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(replaced)),
           std::string(R"({"entries":[{"exerciseId":"back-squat","position":1,"restSeconds":180,)"
                       R"("targetReps":6,"targetSets":4,"targetWeightKg":82.5}],)"
                       R"("id":"rt_11111111","name":"Push A2","position":0})"));
  CHECK_EQ(missing->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(missing)), std::string(R"({"error":"no such routine"})"));
  CHECK_EQ(h.repo.routineRows.size(), static_cast<std::size_t>(1));
}

// Absent and another account's are ONE fact on every routine route, so a caller can never learn
// that an id exists by the shape of its refusal.
TEST(gym_another_accounts_routine_is_404_on_every_route) {
  Harness h;
  h.signIn("s-live");
  h.repo.routineRows.push_back(
      Routine{rtId("rt_11111111"), uid("another-account"), "Their plan", 0, {benchEntry()}});

  drogon::HttpResponsePtr read = send(h.api, &GymApi::getRoutine,
                                      getRequest("/v1/gym/routines/rt_11111111", "s-live"),
                                      "rt_11111111");
  drogon::HttpResponsePtr removed = send(h.api, &GymApi::deleteRoutine,
                                         deleteRequest("/v1/gym/routines/rt_11111111", "s-live"),
                                         "rt_11111111");
  drogon::HttpResponsePtr listed =
      send(h.api, &GymApi::listRoutines, getRequest("/v1/gym/routines", "s-live"));

  CHECK_EQ(read->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(read)), std::string(R"({"error":"no such routine"})"));
  CHECK_EQ(removed->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(listed)), std::string(R"({"routines":[]})"));
  CHECK_EQ(h.repo.routineRows.size(), static_cast<std::size_t>(1));
}

TEST(gym_delete_routine_is_204_with_no_body_and_then_404) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::createRoutine, postRequest("/v1/gym/routines", routineBody(), "s-live"));

  drogon::HttpResponsePtr removed = send(h.api, &GymApi::deleteRoutine,
                                         deleteRequest("/v1/gym/routines/rt_11111111", "s-live"),
                                         "rt_11111111");
  drogon::HttpResponsePtr again = send(h.api, &GymApi::deleteRoutine,
                                       deleteRequest("/v1/gym/routines/rt_11111111", "s-live"),
                                       "rt_11111111");

  CHECK_EQ(removed->getStatusCode(), drogon::k204NoContent);
  CHECK(removed->getBody().empty());
  CHECK_EQ(again->getStatusCode(), drogon::k404NotFound);
  CHECK(h.repo.routineRows.empty());
}

// ---- start from a routine: the plan is frozen by the server ---------------------------------

TEST(gym_start_from_a_routine_carries_the_frozen_plan_on_every_read) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::createRoutine, postRequest("/v1/gym/routines", routineBody(), "s-live"));
  Json::Value start = startBody();
  start["routineId"] = "rt_11111111";

  drogon::HttpResponsePtr started =
      send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", start, "s-live"));
  drogon::HttpResponsePtr detail = send(h.api, &GymApi::getSession,
                                        getRequest("/v1/gym/sessions/ses_11111111", "s-live"),
                                        "ses_11111111");

  CHECK_EQ(started->getStatusCode(), drogon::k200OK);
  // The snapshot is the SERVER's copy of the routine, not a body the client composed: it names the
  // routine as a plain string and carries the plan's numbers, nothing pointing back at the row.
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
  h.repo.routineRows.push_back(
      Routine{rtId("rt_11111111"), uid("another-account"), "Their plan", 0, {benchEntry()}});
  Json::Value start = startBody();
  start["routineId"] = "rt_11111111";
  Json::Value unknown = startBody("ses_22222222");
  unknown["routineId"] = "rt_99999999";

  drogon::HttpResponsePtr theirs =
      send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", start, "s-live"));
  drogon::HttpResponsePtr missing =
      send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", unknown, "s-live"));

  CHECK_EQ(theirs->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(theirs)), std::string(R"({"error":"no such routine"})"));
  CHECK_EQ(missing->getStatusCode(), drogon::k404NotFound);
  // Nothing landed either time, so the same body works the moment the routine does exist.
  CHECK(h.repo.sessions.empty());
}

TEST(gym_start_with_a_non_string_routine_id_is_400) {
  Harness h;
  h.signIn("s-live");
  Json::Value body = startBody();
  body["routineId"] = 7;

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", body, "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that session"})"));
  CHECK(h.repo.sessions.empty());
}

// ---- the catalog's one write -----------------------------------------------------------------

TEST(gym_create_exercise_takes_the_equipments_step_and_joins_the_callers_catalog) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr created = send(h.api, &GymApi::createExercise,
                                         postRequest("/v1/gym/exercises", exerciseBody(), "s-live"));
  drogon::HttpResponsePtr catalog =
      send(h.api, &GymApi::listExercises, getRequest("/v1/gym/exercises", "s-live"));

  CHECK_EQ(created->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(created)),
           std::string(R"({"custom":true,"equipment":"barbell","id":"ex_11111111",)"
                       R"("name":"Zercher Squat","pattern":"squat","stepKg":2.5})"));
  CHECK_EQ(bodyOf(catalog)["exercises"].size(), 3u);
  CHECK_EQ(dump(bodyOf(catalog)["exercises"][2]), dump(bodyOf(created)));
}

TEST(gym_create_exercise_with_a_spent_id_is_409_and_a_malformed_one_is_400) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr seedSlug =
      send(h.api, &GymApi::createExercise,
           postRequest("/v1/gym/exercises", exerciseBody("bench-press", "My Bench"), "s-live"));
  drogon::HttpResponsePtr shortId =
      send(h.api, &GymApi::createExercise,
           postRequest("/v1/gym/exercises", exerciseBody("ex_1"), "s-live"));
  Json::Value unknownPattern = exerciseBody("ex_22222222");
  unknownPattern["pattern"] = "legs";
  drogon::HttpResponsePtr badPattern = send(
      h.api, &GymApi::createExercise, postRequest("/v1/gym/exercises", unknownPattern, "s-live"));

  CHECK_EQ(seedSlug->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(seedSlug)),
           std::string(R"({"code":"exercise-id-taken","error":"that movement id is taken"})"));
  // A created movement's id is client-minted, so it obeys the one id-shape rule the seeds predate.
  CHECK_EQ(shortId->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(shortId)), std::string(R"({"error":"could not read that movement"})"));
  CHECK_EQ(badPattern->getStatusCode(), drogon::k400BadRequest);
  CHECK(h.repo.customs.empty());
}

// A step the step_kg column cannot hold is the CLIENT's mistake and terminal — a 400 — not the 500
// a numeric overflow out of the repository used to answer with, which the ladder calls retryable
// and an offline queue would resend forever. Both ends of numeric(4,2) are refused, and so is a
// name with no ceiling on a row every catalog read then ships.
TEST(gym_create_exercise_refuses_a_step_or_a_name_the_store_could_not_hold) {
  Harness h;
  h.signIn("s-live");
  Json::Value overflows = exerciseBody("ex_22222222");
  overflows["stepKg"] = 1000;
  Json::Value justOver = exerciseBody("ex_33333333");
  justOver["stepKg"] = 100;
  Json::Value roundsToZero = exerciseBody("ex_44444444");
  roundsToZero["stepKg"] = 0.004;
  Json::Value hugeName = exerciseBody("ex_55555555", std::string(2'000'000, 'x'));
  Json::Value theCeiling = exerciseBody("ex_66666666");
  theCeiling["stepKg"] = 99.99;

  for (const Json::Value& body : {overflows, justOver, roundsToZero, hugeName}) {
    drogon::HttpResponsePtr response =
        send(h.api, &GymApi::createExercise, postRequest("/v1/gym/exercises", body, "s-live"));
    CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that movement"})"));
  }
  CHECK(h.repo.customs.empty());

  drogon::HttpResponsePtr stored =
      send(h.api, &GymApi::createExercise, postRequest("/v1/gym/exercises", theCeiling, "s-live"));
  CHECK_EQ(stored->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(stored)["stepKg"].asDouble(), 99.99);
}

// ---- the finish surface: the review read and the discard --------------------------------------

namespace {
// A finished session of the Legs day, its sets, and the routine behind it — pushed straight in,
// because what these cases are about is the bytes the review answers with and not the doors that
// wrote the rows.
void trained(Harness& h, const wm::UserId& caller, const std::string& session,
             std::uint64_t startedAtMs, double weightKg, int reps) {
  const PlanSnapshot plan{"Legs", {PlanEntry{ExerciseId{"back-squat"}, 5, 5, 100.0, 180}}};
  h.repo.sessions.push_back(Session{sid(session), caller, startedAtMs, startedAtMs + 3'720'000,
                                    rtId("rt_11111111"), plan});
  for (int number = 1; number <= 4; ++number)
    h.repo.sets.push_back(Set{setId("set_" + session.substr(4) + std::to_string(number)),
                              sid(session), ExerciseId{"back-squat"}, number, weightKg, reps,
                              SetKind::working, std::nullopt, "",
                              startedAtMs + static_cast<std::uint64_t>(number) * 60'000});
}
}

TEST(gym_review_carries_the_three_facts_the_record_and_the_band) {
  Harness h;
  UserId caller = h.signIn("s-live");
  h.repo.routineRows.push_back(Routine{
      rtId("rt_11111111"), caller, "Legs", 0,
      {RoutineEntry{1, ExerciseId{"back-squat"}, 5, 5, 100.0, 180}}});
  trained(h, caller, "ses_22222222", 1'699'000'000'000, 90, 10);   // e1RM 120 — the mark
  trained(h, caller, "ses_11111111", 1'700'000'000'000, 105, 5);   // e1RM 122.5 — the record

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::reviewSession,
           getRequest("/v1/gym/sessions/ses_11111111/review", "s-live"), "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"against":{"movements":[{"before":{"reps":10,"sets":4,"weightKg":90.0},)"
                       R"("exerciseId":"back-squat","now":{"reps":5,"sets":4,"weightKg":105.0},)"
                       R"("planned":{"reps":5,"sets":5,"weightKg":100.0}}],"routine":"Legs",)"
                       R"("sessionId":"ses_22222222","startedAt":1699000000000},)"
                       R"("record":{"exerciseId":"back-squat","kind":"e1rm","previous":120.0,)"
                       R"("previousAt":1699000060000,"reps":5,"value":122.5,"weightKg":105.0},)"
                       R"("slight":false,)"
                       R"("stats":{"durationMs":3720000,"topE1rm":122.5,"workingSets":4}})"));
}

TEST(gym_review_of_an_ordinary_session_omits_every_line_it_did_not_earn) {
  Harness h;
  UserId caller = h.signIn("s-live");
  trained(h, caller, "ses_11111111", 1'700'000'000'000, 105, 5);
  h.repo.sessions.back().routine = std::nullopt;   // ad-hoc: nothing to stand against
  h.repo.sessions.back().plan = std::nullopt;

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::reviewSession,
           getRequest("/v1/gym/sessions/ses_11111111/review", "s-live"), "ses_11111111");

  // No record on a first session, no band without a day of the program — both absent, never null.
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"slight":false,)"
                       R"("stats":{"durationMs":3720000,"topE1rm":122.5,"workingSets":4}})"));
}

TEST(gym_review_of_a_missing_or_anothers_session_is_404) {
  Harness h;
  h.signIn("s-live");
  h.repo.sessions.push_back(Session{sid("ses_22222222"), uid("another-account"),
                                    1'700'000'000'000, 1'700'000'003'600});

  drogon::HttpResponsePtr missing =
      send(h.api, &GymApi::reviewSession,
           getRequest("/v1/gym/sessions/ses_99999999/review", "s-live"), "ses_99999999");
  drogon::HttpResponsePtr theirs =
      send(h.api, &GymApi::reviewSession,
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
      send(h.api, &GymApi::discardSession, deleteRequest("/v1/gym/sessions/ses_11111111", "s-live"),
           "ses_11111111");
  drogon::HttpResponsePtr again =
      send(h.api, &GymApi::discardSession, deleteRequest("/v1/gym/sessions/ses_11111111", "s-live"),
           "ses_11111111");

  CHECK_EQ(discarded->getStatusCode(), drogon::k204NoContent);
  CHECK(discarded->getBody().empty());
  CHECK_EQ(again->getStatusCode(), drogon::k404NotFound);
  CHECK(h.repo.sessions.empty());
  CHECK(h.repo.sets.empty());
}

TEST(gym_discard_of_a_running_session_is_409_and_leaves_every_set_where_it_is) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet, postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(),
                                              "s-live"),
       "ses_11111111");

  drogon::HttpResponsePtr refused =
      send(h.api, &GymApi::discardSession, deleteRequest("/v1/gym/sessions/ses_11111111", "s-live"),
           "ses_11111111");

  CHECK_EQ(refused->getStatusCode(), drogon::k409Conflict);
  // Its own code: no id to re-mint and no body to fix — finish the workout and send it again.
  CHECK_EQ(dump(bodyOf(refused)),
           std::string(R"({"code":"session-open","error":"that session is still running"})"));
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
}

TEST(gym_unknown_session_detail_is_404) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response = send(h.api, &GymApi::getSession,
                                          getRequest("/v1/gym/sessions/ses_99999999", "s-live"),
                                          "ses_99999999");

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"no such session"})"));
}

// ---- the statistics surface ----------------------------------------------------------------

// One point per finished session per movement, Epley over it, the standing bests beside it, and the
// weekly counts — and nothing else. There is no total, no volume, no streak and no percentage in
// this body, which is the surface's whole design and not an omission to fill in later.
TEST(gym_stats_answers_a_line_per_movement_and_the_weeks_around_it) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 4);

  drogon::HttpResponsePtr response = send(h.api, &GymApi::stats, getRequest("/v1/gym/stats", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"movements":[{"bestE1rm":{"at":1700000060000,"e1rm":104.5,)"
                       R"("reps":8,"weightKg":82.5},)"
                       R"("exerciseId":"bench-press",)"
                       R"("heaviest":{"at":1700000060000,"e1rm":104.5,"reps":8,"weightKg":82.5},)"
                       R"("lastTrainedAt":1700000000000,)"
                       R"("points":[{"at":1700000000000,"e1rm":104.5,"reps":8,"weightKg":82.5}]}],)"
                       R"("weeks":[{"sessions":1,"startedAt":1699833600000,"workingSets":4}]})"));
}

// An account with nothing finished yet answers with the two empty lists rather than with a 404 or a
// zeroed-out skeleton: there is no chart to draw, and saying so is not an error.
TEST(gym_stats_of_an_untrained_account_is_two_empty_lists) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response = send(h.api, &GymApi::stats, getRequest("/v1/gym/stats", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"movements":[],"weeks":[]})"));
}

// ---- the export ------------------------------------------------------------------------------

// The bytes, in full: a header row, CRLF between records, and RFC 4180 quoting where a note holds a
// comma or a quote of its own. Nothing in a note is edited on the way through — it is the lifter's
// own words, and an export that rewrote what it exports would not be one.
TEST(gym_export_is_a_csv_attachment_and_quotes_only_what_needs_it) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession,
       postRequest("/v1/gym/sessions", startBody("ses_11111111", 1'700'000'000'000), "s-live"));
  Json::Value set = setBody("set_11111111", "bench-press", 82.5, 1'700'000'060'000);
  set["note"] = R"(felt heavy, said "again")";
  set["rpe"] = 8.5;
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", set, "s-live"), "ses_11111111");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::exportSets, getRequest("/v1/gym/export", "s-live"));

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

// An account with nothing logged still gets a file, and the file still names its columns: an empty
// export is an answer, and a client that downloaded zero bytes could not tell it from a failure.
TEST(gym_export_of_an_empty_log_is_still_a_header_row) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::exportSets, getRequest("/v1/gym/export", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(std::string(response->getBody()),
           std::string("session_id,started_at,finished_at,routine,set_id,exercise_id,exercise,"
                       "set_number,weight_kg,reps,kind,rpe,note,completed_at\r\n"));
}

// ---- the coach share ---------------------------------------------------------------------------

TEST(gym_share_answers_a_token_and_an_end_and_a_second_tap_answers_the_same_one) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 4);

  drogon::HttpResponsePtr first =
      send(h.api, &GymApi::shareSession,
           postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue),
                       "s-live"),
           "ses_11111111");
  drogon::HttpResponsePtr again =
      send(h.api, &GymApi::shareSession,
           postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue),
                       "s-live"),
           "ses_11111111");

  CHECK_EQ(first->getStatusCode(), drogon::k200OK);
  CHECK_EQ(again->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(first)), dump(bodyOf(again)));
  CHECK(!bodyOf(first)["token"].asString().empty());
  CHECK_EQ(bodyOf(first)["expiresAt"].asUInt64(), h.clock.now + kShareLifetimeMs);
  CHECK_EQ(h.repo.shares.size(), static_cast<std::size_t>(1));
}

// The reply carries the LINK, not just the secret, and the link is the browser app's route. It shipped
// as three strings composed by three surfaces and two of them pasted the JSON route onto a base url,
// so a lifter sharing from the phone or through an agent handed their coach a page of JSON. The
// server composes it once now and every surface renders what it was given.
TEST(gym_share_answers_the_page_a_coach_opens_and_never_the_json_route) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 4);

  drogon::HttpResponsePtr minted =
      send(h.api, &GymApi::shareSession,
           postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue),
                       "s-live"),
           "ses_11111111");

  const std::string url = bodyOf(minted)["url"].asString();
  CHECK_EQ(url, "https://windmill.works/#/gym/shared/" + bodyOf(minted)["token"].asString());
  CHECK(url.find("/v1/") == std::string::npos);
}

// Sharing is a write to the share table and nowhere else: not one of the sixteen owner-scoped
// routes changed, and the session row a share points at is byte-identical to what it was before.
TEST(gym_share_adds_a_row_beside_the_session_and_never_touches_it) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 4);
  const Session before = h.repo.sessions[0];

  send(h.api, &GymApi::shareSession,
       postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue), "s-live"),
       "ses_11111111");

  CHECK_EQ(h.repo.sessions[0], before);
  CHECK_EQ(h.repo.shares.size(), static_cast<std::size_t>(1));
}

TEST(gym_share_of_a_missing_or_anothers_session_is_404) {
  Harness h;
  const UserId other = h.signIn("s-other");
  h.repo.sessions.push_back(Session{SessionId{"ses_22222222"}, other, 1'700'000'000'000,
                                    1'700'003'600'000});
  h.authRepo.insertSession(h.tokens.digestOf("s-live"),
                           h.authRepo.createUser(Email{"lifter@example.com"}, "lifter").id,
                           h.clock.now + 1'000'000, "", "", h.clock.now);

  drogon::HttpResponsePtr absent =
      send(h.api, &GymApi::shareSession,
           postRequest("/v1/gym/sessions/ses_99999999/share", Json::Value(Json::objectValue),
                       "s-live"),
           "ses_99999999");
  drogon::HttpResponsePtr theirs =
      send(h.api, &GymApi::shareSession,
           postRequest("/v1/gym/sessions/ses_22222222/share", Json::Value(Json::objectValue),
                       "s-live"),
           "ses_22222222");

  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(theirs->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(absent)), dump(bodyOf(theirs)));   // absent and forbidden are one fact
  CHECK(h.repo.shares.empty());
}

// The one route in gym that resolves no caller: no cookie, no bearer, no account — the token in the
// path is the whole credential. The body names no account and holds no id at any depth, so nothing
// in it can be walked to a second session.
TEST(gym_shared_session_needs_no_caller_and_carries_no_id) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 2);
  drogon::HttpResponsePtr minted =
      send(h.api, &GymApi::shareSession,
           postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue),
                       "s-live"),
           "ses_11111111");
  const std::string token = bodyOf(minted)["token"].asString();

  drogon::HttpResponsePtr read =
      send(h.api, &GymApi::sharedSession, getRequest("/v1/gym/shared/" + token), token);

  CHECK_EQ(read->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(read)),
           std::string(R"({"finishedAt":1700003600000,"sets":[)"
                       R"({"completedAt":1700000060000,"exercise":"Bench Press","kind":"working",)"
                       R"("note":"","reps":8,"setNumber":1,"weightKg":82.5},)"
                       R"({"completedAt":1700000120000,"exercise":"Bench Press","kind":"working",)"
                       R"("note":"","reps":8,"setNumber":2,"weightKg":82.5}],)"
                       R"("startedAt":1700000000000})"));
}

// Revoked, expired and never-minted answer ONE 404, byte for byte, which is what stops a token from
// being probed for existence — and it is the same body an absent session gives every other read.
TEST(gym_shared_token_that_is_revoked_expired_or_unknown_is_one_404) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 2);
  drogon::HttpResponsePtr minted =
      send(h.api, &GymApi::shareSession,
           postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue),
                       "s-live"),
           "ses_11111111");
  const std::string token = bodyOf(minted)["token"].asString();

  drogon::HttpResponsePtr unknown = send(h.api, &GymApi::sharedSession,
                                         getRequest("/v1/gym/shared/nobody-minted-this"),
                                         "nobody-minted-this");
  h.clock.now += kShareLifetimeMs + 1;
  drogon::HttpResponsePtr expired =
      send(h.api, &GymApi::sharedSession, getRequest("/v1/gym/shared/" + token), token);
  send(h.api, &GymApi::revokeShare, deleteRequest("/v1/gym/sessions/ses_11111111/share", "s-live"),
       "ses_11111111");
  drogon::HttpResponsePtr revoked =
      send(h.api, &GymApi::sharedSession, getRequest("/v1/gym/shared/" + token), token);

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
  send(h.api, &GymApi::shareSession,
       postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue), "s-live"),
       "ses_11111111");

  drogon::HttpResponsePtr first =
      send(h.api, &GymApi::revokeShare,
           deleteRequest("/v1/gym/sessions/ses_11111111/share", "s-live"), "ses_11111111");
  drogon::HttpResponsePtr again =
      send(h.api, &GymApi::revokeShare,
           deleteRequest("/v1/gym/sessions/ses_11111111/share", "s-live"), "ses_11111111");

  CHECK_EQ(first->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(again->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(again)), std::string(R"({"error":"no such session"})"));
  CHECK(h.repo.shares.empty());
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));   // the workout itself is untouched
}
