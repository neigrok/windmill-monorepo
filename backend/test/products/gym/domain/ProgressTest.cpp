#include "products/gym/domain/Progress.h"

#include "platform/domain/sync/Jcs.h"
#include "test/testing.h"

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <optional>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::gym;

namespace {
namespace fs = std::filesystem;

// packages/api-contract/gym/domain/training-reads.json: the server claims every `GymEstimate` case, each compared by
// its JCS bytes, the way both phones and the web claim them.
const fs::path kTrainingReads{WM_GYM_DOMAIN_DIR "/training-reads.json"};

Json::Value trainingReads() {
  std::ifstream stream(kTrainingReads, std::ios::binary);
  return sync::parseJson(std::string{std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()});
}

void runEstimate(Json::ArrayIndex index) {
  const Json::Value vector = trainingReads()[index];
  const Json::Value& input = vector["input"]["input"];
  std::optional<double> rpe;
  if (input.isMember("rpe")) rpe = input["rpe"].asDouble();
  const std::optional<Estimate> estimate = Estimate::of(input["weightKg"].asDouble(), input["reps"].asInt(), rpe);
  const Json::Value answered = estimate ? Json::Value(estimate->e1rm) : Json::Value(Json::nullValue);
  CHECK_EQ(sync::jcs(answered), sync::jcs(vector["expect"]["result"]));
}

[[maybe_unused]] const bool registered = [] {
  if (!fs::is_regular_file(kTrainingReads)) {
    ::testing::Register{"gym_training_reads", [] {
      ::testing::fail(("no training reads at " + kTrainingReads.string()).c_str(), __FILE__, __LINE__);
    }};
    return true;
  }
  const Json::Value vectors = trainingReads();
  for (Json::ArrayIndex i = 0; i < vectors.size(); ++i)
    if (vectors[i]["input"]["read"] == "GymEstimate")
      ::testing::Register{"gym_training_reads/GymEstimate: " + vectors[i]["name"].asString(), [i] { runEstimate(i); }};
  return true;
}();

const SessionId kFirst{"ses_00000001"};
const SessionId kSecond{"ses_00000002"};
const ExerciseId kBench{"bench-press"};

EstimatedFact estimated(const PerformedFact& set) { return EstimatedFact{set, *set.estimate()}; }

ProgressSet benched(const SessionId& session, std::uint64_t startedAtMs, const std::string& id, double weightKg,
                    int reps, std::optional<double> rpe = std::nullopt) {
  return ProgressSet{session, startedAtMs, kBench, PerformedFact{SetId{id}, weightKg, reps, rpe}};
}
}

TEST(gym_estimate_is_stated_to_a_tenth_as_the_last_step) {
  CHECK_EQ(Estimate::stated(Estimate::of(100, 5, std::nullopt)->e1rm), 116.7);
  CHECK_EQ(Estimate::stated(Estimate::of(100, 1, std::nullopt)->e1rm), 100.0);
  CHECK_EQ(Estimate::stated(Estimate::of(62.5, 5, 8.5)->e1rm), 72.9);
}

// 70 × 10 and 80 × 5 differ in Epley's last bit only; their scores are the one equal number.
TEST(gym_estimate_scores_are_exact_where_epley_values_are_not) {
  const Estimate tens = *Estimate::of(70, 10, std::nullopt);
  const Estimate fives = *Estimate::of(80, 5, std::nullopt);

  CHECK(tens.e1rm != fives.e1rm);
  CHECK_EQ(tens.score, fives.score);
  CHECK_EQ(tens.score, 280'000);
  CHECK_EQ(Estimate::of(100, 1, std::nullopt)->score, 300'000);
}

TEST(gym_progress_qualifies_raw_sets_before_selecting_the_estimate) {
  const std::vector<ProgressSet> history{benched(kFirst, 1'000, "set_00000001", 100, 1, 8),
                                         benched(kFirst, 1'000, "set_00000002", 90, 11),
                                         benched(kFirst, 1'000, "set_00000003", 90, 10, 6.5),
                                         benched(kFirst, 1'000, "set_00000004", 90, 8, 7)};

  CHECK_EQ(statsProgress(history, 2'000),
           (StatsProgress{2'000, {{kFirst, 1'000, {{kBench, 4, history[0].performed,
               estimated(history[3].performed), std::nullopt}}}}}));
  CHECK_EQ(history[3].performed.estimate()->e1rm, 114.0);
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
    if (example.estimate) estimate = estimated(set);
    const StatsProgress expected{2'000, {{kFirst, 1'000,
        {{kBench, 1, set, estimate, example.weightKg == 0 ? std::optional<PerformedFact>{set} : std::nullopt}}}}};

    CHECK_EQ(statsProgress({{kFirst, 1'000, kBench, set}}, 2'000), expected);
    CHECK_EQ(set.estimate() ? std::optional<double>(set.estimate()->e1rm) : std::nullopt, example.estimate);
  }
}

TEST(gym_progress_ties_name_one_stable_set_and_retain_its_actual_effort) {
  const std::vector<ProgressSet> history{benched(kFirst, 1'000, "set_00000001", 75, 10, 7.5),
                                         benched(kFirst, 1'000, "set_00000002", 100, 1),
                                         benched(kFirst, 1'000, "set_00000003", 100, 2, 6),
                                         benched(kFirst, 1'000, "set_00000004", 100, 2, 6.5)};

  CHECK_EQ(statsProgress(history, 2'000),
           (StatsProgress{2'000, {{kFirst, 1'000, {{kBench, 4, history[2].performed,
               estimated(history[0].performed), std::nullopt}}}}}));
}

TEST(gym_progress_does_not_round_away_a_higher_estimate) {
  const std::vector<ProgressSet> history{benched(kFirst, 1'000, "set_00000001", 100.01, 3),
                                         benched(kFirst, 1'000, "set_00000002", 100.02, 3)};

  CHECK_EQ(statsProgress(history, 2'000),
           (StatsProgress{2'000, {{kFirst, 1'000, {{kBench, 2, history[1].performed,
               estimated(history[1].performed), std::nullopt}}}}}));
  CHECK_EQ(history[1].performed.estimate()->e1rm, 100.02 * 1.1);
}

TEST(gym_progress_keeps_signed_zero_and_low_effort_movements_without_estimates) {
  const std::vector<ProgressSet> history{
      {kFirst, 1'000, ExerciseId{"chin-up"}, {SetId{"set_00000001"}, -20, 8, std::nullopt}},
      {kFirst, 1'000, ExerciseId{"chin-up"}, {SetId{"set_00000002"}, -10, 6, 8}},
      {kFirst, 1'000, ExerciseId{"dip"}, {SetId{"set_00000003"}, 0, 10, std::nullopt}},
      {kFirst, 1'000, ExerciseId{"press"}, {SetId{"set_00000004"}, 80, 8, 6.5}}};

  CHECK_EQ(statsProgress(history, 2'000), (StatsProgress{2'000, {{kFirst, 1'000, {
      {ExerciseId{"chin-up"}, 2, history[1].performed, std::nullopt, std::nullopt},
      {ExerciseId{"dip"}, 1, history[2].performed, std::nullopt, history[2].performed},
      {ExerciseId{"press"}, 1, history[3].performed, std::nullopt, std::nullopt}}}}}));
}

// However the sets arrive, a session comes out once with its movements in id order, and sessions in time order.
TEST(gym_progress_groups_sets_whatever_order_they_arrive_in) {
  const std::vector<ProgressSet> history{
      {kSecond, 2'000, ExerciseId{"squat"}, {SetId{"set_00000004"}, 100, 5, std::nullopt}},
      {kFirst, 1'000, kBench, {SetId{"set_00000002"}, 80, 5, std::nullopt}},
      {kSecond, 2'000, kBench, {SetId{"set_00000003"}, 82.5, 5, std::nullopt}},
      {kFirst, 1'000, kBench, {SetId{"set_00000001"}, 80, 5, std::nullopt}}};

  CHECK_EQ(progressSessions(history), (std::vector<ProgressSession>{
      {kFirst, 1'000, {{kBench, 2, history[3].performed, estimated(history[3].performed), std::nullopt}}},
      {kSecond, 2'000, {{kBench, 1, history[2].performed, estimated(history[2].performed), std::nullopt},
                        {ExerciseId{"squat"}, 1, history[0].performed, estimated(history[0].performed), std::nullopt}}}}));
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
      facts.movements.push_back(MovementSessionFact{exercise, 1, set, estimated(set), std::nullopt});
    }
    expected.sessions.push_back(facts);
  }

  CHECK_EQ(statsProgress(history, expected.asOfMs), expected);
}

TEST(gym_progress_preserves_distinct_session_ids_at_the_same_instant) {
  const PerformedFact first{SetId{"set_00000001"}, 100, 1, std::nullopt};
  const PerformedFact second{SetId{"set_00000002"}, 100, 1, std::nullopt};

  CHECK_EQ(statsProgress({{kFirst, 1'000, kBench, first}, {kSecond, 1'000, kBench, second}}, 2'000),
           (StatsProgress{2'000, {{kFirst, 1'000, {{kBench, 1, first, estimated(first), std::nullopt}}},
                                  {kSecond, 1'000, {{kBench, 1, second, estimated(second), std::nullopt}}}}}));
}

TEST(gym_progress_of_an_empty_log_retains_only_the_read_instant) {
  CHECK_EQ(statsProgress({}, 2'000), (StatsProgress{2'000, {}}));
}

TEST(gym_progress_bodyweight_most_reps_stays_independent_of_added_load_and_effort) {
  const ExerciseId exercise{"chin-up"};
  const PerformedFact added{SetId{"set_00000001"}, 10, 6, {}};
  const PerformedFact best{SetId{"set_00000002"}, 0, 14, 6};
  const PerformedFact tie{SetId{"set_00000003"}, 0, 14, 9};
  const PerformedFact assisted{SetId{"set_00000004"}, -20, 20, {}};
  const auto progress = statsProgress({{kFirst, 1000, exercise, added}, {kFirst, 1000, exercise, best},
                                       {kFirst, 1000, exercise, tie}, {kFirst, 1000, exercise, assisted}}, 2000);
  REQUIRE_EQ(progress.sessions.size(), 1u);
  REQUIRE_EQ(progress.sessions[0].movements.size(), 1u);
  CHECK_EQ(progress.sessions[0].movements[0].heaviest, added);
  CHECK_EQ(progress.sessions[0].movements[0].mostReps, std::optional<PerformedFact>{best});
}

// An equal score keeps the earlier session: 70 × 10 was the best before 80 × 5 equalled it.
TEST(gym_series_best_keeps_the_earliest_session_on_an_equal_score) {
  const MovementSeries series{progressSessions({benched(kSecond, 2'000, "set_00000002", 80, 5),
                                                benched(kFirst, 1'000, "set_00000001", 70, 10)}),
                              kBench};

  REQUIRE(series.best());
  CHECK_EQ(series.best()->session, kFirst);
  CHECK_EQ(series.records().size(), 1u);
  REQUIRE(series.heaviest());
  CHECK_EQ(series.heaviest()->session, kSecond);
}

// The ladder compares estimates as stated to a tenth, the way every phone does: 116.7 x 1 scores above 100 x 5
// (116.667) and is the exact best, yet states the same 116.7 and is no step; 116.8 x 1 is.
TEST(gym_series_records_step_only_on_a_stated_improvement) {
  const MovementSeries series{
      progressSessions({benched(kFirst, 1'000, "set_00000001", 100, 5), benched(kSecond, 2'000, "set_00000002", 116.7, 1),
                        benched(SessionId{"ses_00000003"}, 3'000, "set_00000003", 116.8, 1)}),
      kBench};

  std::vector<SessionId> steps;
  for (const MovementSeries::Point& point : series.records()) steps.push_back(point.session);
  CHECK_EQ(steps, (std::vector<SessionId>{kFirst, SessionId{"ses_00000003"}}));
  CHECK_EQ(series.best()->session, SessionId{"ses_00000003"});
  const MovementSeries tied{progressSessions({benched(kFirst, 1'000, "set_00000001", 100, 5),
                                              benched(kSecond, 2'000, "set_00000002", 116.7, 1)}),
                            kBench};
  CHECK_EQ(tied.records().size(), 1u);
  CHECK_EQ(tied.best()->session, kSecond);
}

// The ladder leads with the baseline and takes a step only on a higher score; a heavier set with no estimate is the
// heaviest and no step.
TEST(gym_series_records_lead_with_the_baseline_and_step_on_a_higher_score) {
  const MovementSeries series{
      progressSessions({benched(kFirst, 1'000, "set_00000001", 100, 5), benched(kSecond, 2'000, "set_00000002", 120, 5, 6),
                        benched(SessionId{"ses_00000003"}, 3'000, "set_00000003", 102.5, 5),
                        benched(SessionId{"ses_00000004"}, 4'000, "set_00000004", 101, 5)}),
      kBench};

  std::vector<SessionId> steps;
  for (const MovementSeries::Point& point : series.records()) steps.push_back(point.session);
  CHECK_EQ(steps, (std::vector<SessionId>{kFirst, SessionId{"ses_00000003"}}));
  CHECK_EQ(series.heaviest()->session, kSecond);
  CHECK_EQ(series.best()->session, SessionId{"ses_00000003"});
}
