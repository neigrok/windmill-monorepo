#include "products/gym/domain/History.h"
#include "test/testing.h"

using namespace wm::gym;

TEST(gym_history_external_volume_counts_every_rep_and_never_subtracts_assistance) {
  HistoryWorkout workout{"ses_history01", 1'700'000'000'000, 1'700'000'001'000, "", "", {
      {"set_history01", "pull-up", "Pull Up", 1, -20, 8, {}, 1'700'000'000'100},
      {"set_history02", "pull-up", "Pull Up", 2, 10, 6, {}, 1'700'000'000'200},
      {"set_history03", "pull-up", "Pull Up", 3, 30, 10, {}, 1'700'000'000'300}}};
  const auto total = workout.totals();
  CHECK_EQ(total.sessions, 1);
  CHECK_EQ(total.sets, 3);
  CHECK_EQ(total.reps, 24);
  CHECK_EQ(total.tonnageKg, 360.0);
}

TEST(gym_history_share_intersection_never_widens_a_range_and_supports_empty_overlap) {
  const LogShare share{"share_history01", wm::UserId{"owner"}, "secret", LogShareMode::live,
                        true, 200, 400, 500, 600};
  const auto full = share.constrain(HistoryQuery{});
  CHECK_EQ(full.fromMs, 200u);
  CHECK_EQ(full.untilMs, 400u);
  HistoryQuery query;
  query.fromMs = 300;
  query.untilMs = 500;
  const auto narrow = share.constrain(query);
  CHECK_EQ(narrow.fromMs, 300u);
  CHECK_EQ(narrow.untilMs, 400u);
  query.fromMs = 450;
  const auto empty = share.constrain(query);
  CHECK(empty.fromMs >= empty.untilMs);
  query = HistoryQuery{};
  query.exercise = "dip";
  query.validate();
}

TEST(gym_history_volume_respects_single_and_paired_dumbbells_without_changing_entered_loads) {
  HistoryWorkout workout{"ses_history01", 1, 2, "", "", {
    {"set_pair0001", "pair", "Pair", 1, 16, 10, {}, 1, Equipment::dumbbell, 2},
    {"set_single01", "single", "Single", 1, 16, 10, {}, 1, Equipment::dumbbell, 1},
    {"set_bar00001", "bar", "Bar", 1, 32, 10, {}, 1, Equipment::barbell, 2},
    {"set_body0001", "body", "Body", 1, 5, 10, {}, 1, Equipment::bodyweight, 2},
    {"set_assist01", "assist", "Assist", 1, -10, 10, {}, 1, Equipment::bodyweight}}};
  CHECK_EQ(workout.totals().tonnageKg, 850.0);
  CHECK_EQ(workout.totals("pair").tonnageKg, 320.0);
  CHECK_EQ(workout.sets.front().weightKg, 16.0);
}
