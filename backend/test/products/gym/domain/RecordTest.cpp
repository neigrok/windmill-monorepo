#include "products/gym/domain/Record.h"

#include "test/testing.h"

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using namespace wm::gym;

namespace {
const std::uint64_t kNow = 1'700'000'000'000;   // 2023-11-14
const std::uint64_t kWeek = 604'800'000;

Exercise squat() {
  return Exercise{ExerciseId{"back-squat"}, "Back Squat", Pattern::squat, Equipment::barbell, 2.5,
                  false};
}

Exercise chinUp() {
  return Exercise{ExerciseId{"chin-up"}, "Chin-up", Pattern::pull, Equipment::bodyweight, 2.5,
                  false};
}

// A set of the session `session`, which started at `startedAtMs`.
ProgressSet ran(const std::string& session, std::uint64_t startedAtMs, const std::string& set, double weightKg,
                int reps, const std::string& exercise = "back-squat") {
  return ProgressSet{SessionId{session}, startedAtMs, ExerciseId{exercise},
                     PerformedFact{SetId{set}, weightKg, reps, std::nullopt}};
}

double epley(double weightKg, int reps) { return weightKg * (1.0 + reps / 30.0); }

Set squatSet(const std::string& id, double weightKg, int reps, std::uint64_t completedAtMs) {
  return Set{SetId{id}, SessionId{"ses_00000001"}, ExerciseId{"back-squat"}, 1, weightKg, reps,
             std::nullopt, "", completedAtMs};
}
}

TEST(gym_record_of_a_movement_never_lifted_draws_nothing_at_all) {
  const MovementRecord page =
      movementRecord(squat(), MovementHistory{squat(), {"Push A", "Legs"}, {}, {}}, kNow);

  CHECK_EQ(page.exercise.id, ExerciseId{"back-squat"});
  CHECK_EQ(page.routines, (std::vector<std::string>{"Push A", "Legs"}));
  CHECK_EQ(page.sessions, 0);
  CHECK_EQ(page.bestE1rm, std::nullopt);
  CHECK_EQ(page.heaviest, std::nullopt);
  CHECK(page.series.empty());
  CHECK(page.records.empty());
  CHECK(page.recent.empty());
}

TEST(gym_record_plots_the_best_estimate_of_a_session_and_not_its_top_set) {
  const MovementHistory history{
      squat(), {"Push A"},
      {ran("ses_00000011", kNow - kWeek, "set_00000001", 100, 5), ran("ses_00000011", kNow - kWeek, "set_00000002", 95, 10)},
      {}};

  const MovementRecord page = movementRecord(squat(), history, kNow);

  CHECK_EQ(page.sessions, 1);
  CHECK_EQ(page.series, (std::vector<RecordPoint>{{kNow - kWeek, 95, 10, epley(95, 10)}}));
  CHECK_EQ(page.bestE1rm, (Best{95, 10, kNow - kWeek, epley(95, 10)}));
  CHECK_EQ(page.heaviest, (Best{100, 5, kNow - kWeek, epley(100, 5)}));
}

// Past ten reps there is no estimate: twelve reps at a heavier load plot nothing, and the session's point is the set
// the rule estimates.
TEST(gym_record_plots_only_the_sets_the_one_e1rm_rule_estimates) {
  const MovementHistory history{
      squat(), {},
      {ran("ses_00000011", kNow - kWeek, "set_00000001", 100, 12), ran("ses_00000011", kNow - kWeek, "set_00000002", 90, 8)},
      {}};

  const MovementRecord page = movementRecord(squat(), history, kNow);

  CHECK_EQ(page.series, (std::vector<RecordPoint>{{kNow - kWeek, 90, 8, epley(90, 8)}}));
  CHECK_EQ(page.heaviest, (Best{100, 12, kNow - kWeek, std::nullopt}));
}

TEST(gym_record_ladder_holds_every_session_that_beat_the_one_standing_and_never_the_first) {
  const MovementHistory history{squat(),
                                {},
                                {ran("ses_00000011", kNow - 3 * kWeek, "set_00000001", 100, 5),
                                 ran("ses_00000012", kNow - 2 * kWeek, "set_00000002", 100, 4),
                                 ran("ses_00000013", kNow - kWeek, "set_00000003", 102.5, 5),
                                 ran("ses_00000014", kNow, "set_00000004", 105, 5)},
                                {}};

  const MovementRecord page = movementRecord(squat(), history, kNow);

  CHECK_EQ(page.sessions, 4);
  CHECK_EQ(page.records, (std::vector<RecordPoint>{{kNow, 105, 5, epley(105, 5)},
                                                   {kNow - kWeek, 102.5, 5, epley(102.5, 5)}}));
  CHECK_EQ(page.series.size(), 4u);
  CHECK_EQ(page.bestE1rm, (Best{105, 5, kNow, epley(105, 5)}));
}

TEST(gym_record_windows_the_chart_to_twelve_weeks_and_nothing_else) {
  const MovementHistory history{squat(),
                                {},
                                {ran("ses_00000011", kNow - 20 * kWeek, "set_00000001", 140, 5),
                                 ran("ses_00000012", kNow - 2 * kWeek, "set_00000002", 100, 5)},
                                {}};

  const MovementRecord page = movementRecord(squat(), history, kNow);

  CHECK_EQ(page.sessions, 2);
  CHECK_EQ(page.series, (std::vector<RecordPoint>{{kNow - 2 * kWeek, 100, 5, epley(100, 5)}}));
  CHECK_EQ(page.bestE1rm, (Best{140, 5, kNow - 20 * kWeek, epley(140, 5)}));
  REQUIRE(page.heaviest.has_value());
  CHECK_EQ(page.heaviest->weightKg, 140);
}

// No set at or below zero earns an estimate, so an unloaded movement has no estimate at all.
TEST(gym_record_of_an_unloaded_movement_draws_the_heaviest_tile_and_no_chart) {
  const MovementHistory history{
      chinUp(),
      {},
      {ran("ses_00000011", kNow - kWeek, "set_00000001", 0, 10, "chin-up"),
       ran("ses_00000011", kNow - kWeek, "set_00000002", -20, 12, "chin-up")},
      {}};

  const MovementRecord page = movementRecord(chinUp(), history, kNow);

  CHECK_EQ(page.sessions, 1);
  CHECK_EQ(page.bestE1rm, std::nullopt);
  CHECK(page.series.empty());
  CHECK(page.records.empty());
  CHECK_EQ(page.heaviest, (Best{0, 10, kNow - kWeek, std::nullopt}));
}

TEST(gym_record_hands_the_recent_days_through_as_the_store_grouped_them) {
  const MovementDay today{SessionId{"ses_00000001"},
                          kNow,
                          {squatSet("set_00000001", 105, 5, kNow),
                           squatSet("set_00000002", 105, 4, kNow + 1)}};
  const MovementHistory history{
      squat(), {}, {ran("ses_00000001", kNow, "set_00000001", 105, 5)}, {today}};

  const MovementRecord page = movementRecord(squat(), history, kNow);

  REQUIRE_EQ(page.recent.size(), 1u);
  CHECK_EQ(page.recent[0], today);
}
