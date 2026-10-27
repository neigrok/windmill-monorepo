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

// One working set of a finished session; sessions are named by their start.
ProgressSet set(const std::string& exercise, std::uint64_t startedAtMs, const std::string& id, double weightKg,
                int reps, std::optional<double> rpe = std::nullopt) {
  return ProgressSet{SessionId{"ses_" + std::to_string(startedAtMs)}, startedAtMs, ExerciseId{exercise},
                     PerformedFact{SetId{id}, weightKg, reps, rpe}};
}
}

TEST(gym_statistics_draws_a_line_per_movement_from_each_sessions_top_set) {
  const Statistics answer = statistics(TrainingLog{
      {set("back-squat", kMonday, "set_00000001", 100, 5), set("back-squat", kMonday, "set_00000002", 90, 8),
       set("back-squat", kMonday + kWeek, "set_00000003", 105, 5)},
      {}});

  REQUIRE_EQ(answer.movements.size(), 1u);
  const MovementProgress& squat = answer.movements[0];
  CHECK_EQ(squat.exercise, ExerciseId{"back-squat"});
  CHECK_EQ(squat.lastTrainedAtMs, kMonday + kWeek);
  CHECK_EQ(squat.points, (std::vector<MovementPoint>{{kMonday, 100, 5, 100 * (1 + 5 / 30.0)},
                                                     {kMonday + kWeek, 105, 5, 105 * (1 + 5 / 30.0)}}));
}

TEST(gym_statistics_names_the_best_estimate_and_the_heaviest_load_separately) {
  const Statistics answer = statistics(TrainingLog{
      {set("back-squat", kMonday - kWeek, "set_00000001", 105, 5), set("back-squat", kMonday, "set_00000002", 110, 2)},
      {}});

  REQUIRE_EQ(answer.movements.size(), 1u);
  CHECK_EQ(answer.movements[0].bestE1rm, (Best{105, 5, kMonday - kWeek, 105 * (1 + 5 / 30.0)}));
  CHECK_EQ(answer.movements[0].heaviest, (Best{110, 2, kMonday, 110 * (1 + 2 / 30.0)}));
}

// The one e1RM rule: past ten reps, under RPE 7 and at no load, a set earns no estimate; the heaviest set still stands.
TEST(gym_statistics_leaves_a_set_the_rule_does_not_estimate_without_one) {
  const Statistics answer = statistics(TrainingLog{
      {set("chin-up", kMonday, "set_00000001", 0, 8), set("lateral-raise", kMonday, "set_00000002", 20.25, 12),
       set("bench-press", kMonday, "set_00000003", 100, 5, 6.5), set("bench-press", kMonday, "set_00000004", 90, 5, 8)},
      {}});

  REQUIRE_EQ(answer.movements.size(), 3u);
  const MovementProgress& bench = answer.movements[0];
  CHECK_EQ(bench.points, (std::vector<MovementPoint>{{kMonday, 100, 5, std::nullopt}}));
  CHECK_EQ(bench.bestE1rm, (Best{90, 5, kMonday, 90 * (1 + 5 / 30.0)}));
  CHECK_EQ(bench.heaviest, (Best{100, 5, kMonday, std::nullopt}));
  for (const MovementProgress& line : {answer.movements[1], answer.movements[2]}) {
    CHECK_FALSE(line.points[0].e1rm);
    CHECK_FALSE(line.bestE1rm);
    REQUIRE(line.heaviest);
    CHECK_FALSE(line.heaviest->e1rm);
  }
}

// Two estimates equal by the rule keep the earlier session, though Epley puts 80 × 5 a bit above 70 × 10.
TEST(gym_statistics_keeps_the_earliest_of_two_equal_estimates) {
  const Statistics answer = statistics(TrainingLog{
      {set("bench-press", kMonday, "set_00000001", 70, 10), set("bench-press", kMonday + kWeek, "set_00000002", 80, 5)},
      {}});

  REQUIRE_EQ(answer.movements.size(), 1u);
  CHECK_EQ(answer.movements[0].bestE1rm, (Best{70, 10, kMonday, 70 * (1 + 10 / 30.0)}));
}

// Band-assisted work is a NEGATIVE load, so the heaviest of two negatives is the one nearest zero.
TEST(gym_statistics_reads_band_assisted_work_up_the_number_line) {
  const Statistics answer = statistics(TrainingLog{
      {set("pull-up", kMonday, "set_00000001", -20, 5), set("pull-up", kMonday + kWeek, "set_00000002", -10, 5)}, {}});

  REQUIRE_EQ(answer.movements.size(), 1u);
  CHECK_EQ(answer.movements[0].heaviest, (Best{-10, 5, kMonday + kWeek, std::nullopt}));
  CHECK_FALSE(answer.movements[0].bestE1rm);
}

TEST(gym_statistics_puts_the_most_recently_trained_movement_first) {
  const Statistics answer = statistics(TrainingLog{
      {set("back-squat", kMonday, "set_00000001", 100, 5), set("bench-press", kMonday + kDay, "set_00000002", 80, 5)},
      {}});

  REQUIRE_EQ(answer.movements.size(), 2u);
  CHECK_EQ(answer.movements[0].exercise, ExerciseId{"bench-press"});
  CHECK_EQ(answer.movements[1].exercise, ExerciseId{"back-squat"});
}

TEST(gym_statistics_breaks_a_same_day_tie_on_the_movement_id) {
  const Statistics answer = statistics(TrainingLog{
      {set("zercher-squat", kMonday, "set_00000001", 60, 5), set("back-squat", kMonday, "set_00000002", 100, 5)}, {}});

  REQUIRE_EQ(answer.movements.size(), 2u);
  CHECK_EQ(answer.movements[0].exercise, ExerciseId{"back-squat"});
  CHECK_EQ(answer.movements[1].exercise, ExerciseId{"zercher-squat"});
}

TEST(gym_statistics_passes_the_weeks_through_untouched) {
  const std::vector<TrainingWeek> weeks{TrainingWeek{kMonday, 3, 44}, TrainingWeek{kMonday + kWeek, 0, 0},
                                        TrainingWeek{kMonday + 2 * kWeek, 4, 61}};
  const Statistics answer = statistics(TrainingLog{{}, weeks});

  CHECK_EQ(answer.weeks, weeks);
  CHECK_EQ(answer.movements.size(), 0u);
}

TEST(gym_statistics_of_an_empty_log_is_empty) {
  const Statistics answer = statistics(TrainingLog{});

  CHECK_EQ(answer.weeks.size(), 0u);
  CHECK_EQ(answer.movements.size(), 0u);
}
