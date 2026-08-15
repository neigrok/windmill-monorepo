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

// CatalogApi over the fake store: the catalog read, the one write, the rename, and a movement's
// record page.

// ---- the catalog --------------------------------------------------------------------------

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

// ---- the catalog's one write -----------------------------------------------------------------

TEST(gym_create_exercise_takes_the_equipments_step_and_joins_the_callers_catalog) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr created = send(h.catalog, &CatalogApi::createExercise,
                                         postRequest("/v1/gym/exercises", exerciseBody(), "s-live"));
  drogon::HttpResponsePtr catalog =
      send(h.catalog, &CatalogApi::listExercises, getRequest("/v1/gym/exercises", "s-live"));

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
      send(h.catalog, &CatalogApi::createExercise,
           postRequest("/v1/gym/exercises", exerciseBody("bench-press", "My Bench"), "s-live"));
  drogon::HttpResponsePtr shortId =
      send(h.catalog, &CatalogApi::createExercise,
           postRequest("/v1/gym/exercises", exerciseBody("ex_1"), "s-live"));
  Json::Value unknownPattern = exerciseBody("ex_22222222");
  unknownPattern["pattern"] = "legs";
  drogon::HttpResponsePtr badPattern = send(
      h.catalog, &CatalogApi::createExercise, postRequest("/v1/gym/exercises", unknownPattern, "s-live"));

  CHECK_EQ(seedSlug->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(dump(bodyOf(seedSlug)),
           std::string(R"({"code":"exercise-id-taken","error":"that movement id is taken"})"));
  // A created movement's id is client-minted, so it obeys the one id-shape rule the seeds predate.
  CHECK_EQ(shortId->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(shortId)), std::string(R"({"error":"could not read that movement"})"));
  CHECK_EQ(badPattern->getStatusCode(), drogon::k400BadRequest);
  CHECK(h.repo.db.customs.empty());
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
        send(h.catalog, &CatalogApi::createExercise, postRequest("/v1/gym/exercises", body, "s-live"));
    CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"could not read that movement"})"));
  }
  CHECK(h.repo.db.customs.empty());

  drogon::HttpResponsePtr stored =
      send(h.catalog, &CatalogApi::createExercise, postRequest("/v1/gym/exercises", theCeiling, "s-live"));
  CHECK_EQ(stored->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(stored)["stepKg"].asDouble(), 99.99);
}

// ---- the rename, and a movement's record ----------------------------------------------------

// The whole reply, byte for byte: the id has NOT moved, which is the promise the rename exists to
// demonstrate, and only the name did.
TEST(gym_rename_answers_the_movement_under_its_new_name_and_its_unchanged_id) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      send(h.catalog, &CatalogApi::renameExercise,
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
      send(h.catalog, &CatalogApi::renameExercise,
           patchRequest("/v1/gym/exercises/back-squat", renameBody(), "s-live"), "back-squat");
  drogon::HttpResponsePtr listed =
      send(h.catalog, &CatalogApi::listExercises, getRequest("/v1/gym/exercises", "s-live"));
  drogon::HttpResponsePtr back =
      send(h.catalog, &CatalogApi::renameExercise,
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
      send(h.catalog, &CatalogApi::renameExercise,
           patchRequest("/v1/gym/exercises/back-squat", body, "s-live"), "back-squat");
  drogon::HttpResponsePtr empty =
      send(h.catalog, &CatalogApi::renameExercise,
           patchRequest("/v1/gym/exercises/back-squat", renameBody(""), "s-live"), "back-squat");

  drogon::HttpResponsePtr blank =
      send(h.catalog, &CatalogApi::renameExercise,
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
      send(h.catalog, &CatalogApi::renameExercise,
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

// THE RENAME SHEET'S PROOF (§N32), and every number in it comes off THIS read: how many sessions
// hold the movement, how many PRs it has earned and the best estimate standing, and the days of the
// program that name it BY NAME. One read, so a sheet cannot assemble `34 sessions` from one call
// and `Push A · Legs` from another and show a lifter a torn claim about their own history.
TEST(gym_record_carries_the_days_that_name_the_movement_beside_their_count) {
  Harness h;
  const UserId caller = h.signIn("s-live");
  h.repo.db.routineRows.push_back(Routine{rtId("rt_11111111"), caller, "Push A", 0, {benchEntry()}});
  h.repo.db.routineRows.push_back(
      Routine{rtId("rt_22222222"), caller, "Legs", 1, {benchEntry(), benchEntry(2)}});
  trainedThrough(h, "s-live", "ses_11111111", 1'700'000'000'000, 4);

  drogon::HttpResponsePtr response =
      send(h.catalog, &CatalogApi::exerciseRecord,
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
