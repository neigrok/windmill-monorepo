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

// CatalogApi over the fake store: the catalog read and the record page.

TEST(gym_exercises_lists_the_catalog_in_pattern_then_name_order) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.catalog, &CatalogApi::listExercises, getRequest("/v1/gym/exercises", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"exercises":[)"
                       R"({"custom":false,"equipment":"barbell","id":"bench-press",)"
                       R"("name":"Bench Press","pattern":"press","stepKg":2.5},)"
                       R"({"custom":false,"equipment":"barbell","id":"back-squat",)"
                       R"("name":"Back Squat","pattern":"squat","stepKg":2.5}]})"));
}

TEST(gym_exercises_lists_a_movement_the_caller_created_in_its_place) {
  Harness h;
  h.repo.db.seedCustom(h.signIn("s-live"), Exercise{ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat,
                                                    Equipment::barbell, 2.5, true});

  drogon::HttpResponsePtr catalog =
      send(h.catalog, &CatalogApi::listExercises, getRequest("/v1/gym/exercises", "s-live"));

  CHECK_EQ(catalog->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(catalog)),
           std::string(R"({"exercises":[)"
                       R"({"custom":false,"equipment":"barbell","id":"bench-press",)"
                       R"("name":"Bench Press","pattern":"press","stepKg":2.5},)"
                       R"({"custom":false,"equipment":"barbell","id":"back-squat",)"
                       R"("name":"Back Squat","pattern":"squat","stepKg":2.5},)"
                       R"({"custom":true,"equipment":"barbell","id":"ex_11111111",)"
                       R"("name":"Zercher Squat","pattern":"squat","stepKg":2.5}]})"));
}

// A renamed movement reads under its new name with the old one beside it, which the picker searches.
TEST(gym_exercises_lists_the_names_a_movement_used_to_go_by) {
  Harness h;
  const UserId me = h.signIn("s-live");
  h.repo.db.displayNames.push_back({{me.str(), "back-squat"}, "Low-bar Squat"});
  h.repo.db.aliasRows.push_back(FakeGymStore::Alias{me.str(), "back-squat", "Back Squat", 1});

  drogon::HttpResponsePtr listed =
      send(h.catalog, &CatalogApi::listExercises, getRequest("/v1/gym/exercises", "s-live"));

  CHECK_EQ(listed->getStatusCode(), drogon::k200OK);
  // A movement nobody has renamed carries no alias key at all — omitted, never an empty array.
  CHECK_EQ(dump(bodyOf(listed)),
           std::string(R"({"exercises":[)"
                       R"({"custom":false,"equipment":"barbell","id":"bench-press",)"
                       R"("name":"Bench Press","pattern":"press","stepKg":2.5},)"
                       R"({"aliases":["Back Squat"],"custom":false,"equipment":"barbell",)"
                       R"("id":"back-squat","name":"Low-bar Squat","pattern":"squat",)"
                       R"("stepKg":2.5}]})"));
}

TEST(gym_record_answers_the_whole_page_in_one_read) {
  Harness h;
  h.seedWorkout(h.signIn("s-live"), "ses_11111111", 1'700'000'000'000, 4);

  drogon::HttpResponsePtr response =
      send(h.catalog, &CatalogApi::exerciseRecord,
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

TEST(gym_record_carries_the_days_that_name_the_movement_beside_their_count) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  h.repo.db.routineRows.push_back(Routine{rtId("rt_11111111"), caller, "Push A", 0, {benchEntry()}});
  h.repo.db.routineRows.push_back(
      Routine{rtId("rt_22222222"), caller, "Legs", 1, {benchEntry(), benchEntry(2)}});
  h.seedWorkout(caller, "ses_11111111", 1'700'000'000'000, 4);

  drogon::HttpResponsePtr response =
      send(h.catalog, &CatalogApi::exerciseRecord,
           getRequest("/v1/gym/exercises/bench-press/record", "s-live"), "bench-press");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(response)["routineCount"].asInt(), 2);
  CHECK_EQ(dump(bodyOf(response)["routines"]), std::string(R"(["Push A","Legs"])"));
  CHECK_EQ(bodyOf(response)["sessionCount"].asInt(), 1);
}

TEST(gym_record_of_a_movement_never_lifted_omits_every_list) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.catalog, &CatalogApi::exerciseRecord,
           getRequest("/v1/gym/exercises/back-squat/record", "s-live"), "back-squat");
  drogon::HttpResponsePtr unknown =
      send(h.catalog, &CatalogApi::exerciseRecord, getRequest("/v1/gym/exercises/no-such/record", "s-live"),
           "no-such");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"exercise":{"custom":false,"equipment":"barbell","id":"back-squat",)"
                       R"("name":"Back Squat","pattern":"squat","stepKg":2.5},)"
                       R"("routineCount":0,"sessionCount":0})"));
  CHECK_EQ(unknown->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(unknown)), std::string(R"({"error":"no such movement"})"));
}
