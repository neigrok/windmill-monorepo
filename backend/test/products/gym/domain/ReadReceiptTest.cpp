#include "products/gym/domain/ReadReceipt.h"

#include "test/products/gym/Fakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::gym;

namespace {

// Three Mondays and the days around them, so the bucketing is checked against dates a person can
// verify rather than against the formula restated.
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

// The bucket a set falls in has to be the one Postgres already put its week in, or a receipt counts
// one week twice. The store's rule is mirrored in the test fakes; this pins the two together.
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
  // The second read of the same workout — list_sessions named it, get_session then handed it over.
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

// An empty week get_stats hands over is a week we read and answered about — a gap is a fact about a
// program, and the reply carried it.
TEST(a_week_with_no_training_still_counts_as_a_week_read) {
  ReadReceipt receipt;
  receipt.sawWeek(kMon4Aug2025);
  receipt.sawWeek(kMon11Aug2025);
  CHECK_EQ(receipt.tally(), (ReadTally{0, 0, 2}));
}

// THE ONE THAT MATTERS FOR THE LINE A LIFTER READS. Four tool calls answering one question overlap;
// merging by id is why "read 3 sets" is three sets and not the six a sum would have printed.
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
  // …and merging is not destructive to what it read from.
  CHECK_EQ(page.tally(), (ReadTally{0, 2, 2}));
}
