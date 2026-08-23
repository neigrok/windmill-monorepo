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

PriorMark load(double weightKg, int reps, std::uint64_t atMs) {
  return PriorMark{ExerciseId{"back-squat"}, weightKg, reps, atMs};
}

MovementSession ran(const std::string& id, std::uint64_t startedAtMs,
                    std::vector<PriorMark> loads) {
  return MovementSession{SessionId{id}, startedAtMs, std::move(loads)};
}

Set squatSet(const std::string& id, double weightKg, int reps, std::uint64_t completedAtMs) {
  return Set{SetId{id}, SessionId{"ses_00000001"}, ExerciseId{"back-squat"}, 1, weightKg, reps,
             SetKind::working, std::nullopt, "", completedAtMs};
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
      {ran("ses_00000011", kNow - kWeek, {load(100, 5, kNow - kWeek), load(95, 10, kNow - kWeek)})},
      {}};

  const MovementRecord page = movementRecord(squat(), history, kNow);

  CHECK_EQ(page.sessions, 1);
  REQUIRE_EQ(page.series.size(), 1u);
  CHECK_EQ(page.series[0], (RecordPoint{kNow - kWeek, 95, 10, 126.7}));
  REQUIRE(page.bestE1rm.has_value());
  CHECK_EQ(*page.bestE1rm, (Best{95, 10, kNow - kWeek, 126.7}));
  REQUIRE(page.heaviest.has_value());
  CHECK_EQ(*page.heaviest, (Best{100, 5, kNow - kWeek, 116.7}));
}

TEST(gym_record_ladder_holds_every_session_that_beat_the_one_standing_and_never_the_first) {
  const MovementHistory history{squat(),
                                {},
                                {ran("ses_00000011", kNow - 3 * kWeek, {load(100, 5, kNow - 3 * kWeek)}),
                                 ran("ses_00000012", kNow - 2 * kWeek, {load(100, 4, kNow - 2 * kWeek)}),
                                 ran("ses_00000013", kNow - kWeek, {load(102.5, 5, kNow - kWeek)}),
                                 ran("ses_00000014", kNow, {load(105, 5, kNow)})},
                                {}};

  const MovementRecord page = movementRecord(squat(), history, kNow);

  CHECK_EQ(page.sessions, 4);
  REQUIRE_EQ(page.records.size(), 2u);
  CHECK_EQ(page.records[0], (RecordPoint{kNow, 105, 5, 122.5}));
  CHECK_EQ(page.records[1], (RecordPoint{kNow - kWeek, 102.5, 5, 119.6}));
  CHECK_EQ(page.series.size(), 4u);
  REQUIRE(page.bestE1rm.has_value());
  CHECK_EQ(*page.bestE1rm, (Best{105, 5, kNow, 122.5}));
}

TEST(gym_record_windows_the_chart_to_twelve_weeks_and_nothing_else) {
  const MovementHistory history{squat(),
                                {},
                                {ran("ses_00000011", kNow - 20 * kWeek, {load(140, 5, kNow - 20 * kWeek)}),
                                 ran("ses_00000012", kNow - 2 * kWeek, {load(100, 5, kNow - 2 * kWeek)})},
                                {}};

  const MovementRecord page = movementRecord(squat(), history, kNow);

  CHECK_EQ(page.sessions, 2);
  REQUIRE_EQ(page.series.size(), 1u);
  CHECK_EQ(page.series[0], (RecordPoint{kNow - 2 * kWeek, 100, 5, 116.7}));
  REQUIRE(page.bestE1rm.has_value());
  CHECK_EQ(*page.bestE1rm, (Best{140, 5, kNow - 20 * kWeek, 163.3}));
  REQUIRE(page.heaviest.has_value());
  CHECK_EQ(page.heaviest->weightKg, 140);
}

// Epley is undefined at and below zero, so an unloaded movement has no estimate at all.
TEST(gym_record_of_an_unloaded_movement_draws_the_heaviest_tile_and_no_chart) {
  const MovementHistory history{
      chinUp(),
      {},
      {MovementSession{SessionId{"ses_00000011"},
                       kNow - kWeek,
                       {PriorMark{ExerciseId{"chin-up"}, 0, 10, kNow - kWeek},
                        PriorMark{ExerciseId{"chin-up"}, -20, 12, kNow - kWeek}}}},
      {}};

  const MovementRecord page = movementRecord(chinUp(), history, kNow);

  CHECK_EQ(page.sessions, 1);
  CHECK_EQ(page.bestE1rm, std::nullopt);
  CHECK(page.series.empty());
  CHECK(page.records.empty());
  REQUIRE(page.heaviest.has_value());
  CHECK_EQ(*page.heaviest, (Best{0, 10, kNow - kWeek, std::nullopt}));
}

TEST(gym_record_hands_the_recent_days_through_as_the_store_grouped_them) {
  const MovementDay today{SessionId{"ses_00000001"},
                          kNow,
                          {squatSet("set_00000001", 105, 5, kNow),
                           squatSet("set_00000002", 105, 4, kNow + 1)}};
  const MovementHistory history{
      squat(), {}, {ran("ses_00000001", kNow, {load(105, 5, kNow)})}, {today}};

  const MovementRecord page = movementRecord(squat(), history, kNow);

  REQUIRE_EQ(page.recent.size(), 1u);
  CHECK_EQ(page.recent[0], today);
}
