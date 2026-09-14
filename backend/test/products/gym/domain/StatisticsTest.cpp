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

TEST(gym_progress_qualifies_raw_sets_before_selecting_the_estimate) {
  const SessionId session{"ses_00000001"};
  const ExerciseId exercise{"bench-press"};
  const std::vector<ProgressSet> history{
      {session, 1'000, exercise, {SetId{"set_00000001"}, 100, 1, 8}},
      {session, 1'000, exercise, {SetId{"set_00000002"}, 90, 11, std::nullopt}},
      {session, 1'000, exercise, {SetId{"set_00000003"}, 90, 10, 6.5}},
      {session, 1'000, exercise, {SetId{"set_00000004"}, 90, 8, 7}}};

  CHECK_EQ(statsProgress(history, 2'000),
           (StatsProgress{2'000, {{session, 1'000, {{exercise, 4, history[0].performed,
               EstimatedFact{history[3].performed, 114}}}}}}));
}

TEST(gym_progress_estimate_boundaries_keep_every_performed_fact) {
  struct Example {
    double weightKg;
    int reps;
    std::optional<double> rpe;
    std::optional<double> estimate;
  };
  const std::vector<Example> examples{
      {100.01, 1, std::nullopt, 100.01},
      {90, 2, std::nullopt, 96},
      {90, 10, std::nullopt, 120},
      {90, 11, std::nullopt, std::nullopt},
      {90, 99, std::nullopt, std::nullopt},
      {90, 0, std::nullopt, std::nullopt},
      {90, 8, 6, std::nullopt},
      {90, 8, 6.5, std::nullopt},
      {90, 8, 7, 114},
      {90, 8, 7.5, 114},
      {90, 8, 10, 114},
      {0, 8, 10, std::nullopt},
      {-20, 8, 10, std::nullopt}};
  for (const Example& example : examples) {
    const PerformedFact set{SetId{"set_00000001"}, example.weightKg, example.reps, example.rpe};
    std::optional<EstimatedFact> estimate;
    if (example.estimate) estimate = EstimatedFact{set, *example.estimate};
    const StatsProgress expected{2'000, {{SessionId{"ses_00000001"}, 1'000,
        {{ExerciseId{"bench-press"}, 1, set, estimate}}}}};

    CHECK_EQ(statsProgress({{SessionId{"ses_00000001"}, 1'000, ExerciseId{"bench-press"}, set}}, 2'000),
             expected);
  }
}

TEST(gym_progress_ties_name_one_stable_set_and_retain_its_actual_effort) {
  const SessionId session{"ses_00000001"};
  const ExerciseId exercise{"bench-press"};
  const std::vector<ProgressSet> history{
      {session, 1'000, exercise, {SetId{"set_00000001"}, 75, 10, 7.5}},
      {session, 1'000, exercise, {SetId{"set_00000002"}, 100, 1, std::nullopt}},
      {session, 1'000, exercise, {SetId{"set_00000003"}, 100, 2, 6}},
      {session, 1'000, exercise, {SetId{"set_00000004"}, 100, 2, 6.5}}};

  CHECK_EQ(statsProgress(history, 2'000),
           (StatsProgress{2'000, {{session, 1'000, {{exercise, 4, history[2].performed,
               EstimatedFact{history[0].performed, 100}}}}}}));
}

TEST(gym_progress_does_not_round_away_a_higher_estimate) {
  const SessionId session{"ses_00000001"};
  const ExerciseId exercise{"bench-press"};
  const std::vector<ProgressSet> history{
      {session, 1'000, exercise, {SetId{"set_00000001"}, 100.01, 3, std::nullopt}},
      {session, 1'000, exercise, {SetId{"set_00000002"}, 100.02, 3, std::nullopt}}};

  CHECK_EQ(statsProgress(history, 2'000),
           (StatsProgress{2'000, {{session, 1'000, {{exercise, 2, history[1].performed,
               EstimatedFact{history[1].performed, 100.02 * 1.1}}}}}}));
}

TEST(gym_progress_keeps_signed_zero_and_low_effort_movements_without_estimates) {
  const SessionId session{"ses_00000001"};
  const std::vector<ProgressSet> history{
      {session, 1'000, ExerciseId{"chin-up"}, {SetId{"set_00000001"}, -20, 8, std::nullopt}},
      {session, 1'000, ExerciseId{"chin-up"}, {SetId{"set_00000002"}, -10, 6, 8}},
      {session, 1'000, ExerciseId{"dip"}, {SetId{"set_00000003"}, 0, 10, std::nullopt}},
      {session, 1'000, ExerciseId{"press"}, {SetId{"set_00000004"}, 80, 8, 6.5}}};

  CHECK_EQ(statsProgress(history, 2'000), (StatsProgress{2'000, {{session, 1'000, {
      {ExerciseId{"chin-up"}, 2, history[1].performed, std::nullopt},
      {ExerciseId{"dip"}, 1, history[2].performed, std::nullopt},
      {ExerciseId{"press"}, 1, history[3].performed, std::nullopt}}}}}));
}

TEST(gym_progress_retains_complete_lifetime_sessions_and_uncapped_movements) {
  std::vector<ProgressSet> history;
  StatsProgress expected{1'800'000'000'000, {}};
  for (int day = 0; day < 120; ++day) {
    const SessionId session{"ses_" + std::to_string(10'000'000 + day)};
    const std::uint64_t startedAtMs = 1'600'000'000'000 + day * 86'400'000ull;
    ProgressSession facts{session, startedAtMs, {}};
    for (int index = 0; index < 32; ++index) {
      const ExerciseId exercise{"ex_" + std::to_string(10'000'000 + index)};
      const PerformedFact set{SetId{"set_" + std::to_string(10'000'000 + day * 32 + index)},
                              day == 0 ? 150.0 : 100.0, 1, std::nullopt};
      history.push_back(ProgressSet{session, startedAtMs, exercise, set});
      facts.movements.push_back(MovementSessionFact{exercise, 1, set, EstimatedFact{set, set.weightKg}});
    }
    expected.sessions.push_back(facts);
  }

  CHECK_EQ(statsProgress(history, expected.asOfMs), expected);
}

TEST(gym_progress_preserves_distinct_session_ids_at_the_same_instant) {
  const ExerciseId exercise{"bench-press"};
  const PerformedFact first{SetId{"set_00000001"}, 100, 1, std::nullopt};
  const PerformedFact second{SetId{"set_00000002"}, 100, 1, std::nullopt};

  CHECK_EQ(statsProgress({{SessionId{"ses_00000001"}, 1'000, exercise, first},
                         {SessionId{"ses_00000002"}, 1'000, exercise, second}}, 2'000),
           (StatsProgress{2'000, {
               {SessionId{"ses_00000001"}, 1'000, {{exercise, 1, first, EstimatedFact{first, 100}}}},
               {SessionId{"ses_00000002"}, 1'000, {{exercise, 1, second, EstimatedFact{second, 100}}}}}}));
}

TEST(gym_progress_of_an_empty_log_retains_only_the_read_instant) {
  CHECK_EQ(statsProgress({}, 2'000), (StatsProgress{2'000, {}}));
}
