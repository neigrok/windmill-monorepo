#include "products/gym/domain/Bodyweight.h"

#include "test/testing.h"

#include <cmath>
#include <functional>
#include <limits>
#include <string>

using namespace wm;
using namespace wm::gym;

namespace {

// The sentence the constructor refused with, or empty when it built.
std::string refusal(const std::function<void()>& build) {
  try {
    build();
    return "";
  } catch (const InvalidTraining& refused) {
    return refused.what();
  }
}

const UserId kLifter{"lifter"};
constexpr std::uint64_t kSaved = 1'786'000'000'000ull;

Bodyweight weighIn(std::string day, double weightKg, std::uint64_t recordedAtMs = kSaved) {
  return Bodyweight{kLifter, std::move(day), weightKg, recordedAtMs};
}

}  // namespace

TEST(a_weigh_in_is_a_day_a_number_and_the_instant_it_was_saved) {
  const Bodyweight kept = weighIn("2026-08-25", 82.4);

  CHECK_EQ(kept.user, kLifter);
  CHECK_EQ(kept.dateLocal, std::string("2026-08-25"));
  CHECK_EQ(kept.weightKg, 82.4);
  CHECK_EQ(kept.recordedAtMs, kSaved);
  CHECK_EQ(refusal([] { Bodyweight{UserId{}, "2026-08-25", 82.4, kSaved}; }),
           std::string("a weigh-in belongs to an account"));
}

// Two decimals, as the column stores them: the third decimal rounds, half away from zero, and the
// band is checked on the number that will be stored.
TEST(a_weigh_in_rounds_to_two_decimals_and_is_bounded_after_the_rounding) {
  CHECK_EQ(weighIn("2026-08-25", 82.456).weightKg, 82.46);
  CHECK_EQ(weighIn("2026-08-25", 82.454).weightKg, 82.45);
  CHECK_EQ(weighIn("2026-08-25", 82.455).weightKg, 82.46);
  CHECK_EQ(weighIn("2026-08-25", 82.0).weightKg, 82.0);
  CHECK_EQ(weighIn("2026-08-25", 20.0).weightKg, 20.0);
  CHECK_EQ(weighIn("2026-08-25", 400.0).weightKg, 400.0);
  CHECK_EQ(weighIn("2026-08-25", 19.996).weightKg, 20.0);    // rounds into the band
  CHECK_EQ(weighIn("2026-08-25", 400.004).weightKg, 400.0);

  const std::string band = "Between 20 and 400 kg — check the number.";
  CHECK_EQ(refusal([] { weighIn("2026-08-25", 19.99); }), band);
  CHECK_EQ(refusal([] { weighIn("2026-08-25", 19.994); }), band);   // rounds to 19.99, still out
  CHECK_EQ(refusal([] { weighIn("2026-08-25", 400.005); }), band);
  CHECK_EQ(refusal([] { weighIn("2026-08-25", 0.0); }), band);
  CHECK_EQ(refusal([] { weighIn("2026-08-25", -82.4); }), band);
  CHECK_EQ(refusal([] { weighIn("2026-08-25", 182.0); }), std::string(""));   // legal, if unlikely
  CHECK_EQ(refusal([] { weighIn("2026-08-25", std::numeric_limits<double>::quiet_NaN()); }), band);
  CHECK_EQ(refusal([] { weighIn("2026-08-25", std::numeric_limits<double>::infinity()); }), band);
  CHECK_EQ(refusal([] { weighIn("2026-08-25", -std::numeric_limits<double>::infinity()); }), band);
}

// The day is a real calendar day or it is nothing: four digits, two, two, and a day the month has.
TEST(a_weigh_in_needs_a_real_calendar_day) {
  const std::string badDate = "could not read that date";
  CHECK_EQ(refusal([] { weighIn("2026-02-28", 82.4); }), std::string(""));
  CHECK_EQ(refusal([] { weighIn("2024-02-29", 82.4); }), std::string(""));   // leap year
  CHECK_EQ(refusal([] { weighIn("2000-02-29", 82.4); }), std::string(""));   // 400 rule
  CHECK_EQ(refusal([] { weighIn("2026-12-31", 82.4); }), std::string(""));
  CHECK_EQ(refusal([] { weighIn("0001-01-01", 82.4); }), std::string(""));
  CHECK_EQ(refusal([] { weighIn("9999-12-31", 82.4); }), std::string(""));

  CHECK_EQ(refusal([] { weighIn("2026-02-29", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("2100-02-29", 82.4); }), badDate);   // 100 rule
  CHECK_EQ(refusal([] { weighIn("1900-02-29", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("2026-04-31", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("2026-06-31", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("2026-09-31", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("2026-11-31", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("2026-13-01", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("2026-00-10", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("2026-01-00", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("2026-01-32", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("0000-01-01", 82.4); }), badDate);   // there is no year zero
  CHECK_EQ(refusal([] { weighIn("", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("2026-8-25", 82.4); }), badDate);      // not zero-padded
  CHECK_EQ(refusal([] { weighIn("26-08-25", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("2026/08/25", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("20260825", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("2026-08-25T00:00:00Z", 82.4); }), badDate);   // an instant, not a day
  CHECK_EQ(refusal([] { weighIn("2026-08-25 ", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn(" 2026-08-25", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("2026-08-2x", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("today", 82.4); }), badDate);
  CHECK_EQ(refusal([] { weighIn("1786000000000", 82.4); }), badDate);
}

TEST(a_weigh_in_is_saved_at_an_instant_inside_the_stores_band) {
  const std::string unreadable = "could not read that weigh-in";
  CHECK_EQ(refusal([] { weighIn("2026-08-25", 82.4, 0); }), unreadable);
  CHECK_EQ(refusal([] { weighIn("2026-08-25", 82.4, kMaxInstantMs + 1); }), unreadable);
  CHECK_EQ(refusal([] { weighIn("2026-08-25", 82.4, 1); }), std::string(""));
  CHECK_EQ(refusal([] { weighIn("2026-08-25", 82.4, kMaxInstantMs); }), std::string(""));
}

// The three refusals in their order: the day, then the number, then the instant — the order the
// door checks them in, so one bad write earns one sentence.
TEST(a_weigh_in_refuses_the_day_before_the_number_and_the_number_before_the_instant) {
  CHECK_EQ(refusal([] { weighIn("2026-02-30", 500.0, 0); }), std::string("could not read that date"));
  CHECK_EQ(refusal([] { weighIn("2026-02-28", 500.0, 0); }),
           std::string("Between 20 and 400 kg — check the number."));
  CHECK_EQ(refusal([] { weighIn("2026-02-28", 82.4, 0); }),
           std::string("could not read that weigh-in"));
}

// The server's forecast gate: UTC tomorrow is the last day it takes, whatever the hour, so a local
// calendar a day ahead of UTC is never refused and a day past that is never anyone's today.
TEST(beyond_tomorrow_utc_draws_the_line_one_day_past_the_utc_day) {
  constexpr std::uint64_t kFirstMsOf27Aug2026 = 1'787'788'800'000ull;
  constexpr std::uint64_t kLastMsOf27Aug2026 = 1'787'875'199'999ull;
  for (const std::uint64_t now : {kFirstMsOf27Aug2026, kLastMsOf27Aug2026}) {
    CHECK_FALSE(beyondTomorrowUtc("2026-08-27", now));
    CHECK_FALSE(beyondTomorrowUtc("2026-08-28", now));
    CHECK(beyondTomorrowUtc("2026-08-29", now));
    CHECK(beyondTomorrowUtc("2027-01-01", now));
    CHECK_FALSE(beyondTomorrowUtc("2026-08-26", now));
    CHECK_FALSE(beyondTomorrowUtc("0001-01-01", now));
  }
  constexpr std::uint64_t kLastMsOf2026 = 1'798'761'599'999ull;   // 2026-12-31T23:59:59.999Z
  CHECK_FALSE(beyondTomorrowUtc("2027-01-01", kLastMsOf2026));
  CHECK(beyondTomorrowUtc("2027-01-02", kLastMsOf2026));
  CHECK_FALSE(beyondTomorrowUtc("2026-12-31", kLastMsOf2026));
}

TEST(well_formed_local_date_is_the_one_rule_for_a_day_on_the_wire) {
  CHECK(wellFormedLocalDate("2026-08-25"));
  CHECK(wellFormedLocalDate("2024-02-29"));
  CHECK_FALSE(wellFormedLocalDate("2023-02-29"));
  CHECK_FALSE(wellFormedLocalDate("2026-8-25"));
  CHECK_FALSE(wellFormedLocalDate("2026-08-25T10:00"));
  CHECK_FALSE(wellFormedLocalDate(""));
  CHECK_FALSE(wellFormedLocalDate("0000-12-31"));
}
