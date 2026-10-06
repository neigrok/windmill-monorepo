#include "products/gym/adapters/postgres/PgCatalogRepository.h"

#include "test/products/gym/sync/adapters/postgres/GymDoorFixture.h"
#include "test/products/gym/adapters/postgres/PgGymFixture.h"
#include "test/testing.h"

#include "platform/adapters/json/JsonText.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <cstdlib>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// The catalog's store against a real server: the 64-row seed, MCP's create and a phone's rename.
using namespace wm;
using namespace wm::gym;
using namespace wm::gym::pgtest;

namespace {

// A phone's rename: a custom movement's own record, or the account's line over a seed.
Json::Value phoneRename(doortest::Harness& h, const UserId& owner, const std::string& id, const std::string& name,
                        bool seed = false) {
  Json::Value fields(Json::objectValue);
  fields["name"] = name;
  return h.admit(owner, {GymDoor::delta(seed ? "exerciseName" : "exercise", id, fields)});
}

Exercise movementOf(const std::vector<Exercise>& catalog, const std::string& id) {
  const auto found = std::find_if(catalog.begin(), catalog.end(),
                                  [&](const Exercise& exercise) { return exercise.id == ExerciseId{id}; });
  if (found == catalog.end()) throw std::runtime_error("the catalog holds no " + id);
  return *found;
}

Exercise named(Exercise exercise, const std::string& name, std::vector<std::string> aliases) {
  exercise.name = name;
  exercise.aliases = std::move(aliases);
  return exercise;
}

}  // namespace

TEST(pg_gym_catalog_serves_the_seeded_64_in_pattern_then_name_order) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgCatalogRepository repo{pgTestPool()};

  std::vector<Exercise> catalog = repo.catalog(UserId{kUser});

  REQUIRE_EQ(catalog.size(), static_cast<std::size_t>(64));
  CHECK_EQ(catalog.front(), Exercise(ExerciseId{"farmers-carry"}, "Farmers Carry", Pattern::carry,
                                     Equipment::dumbbell, 2.0, false));
  CHECK_EQ(catalog.back(), Exercise(ExerciseId{"walking-lunge"}, "Walking Lunge", Pattern::squat,
                                    Equipment::dumbbell, 2.0, false));
}

TEST(pg_gym_create_exercise_is_the_callers_alone_and_a_spent_id_is_refused) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Exercise mine{ExerciseId{"pg-zercher-squat"}, "Zercher Squat", Pattern::squat, Equipment::machine, 5.0, true};

  const ExerciseInsertOutcome created = h.door.createExercise(
      h.user, ExerciseWrite{mine.id, mine.name, Pattern::squat, Equipment::machine, 5.0});
  const ExerciseInsertOutcome replayed = h.door.createExercise(
      h.user, ExerciseWrite{mine.id, "Renamed mid-flight", Pattern::squat, Equipment::machine, 5.0});
  const ExerciseInsertOutcome theirs = h.door.createExercise(
      h.other, ExerciseWrite{mine.id, "Theirs", Pattern::squat, Equipment::machine, 5.0});
  const ExerciseInsertOutcome seedSlug = h.door.createExercise(
      h.user, ExerciseWrite{ExerciseId{"bench-press"}, "My Bench", Pattern::press, Equipment::barbell, 2.5});

  CHECK(created.error == ExerciseInsertError::none);
  CHECK_EQ(created.exercise, std::optional<Exercise>(mine));
  CHECK(replayed.error == ExerciseInsertError::none);
  CHECK_EQ(replayed.exercise, std::optional<Exercise>(mine));   // the stored row, name and all
  CHECK(theirs.error == ExerciseInsertError::idTaken);
  CHECK_EQ(theirs.exercise, std::optional<Exercise>());
  CHECK(seedSlug.error == ExerciseInsertError::idTaken);
  // It is theirs alone: the seeds plus this one for the owner, the seeds flat for everybody else.
  const std::vector<Exercise> seeds = h.repo.catalog.catalog(h.other);
  CHECK(std::none_of(seeds.begin(), seeds.end(), [](const Exercise& exercise) { return exercise.custom; }));
  std::vector<Exercise> owned;
  std::vector<Exercise> seen;
  for (const Exercise& exercise : h.repo.catalog.catalog(h.user)) (exercise.custom ? owned : seen).push_back(exercise);
  CHECK_EQ(owned, std::vector<Exercise>{mine});
  CHECK_EQ(seen, seeds);
  REQUIRE(h.door.start(h.user, SessionStart{SessionId{"ses_pg000001"}, kNow, false, std::nullopt}).session);
  CHECK(h.door.append(h.user, SessionId{"ses_pg000001"},
                          SetWrite{SetId{"set_pg000001"}, mine.id, 60.0, 8, SetKind::working, std::nullopt, "", kNow})
            .error == AppendError::none);
  CHECK(h.door.createRoutine(h.user, RoutineWrite{RoutineId{"rt_pg000001"}, "Push A", 0,
                                                     {entryAt(1, "pg-zercher-squat")}},
                                ProposalDoor::mcp)
            .error == RoutineWriteError::none);
}

// The domain's step band is the column's band: 99.99 and 0.01 store and read back unchanged.
TEST(pg_gym_the_step_band_the_domain_enforces_is_exactly_what_the_column_holds) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Exercise ceiling{ExerciseId{"pg-heavy-step"}, "Heavy Step", Pattern::squat, Equipment::machine, kMaxStepKg, true};
  const Exercise floorStep{ExerciseId{"pg-fine-step"}, "Fine Step", Pattern::isolation, Equipment::cable, kMinStepKg, true};

  const ExerciseInsertOutcome top = h.door.createExercise(
      h.user, ExerciseWrite{ceiling.id, ceiling.name, Pattern::squat, Equipment::machine, kMaxStepKg});
  const ExerciseInsertOutcome fine = h.door.createExercise(
      h.user, ExerciseWrite{floorStep.id, floorStep.name, Pattern::isolation, Equipment::cable, kMinStepKg});

  CHECK(top.error == ExerciseInsertError::none);
  REQUIRE_EQ(top.exercise, std::optional<Exercise>(ceiling));
  CHECK_EQ(top.exercise->stepKg, 99.99);
  CHECK(fine.error == ExerciseInsertError::none);
  REQUIRE_EQ(fine.exercise, std::optional<Exercise>(floorStep));
  CHECK_EQ(fine.exercise->stepKg, 0.01);
  // What the domain refuses is what the column would have raised on, proved by the statement itself.
  PgLease lease{*doortest::pool()};
  pqxx::work txn{*lease};
  bool overflowed = false;
  try {
    txn.exec("INSERT INTO gym_exercises (id, name, pattern, equipment, step_kg, created_by) "
             "VALUES ($1, $2, 'squat', 'barbell', $3, $4::uuid)",
             pqxx::params{"pg-overflow-step", "Overflow Step", 100.0, h.user.str()});
  } catch (const pqxx::data_exception&) {
    overflowed = true;
  }
  CHECK(overflowed);
}

// A seed is a GLOBAL row, so a rename is the account's own line over it and nobody else's.
TEST(pg_gym_renaming_a_seed_is_one_accounts_alone_and_leaves_the_global_row_untouched) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Exercise seed = movementOf(h.repo.catalog.catalog(h.other), "back-squat");

  CHECK_EQ(GymDoor::refusal(phoneRename(h, h.user, "back-squat", "Low-bar Squat", true)), "");

  // The id never moves.
  CHECK_EQ(movementOf(h.repo.catalog.catalog(h.user), "back-squat"), named(seed, "Low-bar Squat", {"Back Squat"}));
  CHECK_EQ(movementOf(h.repo.catalog.catalog(h.other), "back-squat"), seed);
  CHECK_EQ(seed, named(seed, "Back Squat", {}));
  PgLease lease{*doortest::pool()};
  pqxx::work txn{*lease};
  CHECK_EQ(txn.exec("SELECT name FROM gym_exercises WHERE id = 'back-squat'")[0][0].as<std::string>(),
           std::string("Back Squat"));
}

// A movement the caller CREATED renames in place; a seed renamed back to its own name keeps the line.
TEST(pg_gym_renaming_your_own_movement_edits_its_row_and_a_seed_renamed_back_keeps_its_line) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Exercise zercher = h.door.createExercise(
      h.user, ExerciseWrite{ExerciseId{"ex_pg000001"}, "Zercher Squat", Pattern::squat, Equipment::barbell, 2.5})
      .exercise.value();
  const Exercise seed = movementOf(h.repo.catalog.catalog(h.user), "back-squat");

  CHECK_EQ(GymDoor::refusal(phoneRename(h, h.user, "ex_pg000001", "Zercher")), "");
  CHECK_EQ(GymDoor::refusal(phoneRename(h, h.user, "back-squat", "Low-bar Squat", true)), "");
  CHECK_EQ(GymDoor::refusal(phoneRename(h, h.user, "back-squat", "Back Squat", true)), "");

  CHECK_EQ(movementOf(h.repo.catalog.catalog(h.user), "ex_pg000001"), named(zercher, "Zercher", {"Zercher Squat"}));
  CHECK_EQ(movementOf(h.repo.catalog.catalog(h.user), "back-squat"), named(seed, "Back Squat", {"Low-bar Squat"}));
  {
    PgLease lease{*doortest::pool()};
    pqxx::work txn{*lease};
    CHECK_EQ(txn.exec("SELECT count(*)::int FROM gym_exercise_names WHERE user_id = $1::uuid",
                      pqxx::params{h.user.str()})[0][0].as<int>(),
             1);
  }
  CHECK_EQ(phoneRename(h, h.other, "ex_pg000001", "Mine"), parse(R"({"s":"refused","code":"unknown-record"})"));
  CHECK_EQ(phoneRename(h, h.user, "ex_pg000404", "Mine"), parse(R"({"s":"refused","code":"unknown-record"})"));
  CHECK_EQ(movementOf(h.repo.catalog.catalog(h.user), "ex_pg000001"), named(zercher, "Zercher", {"Zercher Squat"}));
}

// The old name is kept as an alias, renaming BACK takes it off the list, and the list is capped.
TEST(pg_gym_a_rename_keeps_the_old_name_as_an_alias_and_renaming_back_takes_it_off) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Exercise hammer = h.door.createExercise(
      h.user, ExerciseWrite{ExerciseId{"ex_pg000001"}, "Hammer row", Pattern::pull, Equipment::machine, 2.5})
      .exercise.value();
  const Exercise seed = movementOf(h.repo.catalog.catalog(h.user), "back-squat");

  GymDoor::requireOk(phoneRename(h, h.user, "back-squat", "Low-bar Squat", true));
  GymDoor::requireOk(phoneRename(h, h.user, "ex_pg000001", "The slanty one"));

  CHECK_EQ(movementOf(h.repo.catalog.catalog(h.user), "back-squat"), named(seed, "Low-bar Squat", {"Back Squat"}));
  CHECK_EQ(movementOf(h.repo.catalog.catalog(h.user), "ex_pg000001"), named(hammer, "The slanty one", {"Hammer row"}));
  CHECK_EQ(movementOf(h.repo.catalog.catalog(h.other), "back-squat"), seed);

  // Renamed BACK: `Back Squat` is what the movement IS again, and the name it wore in between is the memory.
  GymDoor::requireOk(phoneRename(h, h.user, "back-squat", "Back Squat", true));
  CHECK_EQ(movementOf(h.repo.catalog.catalog(h.user), "back-squat"), named(seed, "Back Squat", {"Low-bar Squat"}));

  // The cap: a lifter who tries eight names keeps the newest five, oldest dropped first.
  for (const std::string& tried : {"One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"})
    GymDoor::requireOk(phoneRename(h, h.user, "back-squat", tried, true));
  CHECK_EQ(movementOf(h.repo.catalog.catalog(h.user), "back-squat"),
           named(seed, "Eight", {"Seven", "Six", "Five", "Four", "Three"}));
}

// A blank name the store holds reads as stored, on the catalog and on the movement's record: never a 500.
TEST(pg_gym_a_blank_stored_movement_name_reads_as_stored) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  REQUIRE(h.door.createExercise(
      h.user, ExerciseWrite{ExerciseId{"ex_pg000001"}, "Sled push", Pattern::carry, Equipment::machine, 5.0}).exercise);
  GymDoor::requireOk(phoneRename(h, h.user, "back-squat", "Low-bar Squat", true));
  {
    PgLease lease{*doortest::pool()};
    pqxx::work txn{*lease};
    txn.exec("UPDATE gym_exercises SET name = '   ' WHERE id = 'ex_pg000001'");
    txn.exec("UPDATE gym_exercise_names SET name = $2 WHERE user_id = $1::uuid AND exercise_id = 'back-squat'",
             pqxx::params{h.user.str(), "\xC2\xA0"});   // U+00A0, past the ASCII trim
    txn.commit();
  }
  const Exercise sled{Stored{}, ExerciseId{"ex_pg000001"}, "", Pattern::carry, Equipment::machine, 5.0, true};
  const Exercise squat{Stored{}, ExerciseId{"back-squat"}, "\xC2\xA0", Pattern::squat, Equipment::barbell, 2.5, false,
                       {"Back Squat"}};

  const std::vector<Exercise> catalog = h.repo.catalog.catalog(h.user);

  CHECK_EQ(catalog.size(), static_cast<std::size_t>(65));
  CHECK_EQ(movementOf(catalog, "ex_pg000001"), sled);
  CHECK_EQ(movementOf(catalog, "back-squat"), squat);
  CHECK_EQ(h.training.movementRecord(h.user, ExerciseId{"ex_pg000001"}),
           std::optional<MovementRecord>(MovementRecord{sled, {}, 0, std::nullopt, std::nullopt, {}, {}, {}}));
  CHECK_EQ(h.training.movementRecord(h.user, ExerciseId{"back-squat"}),
           std::optional<MovementRecord>(MovementRecord{squat, {}, 0, std::nullopt, std::nullopt, {}, {}, {}}));
}

// Every read prints the CALLER's name for a movement; a workout share resolves against its OWNER.
TEST(pg_gym_every_read_that_names_a_movement_names_it_as_the_caller_does) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const std::uint64_t t1 = kNow;
  h.clock.now = t1 + 2'000;
  REQUIRE(h.door.start(h.user, SessionStart{SessionId{"ses_pg000001"}, t1, false, std::nullopt}).session);
  REQUIRE(h.door.append(h.user, SessionId{"ses_pg000001"},
                            SetWrite{SetId{"set_pg000001"}, ExerciseId{"back-squat"}, 100, 5, SetKind::working,
                                     std::nullopt, "", t1 + 1'000})
              .set);
  REQUIRE(h.door.finish(h.user, SessionId{"ses_pg000001"}, t1 + 2'000).session);
  GymDoor::requireOk(phoneRename(h, h.user, "back-squat", "Low-bar Squat", true));
  h.repo.log.insertShare(SessionShare{SessionId{"ses_pg000001"}, h.user, "tok_pg000001", t1 + 30ull * 86'400'000}, t1);

  const std::vector<SessionSummary> listed = pageOf(h.repo.log, h.user, page(t1 + 9'000, 50));
  const std::vector<Set> logged = h.repo.log.setsOf(SessionId{"ses_pg000001"});
  const std::optional<SharedSession> shared = h.repo.log.sharedSession("tok_pg000001", t1 + 1);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].exerciseNames, std::vector<std::string>{"Low-bar Squat"});
  REQUIRE_EQ(logged.size(), static_cast<std::size_t>(1));
  CHECK_EQ(logged[0].exercise, ExerciseId{"back-squat"});   // the id under the set never moved
  REQUIRE(shared.has_value());
  REQUIRE_EQ(shared->sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(shared->sets[0].exercise, std::string("Low-bar Squat"));
}
