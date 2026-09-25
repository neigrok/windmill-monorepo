#include "products/gym/domain/History.h"
#include "test/testing.h"

using namespace wm::gym;

TEST(gym_history_external_volume_counts_working_reps_and_never_subtracts_assistance) {
  HistoryWorkout workout{"ses_history01", 1'700'000'000'000, 1'700'000'001'000, "", "", {
      {"set_history01", "pull-up", "Pull Up", 1, -20, 8, {}, 1'700'000'000'100, true},
      {"set_history02", "pull-up", "Pull Up", 2, 10, 6, {}, 1'700'000'000'200, true},
      {"set_history03", "pull-up", "Pull Up", 3, 30, 10, {}, 1'700'000'000'300, false}}};
  const auto total = workout.totals();
  CHECK_EQ(total.sessions, 1);
  CHECK_EQ(total.sets, 2);
  CHECK_EQ(total.reps, 14);
  CHECK_EQ(total.tonnageKg, 60.0);
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
