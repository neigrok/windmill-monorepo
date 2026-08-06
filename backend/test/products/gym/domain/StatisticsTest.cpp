#include "products/gym/domain/Statistics.h"

#include "test/testing.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

using namespace wm::gym;

namespace {
const std::uint64_t kMonday = 1'700'000'000'000;   // 2023-11-14, a Tuesday — the week is the SQL's
const std::uint64_t kWeek = 604'800'000;
const std::uint64_t kDay = 86'400'000;

MovementTop top(const std::string& exercise, std::uint64_t startedAtMs, double weightKg, int reps) {
  return MovementTop{ExerciseId{exercise}, startedAtMs, weightKg, reps};
}

PriorMark mark(const std::string& exercise, double weightKg, int reps, std::uint64_t atMs) {
  return PriorMark{ExerciseId{exercise}, weightKg, reps, atMs};
}
}

// The whole shape in one case: the series is the tops in the order they arrived, Epley is applied
// to each of them, and the line is dated by the last one.
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

// The two standing bests are different questions and a lifter is owed both answers: 110 × 2 is the
// heavier bar and 105 × 5 is the better set, exactly as the finish's record rules rank them.
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

// Epley is defined only for a loaded set, so a chin-up ladder draws a line of loads with no
// estimate over it rather than a line of invented numbers — and its heaviest is still a real fact.
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

// A band-assisted pull-up logs a NEGATIVE load on the same number line, and the heaviest of two
// negatives is the one closest to zero — the assistance coming off is the progress.
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

// Most recently trained first, which is the order the routines screen already sorts by, so the two
// lists read the same way down the page.
TEST(gym_statistics_puts_the_most_recently_trained_movement_first) {
  const Statistics answer = statistics(TrainingLog{{top("back-squat", kMonday, 100, 5),
                                                    top("bench-press", kMonday + kDay, 80, 5)},
                                                   {},
                                                   {}});

  REQUIRE_EQ(answer.movements.size(), 2u);
  CHECK_EQ(answer.movements[0].exercise, ExerciseId{"bench-press"});
  CHECK_EQ(answer.movements[1].exercise, ExerciseId{"back-squat"});
}

// A movement trained on the same day as another breaks its tie on the id, so the walk is the same
// on every read rather than whatever order the rows happened to arrive in.
TEST(gym_statistics_breaks_a_same_day_tie_on_the_movement_id) {
  const Statistics answer = statistics(TrainingLog{
      {top("zercher-squat", kMonday, 60, 5), top("back-squat", kMonday, 100, 5)}, {}, {}});

  REQUIRE_EQ(answer.movements.size(), 2u);
  CHECK_EQ(answer.movements[0].exercise, ExerciseId{"back-squat"});
  CHECK_EQ(answer.movements[1].exercise, ExerciseId{"zercher-squat"});
}

// The weekly counts are the store's and the rule hands them straight through: nothing here adds a
// total, an average or a trend to them, because every one of those would be an opinion this surface
// refuses to have.
TEST(gym_statistics_passes_the_weeks_through_untouched) {
  const std::vector<TrainingWeek> weeks{TrainingWeek{kMonday, 3, 44}, TrainingWeek{kMonday + kWeek, 0, 0},
                                        TrainingWeek{kMonday + 2 * kWeek, 4, 61}};
  const Statistics answer = statistics(TrainingLog{{}, {}, weeks});

  CHECK_EQ(answer.weeks, weeks);
  CHECK_EQ(answer.movements.size(), 0u);
}

// An account that has never finished a session answers with nothing at all — no zero-length line,
// no week of zeroes, no movement with an empty series. An empty answer is the honest one.
TEST(gym_statistics_of_an_empty_log_is_empty) {
  const Statistics answer = statistics(TrainingLog{});

  CHECK_EQ(answer.weeks.size(), 0u);
  CHECK_EQ(answer.movements.size(), 0u);
}
