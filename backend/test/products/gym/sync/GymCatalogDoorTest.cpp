#include "test/products/gym/sync/GymDoorFixture.h"
#include "test/testing.h"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::doortest;

namespace {

// The catalog seed schema.sql writes, in the order every account reads it: by pattern, then by name.
std::vector<Exercise> seedCatalog() {
  return {
      {ExerciseId{"farmers-carry"}, "Farmers Carry", Pattern::carry, Equipment::dumbbell, 2.0, false},
      {ExerciseId{"overhead-carry"}, "Overhead Carry", Pattern::carry, Equipment::dumbbell, 2.0, false},
      {ExerciseId{"suitcase-carry"}, "Suitcase Carry", Pattern::carry, Equipment::dumbbell, 2.0, false},
      {ExerciseId{"ab-wheel-rollout"}, "Ab Wheel Rollout", Pattern::core, Equipment::bodyweight, 2.5, false},
      {ExerciseId{"cable-crunch"}, "Cable Crunch", Pattern::core, Equipment::cable, 2.5, false},
      {ExerciseId{"hanging-leg-raise"}, "Hanging Leg Raise", Pattern::core, Equipment::bodyweight, 2.5, false},
      {ExerciseId{"pallof-press"}, "Pallof Press", Pattern::core, Equipment::cable, 2.5, false},
      {ExerciseId{"plank"}, "Plank", Pattern::core, Equipment::bodyweight, 2.5, false},
      {ExerciseId{"weighted-sit-up"}, "Weighted Sit Up", Pattern::core, Equipment::bodyweight, 2.5, false},
      {ExerciseId{"back-extension"}, "Back Extension", Pattern::hinge, Equipment::bodyweight, 2.5, false},
      {ExerciseId{"deadlift"}, "Deadlift", Pattern::hinge, Equipment::barbell, 2.5, false},
      {ExerciseId{"good-morning"}, "Good Morning", Pattern::hinge, Equipment::barbell, 2.5, false},
      {ExerciseId{"hip-thrust"}, "Hip Thrust", Pattern::hinge, Equipment::barbell, 2.5, false},
      {ExerciseId{"kettlebell-swing"}, "Kettlebell Swing", Pattern::hinge, Equipment::kettlebell, 4.0, false},
      {ExerciseId{"romanian-deadlift"}, "Romanian Deadlift", Pattern::hinge, Equipment::barbell, 2.5, false},
      {ExerciseId{"sumo-deadlift"}, "Sumo Deadlift", Pattern::hinge, Equipment::barbell, 2.5, false},
      {ExerciseId{"trap-bar-deadlift"}, "Trap Bar Deadlift", Pattern::hinge, Equipment::barbell, 2.5, false},
      {ExerciseId{"barbell-curl"}, "Barbell Curl", Pattern::isolation, Equipment::barbell, 2.5, false},
      {ExerciseId{"cable-fly"}, "Cable Fly", Pattern::isolation, Equipment::cable, 2.5, false},
      {ExerciseId{"dumbbell-curl"}, "Dumbbell Curl", Pattern::isolation, Equipment::dumbbell, 2.0, false},
      {ExerciseId{"dumbbell-fly"}, "Dumbbell Fly", Pattern::isolation, Equipment::dumbbell, 2.0, false},
      {ExerciseId{"hammer-curl"}, "Hammer Curl", Pattern::isolation, Equipment::dumbbell, 2.0, false},
      {ExerciseId{"hip-abduction"}, "Hip Abduction", Pattern::isolation, Equipment::machine, 5.0, false},
      {ExerciseId{"lateral-raise"}, "Lateral Raise", Pattern::isolation, Equipment::dumbbell, 2.0, false},
      {ExerciseId{"leg-extension"}, "Leg Extension", Pattern::isolation, Equipment::machine, 5.0, false},
      {ExerciseId{"lying-leg-curl"}, "Lying Leg Curl", Pattern::isolation, Equipment::machine, 5.0, false},
      {ExerciseId{"overhead-triceps-extension"}, "Overhead Triceps Extension", Pattern::isolation,
       Equipment::dumbbell, 2.0, false},
      {ExerciseId{"rear-delt-fly"}, "Rear Delt Fly", Pattern::isolation, Equipment::dumbbell, 2.0, false},
      {ExerciseId{"seated-calf-raise"}, "Seated Calf Raise", Pattern::isolation, Equipment::machine, 5.0, false},
      {ExerciseId{"skull-crusher"}, "Skull Crusher", Pattern::isolation, Equipment::barbell, 2.5, false},
      {ExerciseId{"standing-calf-raise"}, "Standing Calf Raise", Pattern::isolation, Equipment::machine, 5.0,
       false},
      {ExerciseId{"triceps-pushdown"}, "Triceps Pushdown", Pattern::isolation, Equipment::cable, 2.5, false},
      {ExerciseId{"wrist-curl"}, "Wrist Curl", Pattern::isolation, Equipment::barbell, 2.5, false},
      {ExerciseId{"bench-press"}, "Bench Press", Pattern::press, Equipment::barbell, 2.5, false},
      {ExerciseId{"close-grip-bench-press"}, "Close Grip Bench Press", Pattern::press, Equipment::barbell, 2.5,
       false},
      {ExerciseId{"dip"}, "Dip", Pattern::press, Equipment::bodyweight, 2.5, false},
      {ExerciseId{"dumbbell-bench-press"}, "Dumbbell Bench Press", Pattern::press, Equipment::dumbbell, 2.0,
       false},
      {ExerciseId{"dumbbell-shoulder-press"}, "Dumbbell Shoulder Press", Pattern::press, Equipment::dumbbell,
       2.0, false},
      {ExerciseId{"incline-bench-press"}, "Incline Bench Press", Pattern::press, Equipment::barbell, 2.5, false},
      {ExerciseId{"incline-dumbbell-press"}, "Incline Dumbbell Press", Pattern::press, Equipment::dumbbell, 2.0,
       false},
      {ExerciseId{"machine-chest-press"}, "Machine Chest Press", Pattern::press, Equipment::machine, 5.0, false},
      {ExerciseId{"machine-shoulder-press"}, "Machine Shoulder Press", Pattern::press, Equipment::machine, 5.0,
       false},
      {ExerciseId{"overhead-press"}, "Overhead Press", Pattern::press, Equipment::barbell, 2.5, false},
      {ExerciseId{"push-press"}, "Push Press", Pattern::press, Equipment::barbell, 2.5, false},
      {ExerciseId{"push-up"}, "Push Up", Pattern::press, Equipment::bodyweight, 2.5, false},
      {ExerciseId{"barbell-row"}, "Barbell Row", Pattern::pull, Equipment::barbell, 2.5, false},
      {ExerciseId{"barbell-shrug"}, "Barbell Shrug", Pattern::pull, Equipment::barbell, 2.5, false},
      {ExerciseId{"chest-supported-row"}, "Chest Supported Row", Pattern::pull, Equipment::machine, 5.0, false},
      {ExerciseId{"chin-up"}, "Chin Up", Pattern::pull, Equipment::bodyweight, 2.5, false},
      {ExerciseId{"dumbbell-row"}, "Dumbbell Row", Pattern::pull, Equipment::dumbbell, 2.0, false},
      {ExerciseId{"face-pull"}, "Face Pull", Pattern::pull, Equipment::cable, 2.5, false},
      {ExerciseId{"inverted-row"}, "Inverted Row", Pattern::pull, Equipment::bodyweight, 2.5, false},
      {ExerciseId{"lat-pulldown"}, "Lat Pulldown", Pattern::pull, Equipment::cable, 2.5, false},
      {ExerciseId{"muscle-up"}, "Muscle Up", Pattern::pull, Equipment::bodyweight, 2.5, false},
      {ExerciseId{"pull-up"}, "Pull Up", Pattern::pull, Equipment::bodyweight, 2.5, false},
      {ExerciseId{"seated-cable-row"}, "Seated Cable Row", Pattern::pull, Equipment::cable, 2.5, false},
      {ExerciseId{"back-squat"}, "Back Squat", Pattern::squat, Equipment::barbell, 2.5, false},
      {ExerciseId{"bulgarian-split-squat"}, "Bulgarian Split Squat", Pattern::squat, Equipment::dumbbell, 2.0,
       false},
      {ExerciseId{"front-squat"}, "Front Squat", Pattern::squat, Equipment::barbell, 2.5, false},
      {ExerciseId{"goblet-squat"}, "Goblet Squat", Pattern::squat, Equipment::dumbbell, 2.0, false},
      {ExerciseId{"hack-squat"}, "Hack Squat", Pattern::squat, Equipment::machine, 5.0, false},
      {ExerciseId{"leg-press"}, "Leg Press", Pattern::squat, Equipment::machine, 5.0, false},
      {ExerciseId{"step-up"}, "Step Up", Pattern::squat, Equipment::dumbbell, 2.0, false},
      {ExerciseId{"walking-lunge"}, "Walking Lunge", Pattern::squat, Equipment::dumbbell, 2.0, false},
  };
}


// A catalog in the order the read promises: by pattern, then by the name this account reads.
std::vector<Exercise> inCatalogOrder(std::vector<Exercise> rows) {
  std::sort(rows.begin(), rows.end(), [](const Exercise& a, const Exercise& b) {
    return std::pair(toString(a.pattern), a.name) < std::pair(toString(b.pattern), b.name);
  });
  return rows;
}

// The seeds and this account's own movements, as its catalog read serves them.
std::vector<Exercise> seedsWith(const std::vector<Exercise>& own) {
  std::vector<Exercise> rows = seedCatalog();
  rows.insert(rows.end(), own.begin(), own.end());
  return inCatalogOrder(rows);
}

// A rename as a phone pushes it: a seed by its exerciseName line, a movement of the account's own by its row.
Json::Value renamed(Harness& h, const UserId& account, const std::string& type, const std::string& id,
                    const std::string& name) {
  Json::Value fields(Json::objectValue);
  fields["name"] = name;
  return h.admit(account, {GymDoor::delta(type, id, fields)});
}

}

TEST(create_exercise_takes_the_equipments_default_step_and_joins_the_callers_catalog) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;

  ExerciseInsertOutcome created = h.door.createExercise(
      h.user, ExerciseWrite{ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat,
                            Equipment::machine, std::nullopt});
  ExerciseInsertOutcome stated = h.door.createExercise(
      h.user, ExerciseWrite{ExerciseId{"ex_22222222"}, "Landmine Press", Pattern::press,
                            Equipment::barbell, 1.25});

  CHECK(created.error == ExerciseInsertError::none);
  CHECK_EQ(*created.exercise, Exercise(ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat,
                                       Equipment::machine, 5.0, true));
  CHECK_EQ(stated.exercise->stepKg, 1.25);
  // The catalog read serves the seeds plus the caller's own, never another's.
  CHECK_EQ(h.repo.catalog.catalog(h.user), seedsWith({*stated.exercise, *created.exercise}));
  CHECK_EQ(h.repo.catalog.catalog(h.other), seedCatalog());
}

// A spent id is refused; the caller's OWN id replays the movement already under it.
TEST(create_exercise_refuses_a_spent_id_and_replays_the_callers_own) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  ExerciseInsertOutcome first = h.door.createExercise(
      h.user, ExerciseWrite{ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat,
                            Equipment::barbell, std::nullopt});
  h.door.createExercise(h.other, ExerciseWrite{ExerciseId{"ex_99999999"}, "Their Movement",
                                                  Pattern::pull, Equipment::cable, 2.5});

  ExerciseInsertOutcome seedSlug = h.door.createExercise(
      h.user, ExerciseWrite{ExerciseId{"bench-press"}, "My Bench", Pattern::press,
                            Equipment::barbell, std::nullopt});
  ExerciseInsertOutcome theirs = h.door.createExercise(
      h.user, ExerciseWrite{ExerciseId{"ex_99999999"}, "My Movement", Pattern::pull,
                            Equipment::cable, std::nullopt});
  ExerciseInsertOutcome replayed = h.door.createExercise(
      h.user, ExerciseWrite{ExerciseId{"ex_11111111"}, "Zercher Squat (renamed)", Pattern::squat,
                            Equipment::barbell, std::nullopt});

  CHECK(seedSlug.error == ExerciseInsertError::idTaken);
  CHECK_FALSE(seedSlug.exercise.has_value());
  CHECK(theirs.error == ExerciseInsertError::idTaken);
  CHECK_FALSE(theirs.exercise.has_value());   // never the stranger's row, not even to say it exists
  CHECK(replayed.error == ExerciseInsertError::none);
  CHECK_EQ(*replayed.exercise, *first.exercise);
  CHECK_EQ(h.repo.catalog.catalog(h.user), seedsWith({*first.exercise}));
}

TEST(a_created_movement_can_be_logged_and_planned_like_a_seeded_one) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.door.createExercise(h.user, ExerciseWrite{ExerciseId{"ex_11111111"}, "Zercher Squat",
                                                 Pattern::squat, Equipment::barbell, std::nullopt});
  RoutineWriteOutcome created = h.door.createRoutine(
      h.user,
      RoutineWrite{rtId(), "Push A", 0, {RoutineEntry{1, ExerciseId{"ex_11111111"}, straight(3, 8, 60.0), 120}}},
      std::nullopt);
  h.door.start(h.user, SessionStart{sid(), h.clock.now, true, rtId()});
  AppendOutcome landed = h.door.append(
      h.user, sid(),
      SetWrite{setId(), ExerciseId{"ex_11111111"}, 60.0, 8, SetKind::working, std::nullopt, "",
               h.clock.now + 1});
  h.door.finish(h.user, sid(), h.clock.now + 2);

  LastTimeOutcome last = h.training.lastTime(h.user, ExerciseId{"ex_11111111"});
  LastTimeOutcome theirs = h.training.lastTime(h.other, ExerciseId{"ex_11111111"});

  CHECK(created.error == RoutineWriteError::none);
  CHECK(landed.error == AppendError::none);
  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->routineName, std::string("Push A"));
  CHECK_EQ(last.lastTime->sets, std::vector<Set>{*landed.set});
  CHECK(theirs.error == LastTimeError::unknownExercise);
}

TEST(catalog_serves_seeds_plus_own_customs_ordered_by_pattern_then_name) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.door.createExercise(h.user, ExerciseWrite{ExerciseId{"landmine-press"}, "Landmine Press",
                                                 Pattern::press, Equipment::barbell, std::nullopt});
  h.door.createExercise(h.other, ExerciseWrite{ExerciseId{"zercher-squat"}, "Zercher Squat",
                                                  Pattern::squat, Equipment::barbell, std::nullopt});

  std::vector<Exercise> mineListed = h.repo.catalog.catalog(h.user);

  CHECK_EQ(mineListed, seedsWith({Exercise{ExerciseId{"landmine-press"}, "Landmine Press", Pattern::press,
                                           Equipment::barbell, 2.5, true}}));
}

// The catalog and the log both read the name this account gave a seed, under the id it always had.
TEST(renaming_a_seed_is_this_accounts_alone_and_the_id_never_moves) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  h.door.start(h.user, SessionStart{sid(), h.clock.now, true});
  for (int number = 1; number <= 4; ++number)
    h.door.append(h.user, sid(),
                      SetWrite{setId("set_0000000" + std::to_string(number)), ExerciseId{"back-squat"}, 100,
                               5, SetKind::working, std::nullopt, "",
                               h.clock.now + static_cast<std::uint64_t>(number) * 60'000});
  h.door.finish(h.user, sid(), h.clock.now + 3'600'000);

  CHECK_EQ(GymDoor::refusal(renamed(h, h.user, "exerciseName", "back-squat", "Low-bar Squat")), std::string());

  std::vector<Exercise> named = seedCatalog();
  for (Exercise& seed : named)
    if (seed.id == ExerciseId{"back-squat"})
      seed = Exercise{ExerciseId{"back-squat"}, "Low-bar Squat", Pattern::squat, Equipment::barbell, 2.5,
                      false, {"Back Squat"}};
  CHECK_EQ(h.repo.catalog.catalog(h.user), inCatalogOrder(named));
  CHECK_EQ(h.repo.catalog.catalog(h.other), seedCatalog());
  std::vector<LogRow> listed = h.training.log(h.user, LogCursor{h.clock.now + 604'800'000, std::nullopt, 50});
  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].summary.exerciseNames, std::vector<std::string>{"Low-bar Squat"});
}

// A rename names a movement this account can see and a name it can hold, or nothing is written.
TEST(a_rename_refuses_a_movement_this_account_cannot_see_and_a_name_past_the_bound) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  ExerciseInsertOutcome theirs = h.door.createExercise(
      h.other, ExerciseWrite{ExerciseId{"ex_00000002"}, "Theirs", Pattern::squat, Equipment::barbell, 2.5});

  CHECK_EQ(GymDoor::refusal(renamed(h, h.user, "exercise", "ex_00000002", "Mine")), std::string("unknown-record"));
  CHECK_EQ(GymDoor::refusal(renamed(h, h.user, "exerciseName", "no-such", "Mine")), std::string("invalid"));
  CHECK_EQ(GymDoor::refusal(renamed(h, h.user, "exerciseName", "back-squat",
                                    std::string(kMaxNameLength + 1, 'x'))),
           std::string("invalid"));

  CHECK_EQ(h.repo.catalog.catalog(h.user), seedCatalog());
  CHECK_EQ(h.repo.catalog.catalog(h.other), seedsWith({*theirs.exercise}));
}
