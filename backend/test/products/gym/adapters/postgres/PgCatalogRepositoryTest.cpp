#include "products/gym/adapters/postgres/PgCatalogRepository.h"
#include "products/gym/adapters/postgres/PgLogRepository.h"
#include "products/gym/adapters/postgres/PgProgramRepository.h"

#include "test/products/gym/adapters/postgres/PgGymFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <cstdlib>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// The catalog's store against a real server: the 64-row seed, the one create, and the rename.
using namespace wm::gym;
using namespace wm::gym::pgtest;

TEST(pg_gym_catalog_serves_the_seeded_64_in_pattern_then_name_order) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgCatalogRepository repo{wm::pgTestPool()};

  std::vector<Exercise> catalog = repo.catalog(wm::UserId{kUser});

  REQUIRE_EQ(catalog.size(), static_cast<std::size_t>(64));
  CHECK_EQ(catalog.front(), Exercise(ExerciseId{"farmers-carry"}, "Farmers Carry", Pattern::carry,
                                     Equipment::dumbbell, 2.0, false));
  CHECK_EQ(catalog.back(), Exercise(ExerciseId{"walking-lunge"}, "Walking Lunge", Pattern::squat,
                                    Equipment::dumbbell, 2.0, false));
}

TEST(pg_gym_create_exercise_is_the_callers_alone_and_a_spent_id_is_refused) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgCatalogRepository repo{wm::pgTestPool()};
  PgLogRepository log{wm::pgTestPool()};
  PgProgramRepository program{wm::pgTestPool()};
  const Exercise mine{ExerciseId{"pg-zercher-squat"}, "Zercher Squat", Pattern::squat,
                      Equipment::machine, 5.0, true};

  ExerciseInsertOutcome created = repo.insertExercise(wm::UserId{kUser}, mine);
  ExerciseInsertOutcome replayed = repo.insertExercise(
      wm::UserId{kUser}, Exercise{ExerciseId{"pg-zercher-squat"}, "Renamed mid-flight",
                                  Pattern::squat, Equipment::machine, 5.0, true});
  ExerciseInsertOutcome theirs = repo.insertExercise(
      wm::UserId{kOther}, Exercise{ExerciseId{"pg-zercher-squat"}, "Theirs", Pattern::squat,
                                   Equipment::machine, 5.0, true});
  ExerciseInsertOutcome seedSlug = repo.insertExercise(
      wm::UserId{kUser}, Exercise{ExerciseId{"bench-press"}, "My Bench", Pattern::press,
                                  Equipment::barbell, 2.5, true});

  CHECK(created.error == ExerciseInsertError::none);
  CHECK_EQ(created.exercise, std::optional<Exercise>(mine));
  CHECK(replayed.error == ExerciseInsertError::none);
  CHECK_EQ(replayed.exercise, std::optional<Exercise>(mine));   // the stored row, name and all
  CHECK(theirs.error == ExerciseInsertError::idTaken);
  CHECK_EQ(theirs.exercise, std::optional<Exercise>());
  CHECK(seedSlug.error == ExerciseInsertError::idTaken);
  // It is theirs alone: 64 seeds plus this one for the owner, 64 flat for everybody else.
  CHECK_EQ(repo.catalog(wm::UserId{kUser}).size(), static_cast<std::size_t>(65));
  CHECK_EQ(repo.catalog(wm::UserId{kOther}).size(), static_cast<std::size_t>(64));
  log.insertSession(sessionAt("ses_pg000001", 1'700'000'000'123));
  CHECK(log.insertSet(Set{SetId{"set_pg000001"}, SessionId{"ses_pg000001"},
                           ExerciseId{"pg-zercher-squat"}, 0, 60.0, 8, SetKind::working,
                           std::nullopt, "", 1'700'000'001'123})
            .error == SetInsertError::none);
  CHECK(inserted(program, routineAt("rt_pg000001", "Push A", {entryAt(1, "pg-zercher-squat")}))
            .error == RoutineWriteError::none);
}

// The domain's step band is the column's band: 99.99 and 0.01 store and read back unchanged.
TEST(pg_gym_the_step_band_the_domain_enforces_is_exactly_what_the_column_holds) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgCatalogRepository repo{wm::pgTestPool()};
  const Exercise ceiling{ExerciseId{"pg-heavy-step"}, "Heavy Step", Pattern::squat,
                         Equipment::machine, kMaxStepKg, true};
  const Exercise floorStep{ExerciseId{"pg-fine-step"}, "Fine Step", Pattern::isolation,
                           Equipment::cable, kMinStepKg, true};

  ExerciseInsertOutcome top = repo.insertExercise(wm::UserId{kUser}, ceiling);
  ExerciseInsertOutcome fine = repo.insertExercise(wm::UserId{kUser}, floorStep);

  CHECK(top.error == ExerciseInsertError::none);
  CHECK_EQ(top.exercise, std::optional<Exercise>(ceiling));
  CHECK_EQ(top.exercise->stepKg, 99.99);
  CHECK(fine.error == ExerciseInsertError::none);
  CHECK_EQ(fine.exercise->stepKg, 0.01);
  // What the domain refuses is what the column would have raised on, proved by the statement itself.
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    bool overflowed = false;
    try {
      w.exec_params("INSERT INTO gym_exercises (id, name, pattern, equipment, step_kg, created_by) "
                    "VALUES ($1, $2, 'squat', 'barbell', $3, $4::uuid)",
                    "pg-overflow-step", "Overflow Step", 100.0, kUser);
    } catch (const pqxx::data_exception&) {
      overflowed = true;
    }
    CHECK(overflowed);
  }
}

// The 64 seeds are GLOBAL rows, so a rename may not touch gym_exercises: the other account is untouched.
TEST(pg_gym_renaming_a_seed_is_one_accounts_alone_and_leaves_the_global_row_untouched) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgCatalogRepository repo{wm::pgTestPool()};

  const std::optional<Exercise> renamed =
      repo.renameExercise(wm::UserId{kUser}, ExerciseId{"back-squat"}, "Low-bar Squat");

  REQUIRE(renamed.has_value());
  CHECK_EQ(renamed->id, ExerciseId{"back-squat"});      // the id never moves
  CHECK_EQ(renamed->name, std::string("Low-bar Squat"));
  CHECK_EQ(renamed->custom, false);
  bool mine = false;
  for (const Exercise& row : repo.catalog(wm::UserId{kUser}))
    if (row.id == ExerciseId{"back-squat"} && row.name == "Low-bar Squat") mine = true;
  bool theirs = false;
  for (const Exercise& row : repo.catalog(wm::UserId{kOther}))
    if (row.id == ExerciseId{"back-squat"} && row.name == "Back Squat") theirs = true;
  CHECK(mine);
  CHECK(theirs);
  wm::PgLease conn{*wm::pgTestPool()};
  pqxx::work txn{*conn};
  CHECK_EQ(txn.exec_params("SELECT name FROM gym_exercises WHERE id = 'back-squat'")[0][0]
               .as<std::string>(),
           std::string("Back Squat"));
}

// A movement the caller CREATED is their own row and renames in place — no line beside it.
TEST(pg_gym_renaming_your_own_movement_edits_its_row_and_clearing_a_seeds_name_drops_the_line) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgCatalogRepository repo{wm::pgTestPool()};
  repo.insertExercise(wm::UserId{kUser},
                      Exercise{ExerciseId{"ex_pg000001"}, "Zercher Squat", Pattern::squat,
                               Equipment::barbell, 2.5, true});

  const std::optional<Exercise> own =
      repo.renameExercise(wm::UserId{kUser}, ExerciseId{"ex_pg000001"}, "Zercher");
  repo.renameExercise(wm::UserId{kUser}, ExerciseId{"back-squat"}, "Low-bar Squat");
  // Typed back with a stray space: the entity trims before anything compares, so this is the seed's own name.
  const std::optional<Exercise> restored =
      repo.renameExercise(wm::UserId{kUser}, ExerciseId{"back-squat"}, " Back Squat ");

  REQUIRE(own.has_value());
  CHECK_EQ(own->name, std::string("Zercher"));
  CHECK_EQ(own->custom, true);
  REQUIRE(restored.has_value());
  CHECK_EQ(restored->name, std::string("Back Squat"));
  wm::PgLease conn{*wm::pgTestPool()};
  pqxx::work txn{*conn};
  CHECK_EQ(txn.exec_params("SELECT count(*)::int FROM gym_exercise_names WHERE user_id = $1::uuid",
                           kUser)[0][0]
               .as<int>(),
           0);
  CHECK_EQ(repo.renameExercise(wm::UserId{kOther}, ExerciseId{"ex_pg000001"}, "Mine"),
           std::optional<Exercise>());
  CHECK_EQ(repo.renameExercise(wm::UserId{kUser}, ExerciseId{"no-such"}, "Mine"),
           std::optional<Exercise>());
}

// The old name is kept as an alias, renaming BACK takes it off the list, and the list is capped.
TEST(pg_gym_a_rename_keeps_the_old_name_as_an_alias_and_renaming_back_takes_it_off) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgCatalogRepository repo{wm::pgTestPool()};
  repo.insertExercise(wm::UserId{kUser},
                      Exercise{ExerciseId{"ex_pg000001"}, "Hammer row", Pattern::pull,
                               Equipment::machine, 2.5, true});

  const std::optional<Exercise> renamed =
      repo.renameExercise(wm::UserId{kUser}, ExerciseId{"back-squat"}, "Low-bar Squat");
  const std::optional<Exercise> own =
      repo.renameExercise(wm::UserId{kUser}, ExerciseId{"ex_pg000001"}, "The slanty one");

  REQUIRE(renamed.has_value());
  CHECK_EQ(renamed->aliases, std::vector<std::string>{"Back Squat"});
  REQUIRE(own.has_value());
  CHECK_EQ(own->aliases, std::vector<std::string>{"Hammer row"});
  for (const Exercise& row : repo.catalog(wm::UserId{kUser})) {
    if (row.id == ExerciseId{"back-squat"})
      CHECK_EQ(row.aliases, std::vector<std::string>{"Back Squat"});
    if (row.id == ExerciseId{"ex_pg000001"})
      CHECK_EQ(row.aliases, std::vector<std::string>{"Hammer row"});
  }
  for (const Exercise& row : repo.catalog(wm::UserId{kOther}))
    if (row.id == ExerciseId{"back-squat"}) CHECK(row.aliases.empty());

  // Renamed BACK: `Back Squat` is what the movement IS again, and the name it wore in between is the memory.
  const std::optional<Exercise> back =
      repo.renameExercise(wm::UserId{kUser}, ExerciseId{"back-squat"}, "Back Squat");
  REQUIRE(back.has_value());
  CHECK_EQ(back->aliases, std::vector<std::string>{"Low-bar Squat"});

  // The cap: a lifter who tries eight names keeps the newest five, oldest dropped first.
  for (const std::string& tried : {"One", "Two", "Three", "Four", "Five", "Six", "Seven"})
    repo.renameExercise(wm::UserId{kUser}, ExerciseId{"back-squat"}, tried);
  const std::optional<Exercise> tried =
      repo.renameExercise(wm::UserId{kUser}, ExerciseId{"back-squat"}, "Eight");
  REQUIRE(tried.has_value());
  CHECK_EQ(tried->aliases,
           (std::vector<std::string>{"Seven", "Six", "Five", "Four", "Three"}));
}

// Every read that prints a movement name reads the CALLER's name for it, the coach share resolving against the workout's OWNER.
TEST(pg_gym_every_read_that_names_a_movement_names_it_as_the_caller_does) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgCatalogRepository repo{wm::pgTestPool()};
  PgLogRepository log{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'000;

  log.insertSession(sessionAt("ses_pg000001", t1));
  log.insertSet(squatSet("set_pg000001", "ses_pg000001", 100, 5, t1 + 1'000));
  log.close(SessionId{"ses_pg000001"}, t1 + 2'000, ClosedBy::finish);
  repo.renameExercise(wm::UserId{kUser}, ExerciseId{"back-squat"}, "Low-bar Squat");
  log.insertShare(SessionShare{SessionId{"ses_pg000001"}, wm::UserId{kUser}, "tok_pg000001",
                                t1 + 30ull * 86'400'000},
                   t1);

  const std::vector<SessionSummary> listed = pageOf(log, wm::UserId{kUser}, page(t1 + 9'000, 50));
  const std::vector<ExportedSet> exported = log.exportedSets(wm::UserId{kUser});
  const std::optional<SharedSession> shared = log.sharedSession("tok_pg000001", t1 + 1);

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].exerciseNames, std::vector<std::string>{"Low-bar Squat"});
  REQUIRE_EQ(exported.size(), static_cast<std::size_t>(1));
  CHECK_EQ(exported[0].exerciseName, std::string("Low-bar Squat"));
  CHECK_EQ(exported[0].exerciseId, std::string("back-squat"));   // the id in the file never moved
  REQUIRE(shared.has_value());
  REQUIRE_EQ(shared->sets.size(), static_cast<std::size_t>(1));
  CHECK_EQ(shared->sets[0].exercise, std::string("Low-bar Squat"));
}
