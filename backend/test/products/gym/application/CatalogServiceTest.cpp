#include "test/products/gym/application/GymServiceFixture.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

using namespace wm::gym;
using namespace wm::gym::fake;
using namespace wm::gym::servicetest;

TEST(create_exercise_takes_the_equipments_default_step_and_joins_the_callers_catalog) {
  Harness h;

  ExerciseInsertOutcome created = h.catalog.createExercise(
      uid(), ExerciseWrite{ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat,
                           Equipment::machine, std::nullopt});
  ExerciseInsertOutcome stated = h.catalog.createExercise(
      uid(), ExerciseWrite{ExerciseId{"ex_22222222"}, "Landmine Press", Pattern::press,
                           Equipment::barbell, 1.25});

  CHECK(created.error == ExerciseInsertError::none);
  CHECK_EQ(*created.exercise, Exercise(ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat,
                                       Equipment::machine, 5.0, true));
  CHECK_EQ(stated.exercise->stepKg, 1.25);
  // The catalog read serves the seeds plus the caller's own, never another's.
  CHECK_EQ(h.catalog.catalog(uid()),
           (std::vector<Exercise>{benchPress(), *stated.exercise, backSquat(), *created.exercise}));
  CHECK_EQ(h.catalog.catalog(uid("u2")), (std::vector<Exercise>{benchPress(), backSquat()}));
}

// A spent id is refused; the caller's OWN id replays the movement already under it.
TEST(create_exercise_refuses_a_spent_id_and_replays_the_callers_own) {
  Harness h;
  ExerciseInsertOutcome first = h.catalog.createExercise(
      uid(), ExerciseWrite{ExerciseId{"ex_11111111"}, "Zercher Squat", Pattern::squat,
                           Equipment::barbell, std::nullopt});
  h.repo.db.seedCustom(uid("u2"), Exercise{ExerciseId{"ex_99999999"}, "Their Movement",
                                        Pattern::pull, Equipment::cable, 2.5, true});

  ExerciseInsertOutcome seedSlug = h.catalog.createExercise(
      uid(), ExerciseWrite{ExerciseId{"bench-press"}, "My Bench", Pattern::press,
                           Equipment::barbell, std::nullopt});
  ExerciseInsertOutcome theirs = h.catalog.createExercise(
      uid(), ExerciseWrite{ExerciseId{"ex_99999999"}, "My Movement", Pattern::pull,
                           Equipment::cable, std::nullopt});
  ExerciseInsertOutcome replayed = h.catalog.createExercise(
      uid(), ExerciseWrite{ExerciseId{"ex_11111111"}, "Zercher Squat (renamed)", Pattern::squat,
                           Equipment::barbell, std::nullopt});

  CHECK(seedSlug.error == ExerciseInsertError::idTaken);
  CHECK_FALSE(seedSlug.exercise.has_value());
  CHECK(theirs.error == ExerciseInsertError::idTaken);
  CHECK_FALSE(theirs.exercise.has_value());   // never the stranger's row, not even to say it exists
  CHECK(replayed.error == ExerciseInsertError::none);
  CHECK_EQ(*replayed.exercise, *first.exercise);
  CHECK_EQ(h.catalog.catalog(uid()),
           (std::vector<Exercise>{benchPress(), backSquat(), *first.exercise}));
}

TEST(a_created_movement_can_be_logged_and_planned_like_a_seeded_one) {
  Harness h;
  h.catalog.createExercise(uid(), ExerciseWrite{ExerciseId{"ex_11111111"}, "Zercher Squat",
                                                Pattern::squat, Equipment::barbell, std::nullopt});
  RoutineWriteOutcome created = h.create(h.pushAWrite({RoutineEntry{1, ExerciseId{"ex_11111111"}, 3, 8, 60.0, 120}}));
  h.startFrom(h.clock.now, "ses_00000001", "rt_00000001");
  AppendOutcome landed = h.training.append(
      uid(), sid("ses_00000001"),
      SetWrite{setId("set_00000001"), ExerciseId{"ex_11111111"}, 60.0, 8, SetKind::working,
               std::nullopt, "", h.clock.now + 1});
  h.training.finish(uid(), sid("ses_00000001"), h.clock.now + 2);

  LastTimeOutcome last = h.training.lastTime(uid(), ExerciseId{"ex_11111111"});
  LastTimeOutcome theirs = h.training.lastTime(uid("u2"), ExerciseId{"ex_11111111"});

  CHECK(created.error == RoutineWriteError::none);
  CHECK(landed.error == AppendError::none);
  CHECK(last.error == LastTimeError::none);
  CHECK_EQ(last.lastTime->routineName, std::string("Push A"));
  CHECK_EQ(last.lastTime->sets, std::vector<Set>{*landed.set});
  CHECK(theirs.error == LastTimeError::unknownExercise);
}

TEST(catalog_serves_seeds_plus_own_customs_ordered_by_pattern_then_name) {
  Harness h;
  Exercise mine{ExerciseId{"landmine-press"}, "Landmine Press", Pattern::press,
                Equipment::barbell, 2.5, true};
  h.repo.db.seedCustom(uid(), mine);
  h.repo.db.seedCustom(uid("u2"), Exercise{ExerciseId{"zercher-squat"}, "Zercher Squat",
                                        Pattern::squat, Equipment::barbell, 2.5, true});

  std::vector<Exercise> mineListed = h.catalog.catalog(uid());

  CHECK_EQ(mineListed, (std::vector<Exercise>{benchPress(), mine, backSquat()}));
}

TEST(renaming_a_seed_is_this_accounts_alone_and_the_id_never_moves) {
  Harness h;
  h.trained("ses_00000001", h.clock.now, 100, 5, 4);

  std::optional<Exercise> renamed = h.catalog.renameExercise(uid(), ExerciseId{"back-squat"},
                                                             "Low-bar Squat");

  REQUIRE(renamed.has_value());
  CHECK_EQ(renamed->id, ExerciseId{"back-squat"});
  CHECK_EQ(renamed->name, std::string("Low-bar Squat"));
  CHECK_EQ(renamed->custom, false);
  CHECK_EQ(h.catalog.catalog(uid())[1].name, std::string("Low-bar Squat"));
  CHECK_EQ(h.catalog.catalog(uid("u2"))[1].name, std::string("Back Squat"));
  std::vector<LogRow> listed = h.logBefore(h.clock.now + kWeek);
  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed[0].summary.exerciseNames, std::vector<std::string>{"Low-bar Squat"});
}

TEST(renaming_a_seed_back_to_its_own_name_clears_the_line) {
  Harness h;
  h.catalog.renameExercise(uid(), ExerciseId{"back-squat"}, "Low-bar Squat");

  std::optional<Exercise> restored =
      h.catalog.renameExercise(uid(), ExerciseId{"back-squat"}, "Back Squat");

  REQUIRE(restored.has_value());
  CHECK_EQ(restored->name, std::string("Back Squat"));
  CHECK(h.repo.db.displayNames.empty());
}

TEST(renaming_a_movement_of_your_own_edits_its_row) {
  Harness h;
  h.catalog.createExercise(uid(), ExerciseWrite{ExerciseId{"ex_00000001"}, "Zercher Squat",
                                                Pattern::squat, Equipment::barbell, std::nullopt});

  std::optional<Exercise> renamed =
      h.catalog.renameExercise(uid(), ExerciseId{"ex_00000001"}, "Zercher");

  REQUIRE(renamed.has_value());
  CHECK_EQ(renamed->name, std::string("Zercher"));
  CHECK_EQ(renamed->custom, true);
  CHECK(h.repo.db.displayNames.empty());
}

TEST(a_rename_refuses_a_movement_this_account_cannot_see_and_a_name_it_cannot_hold) {
  Harness h;
  h.repo.db.seedCustom(uid("u2"), Exercise{ExerciseId{"ex_00000002"}, "Theirs", Pattern::squat,
                                        Equipment::barbell, 2.5, true});

  CHECK_EQ(h.catalog.renameExercise(uid(), ExerciseId{"ex_00000002"}, "Mine"), std::nullopt);
  CHECK_EQ(h.catalog.renameExercise(uid(), ExerciseId{"no-such"}, "Mine"), std::nullopt);
  bool refused = false;
  try {
    h.catalog.renameExercise(uid(), ExerciseId{"back-squat"}, std::string(kMaxNameLength + 1, 'x'));
  } catch (const InvalidTraining&) {
    refused = true;
  }
  CHECK(refused);
  bool blankRefused = false;
  try {
    h.catalog.renameExercise(uid(), ExerciseId{"back-squat"}, "   ");
  } catch (const InvalidTraining&) {
    blankRefused = true;
  }
  CHECK(blankRefused);
  CHECK(h.repo.db.displayNames.empty());
}
