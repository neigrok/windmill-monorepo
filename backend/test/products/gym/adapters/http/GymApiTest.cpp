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

drogon::HttpRequestPtr patchRequest(const std::string& path, const Json::Value& body,
                                    const std::string& session = "") {
  drogon::HttpRequestPtr request = postRequest(path, body, session);
  request->setMethod(drogon::Patch);
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

Json::Value renameBody(const std::string& name = "Low-bar Squat") {
  Json::Value body(Json::objectValue);
  body["name"] = name;
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

// The freshness tag, read off a reply and fed back into the next request. The cases below compare
// tags to each OTHER rather than to a literal: since W3 the last term is a fold over the sets as
// they render, so a test that spelled the whole tag out would either be copying the implementation's
// own output back at it or pinning a digest nobody can read. What an ETag actually promises is
// exactly what is asserted here — the same bytes while nothing moved, different bytes the moment
// anything a poll acts on does, and a 304 for whoever echoes one back. The legible half still gets
// pinned: the tag opens with the session's two instants.
std::string tagOf(const drogon::HttpResponsePtr& response) { return response->getHeader("ETag"); }

drogon::HttpResponsePtr readSession(GymApi& api, const std::string& session,
                                    const std::string& cookie,
                                    const std::string& ifNoneMatch = "") {
  drogon::HttpRequestPtr request = getRequest("/v1/gym/sessions/" + session, cookie);
  if (!ifNoneMatch.empty()) request->addHeader("If-None-Match", ifNoneMatch);
  return send(api, &GymApi::getSession, request, session);
}

// The fix and the delete, as a client sends them: the workout is half the address.
drogon::HttpRequestPtr patchSetRequest(const std::string& session, const std::string& set,
                                       const Json::Value& body, const std::string& cookie = "") {
  drogon::HttpRequestPtr request =
      postRequest("/v1/gym/sessions/" + session + "/sets/" + set, body, cookie);
  request->setMethod(drogon::Patch);
  return request;
}

drogon::HttpResponsePtr sendSetWrite(GymApi& api,
                                     void (GymApi::*handler)(const drogon::HttpRequestPtr&,
                                                             HttpCallback&&, const std::string&,
                                                             const std::string&),
                                     const drogon::HttpRequestPtr& request,
                                     const std::string& session, const std::string& set) {
  drogon::HttpResponsePtr captured;
  (api.*handler)(request, [&](const drogon::HttpResponsePtr& response) { captured = response; },
                 session, set);
  return captured;
}

Json::Value fixBody(double weightKg, int reps) {
  Json::Value body(Json::objectValue);
  body["weightKg"] = weightKg;
  body["reps"] = reps;
  return body;
}

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
  drogon::HttpResponsePtr lastSets =
      send(h.api, &GymApi::lastSets, getRequest("/v1/gym/exercises/last"));
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
  drogon::HttpResponsePtr rename =
      send(h.api, &GymApi::renameExercise,
           patchRequest("/v1/gym/exercises/back-squat", renameBody()), "back-squat");
  drogon::HttpResponsePtr record =
      send(h.api, &GymApi::exerciseRecord, getRequest("/v1/gym/exercises/back-squat/record"),
           "back-squat");
  drogon::HttpResponsePtr fix =
      sendSetWrite(h.api, &GymApi::fixSet,
                   patchSetRequest("ses_11111111", "set_11111111", fixBody(80.0, 5)),
                   "ses_11111111", "set_11111111");
  drogon::HttpResponsePtr removeSet =
      sendSetWrite(h.api, &GymApi::deleteSet,
                   deleteRequest("/v1/gym/sessions/ses_11111111/sets/set_11111111"),
                   "ses_11111111", "set_11111111");

  CHECK_EQ(exercises->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(exercises)), std::string(R"({"error":"sign in to open your training log"})"));
  // The picker's meta is a read of somebody's LOG under a catalog-shaped path, so it sits on this
  // side of the gate with every other read of one.
  CHECK_EQ(lastSets->getStatusCode(), drogon::k401Unauthorized);
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
  CHECK_EQ(rename->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(record->getStatusCode(), drogon::k401Unauthorized);
  // The correction's two doors, and the delete answers the gate rather than its own bare 204 —
  // an unsigned caller must never learn that a set id was accepted, let alone touch one.
  CHECK_EQ(fix->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(removeSet->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(removeSet)), std::string(R"({"error":"sign in to open your training log"})"));
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

// The picker's meta line, for the whole catalog in one read. Four rules are on the wire at once, and
// each of them is the picker drawing something true: the line is the LAST set of the block and not
// its heaviest (bench reads the 80 back-off, not the 82.5 that opened it); `at` is the SESSION's
// start, so "3 days ago" is the day it was trained; a movement only ever warmed up has no line, the
// same silence as one never touched, which is what `never logged` draws; and today's live session is
// not a last time. The rows come back keyed by movement id — the key the picker joins them onto its
// catalog by — which is deliberately NOT the order the list is drawn in: the catalog is sorted by
// pattern then name, and press sorts before squat there while back-squat sorts first here.
TEST(gym_exercises_last_is_the_final_set_of_each_movement_and_nothing_for_the_rest) {
  Harness h;
  h.signIn("s-live");

  send(h.api, &GymApi::startSession,
       postRequest("/v1/gym/sessions", startBody("ses_11111111", 1'700'000'000'000), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets",
                   setBody("set_11111111", "bench-press", 82.5, 1'700'000'060'000), "s-live"),
       "ses_11111111");
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets",
                   setBody("set_11111112", "bench-press", 80.0, 1'700'000'120'000), "s-live"),
       "ses_11111111");
  Json::Value warmup = setBody("set_11111113", "back-squat", 60.0, 1'700'000'180'000);
  warmup["kind"] = "warmup";
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", warmup, "s-live"), "ses_11111111");
  send(h.api, &GymApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'300'000), "s-live"),
       "ses_11111111");

  // A later workout that actually squats, so the two lines are dated by two different sessions.
  send(h.api, &GymApi::startSession,
       postRequest("/v1/gym/sessions", startBody("ses_22222222", (h.clock.now = 1'700'000'400'000)), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_22222222/sets",
                   setBody("set_22222221", "back-squat", 100.0, 1'700'000'460'000), "s-live"),
       "ses_22222222");
  send(h.api, &GymApi::finishSession,
       postRequest("/v1/gym/sessions/ses_22222222/finish", finishBody(1'700'000'700'000), "s-live"),
       "ses_22222222");

  // And today, still running and much heavier: the today list, never a last time.
  send(h.api, &GymApi::startSession,
       postRequest("/v1/gym/sessions", startBody("ses_33333333", (h.clock.now = 1'700'001'000'000)), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_33333333/sets",
                   setBody("set_33333331", "bench-press", 140.0, 1'700'001'060'000), "s-live"),
       "ses_33333333");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::lastSets, getRequest("/v1/gym/exercises/last", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"movements":[)"
                       R"({"at":1700000400000,"exerciseId":"back-squat","reps":8,"weightKg":100.0},)"
                       R"({"at":1700000000000,"exerciseId":"bench-press","reps":8,)"
                       R"("weightKg":80.0}]})"));
}

// A lifter who has logged nothing has no meta at all, and the key is still there holding an empty
// list: the picker draws every catalog row `never logged` from the ABSENCE of a line, so it must be
// able to tell "nothing yet" from a read that failed.
TEST(gym_exercises_last_is_an_empty_list_before_anything_is_logged) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::lastSets, getRequest("/v1/gym/exercises/last", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"movements":[]})"));
}

// One account's picker never draws another's numbers. The meta is a read of the LOG, so it obeys the
// rule every read of one obeys: absent is byte-identical to forbidden.
TEST(gym_exercises_last_never_carries_another_accounts_line) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 1);

  User other = h.authRepo.createUser(Email{"coach@example.com"}, "coach");
  h.authRepo.insertSession(h.tokens.digestOf("s-other"), other.id, h.clock.now + 1'000'000, "", "",
                           h.clock.now);

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::lastSets, getRequest("/v1/gym/exercises/last", "s-other"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"movements":[]})"));
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

TEST(gym_start_ahead_of_the_logs_clock_is_400_and_names_the_gap) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::startSession,
           postRequest("/v1/gym/sessions", startBody("ses_11111111", 1'700'000'000'000 + 26 * 60'000),
                       "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"clock-ahead","error":"this device's clock is 26 minutes ahead of )"
                       R"(the log \u2014 a workout cannot start in the future. Check the clock and )"
                       R"(start again."})"));
  CHECK(h.repo.sessions.empty());
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

// ---- fix a set: the log moves, the routine does not ----------------------------------------

TEST(gym_fix_round_trips_the_corrected_set_and_a_replay_reads_it_back) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  drogon::HttpResponsePtr fixed =
      sendSetWrite(h.api, &GymApi::fixSet,
                   patchSetRequest("ses_11111111", "set_11111111", fixBody(47.5, 4), "s-live"),
                   "ses_11111111", "set_11111111");
  drogon::HttpResponsePtr replayed =
      sendSetWrite(h.api, &GymApi::fixSet,
                   patchSetRequest("ses_11111111", "set_11111111", fixBody(47.5, 4), "s-live"),
                   "ses_11111111", "set_11111111");

  CHECK_EQ(fixed->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(fixed)),
           std::string(R"({"completedAt":1700000060000,"exerciseId":"bench-press",)"
                       R"("id":"set_11111111","kind":"working","note":"","reps":4,)"
                       R"("setNumber":1,"weightKg":47.5})"));
  CHECK_EQ(dump(bodyOf(replayed)), dump(bodyOf(fixed)));
  CHECK_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
}

// The kind segmented control and the two fields that carry a lifter's own words. `rpe: null` is the
// one null this write reads as a value: it clears an rpe, which no other field needs a way to do.
TEST(gym_fix_carries_the_kind_the_note_and_an_rpe_that_can_be_cleared) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  Json::Value logged = setBody();
  logged["rpe"] = 8.5;
  logged["note"] = "felt heavy";
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", logged, "s-live"), "ses_11111111");

  Json::Value toWarmup(Json::objectValue);
  toWarmup["kind"] = "warmup";
  toWarmup["note"] = "";
  drogon::HttpResponsePtr retyped =
      sendSetWrite(h.api, &GymApi::fixSet,
                   patchSetRequest("ses_11111111", "set_11111111", toWarmup, "s-live"),
                   "ses_11111111", "set_11111111");
  Json::Value clearRpe(Json::objectValue);
  clearRpe["rpe"] = Json::Value::null;
  drogon::HttpResponsePtr cleared =
      sendSetWrite(h.api, &GymApi::fixSet,
                   patchSetRequest("ses_11111111", "set_11111111", clearRpe, "s-live"),
                   "ses_11111111", "set_11111111");

  CHECK_EQ(bodyOf(retyped)["kind"].asString(), std::string("warmup"));
  CHECK_EQ(bodyOf(retyped)["note"].asString(), std::string(""));
  CHECK_EQ(bodyOf(retyped)["rpe"].asDouble(), 8.5);   // untouched: this fix never named it
  CHECK_FALSE(bodyOf(cleared).isMember("rpe"));
  CHECK_EQ(bodyOf(cleared)["kind"].asString(), std::string("warmup"));
}

// An empty fix is legal and changes nothing, which is what makes the whole write safe to send twice.
TEST(gym_a_fix_that_names_nothing_answers_the_stored_row_untouched) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  drogon::HttpResponsePtr logged =
      send(h.api, &GymApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  drogon::HttpResponsePtr untouched = sendSetWrite(
      h.api, &GymApi::fixSet,
      patchSetRequest("ses_11111111", "set_11111111", Json::Value(Json::objectValue), "s-live"),
      "ses_11111111", "set_11111111");

  CHECK_EQ(untouched->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(untouched)), dump(bodyOf(logged)));
}

// Absent, another account's, and this account's set in a DIFFERENT workout are one 404 byte for
// byte — and it carries the word a flush queue branches on, because its repair is to stop retrying.
TEST(gym_a_fix_of_a_set_this_workout_does_not_hold_is_404_set_not_found) {
  Harness h;
  h.signIn("s-live");
  h.signIn("s-other");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.api, &GymApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'180'000), "s-live"),
       "ses_11111111");
  send(h.api, &GymApi::startSession,
       postRequest("/v1/gym/sessions", startBody("ses_22222222", 1'700'001'000'000), "s-live"));

  drogon::HttpResponsePtr absent =
      sendSetWrite(h.api, &GymApi::fixSet,
                   patchSetRequest("ses_11111111", "set_99999999", fixBody(80.0, 5), "s-live"),
                   "ses_11111111", "set_99999999");
  drogon::HttpResponsePtr elsewhere =
      sendSetWrite(h.api, &GymApi::fixSet,
                   patchSetRequest("ses_22222222", "set_11111111", fixBody(80.0, 5), "s-live"),
                   "ses_22222222", "set_11111111");
  drogon::HttpResponsePtr stranger =
      sendSetWrite(h.api, &GymApi::fixSet,
                   patchSetRequest("ses_11111111", "set_11111111", fixBody(80.0, 5), "s-other"),
                   "ses_11111111", "set_11111111");

  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(absent)),
           std::string(R"({"code":"set-not-found","error":"no such set"})"));
  CHECK_EQ(elsewhere->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(elsewhere)), dump(bodyOf(absent)));
  CHECK_EQ(stranger->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(stranger)), dump(bodyOf(absent)));
  CHECK_EQ(h.repo.sets[0].weightKg, 82.5);
  CHECK(h.repo.kept.empty());
}

// The three fields a correction refuses by name, and the reason it refuses rather than ignores: a
// body naming `exerciseId` answered 200 with the movement unchanged is a write doing less than it
// said, and the client would never learn. A value the store cannot hold wears the same word — both
// are terminal for the queue and neither retry of these bytes lands.
TEST(gym_a_fix_naming_a_field_it_may_not_carry_is_400_fix_unreadable) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
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
        sendSetWrite(h.api, &GymApi::fixSet,
                     patchSetRequest("ses_11111111", "set_11111111", refused, "s-live"),
                     "ses_11111111", "set_11111111");
    CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(bodyOf(response)),
             std::string(R"({"code":"fix-unreadable","error":"could not read that fix"})"));
  }
  CHECK_EQ(h.repo.sets[0], Set(setId("set_11111111"), sid("ses_11111111"),
                               ExerciseId{"bench-press"}, 1, 82.5, 8, SetKind::working,
                               std::nullopt, "", 1'700'000'060'000));
  CHECK(h.repo.kept.empty());
}

// The delete: 204 with nothing to say, and 204 again on the retry a lost reply produces. Deleting
// another account's set is the same 204 and changes nothing — absent stays byte-identical to
// forbidden, which is exactly what an idempotent delete needs it to be.
TEST(gym_deleting_a_set_is_204_and_deleting_it_again_is_204) {
  Harness h;
  h.signIn("s-live");
  h.signIn("s-other");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets",
                   setBody("set_22222222", "bench-press", 85.0, 1'700'000'120'000), "s-live"),
       "ses_11111111");

  drogon::HttpResponsePtr gone = sendSetWrite(
      h.api, &GymApi::deleteSet,
      deleteRequest("/v1/gym/sessions/ses_11111111/sets/set_11111111", "s-live"),
      "ses_11111111", "set_11111111");
  drogon::HttpResponsePtr again = sendSetWrite(
      h.api, &GymApi::deleteSet,
      deleteRequest("/v1/gym/sessions/ses_11111111/sets/set_11111111", "s-live"),
      "ses_11111111", "set_11111111");
  drogon::HttpResponsePtr stranger = sendSetWrite(
      h.api, &GymApi::deleteSet,
      deleteRequest("/v1/gym/sessions/ses_11111111/sets/set_22222222", "s-other"),
      "ses_11111111", "set_22222222");

  CHECK_EQ(gone->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(gone->getBody(), std::string(""));
  CHECK_EQ(again->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(stranger->getStatusCode(), drogon::k204NoContent);
  REQUIRE_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.sets[0].id, setId("set_22222222"));
  // One kept row, not two: the retry destroyed nothing and the stranger reached nothing.
  REQUIRE_EQ(h.repo.kept.size(), static_cast<std::size_t>(1));
  CHECK(h.repo.kept[0].deleted);
  CHECK_EQ(h.repo.kept[0].set.id, setId("set_11111111"));
}

// THE APPEND THAT WOULD UNDO THE DELETE, on the wire where the queue meets it: a POST whose 200 was
// lost goes again, and the id is free the moment its row leaves gym_sets. `set-deleted` and not
// `set-id-taken` is the whole of this case — every surface repairs a spent id by minting a fresh one
// and re-sending, and doing that here would log the deleted set back into the workout under a number
// the lifter never chose. An unrecognised 409 is terminal on all three queues, so the word lands
// correctly on a client built before it existed.
TEST(gym_replaying_the_append_of_a_deleted_set_is_409_set_deleted_and_never_a_re_mint) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  sendSetWrite(h.api, &GymApi::deleteSet,
               deleteRequest("/v1/gym/sessions/ses_11111111/sets/set_11111111", "s-live"),
               "ses_11111111", "set_11111111");

  drogon::HttpResponsePtr replayed =
      send(h.api, &GymApi::appendSet,
           postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  CHECK_EQ(replayed->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(replayed)),
           std::string(R"({"code":"set-deleted","error":"that set was deleted"})"));
  CHECK_EQ(h.repo.sets, std::vector<Set>{});
  REQUIRE_EQ(h.repo.kept.size(), static_cast<std::size_t>(1));
  CHECK(h.repo.kept[0].deleted);
}

// A NOTE THE COLUMN CANNOT HOLD IS THE CLIENT'S FAULT, ANSWERED AS ONE. `text` is UTF-8 end to end,
// and json is not — jsoncpp copies raw bytes through a string without judging them — so a note
// carrying a lone surrogate half reached Postgres, which refused it MID-TRANSACTION, and that vendor
// error left as the house 500. 500 is the one status every queue on every surface is told to retry,
// so those bytes would have been re-sent forever. The domain refuses them at construction now, where
// the answer is the terminal 400 the wire promises for a value the store cannot hold — on the
// correction and on the append alike, because the note is the same field and the rule is stated once.
TEST(gym_a_note_the_store_could_never_hold_is_400_on_both_writes_and_never_a_retryable_500) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  // Written as bytes rather than through the json writer, which would sanitise them on the way out.
  const std::string surrogate = "{\"id\":\"set_22222222\",\"exerciseId\":\"bench-press\","
                                "\"weightKg\":82.5,\"reps\":8,\"completedAt\":1700000120000,"
                                "\"note\":\"ok \xED\xA0\x80 bad\"}";
  drogon::HttpRequestPtr logging =
      postRequest("/v1/gym/sessions/ses_11111111/sets", Json::Value(Json::objectValue), "s-live");
  logging->setBody(surrogate);
  drogon::HttpRequestPtr fixing =
      patchSetRequest("ses_11111111", "set_11111111", Json::Value(Json::objectValue), "s-live");
  fixing->setBody(std::string("{\"note\":\"ok \xED\xA0\x80 bad\"}"));

  drogon::HttpResponsePtr logged = send(h.api, &GymApi::appendSet, logging, "ses_11111111");
  drogon::HttpResponsePtr fixed =
      sendSetWrite(h.api, &GymApi::fixSet, fixing, "ses_11111111", "set_11111111");

  CHECK_EQ(logged->getStatusCode(), drogon::k400BadRequest);
  // "could not read that set" and not "expected json": the body PARSED, and the rule refused it —
  // which is what makes this a case about the value and not about the reader.
  CHECK_EQ(dump(bodyOf(logged)), std::string(R"({"error":"could not read that set"})"));
  CHECK_EQ(fixed->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(fixed)),
           std::string(R"({"code":"fix-unreadable","error":"could not read that fix"})"));
  REQUIRE_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(h.repo.sets[0].note, std::string(""));
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

TEST(gym_list_sessions_wraps_rows_with_both_counts_the_tonnage_and_the_top_sets_estimate) {
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
  // The facts §G16 draws a row from: how many sets and how many of those were working, the tonnage
  // those working sets moved, which movements, the heaviest working set, the domain's estimate for
  // the session, and whether the four-hour rule ended it — this one is still running, so nothing
  // did. Both sets are straight work here, so the session's estimate is also the top set's.
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"sessions":[{"closedItself":false,)"
                       R"("exercises":["Back Squat","Bench Press"],"id":"ses_11111111",)"
                       R"("record":false,"setCount":2,"startedAt":1700000000000,)"
                            R"("tonnageKg":1460.0,)"
                       R"("topE1rm":126.7,"topSet":{"reps":8,"weightKg":100.0},)"
                       R"("workingSetCount":2}]})"));
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
  // A ramp-up and nothing else: one set held, none of them working, and so no top set, no estimate
  // over one, and a tonnage of zero — which the screen draws as nothing rather than as `0.0 t`.
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"sessions":[{"closedItself":true,"exercises":["Bench Press"],)"
                       R"("finishedAt":1700000060000,"id":"ses_11111111","record":false,)"
                            R"("setCount":1,)"
                       R"("startedAt":1700000000000,"tonnageKg":0.0,"workingSetCount":0}]})"));
}

// The number §G16 puts on the row is the SESSION's e1RM, and this is the session that proves it is
// not the top set's: 100 × 5 is the heaviest bar, and the three back-offs at 95 × 10 estimate above
// it. The finish screen has always shown 126.7 here; until 2026-08-12 the log row beside it showed
// 116.7, and both come off this wire, so no client could have reconciled them.
TEST(gym_list_sessions_carries_the_sessions_estimate_not_its_top_sets) {
  Harness h;
  UserId user = h.signIn("s-live");
  h.repo.sessions.push_back(
      Session{sid("ses_11111111"), user, 1'700'000'000'000, 1'700'000'300'000});
  h.repo.sets.push_back(Set{setId("set_11111111"), sid("ses_11111111"), ExerciseId{"back-squat"},
                            1, 100.0, 5, SetKind::working, std::nullopt, "", 1'700'000'060'000});
  for (int number = 2; number <= 4; ++number)
    h.repo.sets.push_back(Set{setId("set_1111111" + std::to_string(number)), sid("ses_11111111"),
                              ExerciseId{"back-squat"}, number, 95.0, 10, SetKind::working,
                              std::nullopt, "",
                              1'700'000'060'000 + static_cast<std::uint64_t>(number) * 1'000});

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::listSessions, getRequest("/v1/gym/sessions", "s-live"));
  drogon::HttpResponsePtr finish =
      send(h.api, &GymApi::reviewSession,
           getRequest("/v1/gym/sessions/ses_11111111/review", "s-live"), "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"sessions":[{"closedItself":false,"exercises":["Back Squat"],)"
                       R"("finishedAt":1700000300000,"id":"ses_11111111","record":false,)"
                            R"("setCount":4,)"
                       R"("startedAt":1700000000000,"tonnageKg":3350.0,"topE1rm":126.7,)"
                       R"("topSet":{"reps":5,"weightKg":100.0},"workingSetCount":4}]})"));
  // The same session read through the other door, on the same wire, saying the same number.
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

// The mirror's freshness tag: stable while the workout is what it was — a replayed read answers the
// same bytes — and moved by everything a poll acts on. A set landing and the close were the whole
// list until W3; a CORRECTION is now the third, and it is the one that moves no count, no last
// instant and no finished_at, which is exactly why the tag folds the sets rather than counting them.
TEST(gym_session_detail_etag_is_stable_replayed_and_moved_by_a_set_a_fix_and_the_finish) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  const std::string first = tagOf(readSession(h.api, "ses_11111111", "s-live"));
  const std::string replayed = tagOf(readSession(h.api, "ses_11111111", "s-live"));
  CHECK_EQ(first.rfind(R"(W/"1700000000000-0-)", 0), std::size_t{0});
  CHECK_EQ(replayed, first);

  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets",
                   setBody("set_22222222", "bench-press", 85.0, 1'700'000'120'000), "s-live"),
       "ses_11111111");
  const std::string grown = tagOf(readSession(h.api, "ses_11111111", "s-live"));
  CHECK(grown != first);

  // The whole reason the tag changed shape: this moves one weight and nothing else about the
  // session. Under the old (startedAt, count, last completedAt, finished_at) tag it was invisible,
  // and the mirror would have polled 304 forever over a number the lifter had corrected.
  sendSetWrite(h.api, &GymApi::fixSet,
               patchSetRequest("ses_11111111", "set_22222222", fixBody(87.5, 8), "s-live"),
               "ses_11111111", "set_22222222");
  const std::string fixed = tagOf(readSession(h.api, "ses_11111111", "s-live"));
  CHECK(fixed != grown);

  send(h.api, &GymApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'180'000), "s-live"),
       "ses_11111111");
  const std::string closed = tagOf(readSession(h.api, "ses_11111111", "s-live"));
  CHECK_EQ(closed.rfind(R"(W/"1700000000000-1700000180000-)", 0), std::size_t{0});
  CHECK(closed != fixed);
}

// The steady state of the poll: a matching If-None-Match answers 304 with no body at all — the tag
// still rides the reply, per RFC 9110 — and the moment a set lands the same stale tag no longer
// matches, so the next beat is the full 200 again.
TEST(gym_session_detail_matching_if_none_match_is_304_and_a_new_set_unmatches_it) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  const std::string held = tagOf(readSession(h.api, "ses_11111111", "s-live"));

  drogon::HttpResponsePtr unchanged = readSession(h.api, "ses_11111111", "s-live", held);
  CHECK_EQ(unchanged->getStatusCode(), drogon::k304NotModified);
  CHECK_EQ(tagOf(unchanged), held);
  CHECK_EQ(unchanged->getBody(), std::string(""));
  CHECK_EQ(unchanged->contentType(), drogon::CT_NONE);

  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets",
                   setBody("set_22222222", "bench-press", 85.0, 1'700'000'120'000), "s-live"),
       "ses_11111111");
  drogon::HttpResponsePtr changed = readSession(h.api, "ses_11111111", "s-live", held);
  CHECK_EQ(changed->getStatusCode(), drogon::k200OK);
  CHECK(tagOf(changed) != held);
  CHECK_EQ(bodyOf(changed)["sets"].size(), 2u);
}

// The one a corrected set would have got wrong, asserted on its own because it is the failure this
// wave could most easily have shipped: the mirror holds a tag, the lifter fixes 82.5 to 80 on the
// phone, and the very next poll must be a 200 carrying 80 rather than a 304 over a stale screen.
TEST(gym_session_detail_a_corrected_set_unmatches_the_tag_the_mirror_is_holding) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  const std::string held = tagOf(readSession(h.api, "ses_11111111", "s-live"));

  sendSetWrite(h.api, &GymApi::fixSet,
               patchSetRequest("ses_11111111", "set_11111111", fixBody(80.0, 8), "s-live"),
               "ses_11111111", "set_11111111");
  drogon::HttpResponsePtr polled = readSession(h.api, "ses_11111111", "s-live", held);

  CHECK_EQ(polled->getStatusCode(), drogon::k200OK);
  CHECK(tagOf(polled) != held);
  CHECK_EQ(bodyOf(polled)["sets"][0]["weightKg"].asDouble(), 80.0);
}

// The forms RFC 9110 §13.1.2 lets a client or a proxy send: the strong-form echo of our weak tag
// (weak comparison strips W/ from both sides), the tag inside a comma-separated list, and the lone
// "*" — each earns the 304 — while a list of tags that are all somebody else's earns the full 200.
TEST(gym_session_detail_if_none_match_reads_the_rfc_9110_forms) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");

  const std::string held = tagOf(readSession(h.api, "ses_11111111", "s-live"));
  const std::string opaque = held.substr(2);   // the strong form of our weak tag: W/ stripped

  drogon::HttpResponsePtr strong = readSession(h.api, "ses_11111111", "s-live", opaque);
  CHECK_EQ(strong->getStatusCode(), drogon::k304NotModified);
  CHECK_EQ(tagOf(strong), held);

  drogon::HttpResponsePtr listed =
      readSession(h.api, "ses_11111111", "s-live", R"(W/"other", "stale", )" + held);
  CHECK_EQ(listed->getStatusCode(), drogon::k304NotModified);
  CHECK_EQ(tagOf(listed), held);

  drogon::HttpResponsePtr any = readSession(h.api, "ses_11111111", "s-live", "*");
  CHECK_EQ(any->getStatusCode(), drogon::k304NotModified);
  CHECK_EQ(tagOf(any), held);

  drogon::HttpResponsePtr full =
      readSession(h.api, "ses_11111111", "s-live", R"(W/"other", garbage, "1-1700000060000-0")");
  CHECK_EQ(full->getStatusCode(), drogon::k200OK);
  CHECK_EQ(tagOf(full), held);
  CHECK_EQ(bodyOf(full)["sets"].size(), 1u);
}

// Why startedAt leads the tag: a workout discarded and recreated under the SAME id with the SAME set
// replayed into it is a new representation, and every other term — the fold over those sets and the
// finish instant — is byte-identical to the dead workout's. Without startedAt the recreate would
// hide behind a 304 and the mirror would keep drawing a workout that no longer exists.
TEST(gym_session_detail_recreated_under_the_same_id_never_echoes_the_dead_workouts_tag) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.api, &GymApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'180'000), "s-live"),
       "ses_11111111");
  const std::string dead = tagOf(readSession(h.api, "ses_11111111", "s-live"));
  send(h.api, &GymApi::discardSession, deleteRequest("/v1/gym/sessions/ses_11111111", "s-live"),
       "ses_11111111");

  send(h.api, &GymApi::startSession,
       postRequest("/v1/gym/sessions", startBody("ses_11111111", 1'700'000'030'000), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.api, &GymApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'180'000), "s-live"),
       "ses_11111111");
  drogon::HttpResponsePtr recreated = readSession(h.api, "ses_11111111", "s-live", dead);

  CHECK_EQ(recreated->getStatusCode(), drogon::k200OK);
  CHECK_EQ(tagOf(recreated).rfind(R"(W/"1700000030000-1700000180000-)", 0), std::size_t{0});
  // Past `W/"` and the thirteen digits of startedAt: everything the two tags have left is equal, so
  // startedAt is provably the only term keeping them apart.
  CHECK_EQ(tagOf(recreated).substr(17), dead.substr(17));
}

// The refusals stay byte-identical to what they always answered: no tag on a session this account
// cannot read — absent and another's alike — and none on the unsigned 401.
TEST(gym_session_detail_refusals_carry_no_etag) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr absent = send(h.api, &GymApi::getSession,
                                        getRequest("/v1/gym/sessions/ses_99999999", "s-live"),
                                        "ses_99999999");
  drogon::HttpResponsePtr anonymous = send(h.api, &GymApi::getSession,
                                           getRequest("/v1/gym/sessions/ses_11111111"),
                                           "ses_11111111");

  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(absent->getHeader("ETag"), std::string(""));
  CHECK_EQ(anonymous->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(anonymous->getHeader("ETag"), std::string(""));
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
                       R"("id":"rt_11111111","name":"Push A","position":0,"revision":1})"));
  CHECK_EQ(dump(bodyOf(listed)), R"({"routines":[)" + dump(bodyOf(created)) + R"(]})");
  // The single read is the create's reply plus the day's own history, which the LIST does not carry:
  // §M30 draws that section and a routines screen does not. The creation row names no door, and
  // that absence is what the screen draws as `created by you`.
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
      send(h.api, &GymApi::createRoutine, postRequest("/v1/gym/routines", body, "s-live"));

  CHECK_EQ(created->getStatusCode(), drogon::k200OK);
  // No targetWeightKg means "whatever you did last time" and no restSeconds means the client's own
  // default: a zero in either would read as a real target the lifter never set.
  CHECK_EQ(dump(bodyOf(created)),
           std::string(R"({"entries":[{"exerciseId":"bench-press","position":1,"restSeconds":180,)"
                       R"("targetReps":5,"targetSets":5,"targetWeightKg":82.5},)"
                       R"({"exerciseId":"back-squat","position":2,"targetReps":8,"targetSets":3}],)"
                       R"("id":"rt_11111111","name":"Push A","position":0,"revision":1})"));
}

// `Chin-up 3 × max` on the wire. targetReps is one of the four omissions that MEAN something, and it is
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
                       R"("id":"rt_11111111","name":"Push A","position":0,"revision":1})"));
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

// §M's third door: a routine copied out of a notebook on Sunday night, SAVED while it is still
// incomplete. The open line omits targetSets on the way in and on the way out — the absence is the
// state, and a zero would be a target of nothing — and the frozen plan carries the same absence
// onto the session, which is what lets the logger ask at the rack instead of reading `0 × 5`.
TEST(gym_a_routine_saves_with_an_open_line_and_the_plan_freezes_it_open) {
  Harness h;
  h.signIn("s-live");
  h.repo.seed(Exercise{ExerciseId{"barbell-row"}, "Barbell Row", Pattern::pull, Equipment::barbell,
                       2.5, false});
  Json::Value body = routineBody();
  Json::Value open(Json::objectValue);
  open["exerciseId"] = "barbell-row";
  body["entries"].append(open);

  drogon::HttpResponsePtr created =
      send(h.api, &GymApi::createRoutine, postRequest("/v1/gym/routines", body, "s-live"));
  Json::Value start = startBody();
  start["routineId"] = "rt_11111111";
  drogon::HttpResponsePtr started =
      send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", start, "s-live"));

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

// Half a target is not a target: the sheet that leaves a line open clears the whole row, so a line
// naming reps with no sets is refused where every unstorable value is.
TEST(gym_a_routine_line_with_reps_but_no_sets_is_400) {
  Harness h;
  h.signIn("s-live");
  Json::Value body = routineBody();
  body["entries"][0].removeMember("targetSets");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::createRoutine, postRequest("/v1/gym/routines", body, "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that routine"})"));
  CHECK(h.repo.routineRows.empty());
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
  tooLong["name"] = std::string(kMaxNameLength + 1, 'x');
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
                       R"("id":"rt_11111111","name":"Push A2","position":0,"revision":2})"));
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
                       // previousAt is the SESSION that set the mark, not the set inside it: a
                       // device's clock does not get to date what a lifter reads (domain/Review.h).
                       R"("record":{"exerciseId":"back-squat","kind":"e1rm","previous":120.0,)"
                       R"("previousAt":1699000000000,"reps":5,"value":122.5,"weightKg":105.0},)"
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

// ---- the statistics engine, which no app screen reads any more ------------------------------

// One point per finished session per movement, Epley over it, the standing bests beside it, and the
// weekly counts — and nothing else. There is no total, no volume, no streak and no percentage in
// this body, which is the engine's whole design and not an omission to fill in later. W1c retired
// the room this fed; these cases guard the route an agent still reads through `get_stats`.
TEST(gym_stats_answers_a_line_per_movement_and_the_weeks_around_it) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 4);

  drogon::HttpResponsePtr response = send(h.api, &GymApi::stats, getRequest("/v1/gym/stats", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  // Every instant in this body is the SESSION's start — the bests, the point they sit on, and the
  // last-trained line all name one workout. They did not until 2026-08-12: a best was dated by the
  // set's own clock, so this reply put a PR on 1700000060000 and the point that IS that PR on
  // 1700000000000, and an evening session crossed midnight between the two (domain/Review.h).
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"movements":[{"bestE1rm":{"at":1700000000000,"e1rm":104.5,)"
                       R"("reps":8,"weightKg":82.5},)"
                       R"("exerciseId":"bench-press",)"
                       R"("heaviest":{"at":1700000000000,"e1rm":104.5,"reps":8,"weightKg":82.5},)"
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

// Sharing is a write to the share table and nowhere else: not one row of the lifter's own log or
// program changed, and the session a share points at is byte-identical to what it was before.
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

// ---- the rename, and a movement's record ----------------------------------------------------

// The whole reply, byte for byte: the id has NOT moved, which is the promise the rename exists to
// demonstrate, and only the name did.
TEST(gym_rename_answers_the_movement_under_its_new_name_and_its_unchanged_id) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::renameExercise,
           patchRequest("/v1/gym/exercises/back-squat", renameBody(), "s-live"), "back-squat");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  // The id never moved, and the name it had a moment ago rides back as an alias — the picker
  // searches it, so the word in a lifter's muscle memory still finds the movement (§N32).
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"aliases":["Back Squat"],"custom":false,"equipment":"barbell",)"
                       R"("id":"back-squat","name":"Low-bar Squat","pattern":"squat",)"
                       R"("stepKg":2.5})"));
}

// §N32's *old name searchable as an alias*, and the rule that keeps it honest: renaming BACK does
// not leave the old name standing as an alias of itself. A picker that matched `Back Squat` twice —
// once as the name and once as a memory of it — would be shadowing the truth with the very list
// that exists to protect it.
TEST(gym_the_old_name_stays_searchable_and_renaming_back_takes_it_off_again) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr renamed =
      send(h.api, &GymApi::renameExercise,
           patchRequest("/v1/gym/exercises/back-squat", renameBody(), "s-live"), "back-squat");
  drogon::HttpResponsePtr listed =
      send(h.api, &GymApi::listExercises, getRequest("/v1/gym/exercises", "s-live"));
  drogon::HttpResponsePtr back =
      send(h.api, &GymApi::renameExercise,
           patchRequest("/v1/gym/exercises/back-squat", renameBody("Back Squat"), "s-live"),
           "back-squat");

  CHECK_EQ(dump(bodyOf(renamed)["aliases"]), std::string(R"(["Back Squat"])"));
  // The catalog is where the picker searches, so the alias has to be ON that read and not behind a
  // second one — a movement whose old name arrived a frame late is a movement you cannot find.
  // (The list is ordered by pattern then name, so the squat sits behind the press.)
  CHECK_EQ(dump(bodyOf(listed)["exercises"][1]["aliases"]), std::string(R"(["Back Squat"])"));
  // Renamed BACK: the name it is called now is off the alias list, and the one it was called for
  // the last few days is on it. A name is either what the movement is called or a memory of it.
  CHECK_EQ(bodyOf(back)["name"].asString(), std::string("Back Squat"));
  CHECK_EQ(dump(bodyOf(back)["aliases"]), std::string(R"(["Low-bar Squat"])"));
  // And a movement nobody has renamed carries no key at all: the ordinary catalog is byte-identical
  // to what it was before names grew a memory — omitted, never an empty array.
  CHECK(!bodyOf(listed)["exercises"][0].isMember("aliases"));
}

// A rename carries ONE field. A body naming anything else would be answered 200 with that field
// silently ignored, which is a write doing less than it said — so it is a 400 instead.
TEST(gym_rename_refuses_a_body_that_names_anything_but_the_name) {
  Harness h;
  h.signIn("s-live");
  Json::Value body = renameBody();
  body["stepKg"] = 5.0;

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::renameExercise,
           patchRequest("/v1/gym/exercises/back-squat", body, "s-live"), "back-squat");
  drogon::HttpResponsePtr empty =
      send(h.api, &GymApi::renameExercise,
           patchRequest("/v1/gym/exercises/back-squat", renameBody(""), "s-live"), "back-squat");

  drogon::HttpResponsePtr blank =
      send(h.api, &GymApi::renameExercise,
           patchRequest("/v1/gym/exercises/back-squat", renameBody("   "), "s-live"), "back-squat");

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that name"})"));
  CHECK_EQ(empty->getStatusCode(), drogon::k400BadRequest);
  // Blanks are the empty name in disguise, and they used to land: the movement then drew a blank
  // header, a blank picker row and a blank name on every log row, with no way to find it again.
  CHECK_EQ(blank->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(blank)), std::string(R"({"error":"could not read that name"})"));
}

// The path names a movement this account's catalog does not hold — absent and another lifter's
// private movement are the one fact, exactly as an absent session is.
TEST(gym_rename_of_a_movement_this_account_cannot_see_is_404) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::renameExercise,
           patchRequest("/v1/gym/exercises/no-such", renameBody(), "s-live"), "no-such");

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"no such movement"})"));
}

// The whole page in one reply, byte for byte: two tiles, the bars, the ladder and the days. The
// session that set the standing best is not on the ladder — a mark has to be passed.
TEST(gym_record_answers_the_whole_page_in_one_read) {
  Harness h;
  h.signIn("s-live");
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 4);

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::exerciseRecord,
           getRequest("/v1/gym/exercises/bench-press/record", "s-live"), "bench-press");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"bestE1rm":{"at":1700000000000,"e1rm":104.5,"reps":8,)"
                       R"("weightKg":82.5},)"
                       R"("e1rmSeries":[{"at":1700000000000,"e1rm":104.5,"reps":8,)"
                       R"("weightKg":82.5}],)"
                       R"("exercise":{"custom":false,"equipment":"barbell","id":"bench-press",)"
                       R"("name":"Bench Press","pattern":"press","stepKg":2.5},)"
                       R"("heaviest":{"at":1700000000000,"e1rm":104.5,"reps":8,"weightKg":82.5},)"
                       R"("recentDays":[{"sessionId":"ses_11111111",)"
                       R"("sets":[{"completedAt":1700000060000,"exerciseId":"bench-press",)"
                       R"("id":"set_111111111","kind":"working","note":"","reps":8,)"
                       R"("setNumber":1,"weightKg":82.5},)"
                       R"({"completedAt":1700000120000,"exerciseId":"bench-press",)"
                       R"("id":"set_111111112","kind":"working","note":"","reps":8,)"
                       R"("setNumber":2,"weightKg":82.5},)"
                       R"({"completedAt":1700000180000,"exerciseId":"bench-press",)"
                       R"("id":"set_111111113","kind":"working","note":"","reps":8,)"
                       R"("setNumber":3,"weightKg":82.5},)"
                       R"({"completedAt":1700000240000,"exerciseId":"bench-press",)"
                       R"("id":"set_111111114","kind":"working","note":"","reps":8,)"
                       R"("setNumber":4,"weightKg":82.5}],)"
                       R"("startedAt":1700000000000}],)"
                       R"("routineCount":0,"sessionCount":1})"));
}

// THE RENAME SHEET'S PROOF (§N32), and every number in it comes off THIS read: how many sessions
// hold the movement, how many PRs it has earned and the best estimate standing, and the days of the
// program that name it BY NAME. One read, so a sheet cannot assemble `34 sessions` from one call
// and `Push A · Legs` from another and show a lifter a torn claim about their own history.
TEST(gym_record_carries_the_days_that_name_the_movement_beside_their_count) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  h.repo.routineRows.push_back(Routine{rtId("rt_11111111"), caller, "Push A", 0, {benchEntry()}});
  h.repo.routineRows.push_back(
      Routine{rtId("rt_22222222"), caller, "Legs", 1, {benchEntry(), benchEntry(2)}});
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 4);

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::exerciseRecord,
           getRequest("/v1/gym/exercises/bench-press/record", "s-live"), "bench-press");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  // The count is the list's own length — the same fact twice would be two facts to keep in step.
  CHECK_EQ(bodyOf(response)["routineCount"].asInt(), 2);
  CHECK_EQ(dump(bodyOf(response)["routines"]), std::string(R"(["Push A","Legs"])"));
  CHECK_EQ(bodyOf(response)["sessionCount"].asInt(), 1);
}

// A movement in the catalog nobody has lifted: two zero counts, and not one empty list beside them
// — the page says `never logged` rather than drawing a chart frame with no bars in it. A movement
// no catalog holds is the different answer, and it is the one every absent thing here gets.
TEST(gym_record_of_a_movement_never_lifted_omits_every_list) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::exerciseRecord,
           getRequest("/v1/gym/exercises/back-squat/record", "s-live"), "back-squat");
  drogon::HttpResponsePtr unknown =
      send(h.api, &GymApi::exerciseRecord, getRequest("/v1/gym/exercises/no-such/record", "s-live"),
           "no-such");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"exercise":{"custom":false,"equipment":"barbell","id":"back-squat",)"
                       R"("name":"Back Squat","pattern":"squat","stepKg":2.5},)"
                       R"("routineCount":0,"sessionCount":0})"));
  CHECK_EQ(unknown->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(unknown)), std::string(R"({"error":"no such movement"})"));
}

// ---- §I · the settings section -----------------------------------------------------------------

// The read that cannot 404. A lifter who has never opened this screen holds no row, and what comes
// back is the DEFAULTS — kg, no rest target at all, confirmation on — because every client needs
// those values before it can draw its first frame, and an absence there would put a copy of the
// defaults in each of them.
TEST(gym_settings_answer_the_defaults_for_a_lifter_with_no_row) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::preferences, getRequest("/v1/gym/preferences", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"confirmHaptic":true,"confirmSound":false,"restSound":true,)"
                       R"("units":"kg"})"));
  // And nothing was written on the way out: reading settings does not give a lifter a row.
  CHECK_EQ(h.repo.preferenceRows.size(), std::size_t{0});
}

// The write is the whole document and it answers with the stored one, so the screen redraws from
// what the store now holds rather than from what it hoped it sent.
TEST(gym_settings_write_the_whole_document_and_answer_with_the_stored_one) {
  Harness h;
  h.signIn("s-live");

  Json::Value body(Json::objectValue);
  body["units"] = "lb";
  body["restSeconds"] = 90;
  body["restSound"] = false;
  body["confirmHaptic"] = false;
  body["confirmSound"] = true;
  drogon::HttpResponsePtr saved =
      send(h.api, &GymApi::savePreferences, putRequest("/v1/gym/preferences", body, "s-live"));
  drogon::HttpResponsePtr read =
      send(h.api, &GymApi::preferences, getRequest("/v1/gym/preferences", "s-live"));

  CHECK_EQ(saved->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(saved)),
           std::string(R"({"confirmHaptic":false,"confirmSound":true,"restSeconds":90,)"
                       R"("restSound":false,"units":"lb"})"));
  CHECK_EQ(dump(bodyOf(read)), dump(bodyOf(saved)));
  CHECK_EQ(h.repo.preferenceRows.size(), std::size_t{1});
}

// A whole-document PUT means the document IS the body: a field the sender did not name takes its
// default rather than quietly keeping a value the sender cannot see and cannot clear. `restSeconds`
// is the field that proves it — omitting it is how a lifter turns the timer off.
TEST(gym_settings_omitted_fields_take_their_default_and_no_rest_target_is_the_timer_off) {
  Harness h;
  h.signIn("s-live");

  Json::Value armed(Json::objectValue);
  armed["restSeconds"] = 180;
  send(h.api, &GymApi::savePreferences, putRequest("/v1/gym/preferences", armed, "s-live"));
  drogon::HttpResponsePtr cleared = send(h.api, &GymApi::savePreferences,
                                         putRequest("/v1/gym/preferences",
                                                    Json::Value(Json::objectValue), "s-live"));

  CHECK_EQ(cleared->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(cleared)),
           std::string(R"({"confirmHaptic":true,"confirmSound":false,"restSound":true,)"
                       R"("units":"kg"})"));
}

// Every refusal this write can make carries a machine word, and they are all different words:
// several independent values arrive at once, so a screen told only "could not read that" could not
// say which of its rows to send the lifter back to. The sentences are pinned beside the codes because they are
// what a lifter reads.
TEST(gym_settings_refusals_each_name_the_row_that_has_to_be_fixed) {
  Harness h;
  h.signIn("s-live");

  const auto refuse = [&](const Json::Value& body) {
    return send(h.api, &GymApi::savePreferences, putRequest("/v1/gym/preferences", body, "s-live"));
  };
  Json::Value unknownUnit(Json::objectValue);
  unknownUnit["units"] = "st";
  Json::Value badRest(Json::objectValue);
  badRest["restSeconds"] = 5;
  Json::Value misspelled(Json::objectValue);
  misspelled["restSecond"] = 90;

  // Asserted field by field rather than as one dumped line, because a sentence a lifter reads may
  // hold an em dash and the writer escapes it — the contract is the code and the words, not the
  // encoding of a punctuation mark.
  const auto said = [&](const Json::Value& body) {
    return std::pair(body["code"].asString(), body["error"].asString());
  };
  CHECK_EQ(refuse(unknownUnit)->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(said(bodyOf(refuse(unknownUnit))),
           std::pair(std::string("unknown-unit"), std::string(R"(units are "kg" or "lb")")));
  CHECK_EQ(said(bodyOf(refuse(badRest))),
           std::pair(std::string("rest-target"),
                     std::string("a rest target runs from 15 to 900 seconds — send none for no "
                                 "timer")));
  // A misspelled field is refused rather than ignored, and here that is not pedantry: an ignored
  // `restSecond` would answer 200 while the timer it was aiming at silently switched off.
  CHECK_EQ(said(bodyOf(refuse(misspelled))),
           std::pair(std::string("preferences-unreadable"),
                     std::string(R"(unknown settings field "restSecond". Settings take: units, )"
                                 R"(restSeconds, restSound, confirmHaptic, confirmSound.)")));
  // And nothing landed: a refused document leaves no row behind at all.
  CHECK_EQ(h.repo.preferenceRows.size(), std::size_t{0});
}

TEST(gym_settings_are_owner_scoped_on_both_doors) {
  Harness h;
  h.signIn("s-live");

  CHECK_EQ(send(h.api, &GymApi::preferences, getRequest("/v1/gym/preferences"))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.api, &GymApi::savePreferences,
                putRequest("/v1/gym/preferences", Json::Value(Json::objectValue)))
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(h.repo.preferenceRows.size(), std::size_t{0});
}

// §I's first row, proved rather than promised: KILOGRAMS ARE THE ONLY THING STORED. The account
// below switches to `lb` before it logs anything, and every number that comes back afterwards — the
// set it wrote, the session read, the log row's tonnage and top set, the CSV cell — is the kilogram
// it sent. Then it switches back, and the log is byte-identical: history does not get rewritten.
TEST(gym_units_are_a_display_transform_and_reach_no_write_or_read) {
  Harness h;
  h.signIn("s-live");

  Json::Value toPounds(Json::objectValue);
  toPounds["units"] = "lb";
  send(h.api, &GymApi::savePreferences, putRequest("/v1/gym/preferences", toPounds, "s-live"));
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 2);

  const std::string sessionUnderLb =
      dump(bodyOf(send(h.api, &GymApi::getSession,
                       getRequest("/v1/gym/sessions/ses_11111111", "s-live"), "ses_11111111")));
  const std::string logUnderLb =
      dump(bodyOf(send(h.api, &GymApi::listSessions, getRequest("/v1/gym/sessions", "s-live"))));
  const std::string csvUnderLb{
      send(h.api, &GymApi::exportSets, getRequest("/v1/gym/export", "s-live"))->getBody()};

  // The set the lifter logged is the kilogram they sent, in every reply that carries it.
  CHECK(sessionUnderLb.find(R"("weightKg":82.5)") != std::string::npos);
  CHECK(logUnderLb.find(R"("tonnageKg":1320.0)") != std::string::npos);
  CHECK(logUnderLb.find(R"("topSet":{"reps":8,"weightKg":82.5})") != std::string::npos);
  CHECK(csvUnderLb.find(",82.50,8,working,") != std::string::npos);
  // Nothing anywhere on the wire says lb but the settings document itself.
  CHECK(sessionUnderLb.find("lb") == std::string::npos);
  CHECK(logUnderLb.find("lb") == std::string::npos);
  CHECK(csvUnderLb.find("lb") == std::string::npos);
  // And the stored sets hold plain kilograms — the store never heard about the unit at all.
  CHECK_EQ(h.repo.sets.front().weightKg, 82.5);

  Json::Value toKilos(Json::objectValue);
  toKilos["units"] = "kg";
  send(h.api, &GymApi::savePreferences, putRequest("/v1/gym/preferences", toKilos, "s-live"));

  // Switching back rewrites nothing: the same three replies, byte for byte.
  CHECK_EQ(dump(bodyOf(send(h.api, &GymApi::getSession,
                            getRequest("/v1/gym/sessions/ses_11111111", "s-live"), "ses_11111111"))),
           sessionUnderLb);
  CHECK_EQ(dump(bodyOf(send(h.api, &GymApi::listSessions, getRequest("/v1/gym/sessions", "s-live")))),
           logUnderLb);
  CHECK_EQ(std::string{send(h.api, &GymApi::exportSets,
                                getRequest("/v1/gym/export", "s-live"))
                           ->getBody()},
           csvUnderLb);
}

// ---- the proposal ledger, and THE TAP ----------------------------------------------------------

namespace {
// The mint an agent makes, put straight into the store — the HTTP surface has no door for it, and
// that is the point: proposing is a tool, applying is a tap.
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

// The diff screen's read, and the shape three clients are pinned to. `changes` are the rows a lifter
// reads; `changeCount` is what the button counts.
TEST(gym_a_proposal_reads_as_a_typed_field_level_diff) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  h.repo.routineRows.push_back(Routine{rtId("rt_11111111"), caller, "Push A", 0, {benchEntry()}});
  h.repo.proposalRows.push_back(proposedFor(caller, {benchAt(87.5, 3)}));

  drogon::HttpResponsePtr read =
      send(h.api, &GymApi::getProposal, getRequest("/v1/gym/proposals/prop_11111111", "s-live"),
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

// THE TAP: all of it or none, and the reply carries both halves so the card redraws as `Applied`
// and the editor behind it redraws without a second read.
TEST(gym_applying_a_proposal_writes_the_whole_document_and_settles_the_card) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  h.repo.routineRows.push_back(Routine{rtId("rt_11111111"), caller, "Push A", 0, {benchEntry()}});
  h.repo.proposalRows.push_back(proposedFor(caller, {benchAt(87.5, 3)}));

  drogon::HttpResponsePtr applied =
      send(h.api, &GymApi::applyProposal,
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

// The line the whole ledger stands on, over the wire: the lifter's own PUT moves the routine, and a
// proposal minted against what it replaced is SUPERSEDED rather than merged over the top.
TEST(gym_a_routine_the_lifter_rewrote_refuses_the_proposal_that_predates_it) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  send(h.api, &GymApi::createRoutine, postRequest("/v1/gym/routines", routineBody(), "s-live"));
  h.repo.proposalRows.push_back(proposedFor(caller, {benchAt(87.5, 3)}));

  Json::Value rewritten = routineBody("rt_11111111", "Push A");
  rewritten["entries"][0]["targetWeightKg"] = 85.0;
  send(h.api, &GymApi::replaceRoutine,
       putRequest("/v1/gym/routines/rt_11111111", rewritten, "s-live"), "rt_11111111");
  drogon::HttpResponsePtr refused =
      send(h.api, &GymApi::applyProposal,
           postRequest("/v1/gym/proposals/prop_11111111/apply", Json::Value(Json::objectValue),
                       "s-live"),
           "prop_11111111");

  CHECK_EQ(refused->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(bodyOf(refused)["code"].asString(), std::string("proposal-superseded"));
  // The lifter's own numbers stand.
  drogon::HttpResponsePtr routine =
      send(h.api, &GymApi::getRoutine, getRequest("/v1/gym/routines/rt_11111111", "s-live"),
           "rt_11111111");
  CHECK_EQ(bodyOf(routine)["entries"][0]["targetWeightKg"].asDouble(), 85.0);
  CHECK_EQ(bodyOf(routine)["revision"].asInt(), 2);
  // And the superseded card is still on the routine's history rather than gone.
  drogon::HttpResponsePtr history = send(
      h.api, &GymApi::listProposals,
      getRequest("/v1/gym/proposals?routineId=rt_11111111", "s-live"));
  CHECK_EQ(bodyOf(history)["proposals"][0]["state"].asString(), std::string("superseded"));
}

// Dismissing asks for no reason and changes nothing, and the card stays in the history in case the
// lifter wants it back. Asking again for the SAME decision replays 200; the other one is 409.
TEST(gym_dismissing_a_proposal_changes_nothing_and_the_other_decision_is_refused) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  h.repo.routineRows.push_back(Routine{rtId("rt_11111111"), caller, "Push A", 0, {benchEntry()}});
  h.repo.proposalRows.push_back(proposedFor(caller, {benchAt(87.5, 3)}));

  drogon::HttpResponsePtr dismissed =
      send(h.api, &GymApi::dismissProposal,
           postRequest("/v1/gym/proposals/prop_11111111/dismiss", Json::Value(Json::objectValue),
                       "s-live"),
           "prop_11111111");
  drogon::HttpResponsePtr again =
      send(h.api, &GymApi::dismissProposal,
           postRequest("/v1/gym/proposals/prop_11111111/dismiss", Json::Value(Json::objectValue),
                       "s-live"),
           "prop_11111111");
  drogon::HttpResponsePtr applied =
      send(h.api, &GymApi::applyProposal,
           postRequest("/v1/gym/proposals/prop_11111111/apply", Json::Value(Json::objectValue),
                       "s-live"),
           "prop_11111111");

  CHECK_EQ(dismissed->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(dismissed)["proposal"]["state"].asString(), std::string("dismissed"));
  CHECK_EQ(again->getStatusCode(), drogon::k200OK);   // the replayed tap is not a failure
  CHECK_EQ(applied->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(bodyOf(applied)["code"].asString(), std::string("proposal-settled"));
  CHECK_EQ(h.repo.routineRows[0].entries[0].targetWeightKg, std::optional<double>(82.5));
  CHECK_EQ(h.repo.routineRows[0].revision, 1);
}

// Every proposal route is owner-scoped, and absent is byte-identical to another account's — the
// same rule every other route in this file keeps.
TEST(gym_another_accounts_proposal_is_404_on_every_route) {
  Harness h;
  h.signIn("s-live");
  h.repo.routineRows.push_back(
      Routine{rtId("rt_11111111"), uid("another-account"), "Their plan", 0, {benchEntry()}});
  h.repo.proposalRows.push_back(proposedFor(uid("another-account"), {benchAt(87.5, 3)}));

  drogon::HttpResponsePtr read =
      send(h.api, &GymApi::getProposal, getRequest("/v1/gym/proposals/prop_11111111", "s-live"),
           "prop_11111111");
  drogon::HttpResponsePtr applied =
      send(h.api, &GymApi::applyProposal,
           postRequest("/v1/gym/proposals/prop_11111111/apply", Json::Value(Json::objectValue),
                       "s-live"),
           "prop_11111111");
  drogon::HttpResponsePtr listed =
      send(h.api, &GymApi::listProposals, getRequest("/v1/gym/proposals", "s-live"));

  CHECK_EQ(read->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(read)), std::string(R"({"error":"no such proposal"})"));
  CHECK_EQ(applied->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(bodyOf(listed)["proposals"].size(), 0u);
  // And their plan is exactly where it was.
  CHECK_EQ(h.repo.routineRows[0].entries[0].targetWeightKg, std::optional<double>(82.5));
}

// Proposals have no anonymous story: no account, no proposal. Every door 401s before it reads
// anything, which is what the claim replay leans on — there is nothing here for it to replay.
TEST(gym_every_proposal_route_refuses_a_caller_with_no_session) {
  Harness h;

  CHECK_EQ(send(h.api, &GymApi::listProposals, getRequest("/v1/gym/proposals"))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.api, &GymApi::getProposal, getRequest("/v1/gym/proposals/prop_11111111"),
                "prop_11111111")
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.api, &GymApi::applyProposal,
                postRequest("/v1/gym/proposals/prop_11111111/apply", Json::Value(Json::objectValue)),
                "prop_11111111")
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.api, &GymApi::dismissProposal,
                postRequest("/v1/gym/proposals/prop_11111111/dismiss",
                            Json::Value(Json::objectValue)),
                "prop_11111111")
               ->getStatusCode(),
           drogon::k401Unauthorized);
}

// §B5's dot, on the read the routines screen already makes.
TEST(gym_the_routines_list_carries_the_proposal_waiting_on_a_day_of_the_program) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  h.repo.routineRows.push_back(Routine{rtId("rt_11111111"), caller, "Push A", 0, {benchEntry()}});

  drogon::HttpResponsePtr quiet =
      send(h.api, &GymApi::listRoutines, getRequest("/v1/gym/routines", "s-live"));
  h.repo.proposalRows.push_back(proposedFor(caller, {benchAt(87.5, 3)}));
  drogon::HttpResponsePtr waiting =
      send(h.api, &GymApi::listRoutines, getRequest("/v1/gym/routines", "s-live"));

  CHECK(bodyOf(quiet)["routines"][0]["pendingProposal"].isNull());
  CHECK_EQ(dump(bodyOf(waiting)["routines"][0]["pendingProposal"]),
           std::string(R"({"changeCount":1,"createdAt":1700000000000,"id":"prop_11111111",)"
                       R"("intent":"revise","routineId":"rt_11111111","source":{"door":"mcp"},)"
                       R"("state":"pending","summary":"Heavier triples."})"));
}

// ---- Ask's threads (§O), over HTTP -------------------------------------------------------------

namespace {
// A conversation seeded straight into the store, as Ask would have written it: the title is the
// lifter's first message and the turns are what was said.
void seedThread(Harness& h, const UserId& owner, const std::string& id, const std::string& title,
                std::uint64_t at = 1'700'000'000'000) {
  h.repo.threadRows.push_back(AskThread{ThreadId{id},
                                        owner,
                                        title,
                                        at,
                                        at,
                                        {ThreadTurn{true, title, at},
                                         ThreadTurn{false, "Your top set has not moved.", at}},
                                        {}});
}
}

// The list is titles and outcomes and nothing else — no unread count, no badge, nothing waiting.
TEST(gym_threads_lists_the_lifters_own_words_and_what_came_of_each) {
  Harness h;
  const UserId lifter = h.signIn("s-live");
  seedThread(h, lifter, "thr_00000001", "Is my squat volume too low?");
  seedThread(h, lifter, "thr_00000002", "Bench “stuck” at 82.5 💀?", 1'700'000'100'000);
  seedThread(h, UserId{"stranger"}, "thr_00000003", "not yours");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::listThreads, getRequest("/v1/gym/threads", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  const Json::Value body = bodyOf(response);
  REQUIRE_EQ(body["threads"].size(), 2u);
  // Newest asked first, and the title is the lifter's own bytes.
  CHECK_EQ(body["threads"][0]["id"].asString(), std::string("thr_00000002"));
  CHECK_EQ(body["threads"][0]["title"].asString(), std::string("Bench “stuck” at 82.5 💀?"));
  CHECK_EQ(body["threads"][0]["outcome"]["kind"].asString(), std::string("read-only"));
  CHECK_EQ(body["threads"][0]["outcome"]["changes"].asInt(), 0);
  CHECK_FALSE(body["threads"][0]["outcome"].isMember("routine"));
  CHECK_EQ(body["threads"][0]["proposals"].size(), 0u);
  // The list carries no turns: a list prints titles.
  CHECK_FALSE(body["threads"][0].isMember("turns"));
  CHECK_EQ(body["threads"][1]["id"].asString(), std::string("thr_00000001"));
  // …and there is no unread count, no badge, and nothing waiting. The reply is the list.
  CHECK_EQ(body.getMemberNames().size(), 1u);
}

TEST(gym_thread_reads_the_whole_conversation_and_another_accounts_is_absent) {
  Harness h;
  const UserId lifter = h.signIn("s-live");
  seedThread(h, lifter, "thr_00000001", "why is my bench stuck?");
  seedThread(h, UserId{"stranger"}, "thr_00000002", "not yours");

  drogon::HttpResponsePtr mine =
      send(h.api, &GymApi::getThread, getRequest("/v1/gym/threads/thr_00000001", "s-live"),
           "thr_00000001");
  drogon::HttpResponsePtr theirs =
      send(h.api, &GymApi::getThread, getRequest("/v1/gym/threads/thr_00000002", "s-live"),
           "thr_00000002");
  drogon::HttpResponsePtr absent =
      send(h.api, &GymApi::getThread, getRequest("/v1/gym/threads/thr_00009999", "s-live"),
           "thr_00009999");

  CHECK_EQ(mine->getStatusCode(), drogon::k200OK);
  const Json::Value body = bodyOf(mine);
  REQUIRE_EQ(body["turns"].size(), 2u);
  CHECK_EQ(body["turns"][0]["from"].asString(), std::string("lifter"));
  CHECK_EQ(body["turns"][0]["text"].asString(), std::string("why is my bench stuck?"));
  CHECK_EQ(body["turns"][1]["from"].asString(), std::string("ask"));
  // Another account's and an absent one are the same answer, byte for byte.
  CHECK_EQ(theirs->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(theirs)), dump(bodyOf(absent)));
}

TEST(gym_thread_delete_removes_the_conversation_and_answers_nothing_for_another_accounts) {
  Harness h;
  const UserId lifter = h.signIn("s-live");
  seedThread(h, lifter, "thr_00000001", "why is my bench stuck?");
  seedThread(h, UserId{"stranger"}, "thr_00000002", "not yours");

  drogon::HttpResponsePtr removed =
      send(h.api, &GymApi::deleteThread, deleteRequest("/v1/gym/threads/thr_00000001", "s-live"),
           "thr_00000001");
  drogon::HttpResponsePtr theirs =
      send(h.api, &GymApi::deleteThread, deleteRequest("/v1/gym/threads/thr_00000002", "s-live"),
           "thr_00000002");

  CHECK_EQ(removed->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(theirs->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(h.repo.threadRows.size(), 1u);
  CHECK_EQ(h.repo.threadRows[0].id, ThreadId{"thr_00000002"});
}

// The threads export: the same deliberately dull file the sets get — no parameters, nothing omitted,
// and every turn byte for byte. The outcome the domain derived rides on every row of its thread.
TEST(gym_thread_export_is_a_csv_attachment_carrying_every_turn_and_the_outcome) {
  Harness h;
  const UserId lifter = h.signIn("s-live");
  h.repo.routineRows.push_back(Routine{RoutineId{"rt_00000001"}, lifter, "Push A", 0,
                                       {RoutineEntry{1, ExerciseId{"bench-press"}, 5, 5, 82.5,
                                                     180}}});
  seedThread(h, lifter, "thr_00000001", R"(why is my bench, uh, "stuck"?)");
  h.repo.proposalRows.push_back(RoutineProposal{
      ProposalHead{ProposalId{"prop_00000001"}, RoutineId{"rt_00000001"}, lifter,
                   ProposalIntent::revise, ProposalState::applied,
                   ProposalSource{ProposalDoor::ask, "", "", ThreadId{"thr_00000001"}},
                   "Heavier triples.", 4, 1'700'000'000'000, 1'700'000'000'000},
      1, "Push A", "Push A",
      {RoutineChange{1, ChangeKind::retargeted, ExerciseId{"bench-press"},
                     EntryTargets{5, 5, 82.5, 180}, EntryTargets{5, 3, 87.5, 180}, 0}}});

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::exportThreads, getRequest("/v1/gym/export/threads", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(response->getHeader("Content-Disposition"),
           std::string(R"(attachment; filename="windmill-gym-threads.csv")"));
  CHECK_EQ(std::string(response->getBody()),
           std::string("thread_id,title,outcome,changes,routine,created_at,turn_number,from,text,"
                       "said_at\r\n"
                       R"(thr_00000001,"why is my bench, uh, ""stuck""?",applied,4,Push A,)"
                       "2023-11-14T22:13:20Z,1,lifter,"
                       R"("why is my bench, uh, ""stuck""?",2023-11-14T22:13:20Z)"
                       "\r\n"
                       R"(thr_00000001,"why is my bench, uh, ""stuck""?",applied,4,Push A,)"
                       "2023-11-14T22:13:20Z,2,ask,Your top set has not moved.,"
                       "2023-11-14T22:13:20Z\r\n"));
}

// An account that has never asked anything still gets a file, and the file still names its columns —
// the same rule the sets export keeps: an empty export is an answer.
TEST(gym_thread_export_of_an_account_that_never_asked_is_still_a_header_row) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.api, &GymApi::exportThreads, getRequest("/v1/gym/export/threads", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(std::string(response->getBody()),
           std::string("thread_id,title,outcome,changes,routine,created_at,turn_number,from,text,"
                       "said_at\r\n"));
}

// Every one of the four doors is owner-scoped like the rest of the product: an unsigned caller
// learns nothing at all, and touches nothing.
TEST(gym_threads_refuse_an_unsigned_caller_on_every_door) {
  Harness h;
  seedThread(h, UserId{"someone"}, "thr_00000001", "why is my bench stuck?");

  CHECK_EQ(send(h.api, &GymApi::listThreads, getRequest("/v1/gym/threads"))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.api, &GymApi::getThread, getRequest("/v1/gym/threads/thr_00000001"),
                "thr_00000001")
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.api, &GymApi::deleteThread, deleteRequest("/v1/gym/threads/thr_00000001"),
                "thr_00000001")
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(send(h.api, &GymApi::exportThreads, getRequest("/v1/gym/export/threads"))
               ->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(h.repo.threadRows.size(), 1u);
}
