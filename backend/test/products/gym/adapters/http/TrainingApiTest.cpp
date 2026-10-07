#include "test/products/gym/adapters/http/GymApiFixture.h"

#include <cstddef>
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

// TrainingApi: the gate, the log reads and the shares over the fake store; the import and write-decided reads over GymDoor.

namespace {
// The freshness tag, read off a reply and fed back into the next request.
std::string tagOf(const drogon::HttpResponsePtr& response) { return response->getHeader("ETag"); }

drogon::HttpResponsePtr readSession(TrainingApi& api, const std::string& session,
                                    const std::string& cookie,
                                    const std::string& ifNoneMatch = "") {
  drogon::HttpRequestPtr request = getRequest("/v1/gym/sessions/" + session, cookie);
  if (!ifNoneMatch.empty()) request->addHeader("If-None-Match", ifNoneMatch);
  return send(api, &TrainingApi::getSession, request, session);
}

// The set `setBody` describes, as the store holds it once logged into `session`: seeding numbers it.
Set loggedSet(const std::string& session = "ses_11111111", const std::string& id = "set_11111111",
              const std::string& exercise = "bench-press", double weightKg = 82.5,
              std::uint64_t completedAt = 1'700'000'060'000) {
  return Set{setId(id), sid(session), ExerciseId{exercise}, 0, weightKg, 8, SetKind::working,
             std::nullopt, "", completedAt};
}

// The same set as an agent's door writes it.
SetWrite setWrite(const std::string& id, double weightKg, std::uint64_t completedAt) {
  return SetWrite{setId(id), ExerciseId{"bench-press"}, weightKg, 8, SetKind::working, std::nullopt, "",
                  completedAt};
}

// Every id standing in one gym table of the sync database, in id order.
std::vector<std::string> idsIn(const std::string& table) {
  PgLease lease{*doortest::pool()};
  pqxx::read_transaction txn{*lease};
  std::vector<std::string> ids;
  for (const auto& row : txn.exec("select id from " + table + " order by id")) ids.push_back(row[0].as<std::string>());
  return ids;
}
}

TEST(gym_routes_without_a_session_are_401) {
  Harness h;

  drogon::HttpResponsePtr exercises =
      send(h.catalog, &CatalogApi::listExercises, getRequest("/v1/gym/exercises"));
  drogon::HttpResponsePtr lastSets =
      send(h.training, &TrainingApi::lastSets, getRequest("/v1/gym/exercises/last"));
  drogon::HttpResponsePtr import =
      send(h.training, &TrainingApi::importSession,
           postRequest("/v1/gym/sessions/import", Json::Value(Json::objectValue)));
  drogon::HttpResponsePtr routines =
      send(h.program, &ProgramApi::listRoutines, getRequest("/v1/gym/routines"));
  drogon::HttpResponsePtr review =
      send(h.training, &TrainingApi::reviewSession, getRequest("/v1/gym/sessions/ses_11111111/review"),
           "ses_11111111");
  drogon::HttpResponsePtr stats = send(h.training, &TrainingApi::stats, getRequest("/v1/gym/stats"));
  drogon::HttpResponsePtr share =
      send(h.training, &TrainingApi::shareSession,
           postRequest("/v1/gym/sessions/ses_11111111/share", Json::Value(Json::objectValue)),
           "ses_11111111");
  drogon::HttpResponsePtr revoke =
      send(h.training, &TrainingApi::revokeShare, deleteRequest("/v1/gym/sessions/ses_11111111/share"),
           "ses_11111111");
  drogon::HttpResponsePtr record =
      send(h.catalog, &CatalogApi::exerciseRecord, getRequest("/v1/gym/exercises/back-squat/record"),
           "back-squat");

  CHECK_EQ(exercises->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(exercises)), std::string(R"({"error":"sign in to open your training log"})"));
  // The picker's meta is a read of somebody's LOG under a catalog-shaped path.
  CHECK_EQ(lastSets->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(import->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(routines->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(review->getStatusCode(), drogon::k401Unauthorized);
  // Only `GET /v1/gym/shared/{token}` is on the other side of the gate.
  CHECK_EQ(stats->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(share->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(record->getStatusCode(), drogon::k401Unauthorized);
  // The revoke answers the gate rather than its own bare 204.
  CHECK_EQ(revoke->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(revoke)), std::string(R"({"error":"sign in to open your training log"})"));
  CHECK(h.repo.db.sessions.empty());
  CHECK(h.repo.db.sets.empty());
  CHECK(h.repo.db.shares.empty());
}

// The picker's meta line: the LAST set of the block, dated by the SESSION's start, keyed by movement id.
TEST(gym_exercises_last_is_the_final_set_of_each_movement_and_nothing_for_the_rest) {
  Harness h;
  const UserId me = h.signIn("s-live");
  h.repo.db.seedSession(Session{sid("ses_11111111"), me, 1'700'000'000'000, 1'700'000'300'000,
                                std::nullopt, std::nullopt, ClosedBy::finish});
  h.repo.db.seedSet(loggedSet());
  h.repo.db.seedSet(loggedSet("ses_11111111", "set_11111112", "bench-press", 80.0, 1'700'000'120'000));
  Set warmup = loggedSet("ses_11111111", "set_11111113", "back-squat", 60.0, 1'700'000'180'000);
  warmup.kind = SetKind::warmup;
  h.repo.db.seedSet(warmup);
  h.repo.db.seedSession(Session{sid("ses_22222222"), me, 1'700'000'400'000, 1'700'000'700'000,
                                std::nullopt, std::nullopt, ClosedBy::finish});
  h.repo.db.seedSet(loggedSet("ses_22222222", "set_22222221", "back-squat", 100.0, 1'700'000'460'000));
  h.repo.db.seedSession(Session{sid("ses_33333333"), me, 1'700'001'000'000});
  h.repo.db.seedSet(loggedSet("ses_33333333", "set_33333331", "bench-press", 140.0, 1'700'001'060'000));

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
  h.seedWorkout(h.signIn("s-live"), "ses_11111111", 1'700'000'000'000, 1);

  User other = h.authRepo.createUser(Email{"coach@example.com"}, "coach");
  h.authRepo.insertSession(h.tokens.digestOf("s-other"), other.id, h.clock.now + 1'000'000, "", "",
                           h.clock.now);

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::lastSets, getRequest("/v1/gym/exercises/last", "s-other"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"movements":[]})"));
}

TEST(gym_list_sessions_wraps_rows_with_both_counts_the_tonnage_and_the_top_sets_estimate) {
  Harness h;
  const UserId me = h.signIn("s-live");
  h.repo.db.seedSession(Session{sid("ses_11111111"), me, 1'700'000'000'000});
  h.repo.db.seedSet(loggedSet());
  h.repo.db.seedSet(loggedSet("ses_11111111", "set_22222222", "back-squat", 100.0, 1'700'000'120'000));

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
  h.repo.db.seedSession(Session{sid("ses_11111111"), h.signIn("s-live"), 1'700'000'000'000});
  h.repo.db.seedSet(loggedSet());

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
TEST(gym_session_detail_etag_is_stable_replayed_and_moved_by_a_set_a_correction_and_the_finish) {
  Harness h;
  h.repo.db.seedSession(Session{sid("ses_11111111"), h.signIn("s-live"), 1'700'000'000'000});
  h.repo.db.seedSet(loggedSet());

  const std::string first = tagOf(readSession(h.training, "ses_11111111", "s-live"));
  const std::string replayed = tagOf(readSession(h.training, "ses_11111111", "s-live"));
  CHECK_EQ(first.rfind(R"(W/"1700000000000-0-)", 0), std::size_t{0});
  CHECK_EQ(replayed, first);

  h.repo.db.seedSet(loggedSet("ses_11111111", "set_22222222", "bench-press", 85.0, 1'700'000'120'000));
  const std::string grown = tagOf(readSession(h.training, "ses_11111111", "s-live"));
  CHECK(grown != first);

  // This moves one weight and nothing else about the session, which is why the tag folds the sets.
  h.repo.db.sets[1].weightKg = 87.5;
  const std::string corrected = tagOf(readSession(h.training, "ses_11111111", "s-live"));
  CHECK(corrected != grown);

  h.repo.db.sessions[0].finishedAtMs = 1'700'000'180'000;
  h.repo.db.sessions[0].closedBy = ClosedBy::finish;
  const std::string closed = tagOf(readSession(h.training, "ses_11111111", "s-live"));
  CHECK_EQ(closed.rfind(R"(W/"1700000000000-1700000180000-)", 0), std::size_t{0});
  CHECK(closed != corrected);
}

// A matching If-None-Match answers 304 with no body, and the tag still rides the reply (RFC 9110).
TEST(gym_session_detail_matching_if_none_match_is_304_and_a_new_set_unmatches_it) {
  Harness h;
  h.repo.db.seedSession(Session{sid("ses_11111111"), h.signIn("s-live"), 1'700'000'000'000});
  h.repo.db.seedSet(loggedSet());
  const std::string held = tagOf(readSession(h.training, "ses_11111111", "s-live"));

  drogon::HttpResponsePtr unchanged = readSession(h.training, "ses_11111111", "s-live", held);
  CHECK_EQ(unchanged->getStatusCode(), drogon::k304NotModified);
  CHECK_EQ(tagOf(unchanged), held);
  CHECK_EQ(unchanged->getBody(), std::string(""));
  CHECK_EQ(unchanged->contentType(), drogon::CT_NONE);

  h.repo.db.seedSet(loggedSet("ses_11111111", "set_22222222", "bench-press", 85.0, 1'700'000'120'000));
  drogon::HttpResponsePtr changed = readSession(h.training, "ses_11111111", "s-live", held);
  CHECK_EQ(changed->getStatusCode(), drogon::k200OK);
  CHECK(tagOf(changed) != held);
  CHECK_EQ(bodyOf(changed)["sets"].size(), 2u);
}

TEST(gym_session_detail_a_corrected_set_unmatches_the_tag_the_mirror_is_holding) {
  Harness h;
  h.repo.db.seedSession(Session{sid("ses_11111111"), h.signIn("s-live"), 1'700'000'000'000});
  h.repo.db.seedSet(loggedSet());
  const std::string held = tagOf(readSession(h.training, "ses_11111111", "s-live"));

  h.repo.db.sets[0].weightKg = 80.0;
  drogon::HttpResponsePtr polled = readSession(h.training, "ses_11111111", "s-live", held);

  CHECK_EQ(polled->getStatusCode(), drogon::k200OK);
  CHECK(tagOf(polled) != held);
  CHECK_EQ(bodyOf(polled)["sets"][0]["weightKg"].asDouble(), 80.0);
}

// The forms RFC 9110 §13.1.2 allows: the strong-form echo of our weak tag, a comma-separated list, and "*".
TEST(gym_session_detail_if_none_match_reads_the_rfc_9110_forms) {
  Harness h;
  h.repo.db.seedSession(Session{sid("ses_11111111"), h.signIn("s-live"), 1'700'000'000'000});
  h.repo.db.seedSet(loggedSet());

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

TEST(gym_deleted_session_ids_cannot_recreate_records_or_reuse_the_dead_etag) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  REQUIRE(h.door.start(h.user, SessionStart{sid("ses_11111111"), 1'700'000'000'000}).session);
  REQUIRE(h.door.append(h.user, sid("ses_11111111"), setWrite("set_11111111", 82.5, 1'700'000'060'000)).set);
  REQUIRE(h.door.finish(h.user, sid("ses_11111111"), 1'700'000'180'000).session);
  const std::string dead = tagOf(readSession(h.trainingApi, "ses_11111111", "s-door"));
  REQUIRE_EQ(h.door.discard(h.user, sid("ses_11111111")), DiscardOutcome::done);

  const StartOutcome recreate =
      h.door.start(h.user, SessionStart{sid("ses_11111111"), 1'700'000'030'000});
  CHECK_EQ(recreate.error, StartError::idTaken);
  CHECK_FALSE(recreate.session);
  const auto absent = readSession(h.trainingApi, "ses_11111111", "s-door", dead);
  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(absent)), std::string(R"({"error":"no such session"})"));
  CHECK(tagOf(absent).empty());
  CHECK(h.failures.messages.empty());
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
  const UserId me = h.signIn("s-live");
  // The snapshot a start from a routine freezes, on the stored row.
  h.repo.db.seedSession(Session{sid("ses_11111111"), me, 1'700'000'000'000, 1'700'000'100'000,
                                std::nullopt, PlanSnapshot{"Bench day", {}}, ClosedBy::finish});
  h.repo.db.seedSet(loggedSet());
  h.repo.db.seedSession(Session{sid("ses_22222222"), me, 1'700'000'110'000});
  h.repo.db.seedSet(loggedSet("ses_22222222", "set_22222222", "bench-press", 100.0, 1'700'000'120'000));

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
  h.repo.db.seedSession(Session{sid("ses_11111111"), h.signIn("s-live"), 1'700'000'000'000,
                                1'700'000'100'000, std::nullopt, std::nullopt, ClosedBy::finish});
  h.repo.db.seedSet(loggedSet());

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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  REQUIRE(h.door.start(h.user, SessionStart{sid("ses_11111111"), 1'700'000'000'000}).session);
  REQUIRE(h.door.append(h.user, sid("ses_11111111"), setWrite("set_11111111", 82.5, 1'700'000'060'000)).set);
  REQUIRE(h.door.finish(h.user, sid("ses_11111111"), 1'700'000'100'000).session);
  REQUIRE(h.door.start(h.user, SessionStart{sid("ses_22222222"), 1'700'000'110'000}).session);
  REQUIRE(h.door.append(h.user, sid("ses_22222222"), setWrite("set_22222222", 100.0, 1'700'000'120'000)).set);
  h.clock.now = 1'700'000'120'000 + kAutoCloseMs;   // the live workout reads as idle past the window

  drogon::HttpRequestPtr request = getRequest("/v1/gym/last", "s-door");
  request->setParameter("exercise", "bench-press");
  drogon::HttpResponsePtr prefill = send(h.trainingApi, &TrainingApi::lastTime, request);
  const std::optional<Session> live = h.repo.log.session(h.user, sid("ses_22222222"));
  const AppendOutcome next =
      h.door.append(h.user, sid("ses_22222222"), setWrite("set_33333333", 102.5, 1'700'000'130'000));

  CHECK_EQ(prefill->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(prefill)["session"]["id"].asString(), std::string("ses_11111111"));
  CHECK_EQ(live, (std::optional<Session>{Session{sid("ses_22222222"), h.user, 1'700'000'110'000}}));
  CHECK_EQ(next.error, AppendError::none);
  CHECK_EQ(next.set, (std::optional<Set>{Set{setId("set_33333333"), sid("ses_22222222"), ExerciseId{"bench-press"},
                                             2, 102.5, 8, SetKind::working, std::nullopt, "", 1'700'000'130'000}}));
  CHECK(h.failures.messages.empty());
}

// A first-ever movement is answered, not refused: 200 naming the movement and nothing else.
TEST(gym_last_for_a_first_ever_movement_is_a_fact_not_a_fault) {
  Harness h;
  h.repo.db.seedSession(Session{sid("ses_11111111"), h.signIn("s-live"), 1'700'000'000'000,
                                1'700'000'100'000, std::nullopt, std::nullopt, ClosedBy::finish});
  h.repo.db.seedSet(loggedSet());

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
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  REQUIRE_EQ(h.door.createRoutine(h.user, RoutineWrite{rtId("rt_11111111"), "Push A", 0, {benchEntry()}},
                                     ProposalDoor::mcp).error, RoutineWriteError::none);

  const StartOutcome started = h.door.start(
      h.user, SessionStart{sid("ses_11111111"), 1'700'000'000'000, true, rtId("rt_11111111")});
  drogon::HttpResponsePtr detail = readSession(h.trainingApi, "ses_11111111", "s-door");

  CHECK_EQ(started.error, StartError::none);
  CHECK_EQ(detail->getStatusCode(), drogon::k200OK);
  // The snapshot is the SERVER's copy: the routine as a plain string and the plan's numbers, no pointer back.
  CHECK_EQ(dump(bodyOf(detail)["session"]),
           std::string(R"({"id":"ses_11111111",)"
                       R"("plan":{"entries":[{"exerciseId":"bench-press","restSeconds":180,)"
                       R"("sets":[{"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5}]}],"routine":"Push A"},)"
                       R"("routineId":"rt_11111111","startedAt":1700000000000})"));
  CHECK_EQ(started.session, h.repo.log.session(h.user, sid("ses_11111111")));
  CHECK(h.failures.messages.empty());
}

// A ramp freezes into the plan set by set, and the session read carries it back byte for byte.
TEST(gym_start_from_a_routine_freezes_the_ramp_into_the_plan) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  REQUIRE_EQ(h.door.createRoutine(h.user,
                                     RoutineWrite{rtId("rt_11111111"), "Lower A", 0,
                                                  {RoutineEntry{1, ExerciseId{"back-squat"}, ramp(), 180}}},
                                     ProposalDoor::mcp).error, RoutineWriteError::none);

  const StartOutcome started = h.door.start(
      h.user, SessionStart{sid("ses_11111111"), 1'700'000'000'000, true, rtId("rt_11111111")});
  drogon::HttpResponsePtr detail = readSession(h.trainingApi, "ses_11111111", "s-door");

  CHECK_EQ(started.error, StartError::none);
  CHECK_EQ(detail->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(detail)["session"]),
           std::string(R"({"id":"ses_11111111",)"
                       R"("plan":{"entries":[{"exerciseId":"back-squat","restSeconds":180,)"
                       R"("sets":[{"reps":5,"weightKg":60.0},{"reps":5,"weightKg":80.0},)"
                       R"({"reps":3,"weightKg":90.0},{"reps":1,"weightKg":100.0},)"
                       R"({"reps":5,"weightKg":80.0}]}],"routine":"Lower A"},)"
                       R"("routineId":"rt_11111111","startedAt":1700000000000})"));
  CHECK_EQ(h.repo.log.session(h.user, sid("ses_11111111")),
           (std::optional<Session>{Session{sid("ses_11111111"), h.user, 1'700'000'000'000, std::nullopt,
                                           rtId("rt_11111111"),
                                           PlanSnapshot{"Lower A", {PlanEntry{ExerciseId{"back-squat"}, ramp(), 180}}}}}));
  CHECK(h.failures.messages.empty());
}

namespace {
// A finished session of the Legs day, its sets and the routine behind it, pushed straight in.
void trained(Harness& h, const wm::UserId& caller, const std::string& session,
             std::uint64_t startedAtMs, double weightKg, int reps) {
  const PlanSnapshot plan{"Legs", {PlanEntry{ExerciseId{"back-squat"}, straight(5, 5, 100.0), 180}}};
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
      {RoutineEntry{1, ExerciseId{"back-squat"}, straight(5, 5, 100.0), 180}}});
  trained(h, caller, "ses_22222222", 1'699'000'000'000, 90, 10);   // e1RM 120 — the mark
  trained(h, caller, "ses_11111111", 1'700'000'000'000, 105, 5);   // e1RM 122.5 — the record

  drogon::HttpResponsePtr response =
      send(h.training, &TrainingApi::reviewSession,
           getRequest("/v1/gym/sessions/ses_11111111/review", "s-live"), "ses_11111111");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"against":{"movements":[{"before":{"reps":10,"sets":4,"weightKg":90.0},)"
                       R"("exerciseId":"back-squat","now":{"reps":5,"sets":4,"weightKg":105.0},)"
                       R"("planned":{"sets":[{"reps":5,"weightKg":100.0},{"reps":5,"weightKg":100.0},)"
                       R"({"reps":5,"weightKg":100.0},{"reps":5,"weightKg":100.0},)"
                       R"({"reps":5,"weightKg":100.0}]}}],"routine":"Legs",)"
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
  h.seedWorkout(h.signIn("s-live"), "ses_11111111", 1'700'000'000'000, 4);

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

TEST(gym_stats_progress_requires_a_signed_in_owner) {
  Harness h;
  const auto request = getRequest("/v1/gym/stats");
  request->setParameter("projection", "progress");

  const auto response = send(h.training, &TrainingApi::stats, request);

  CHECK_EQ(response->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"sign in to open your training log"})"));
}

TEST(gym_stats_progress_answers_the_complete_qualified_identity_and_effort_contract) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.repo.db.sessions.push_back(Session{sid("ses_11111111"), user, 1'700'000'000'000, 1'700'000'060'000});
  h.repo.db.sets = {
      {setId("set_11111111"), sid("ses_11111111"), ExerciseId{"bench-press"}, 1,
       100, 1, SetKind::working, std::nullopt, "private note", 1'700'000'010'000},
      {setId("set_11111112"), sid("ses_11111111"), ExerciseId{"bench-press"}, 2,
       90, 10, SetKind::working, 6.5, "", 1'700'000'020'000},
      {setId("set_11111113"), sid("ses_11111111"), ExerciseId{"bench-press"}, 3,
       90, 8, SetKind::working, 7.5, "", 1'700'000'030'000},
      {setId("set_11111114"), sid("ses_11111111"), ExerciseId{"chin-up"}, 1,
       -10, 8, SetKind::working, 8, "", 1'700'000'040'000}};
  const auto request = getRequest("/v1/gym/stats", "s-live");
  request->setParameter("projection", "progress");

  const auto response = send(h.training, &TrainingApi::stats, request);

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)), std::string(
      R"({"asOf":1700000000000,"sessions":[{"movements":[)"
      R"({"estimate":{"e1rm":114.0,"reps":8,"rpe":7.5,"setId":"set_11111113","weightKg":90.0},)"
      R"("exerciseId":"bench-press","heaviest":{"reps":1,"setId":"set_11111111","weightKg":100.0},)"
      R"("workingSetCount":3},)"
      R"({"exerciseId":"chin-up","heaviest":{"reps":8,"rpe":8.0,"setId":"set_11111114","weightKg":-10.0},)"
      R"("workingSetCount":1}],"sessionId":"ses_11111111","startedAt":1700000000000}]})"));
}

TEST(gym_stats_progress_empty_is_explicit_and_another_owner_has_no_rows) {
  Harness h;
  h.signIn("s-live");
  h.repo.db.sessions.push_back(Session{sid("ses_11111111"), uid("other"),
                                      1'700'000'000'000, 1'700'000'060'000});
  h.repo.db.sets.push_back(Set{setId("set_11111111"), sid("ses_11111111"),
      ExerciseId{"bench-press"}, 1, 100, 1, SetKind::working, 8, "", 1'700'000'030'000});
  const auto request = getRequest("/v1/gym/stats", "s-live");
  request->setParameter("projection", "progress");

  const auto response = send(h.training, &TrainingApi::stats, request);

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"asOf":1700000000000,"sessions":[]})"));
}

TEST(gym_stats_only_opts_into_the_progress_projection_by_its_exact_name) {
  Harness h;
  h.signIn("s-live");
  const auto request = getRequest("/v1/gym/stats", "s-live");
  request->setParameter("projection", "unknown");

  const auto response = send(h.training, &TrainingApi::stats, request);

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"movements":[],"weeks":[]})"));
}

TEST(gym_share_answers_a_token_and_an_end_and_a_second_tap_answers_the_same_one) {
  Harness h;
  h.seedWorkout(h.signIn("s-live"), "ses_11111111", 1'700'000'000'000, 4);

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
TEST(gym_share_answers_the_page_its_holder_opens_and_never_the_json_route) {
  Harness h;
  h.seedWorkout(h.signIn("s-live"), "ses_11111111", 1'700'000'000'000, 4);

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
  h.seedWorkout(h.signIn("s-live"), "ses_11111111", 1'700'000'000'000, 4);
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
  h.seedWorkout(h.signIn("s-live"), "ses_11111111", 1'700'000'000'000, 2);
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
  h.seedWorkout(h.signIn("s-live"), "ses_11111111", 1'700'000'000'000, 2);
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
  h.seedWorkout(h.signIn("s-live"), "ses_11111111", 1'700'000'000'000, 2);
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

// ── POST /v1/gym/sessions/import: a past workout written whole, over the real door ─────────────
// The clock stands at 1'700'000'000'000; the imported workout ran from two hours to one hour before.

namespace {
Json::Value importBody(const std::string& id, std::uint64_t startedAt, std::uint64_t finishedAt,
                       const std::vector<Json::Value>& sets) {
  Json::Value body(Json::objectValue);
  body["id"] = id;
  body["startedAt"] = Json::Value::UInt64(startedAt);
  body["finishedAt"] = Json::Value::UInt64(finishedAt);
  body["sets"] = Json::Value(Json::arrayValue);
  for (const Json::Value& set : sets) body["sets"].append(set);
  return body;
}

drogon::HttpResponsePtr sendImport(DoorApis& h, const Json::Value& body) {
  return send(h.trainingApi, &TrainingApi::importSession,
              postRequest("/v1/gym/sessions/import", body, "s-door"));
}
}

TEST(gym_import_from_a_routine_is_201_with_the_plan_frozen_and_the_routine_left_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  REQUIRE_EQ(h.door.createRoutine(h.user, RoutineWrite{rtId("rt_11111111"), "Push A", 0, {benchEntry()}},
                                     ProposalDoor::mcp).error, RoutineWriteError::none);
  const std::string routineBefore = dump(bodyOf(
      send(h.programApi, &ProgramApi::getRoutine, getRequest("/v1/gym/routines/rt_11111111", "s-door"), "rt_11111111")));
  Json::Value body = importBody("ses_import01", 1'699'992'800'000, 1'699'996'400'000,
                                {setBody("set_import01", "bench-press", 60, 1'699'993'400'000),
                                 setBody("set_import02", "bench-press", 62.5, 1'699'994'000'000)});
  body["routineId"] = "rt_11111111";

  drogon::HttpResponsePtr response = sendImport(h, body);

  CHECK_EQ(response->getStatusCode(), drogon::k201Created);
  const std::string stored =
      R"({"session":{"finishedAt":1699996400000,"id":"ses_import01","plan":{"entries":[{"exerciseId":"bench-press",)"
      R"("restSeconds":180,"sets":[{"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
      R"({"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5}]}],"routine":"Push A"},"routineId":"rt_11111111",)"
      R"("startedAt":1699992800000},"sets":[{"completedAt":1699993400000,"exerciseId":"bench-press","id":"set_import01",)"
      R"("kind":"working","note":"","reps":8,"setNumber":1,"weightKg":60.0},{"completedAt":1699994000000,)"
      R"("exerciseId":"bench-press","id":"set_import02","kind":"working","note":"","reps":8,"setNumber":2,"weightKg":62.5}]})";
  CHECK_EQ(dump(bodyOf(response)), stored);
  // The same shape the session's own read answers, byte for byte.
  CHECK_EQ(dump(bodyOf(readSession(h.trainingApi, "ses_import01", "s-door"))), stored);
  // Logging a day is not changing the plan: the routine moves only its trained line.
  Json::Value routineAfter = bodyOf(send(h.programApi, &ProgramApi::getRoutine,
                                         getRequest("/v1/gym/routines/rt_11111111", "s-door"), "rt_11111111"));
  CHECK_EQ(routineAfter["lastTrainedAt"].asUInt64(), static_cast<std::uint64_t>(1'699'992'800'000));
  routineAfter.removeMember("lastTrainedAt");
  CHECK_EQ(dump(routineAfter), routineBefore);
  CHECK(h.failures.messages.empty());
}

TEST(gym_import_without_a_routine_is_201_ad_hoc_and_a_replay_is_200_with_the_stored_row) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  const Json::Value body = importBody("ses_import01", 1'699'992'800'000, 1'699'996'400'000,
                                      {setBody("set_import01", "back-squat", 100, 1'699'993'400'000)});

  drogon::HttpResponsePtr created = sendImport(h, body);
  drogon::HttpResponsePtr replayed = sendImport(h, body);

  const std::string stored =
      R"({"session":{"finishedAt":1699996400000,"id":"ses_import01","startedAt":1699992800000},)"
      R"("sets":[{"completedAt":1699993400000,"exerciseId":"back-squat","id":"set_import01","kind":"working",)"
      R"("note":"","reps":8,"setNumber":1,"weightKg":100.0}]})";
  CHECK_EQ(created->getStatusCode(), drogon::k201Created);
  CHECK_EQ(dump(bodyOf(created)), stored);
  CHECK_EQ(replayed->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(replayed)), stored);
  CHECK_EQ(idsIn("gym_sessions"), std::vector<std::string>{"ses_import01"});
  CHECK_EQ(idsIn("gym_sets"), std::vector<std::string>{"set_import01"});
  CHECK(h.failures.messages.empty());
}

TEST(gym_import_leaves_the_open_session_alone_even_where_their_times_cross) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  REQUIRE(h.door.start(h.user, SessionStart{sid("ses_live0001"), 1'699'995'000'000}).session);

  drogon::HttpResponsePtr response =
      sendImport(h, importBody("ses_import01", 1'699'992'800'000, 1'699'996'400'000,
                               {setBody("set_import01", "bench-press", 60, 1'699'993'400'000)}));

  CHECK_EQ(response->getStatusCode(), drogon::k201Created);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"session":{"finishedAt":1699996400000,"id":"ses_import01","startedAt":1699992800000},)"
                       R"("sets":[{"completedAt":1699993400000,"exerciseId":"bench-press","id":"set_import01",)"
                       R"("kind":"working","note":"","reps":8,"setNumber":1,"weightKg":60.0}]})"));
  // Still open, still where it began.
  CHECK_EQ(h.repo.log.open(h.user), (std::optional<Session>{Session{sid("ses_live0001"), h.user, 1'699'995'000'000}}));
  CHECK(h.failures.messages.empty());
}

TEST(gym_import_replayed_after_the_hour_filled_in_is_still_200_and_a_changed_body_still_id_taken) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  REQUIRE(h.door.start(h.user, SessionStart{sid("ses_live0001"), 1'699'995'000'000}).session);
  const Json::Value body = importBody("ses_import01", 1'699'992'800'000, 1'699'996'400'000,
                                      {setBody("set_import01", "bench-press", 60, 1'699'993'400'000)});
  REQUIRE_EQ(sendImport(h, body)->getStatusCode(), drogon::k201Created);
  // The live workout ends inside the imported hour, and now it is a finished session in the way.
  REQUIRE(h.door.finish(h.user, sid("ses_live0001"), 1'699'996'000'000).session);
  Json::Value changed = body;
  changed["sets"][0]["reps"] = 9;

  drogon::HttpResponsePtr replayed = sendImport(h, body);
  drogon::HttpResponsePtr rewritten = sendImport(h, changed);

  CHECK_EQ(replayed->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(replayed)),
           std::string(R"({"session":{"finishedAt":1699996400000,"id":"ses_import01","startedAt":1699992800000},)"
                       R"("sets":[{"completedAt":1699993400000,"exerciseId":"bench-press","id":"set_import01",)"
                       R"("kind":"working","note":"","reps":8,"setNumber":1,"weightKg":60.0}]})"));
  CHECK_EQ(rewritten->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(rewritten)), std::string(R"({"code":"session-id-taken","error":"that session id is taken"})"));
  CHECK(h.failures.messages.empty());
}

TEST(gym_import_crossing_a_finished_session_is_409_session_overlap_naming_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  REQUIRE(h.door.start(h.user, SessionStart{sid("ses_before01"), 1'699'990'000'000}).session);
  REQUIRE(h.door.append(h.user, sid("ses_before01"), setWrite("set_before011", 82.5, 1'699'990'060'000)).set);
  REQUIRE(h.door.finish(h.user, sid("ses_before01"), 1'699'993'600'000).session);

  drogon::HttpResponsePtr response =
      sendImport(h, importBody("ses_import01", 1'699'992'800'000, 1'699'996'400'000,
                               {setBody("set_import01", "bench-press", 60, 1'699'993'400'000)}));

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"session-overlap","error":"these times cross a session already in the log",)"
                       R"("session":{"finishedAt":1699993600000,"id":"ses_before01","startedAt":1699990000000},)"
                       R"("sessionId":"ses_before01"})"));
  CHECK_EQ(idsIn("gym_sessions"), std::vector<std::string>{"ses_before01"});
  // Ending exactly as that one began, or beginning as it ended, crosses nothing.
  drogon::HttpResponsePtr after =
      sendImport(h, importBody("ses_import02", 1'699'993'600'000, 1'699'996'400'000, {}));
  CHECK_EQ(after->getStatusCode(), drogon::k201Created);
  CHECK(h.failures.messages.empty());
}

TEST(gym_import_with_a_spent_session_id_is_409_session_id_taken_whoever_spent_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  REQUIRE(h.door.start(h.other, SessionStart{sid("ses_taken001"), 1'699'000'000'000}).session);
  const Json::Value mine = importBody("ses_import01", 1'699'992'800'000, 1'699'996'400'000,
                                      {setBody("set_import01", "bench-press", 60, 1'699'993'400'000)});
  REQUIRE_EQ(sendImport(h, mine)->getStatusCode(), drogon::k201Created);
  Json::Value changed = mine;
  changed["sets"][0]["reps"] = 9;

  drogon::HttpResponsePtr theirs =
      sendImport(h, importBody("ses_taken001", 1'699'980'000'000, 1'699'983'600'000, {}));
  drogon::HttpResponsePtr rewritten = sendImport(h, changed);

  CHECK_EQ(theirs->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(theirs)), std::string(R"({"code":"session-id-taken","error":"that session id is taken"})"));
  CHECK_EQ(rewritten->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(rewritten)), std::string(R"({"code":"session-id-taken","error":"that session id is taken"})"));
  CHECK_EQ(h.repo.log.setsOf(sid("ses_import01")),
           (std::vector<Set>{Set{setId("set_import01"), sid("ses_import01"), ExerciseId{"bench-press"}, 1, 60, 8,
                                 SetKind::working, std::nullopt, "", 1'699'993'400'000}}));
  CHECK(h.failures.messages.empty());
}

TEST(gym_import_with_a_spent_set_id_is_409_set_id_taken_and_lands_nothing) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  REQUIRE_EQ(sendImport(h, importBody("ses_import01", 1'699'980'000'000, 1'699'983'600'000,
                                      {setBody("set_import01", "bench-press", 60, 1'699'981'000'000)}))
                 ->getStatusCode(),
             drogon::k201Created);

  drogon::HttpResponsePtr response =
      sendImport(h, importBody("ses_import02", 1'699'992'800'000, 1'699'996'400'000,
                               {setBody("set_import02", "bench-press", 60, 1'699'993'400'000),
                                setBody("set_import01", "bench-press", 60, 1'699'994'000'000)}));

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"set-id-taken","error":"sets[1] (set_import01): that set id is already used"})"));
  CHECK_EQ(idsIn("gym_sessions"), std::vector<std::string>{"ses_import01"});
  CHECK_EQ(idsIn("gym_sets"), std::vector<std::string>{"set_import01"});
  CHECK(h.failures.messages.empty());
}

TEST(gym_import_naming_a_routine_the_caller_cannot_read_is_404) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  REQUIRE_EQ(h.door.createRoutine(h.other, RoutineWrite{rtId("rt_theirs01"), "Legs", 0, {benchEntry()}},
                                     ProposalDoor::mcp).error, RoutineWriteError::none);
  Json::Value theirs = importBody("ses_import01", 1'699'992'800'000, 1'699'996'400'000, {});
  theirs["routineId"] = "rt_theirs01";
  Json::Value missing = importBody("ses_import02", 1'699'992'800'000, 1'699'996'400'000, {});
  missing["routineId"] = "rt_missing1";

  drogon::HttpResponsePtr another = sendImport(h, theirs);
  drogon::HttpResponsePtr absent = sendImport(h, missing);

  CHECK_EQ(another->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(another)), std::string(R"({"error":"no such routine"})"));
  CHECK_EQ(dump(bodyOf(absent)), dump(bodyOf(another)));
  CHECK_EQ(idsIn("gym_sessions"), std::vector<std::string>{});
  CHECK(h.failures.messages.empty());
}

TEST(gym_import_that_cannot_be_read_is_400_with_the_sentence_that_says_why) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  const auto refusal = [&](const Json::Value& body) {
    drogon::HttpResponsePtr response = sendImport(h, body);
    CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
    return dump(bodyOf(response));
  };
  const Json::Value good = importBody("ses_import01", 1'699'992'800'000, 1'699'996'400'000,
                                      {setBody("set_import01", "bench-press", 60, 1'699'993'400'000)});
  Json::Value unknownField = good;
  unknownField["joinOpenSession"] = false;
  Json::Value unknownSetField = good;
  unknownSetField["sets"][0]["setNumber"] = 1;
  Json::Value unknownKind = good;
  unknownKind["sets"][0]["kind"] = "cluster";
  Json::Value outside = good;
  outside["sets"][0]["completedAt"] = Json::Value::UInt64(1'699'996'400'001);
  Json::Value unknownExercise = good;
  unknownExercise["sets"][0]["exerciseId"] = "no-such-lift";

  CHECK_EQ(refusal(unknownField),
           std::string(R"({"error":"unknown import field \"joinOpenSession\". An import takes: id, startedAt, )"
                       R"(finishedAt, routineId, sets."})"));
  CHECK_EQ(refusal(unknownSetField),
           std::string(R"({"error":"sets[0]: unknown set field \"setNumber\". A set takes: id, exerciseId, )"
                       R"(weightKg, reps, completedAt, kind, rpe, note."})"));
  CHECK_EQ(refusal(unknownKind), std::string(R"({"error":"sets[0]: unknown set kind: cluster"})"));
  CHECK_EQ(refusal(importBody("ses_import01", 1'699'996'400'000, 1'699'992'800'000, {})),
           std::string(R"({"error":"finishedAt must be at or after startedAt"})"));
  CHECK_EQ(refusal(importBody("ses_import01", 1'699'992'800'000, 1'700'000'000'001, {})),
           std::string(R"({"error":"finishedAt cannot be in the future"})"));
  CHECK_EQ(refusal(outside),
           std::string(R"({"error":"sets[0] (set_import01): completedAt must be within the workout interval"})"));
  CHECK_EQ(refusal(unknownExercise),
           std::string(R"({"code":"unknown-exercise","error":"sets[0] (set_import01): no such exercise"})"));
  Json::Value tooMany = importBody("ses_import01", 1'699'992'800'000, 1'699'996'400'000, {});
  for (int i = 0; i < 201; ++i)
    tooMany["sets"].append(setBody("set_many" + std::to_string(1000 + i), "bench-press", 60, 1'699'993'400'000));
  CHECK_EQ(refusal(tooMany), std::string(R"({"error":"sets must contain 0 to 200 rows"})"));
  CHECK_EQ(idsIn("gym_sessions"), std::vector<std::string>{});
  CHECK(h.failures.messages.empty());
}

TEST(gym_import_replayed_after_the_workout_was_discarded_is_409_and_never_brings_it_back) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  const Json::Value body = importBody("ses_import01", 1'699'992'800'000, 1'699'996'400'000,
                                      {setBody("set_import01", "bench-press", 60, 1'699'993'400'000)});
  REQUIRE_EQ(sendImport(h, body)->getStatusCode(), drogon::k201Created);
  REQUIRE_EQ(h.door.discard(h.user, sid("ses_import01")), DiscardOutcome::done);

  drogon::HttpResponsePtr response = sendImport(h, body);

  CHECK_EQ(response->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"code":"session-deleted","error":"that workout was discarded"})"));
  CHECK_EQ(idsIn("gym_sessions"), std::vector<std::string>{});
  CHECK_EQ(idsIn("gym_sets"), std::vector<std::string>{});
  CHECK(h.failures.messages.empty());
}

TEST(gym_history_http_reads_whole_scope_and_rejects_malformed_filters) {
  Harness h;
  h.seedWorkout(h.signIn("history-cookie"), "ses_history01", 1'700'000'000'000, 2);
  auto request = getRequest("/v1/gym/history", "history-cookie");
  request->setParameter("limit", "1");
  const auto response = send(h.training, &TrainingApi::history, request);
  REQUIRE_EQ(response->statusCode(), drogon::k200OK);
  const auto body = bodyOf(response);
  CHECK_EQ(wm::dump(body["summary"]), "{\"reps\":16,\"sessions\":1,\"sets\":2,\"tonnageKg\":1320.0}");
  CHECK(body["next"].isNull());
  for (const auto& [name, value] : std::vector<std::pair<std::string,std::string>>{
      {"limit", "0"}, {"limit", "201"}, {"from", "bad"}, {"until", "0"},
      {"beforeId", "ses_history01"}, {"before", "1700000000000"}, {"exercise", "bad' OR true"}}) {
    auto invalid = getRequest("/v1/gym/history", "history-cookie");
    invalid->setParameter(name, value);
    CHECK_EQ(send(h.training, &TrainingApi::history, invalid)->statusCode(), drogon::k400BadRequest);
  }
  CHECK_EQ(send(h.training, &TrainingApi::history, getRequest("/v1/gym/history"))->statusCode(),
           drogon::k401Unauthorized);
}

TEST(gym_log_share_http_mints_replays_lists_revokes_and_never_exposes_private_fields) {
  Harness h;
  h.seedWorkout(h.signIn("share-cookie"), "ses_history01", 1'700'000'000'000, 1);
  h.repo.db.sets[0].note = "private medical details";
  const Json::Value input = wm::parse(R"({"id":"share_history01","mode":"snapshot","scope":"all"})");
  const auto created = send(h.training, &TrainingApi::createLogShare,
      postRequest("/v1/gym/log-shares", input, "share-cookie"));
  REQUIRE_EQ(created->statusCode(), drogon::k201Created);
  const auto share = bodyOf(created);
  const auto replay = send(h.training, &TrainingApi::createLogShare,
      postRequest("/v1/gym/log-shares", input, "share-cookie"));
  CHECK_EQ(wm::dump(bodyOf(replay)), wm::dump(share));
  CHECK_EQ(share["url"].asString(), "https://windmill.works/#/gym/shared-log/" + share["token"].asString());
  const auto publicRead = send(h.training, &TrainingApi::sharedHistory,
      getRequest("/v1/gym/shared-logs/" + share["token"].asString()), share["token"].asString());
  REQUIRE_EQ(publicRead->statusCode(), drogon::k200OK);
  CHECK_EQ(publicRead->getHeader("Cache-Control"), "no-store");
  const auto page = bodyOf(publicRead);
  CHECK_EQ(wm::dump(page["sessions"][0]),
      "{\"exerciseNames\":[\"Bench Press\"],\"finishedAt\":1700003600000,\"id\":\"ses_history01\",\"movements\":[{\"exerciseId\":\"bench-press\",\"reps\":8,\"sets\":1,\"tonnageKg\":660.0}],\"reps\":8,\"routineName\":\"\",\"setCount\":1,\"sets\":[{\"completedAt\":1700000060000,\"exercise\":\"Bench Press\",\"exerciseId\":\"bench-press\",\"id\":\"set_history011\",\"reps\":8,\"setNumber\":1,\"weightKg\":82.5}],\"startedAt\":1700000000000,\"tonnageKg\":660.0,\"workingSetCount\":1}");
  CHECK_EQ(wm::dump(page["share"]), wm::dump(wm::parse(
      "{\"createdAt\":" + share["createdAt"].asString() + ",\"expiresAt\":" + share["expiresAt"].asString() +
      ",\"mode\":\"snapshot\",\"scope\":\"all\"}")));
  const auto list = send(h.training, &TrainingApi::listLogShares,
      getRequest("/v1/gym/log-shares", "share-cookie"));
  REQUIRE_EQ(bodyOf(list)["shares"].size(), 1u);
  CHECK_EQ(wm::dump(bodyOf(list)["shares"][0]), wm::dump(share));
  CHECK_EQ(send(h.training, &TrainingApi::revokeLogShare,
      deleteRequest("/v1/gym/log-shares/share_history01", "share-cookie"),
      std::string{"share_history01"})->statusCode(), drogon::k204NoContent);
  const auto revoked = send(h.training, &TrainingApi::sharedHistory,
      getRequest("/v1/gym/shared-logs/" + share["token"].asString()), share["token"].asString());
  const auto absent = send(h.training, &TrainingApi::sharedHistory,
      getRequest("/v1/gym/shared-logs/absent"), std::string{"absent"});
  CHECK_EQ(revoked->statusCode(), drogon::k404NotFound);
  CHECK_EQ(wm::dump(bodyOf(revoked)), wm::dump(bodyOf(absent)));
  CHECK_EQ(send(h.training, &TrainingApi::createLogShare,
      postRequest("/v1/gym/log-shares", input, "share-cookie"))->statusCode(), drogon::k409Conflict);
}

// A phone's `gym.correctSession` keeps the frozen plan, clears what it names, and moves the read's tag, a rename alone included.
TEST(gym_atomic_correction_keeps_the_frozen_plan_clears_rpe_and_refreshes_the_name_etag) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  DoorApis h;
  h.clock.now = 1'700'000'100'000;
  REQUIRE_EQ(h.door.createRoutine(h.user, RoutineWrite{rtId("rt_original1"), "Original routine", 0, {benchEntry()}},
                                     ProposalDoor::mcp).error, RoutineWriteError::none);
  const SessionId id{"ses_correct01"};
  REQUIRE_EQ(h.door.importSession(h.user, SessionImport{id, 1'700'000'000'000, 1'700'000'003'000, rtId("rt_original1"),
      {SetWrite{setId("set_correct01"), ExerciseId{"bench-press"}, 80, 8, SetKind::working, 8, "private",
                1'700'000'001'000}}}).error, BatchLogError::none);
  const auto before = readSession(h.trainingApi, id.str(), "s-door");
  Json::Value correction = wm::parse(R"({"sessionId":"ses_correct01","requestId":"fix_correct01","startedAt":1700000000000,"finishedAt":1700000003000,"routineName":"Historical name","sets":[{"id":"set_correct01","exerciseId":"bench-press","setNumber":1,"weightKg":80,"reps":8,"rpe":null,"note":"","completedAt":1700000001000}]})");

  REQUIRE_EQ(GymDoor::refusal(h.door.command(h.user, "gym.correctSession", correction)), std::string());
  const auto after = readSession(h.trainingApi, id.str(), "s-door", before->getHeader("ETag"));

  CHECK_EQ(after->statusCode(), drogon::k200OK);
  CHECK(after->getHeader("ETag") != before->getHeader("ETag"));
  CHECK_EQ(dump(bodyOf(after)),
           std::string(R"({"session":{"finishedAt":1700000003000,"id":"ses_correct01",)"
                       R"("plan":{"entries":[{"exerciseId":"bench-press","restSeconds":180,)"
                       R"("sets":[{"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5}]}],"routine":"Original routine"},)"
                       R"("routineId":"rt_original1","routineName":"Historical name","startedAt":1700000000000},)"
                       R"("sets":[{"completedAt":1700000001000,"exerciseId":"bench-press","id":"set_correct01",)"
                       R"("kind":"working","note":"","reps":8,"setNumber":1,"weightKg":80.0}]})"));
  correction["requestId"] = "fix_correct02";
  correction["routineName"] = "Name only";
  REQUIRE_EQ(GymDoor::refusal(h.door.command(h.user, "gym.correctSession", correction)), std::string());
  const auto renamed = readSession(h.trainingApi, id.str(), "s-door", after->getHeader("ETag"));
  CHECK_EQ(renamed->statusCode(), drogon::k200OK);
  // An unknown set kind refuses the whole correction.
  correction["requestId"] = "fix_bad00001";
  correction["routineName"] = "Never lands";
  correction["sets"][0]["kind"] = "unknown";
  CHECK_EQ(GymDoor::refusal(h.door.command(h.user, "gym.correctSession", correction)), std::string("invalid"));
  CHECK_EQ(readSession(h.trainingApi, id.str(), "s-door", renamed->getHeader("ETag"))->statusCode(),
           drogon::k304NotModified);
  CHECK(h.failures.messages.empty());
}
