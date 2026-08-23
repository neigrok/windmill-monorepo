#include "products/gym/domain/Statistics.h"

#include "test/testing.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

using namespace wm::gym;

namespace {
const std::uint64_t kMonday = 1'700'000'000'000;   // 2023-11-14, a Tuesday
const std::uint64_t kWeek = 604'800'000;
const std::uint64_t kDay = 86'400'000;

MovementTop top(const std::string& exercise, std::uint64_t startedAtMs, double weightKg, int reps) {
  return MovementTop{ExerciseId{exercise}, startedAtMs, weightKg, reps};
}

PriorMark mark(const std::string& exercise, double weightKg, int reps, std::uint64_t atMs) {
  return PriorMark{ExerciseId{exercise}, weightKg, reps, atMs};
}
}

TEST(gym_statistics_draws_a_line_per_movement_with_epley_over_it) {
  const Statistics answer = statistics(TrainingLog{
      {top("back-squat", kMonday, 100, 5), top("back-squat", kMonday + kWeek, 105, 5)},
      {mark("back-squat", 100, 5, kMonday), mark("back-squat", 105, 5, kMonday + kWeek)},
      {}});

  REQUIRE_EQ(answer.movements.size(), 1u);
  const MovementProgress& squat = answer.movements[0];
  CHECK_EQ(squat.exercise, ExerciseId{"back-squat"});
  CHECK_EQ(squat.lastTrainedAtMs, kMonday + kWeek);
  REQUIRE_EQ(squat.points.size(), 2u);
  CHECK_EQ(squat.points[0], (MovementPoint{kMonday, 100, 5, 116.7}));
  CHECK_EQ(squat.points[1], (MovementPoint{kMonday + kWeek, 105, 5, 122.5}));
}

TEST(gym_statistics_names_the_best_estimate_and_the_heaviest_load_separately) {
  const Statistics answer = statistics(TrainingLog{
      {top("back-squat", kMonday, 110, 2)},
      {mark("back-squat", 105, 5, kMonday - kWeek), mark("back-squat", 110, 2, kMonday)},
      {}});

  REQUIRE_EQ(answer.movements.size(), 1u);
  REQUIRE(answer.movements[0].bestE1rm);
  REQUIRE(answer.movements[0].heaviest);
  CHECK_EQ(*answer.movements[0].bestE1rm, (Best{105, 5, kMonday - kWeek, 122.5}));
  CHECK_EQ(*answer.movements[0].heaviest, (Best{110, 2, kMonday, 117.3}));
}

// Epley is defined only for a loaded set.
TEST(gym_statistics_leaves_an_unloaded_movement_without_an_estimate) {
  const Statistics answer = statistics(TrainingLog{{top("chin-up", kMonday, 0, 8)},
                                                   {mark("chin-up", 0, 8, kMonday)},
                                                   {}});

  REQUIRE_EQ(answer.movements.size(), 1u);
  REQUIRE_EQ(answer.movements[0].points.size(), 1u);
  CHECK_FALSE(answer.movements[0].points[0].e1rm);
  CHECK_FALSE(answer.movements[0].bestE1rm);
  REQUIRE(answer.movements[0].heaviest);
  CHECK_EQ(*answer.movements[0].heaviest, (Best{0, 8, kMonday, std::nullopt}));
}

// Band-assisted work is a NEGATIVE load, so the heaviest of two negatives is the one nearest zero.
TEST(gym_statistics_reads_band_assisted_work_up_the_number_line) {
  const Statistics answer = statistics(TrainingLog{
      {top("pull-up", kMonday, -20, 5), top("pull-up", kMonday + kWeek, -10, 5)},
      {mark("pull-up", -20, 5, kMonday), mark("pull-up", -10, 5, kMonday + kWeek)},
      {}});

  REQUIRE_EQ(answer.movements.size(), 1u);
  REQUIRE(answer.movements[0].heaviest);
  CHECK_EQ(*answer.movements[0].heaviest, (Best{-10, 5, kMonday + kWeek, std::nullopt}));
  CHECK_FALSE(answer.movements[0].bestE1rm);
}

TEST(gym_statistics_puts_the_most_recently_trained_movement_first) {
  const Statistics answer = statistics(TrainingLog{{top("back-squat", kMonday, 100, 5),
                                                    top("bench-press", kMonday + kDay, 80, 5)},
                                                   {},
                                                   {}});

  REQUIRE_EQ(answer.movements.size(), 2u);
  CHECK_EQ(answer.movements[0].exercise, ExerciseId{"bench-press"});
  CHECK_EQ(answer.movements[1].exercise, ExerciseId{"back-squat"});
}

TEST(gym_statistics_breaks_a_same_day_tie_on_the_movement_id) {
  const Statistics answer = statistics(TrainingLog{
      {top("zercher-squat", kMonday, 60, 5), top("back-squat", kMonday, 100, 5)}, {}, {}});

  REQUIRE_EQ(answer.movements.size(), 2u);
  CHECK_EQ(answer.movements[0].exercise, ExerciseId{"back-squat"});
  CHECK_EQ(answer.movements[1].exercise, ExerciseId{"zercher-squat"});
}

TEST(gym_statistics_passes_the_weeks_through_untouched) {
  const std::vector<TrainingWeek> weeks{TrainingWeek{kMonday, 3, 44}, TrainingWeek{kMonday + kWeek, 0, 0},
                                        TrainingWeek{kMonday + 2 * kWeek, 4, 61}};
  const Statistics answer = statistics(TrainingLog{{}, {}, weeks});

  CHECK_EQ(answer.weeks, weeks);
  CHECK_EQ(answer.movements.size(), 0u);
}

TEST(gym_statistics_of_an_empty_log_is_empty) {
  const Statistics answer = statistics(TrainingLog{});

  CHECK_EQ(answer.weeks.size(), 0u);
  CHECK_EQ(answer.movements.size(), 0u);
}
