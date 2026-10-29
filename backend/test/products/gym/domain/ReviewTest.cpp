#include "products/gym/domain/Review.h"

#include "test/testing.h"

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using namespace wm::gym;

namespace {
const std::uint64_t kStart = 1'700'000'000'000;
const std::uint64_t kHour = 3'600'000;
const std::uint64_t kWeek = 604'800'000;

std::uint64_t at(int minutes) { return kStart + static_cast<std::uint64_t>(minutes) * 60'000; }

Set setOf(const std::string& exercise, double weightKg, int reps, std::uint64_t atMs,
          std::optional<double> rpe = std::nullopt) {
  return Set{SetId{"set_00000001"}, SessionId{"ses_00000001"}, ExerciseId{exercise}, 1, weightKg,
             reps, rpe, "", atMs};
}

Set squat(double weightKg, int reps, std::uint64_t atMs) {
  return setOf("back-squat", weightKg, reps, atMs);
}

Set bench(double weightKg, int reps, std::uint64_t atMs) {
  return setOf("bench-press", weightKg, reps, atMs);
}

// A set of a finished session that started at `startedAtMs`, standing before today's.
ProgressSet stood(const std::string& exercise, double weightKg, int reps, std::uint64_t startedAtMs = kStart - kWeek,
                  std::optional<double> rpe = std::nullopt) {
  return ProgressSet{SessionId{"ses_" + std::to_string(startedAtMs)}, startedAtMs, ExerciseId{exercise},
                     PerformedFact{SetId{"set_" + std::to_string(startedAtMs)}, weightKg, reps, rpe}};
}

double epley(double weightKg, int reps) { return weightKg * (1.0 + reps / 30.0); }

PlanEntry plannedSquat() {
  return PlanEntry{ExerciseId{"back-squat"}, std::vector<SetTarget>(5, SetTarget{5, 105.0}), 180};
}

Session legs(std::uint64_t startedAtMs = kStart, std::string id = "ses_00000001",
             std::string routineName = "Legs") {
  return Session{SessionId{std::move(id)},
                 wm::UserId{"u1"},
                 startedAtMs,
                 startedAtMs + kHour,
                 RoutineId{"rt_00000001"},
                 PlanSnapshot{std::move(routineName), {plannedSquat()}}};
}

Session adHoc() {
  return Session{SessionId{"ses_00000001"}, wm::UserId{"u1"}, kStart, kStart + kHour};
}

std::vector<Set> fourFives(double weightKg) {
  return {squat(weightKg, 5, at(10)), squat(weightKg, 5, at(14)), squat(weightKg, 5, at(18)),
          squat(weightKg, 5, at(22))};
}
}

TEST(top_e1rm_is_absent_when_no_set_earned_an_estimate) {
  std::vector<Set> sets = {setOf("chin-up", 0, 9, at(5)), setOf("lateral-raise", 20, 12, at(9)),
                           setOf("bench-press", 80, 5, at(13), 6.5),
                           setOf("chin-up", 0, 6, at(17))};

  Review result = review(adHoc(), sets, SessionHistory{});

  const ReviewStats unloaded{kHour, 4, std::optional<double>()};
  CHECK_EQ(result.stats, unloaded);
}

TEST(a_first_ever_session_earns_no_record) {
  Review result = review(legs(), fourFives(100), SessionHistory{});

  const ReviewStats facts{kHour, 4, epley(100, 5)};
  CHECK_FALSE(result.slight);
  CHECK_EQ(result.stats, facts);
  CHECK_EQ(result.record, std::optional<PersonalRecord>());
  CHECK_EQ(result.against, std::optional<Against>());
}

TEST(an_ordinary_session_earns_no_record) {
  // Equalling is not beating.
  SessionHistory history;
  history.standing = {stood("back-squat", 100, 5)};
  history.previous = legs(kStart - kWeek, "ses_00000002");
  history.previousSets = fourFives(100);

  Review result = review(legs(), fourFives(100), history);

  CHECK_FALSE(result.slight);
  CHECK_EQ(result.record, std::optional<PersonalRecord>());
  CHECK(result.against.has_value());   // the comparison is still drawn; only the gold line is not
}

TEST(an_e1rm_record_outranks_a_heaviest_earned_beside_it) {
  SessionHistory history;
  history.standing = {stood("back-squat", 100, 8), stood("bench-press", 80, 5, kStart - 2 * kWeek)};
  std::vector<Set> sets = {squat(110, 2, at(10)), squat(110, 2, at(14)), bench(82.5, 5, at(30)),
                           bench(82.5, 5, at(34))};

  Review result = review(legs(), sets, history);

  const PersonalRecord estimate{RecordKind::e1rm, ExerciseId{"bench-press"}, epley(82.5, 5), 82.5, 5,
                                epley(80, 5), kStart - 2 * kWeek};
  REQUIRE(result.record.has_value());
  CHECK_EQ(*result.record, estimate);
}

TEST(a_heaviest_record_names_the_bar_and_not_the_estimate) {
  SessionHistory history;
  history.standing = {stood("back-squat", 100, 8)};
  std::vector<Set> sets = {squat(110, 2, at(10)), squat(110, 2, at(14)), squat(110, 2, at(18)),
                           squat(110, 2, at(22))};

  Review result = review(legs(), sets, history);

  const ReviewStats facts{kHour, 4, epley(110, 2)};
  const PersonalRecord bar{RecordKind::heaviest, ExerciseId{"back-squat"}, 110.0, 110.0, 2, 100.0,
                           kStart - kWeek};
  CHECK_EQ(result.stats, facts);
  REQUIRE(result.record.has_value());
  CHECK_EQ(*result.record, bar);
}

TEST(more_reps_at_a_load_is_the_record_a_bodyweight_movement_earns) {
  SessionHistory history;
  history.standing = {stood("chin-up", 0, 8)};
  std::vector<Set> sets = {setOf("chin-up", 0, 9, at(5)), setOf("chin-up", 0, 8, at(9)),
                           setOf("chin-up", 0, 6, at(13)), setOf("chin-up", 0, 6, at(17))};

  Review result = review(legs(), sets, history);

  const PersonalRecord reps{RecordKind::repsAtWeight, ExerciseId{"chin-up"}, 9.0, 0.0, 9, 8.0,
                           kStart - kWeek};
  REQUIRE(result.record.has_value());
  CHECK_EQ(*result.record, reps);
}

TEST(a_three_set_session_is_slight_and_carries_neither_line) {
  SessionHistory history;
  history.standing = {stood("back-squat", 100, 5)};
  history.previous = legs(kStart - kWeek, "ses_00000002");
  history.previousSets = fourFives(100);
  std::vector<Set> sets = {squat(120, 5, at(4)), squat(120, 5, at(8)), squat(120, 5, at(11))};

  Review result = review(legs(), sets, history);

  const ReviewStats facts{kHour, 3, epley(120, 5)};
  CHECK(result.slight);
  CHECK_EQ(result.stats, facts);
  CHECK_EQ(result.record, std::optional<PersonalRecord>());
  CHECK_EQ(result.against, std::optional<Against>());
}

TEST(a_fourth_set_is_where_a_session_starts_speaking) {
  SessionHistory history;
  history.standing = {stood("back-squat", 100, 5)};

  CHECK(review(legs(), {squat(120, 5, at(4)), squat(120, 5, at(8)), squat(120, 5, at(11))}, history)
            .slight);
  CHECK_FALSE(review(legs(), fourFives(120), history).slight);
}

TEST(the_comparison_matches_the_top_set_and_never_volume) {
  SessionHistory history;
  history.previous = legs(kStart - kWeek, "ses_00000002");
  history.previousSets = {squat(60, 10, at(10) - kWeek), squat(60, 10, at(14) - kWeek),
                          squat(60, 10, at(18) - kWeek), squat(60, 10, at(22) - kWeek),
                          squat(60, 10, at(26) - kWeek)};
  std::vector<Set> sets = {squat(100, 5, at(10)), squat(100, 5, at(14)), squat(100, 5, at(18)),
                           squat(60, 12, at(22))};

  Review result = review(legs(), sets, history);

  const Against band{SessionId{"ses_00000002"},
                     "Legs",
                     kStart - kWeek,
                     {AgainstMovement{ExerciseId{"back-squat"}, TopSet{100, 5, 3},
                                      TopSet{60, 10, 5}, plannedSquat()}}};
  REQUIRE(result.against.has_value());
  CHECK_EQ(*result.against, band);
}

TEST(the_comparison_walks_the_movements_in_first_performed_order_with_its_absences) {
  SessionHistory history;
  history.previous = legs(kStart - kWeek, "ses_00000002");
  history.previousSets = {squat(95, 5, at(10) - kWeek), squat(95, 5, at(14) - kWeek),
                          squat(95, 5, at(18) - kWeek)};
  std::vector<Set> sets = {bench(80, 5, at(6)), bench(80, 5, at(10)), squat(100, 5, at(24)),
                           squat(100, 5, at(28))};

  Review result = review(legs(), sets, history);

  const Against band{SessionId{"ses_00000002"},
                     "Legs",
                     kStart - kWeek,
                     {AgainstMovement{ExerciseId{"bench-press"}, TopSet{80, 5, 2}, std::nullopt,
                                      std::nullopt},
                      AgainstMovement{ExerciseId{"back-squat"}, TopSet{100, 5, 2},
                                      TopSet{95, 5, 3}, plannedSquat()}}};
  REQUIRE(result.against.has_value());
  CHECK_EQ(*result.against, band);
}

TEST(an_ad_hoc_session_stands_against_nothing) {
  SessionHistory history;
  history.previous = legs(kStart - kWeek, "ses_00000002");
  history.previousSets = fourFives(100);

  Review result = review(adHoc(), fourFives(100), history);

  CHECK_EQ(result.against, std::optional<Against>());
}

TEST(the_comparison_names_the_day_the_earlier_session_was_trained_under) {
  SessionHistory history;
  history.previous = legs(kStart - kWeek, "ses_00000002", "Legs");
  history.previousSets = fourFives(100);

  Review result = review(legs(kStart, "ses_00000001", "Leg day (heavy)"), fourFives(105), history);

  REQUIRE(result.against.has_value());
  CHECK_EQ(result.against->routineName, std::string("Legs"));
}

TEST(the_span_runs_to_the_finish_and_to_the_last_set_while_the_session_is_open) {
  std::vector<Set> sets = fourFives(100);
  Session open{SessionId{"ses_00000001"}, wm::UserId{"u1"}, kStart};

  CHECK_EQ(review(legs(), sets, SessionHistory{}).stats.durationMs, kHour);
  // Still open: the last set logged is the only end the domain can see without a clock.
  CHECK_EQ(review(open, sets, SessionHistory{}).stats.durationMs, 22ull * 60'000);
  CHECK_EQ(review(open, {}, SessionHistory{}).stats.durationMs, 0ull);
}

// A set under RPE 7 earns no estimate, so it can set no e1RM record; the bar it moved is still the heaviest.
TEST(a_set_under_rpe_seven_earns_no_estimate_record_and_still_counts_as_the_heaviest) {
  SessionHistory history;
  history.standing = {stood("back-squat", 100, 5, kStart - kWeek, 8)};
  std::vector<Set> sets(4, setOf("back-squat", 105, 5, at(10), 6));

  Review result = review(legs(), sets, history);

  CHECK_EQ(result.stats.topE1rm, std::nullopt);
  REQUIRE(result.record.has_value());
  CHECK_EQ(*result.record, (PersonalRecord{RecordKind::heaviest, ExerciseId{"back-squat"}, 105.0, 105.0, 5, 100.0,
                                           kStart - kWeek}));
}

// 80 × 5 equals 70 × 10 by the rule, so it beats nothing: the record it earns is the heavier bar.
TEST(an_equal_estimate_is_no_e1rm_record) {
  SessionHistory history;
  history.standing = {stood("bench-press", 70, 10)};

  Review result = review(legs(), std::vector<Set>(4, bench(80, 5, at(10))), history);

  REQUIRE(result.record.has_value());
  CHECK_EQ(result.record->kind, RecordKind::heaviest);
}

// The workout is not over, so nothing in it is a record yet; its comparison is still drawn.
TEST(an_open_session_earns_no_record) {
  SessionHistory history;
  history.standing = {stood("back-squat", 100, 5)};
  history.previous = legs(kStart - kWeek, "ses_00000002");
  history.previousSets = fourFives(100);
  Session open = legs();
  open.finishedAtMs = std::nullopt;

  Review result = review(open, fourFives(110), history);

  CHECK_EQ(result.record, std::optional<PersonalRecord>());
  CHECK(result.against.has_value());
}

namespace {
// A page row of `sets` sets of five at one load, in a session that started at `startedAtMs`.
WorkedSession earned(const std::string& id, std::uint64_t startedAtMs, double weightKg, int sets = 4,
                     bool finished = true) {
  std::vector<ProgressSet> worked;
  for (int n = 0; n < sets; ++n)
    worked.push_back(ProgressSet{SessionId{id}, startedAtMs, ExerciseId{"back-squat"},
                                 PerformedFact{SetId{id + "_" + std::to_string(n)}, weightKg, 5, std::nullopt}});
  return WorkedSession{SessionId{id}, finished, std::move(worked)};
}
}

TEST(the_page_walk_marks_every_session_that_passed_a_mark_and_no_others) {
  const std::vector<WorkedSession> page{earned("ses_00000001", at(1), 100), earned("ses_00000002", at(2), 102.5),
                                        earned("ses_00000003", at(3), 105), earned("ses_00000004", at(4), 105)};

  const std::vector<SessionId> marked = recordedIn(page, {});

  CHECK_EQ(marked, (std::vector<SessionId>{SessionId{"ses_00000002"}, SessionId{"ses_00000003"}}));
}

TEST(the_page_walk_judges_its_oldest_row_against_the_sets_standing_before_the_page) {
  const std::vector<WorkedSession> page{earned("ses_00000001", at(1), 100)};

  CHECK_EQ(recordedIn(page, {}), std::vector<SessionId>{});
  CHECK_EQ(recordedIn(page, {stood("back-squat", 95, 5)}), std::vector<SessionId>{SessionId{"ses_00000001"}});
}

TEST(a_slight_session_earns_no_dot_and_still_moves_the_marks_it_set) {
  const std::vector<WorkedSession> page{earned("ses_00000001", at(1), 105, kSlightSets - 1),
                                        earned("ses_00000002", at(2), 105)};

  CHECK_EQ(recordedIn(page, {stood("back-squat", 100, 5)}), std::vector<SessionId>{});
}

TEST(the_dot_and_the_finish_screens_record_are_the_same_judgement) {
  SessionHistory history;
  history.standing = {stood("back-squat", 100, 5)};
  const std::vector<Set> sets = fourFives(105);
  std::vector<ProgressSet> worked;
  for (const Set& set : sets) worked.push_back(ProgressSet::of(legs(), set));

  const Review finish = review(legs(), sets, history);
  const std::vector<SessionId> marked =
      recordedIn({WorkedSession{SessionId{"ses_00000001"}, true, worked}}, history.standing);

  CHECK(finish.record.has_value());
  CHECK_EQ(marked, std::vector<SessionId>{SessionId{"ses_00000001"}});
}

TEST(an_open_session_on_the_page_earns_nothing_and_never_stands_under_the_rows_above_it) {
  const std::vector<WorkedSession> page{earned("ses_00000001", at(1), 100),
                                        earned("ses_00000002", at(2), 110, 4, false),
                                        earned("ses_00000003", at(3), 105)};

  CHECK_EQ(recordedIn(page, {}), (std::vector<SessionId>{SessionId{"ses_00000003"}}));
}
