#include "products/gym/adapters/http/GymApi.h"

#include "platform/adapters/json/JsonText.h"
#include "products/gym/adapters/json/TrainingJson.h"
#include "test/application/AuthFakes.h"
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
  std::shared_ptr<LogService> log = std::make_shared<LogService>(repo, clock);
  GymApi api{log, auth};

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

  CHECK_EQ(exercises->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(exercises)), std::string(R"({"error":"sign in to open your training log"})"));
  CHECK_EQ(start->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(append->getStatusCode(), drogon::k401Unauthorized);
  CHECK(h.repo.sessions.empty());
  CHECK(h.repo.sets.empty());
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
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
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
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
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
  CHECK_EQ(h.repo.sets.size(), static_cast<std::size_t>(1));
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
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
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
  CHECK_EQ(h.repo.sessions.size(), static_cast<std::size_t>(1));
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
  auto log = std::make_shared<LogService>(down, h.clock);
  GymApi api{log, h.auth};

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
  auto log = std::make_shared<LogService>(down, h.clock);
  GymApi api{log, h.auth};

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

TEST(gym_list_sessions_wraps_summaries_with_counts_and_names) {
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
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"sessions":[{"exercises":["Back Squat","Bench Press"],)"
                       R"("id":"ses_11111111","setCount":2,"startedAt":1700000000000}]})"));
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
  CHECK_EQ(bodyOf(one)["sessions"].size(), 2u);
  CHECK_EQ(bodyOf(one)["sessions"][0]["id"].asString(), std::string("ses_aaaaaaa4"));
  CHECK_EQ(bodyOf(one)["sessions"][1]["id"].asString(), std::string("ses_aaaaaaa3"));
  CHECK_EQ(two->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(two)["sessions"].size(), 2u);
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
  // No phase-0 write path mints a plan (§2.2), so the frozen snapshot the name is read out of is
  // placed on the stored row the way phase 2 will write it — and it rides the reply as an object.
  h.repo.sessions[0].planJson = R"({"routine":"Bench day","entries":[]})";
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

// A snapshot is client data, so the suffix the card prints is a string or nothing at all: an object
// under `routine` reaches jsonb as text, and `{"nested": 1}` would land in the product's
// highest-value pixel as the day of the program this session was trained on.
TEST(gym_last_omits_a_routine_the_snapshot_does_not_hold_as_a_string) {
  Harness h;
  h.signIn("s-live");
  send(h.api, &GymApi::startSession, postRequest("/v1/gym/sessions", startBody(), "s-live"));
  send(h.api, &GymApi::appendSet,
       postRequest("/v1/gym/sessions/ses_11111111/sets", setBody(), "s-live"), "ses_11111111");
  send(h.api, &GymApi::finishSession,
       postRequest("/v1/gym/sessions/ses_11111111/finish", finishBody(1'700'000'100'000), "s-live"),
       "ses_11111111");
  h.repo.sessions[0].planJson = R"({"routine":{"nested":1},"entries":[]})";

  drogon::HttpRequestPtr request = getRequest("/v1/gym/last", "s-live");
  request->setParameter("exercise", "bench-press");
  drogon::HttpResponsePtr response = send(h.api, &GymApi::lastTime, request);

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_FALSE(bodyOf(response).isMember("routine"));
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"exerciseId":"bench-press",)"
                       R"("session":{"finishedAt":1700000100000,"id":"ses_11111111",)"
                       R"("plan":{"entries":[],"routine":{"nested":1}},)"
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

TEST(gym_unknown_session_detail_is_404) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response = send(h.api, &GymApi::getSession,
                                          getRequest("/v1/gym/sessions/ses_99999999", "s-live"),
                                          "ses_99999999");

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"no such session"})"));
}
