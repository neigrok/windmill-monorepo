#include "products/gym/domain/ReadReceipt.h"

#include "test/products/gym/Fakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::gym;

namespace {

constexpr std::uint64_t kMon4Aug2025 = 1'754'265'600'000;   // Monday 2025-08-04 00:00:00 UTC
constexpr std::uint64_t kSun10Aug2025 = 1'754'870'399'000;  // Sunday 2025-08-10 23:59:59 UTC
constexpr std::uint64_t kMon11Aug2025 = 1'754'870'400'000;  // Monday 2025-08-11 00:00:00 UTC

}  // namespace

TEST(a_week_starts_on_monday_and_a_sunday_night_still_belongs_to_it) {
  CHECK_EQ(weekStartMs(kMon4Aug2025), kMon4Aug2025);
  CHECK_EQ(weekStartMs(kMon4Aug2025 + 1), kMon4Aug2025);
  CHECK_EQ(weekStartMs(kSun10Aug2025), kMon4Aug2025);
  CHECK_EQ(weekStartMs(kMon11Aug2025), kMon11Aug2025);
}

TEST(the_weeks_this_counts_are_the_weeks_postgres_counts) {
  for (std::uint64_t at : {kMon4Aug2025, kSun10Aug2025, kMon11Aug2025, std::uint64_t{1},
                           std::uint64_t{1'700'000'000'000}})
    CHECK_EQ(weekStartMs(at), fake::weekStartMs(at));
}

TEST(a_receipt_counts_nothing_until_something_is_served) {
  ReadReceipt receipt;
  CHECK_EQ(receipt.tally(), (ReadTally{0, 0, 0}));
  CHECK_FALSE(receipt.tally().anything());
}

TEST(the_same_row_served_twice_is_counted_once) {
  ReadReceipt receipt;
  receipt.sawSession(SessionId{"ses_1"}, kMon4Aug2025);
  receipt.sawSet(SetId{"set_1"}, kMon4Aug2025);
  receipt.sawSet(SetId{"set_2"}, kMon4Aug2025);
  receipt.sawSession(SessionId{"ses_1"}, kMon4Aug2025);
  receipt.sawSet(SetId{"set_1"}, kMon4Aug2025);

  CHECK_EQ(receipt.tally(), (ReadTally{2, 1, 1}));
  CHECK(receipt.tally().anything());
}

TEST(sets_and_sessions_each_carry_the_week_they_fall_in) {
  ReadReceipt receipt;
  receipt.sawSession(SessionId{"ses_1"}, kSun10Aug2025);   // week of the 4th
  receipt.sawSet(SetId{"set_1"}, kMon11Aug2025);           // the week after
  receipt.sawWeek(kMon4Aug2025);                           // a week get_stats served, already seen

  CHECK_EQ(receipt.tally(), (ReadTally{1, 1, 2}));
}

TEST(a_week_with_no_training_still_counts_as_a_week_read) {
  ReadReceipt receipt;
  receipt.sawWeek(kMon4Aug2025);
  receipt.sawWeek(kMon11Aug2025);
  CHECK_EQ(receipt.tally(), (ReadTally{0, 0, 2}));
}

TEST(merging_two_replies_counts_the_overlap_once) {
  ReadReceipt page;
  page.sawSession(SessionId{"ses_1"}, kMon4Aug2025);
  page.sawSession(SessionId{"ses_2"}, kMon11Aug2025);

  ReadReceipt detail;
  detail.sawSession(SessionId{"ses_1"}, kMon4Aug2025);
  detail.sawSet(SetId{"set_1"}, kMon4Aug2025);
  detail.sawSet(SetId{"set_2"}, kMon4Aug2025);

  ReadReceipt again;
  again.sawSet(SetId{"set_2"}, kMon4Aug2025);
  again.sawSet(SetId{"set_3"}, kMon11Aug2025);

  ReadReceipt run;
  run.merge(page);
  run.merge(detail);
  run.merge(again);

  CHECK_EQ(run.tally(), (ReadTally{3, 2, 2}));
  // merge does not drain the source.
  CHECK_EQ(page.tally(), (ReadTally{0, 2, 2}));
}

TEST(workout_evidence_counts_working_rows_and_positive_load_without_promoting_other_kinds) {
  const Session session{SessionId{"ses_evidence1"}, UserId{"u1"}, 1000, 9000};
  std::vector<Set> sets;
  int number = 0;
  for (const auto& [kind, kg] : std::vector<std::pair<SetKind, double>>{
           {SetKind::warmup, 20}, {SetKind::working, 82.5}, {SetKind::working, 0},
           {SetKind::working, -10}, {SetKind::drop, 60}, {SetKind::failure, 100}})
    sets.emplace_back(SetId{"set_evidence" + std::to_string(++number)}, session.id,
                      ExerciseId{"bench-press"}, number, kg, 5, kind, std::nullopt, "", 2000);

  const WorkoutObservation total{session, sets};
  CHECK_EQ(total.workingSetCount, 3);
  CHECK_EQ(total.tonnageKg, 412.5);
  CHECK_EQ(total.durationMs, std::optional<std::uint64_t>{8000});
  const Session open{session.id, session.user, session.startedAtMs};
  CHECK_FALSE(WorkoutObservation(open, sets).durationMs.has_value());
  CHECK_EQ(WorkoutObservation(session, {}).workingSetCount, 0);
}

TEST(evidence_keeps_ordered_snapshots_when_repeat_reads_deduplicate_the_tally) {
  const Session before{SessionId{"ses_evidence1"}, UserId{"u1"}, kMon4Aug2025,
                       kMon4Aug2025 + 9000, std::nullopt, PlanSnapshot{"Push A", {}}};
  Session after = before;
  after.plan->routineName = "Renamed";
  ReadReceipt first;
  first.sawSession(before.id, before.startedAtMs);
  first.observed(SessionObservation{"list_sessions", before, ReadCoverage::summary, 0,
                                     WorkoutObservation{before, 2, 800}});
  ReadReceipt second;
  second.sawSession(after.id, after.startedAtMs);
  second.observed(SessionObservation{"get_session", after, ReadCoverage::session, 3,
                                      WorkoutObservation{after, 2, 900}});

  ReadReceipt run;
  run.merge(first);
  run.merge(second);
  run.merge(first);
  CHECK_EQ(run.tally(), (ReadTally{0, 1, 1}));
  CHECK_EQ(run.observations(), (std::vector<SessionObservation>{
      first.observations()[0], second.observations()[0], first.observations()[0]}));
  CHECK_EQ(run.observations()[0].routine, std::optional<std::string>{"Push A"});
  CHECK_EQ(run.observations()[1].routine, std::optional<std::string>{"Renamed"});
}
