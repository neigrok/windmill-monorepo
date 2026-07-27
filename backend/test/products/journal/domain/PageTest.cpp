#include "products/journal/domain/Page.h"
#include "test/testing.h"

using namespace wm;

// LocalDate has no throwing observer, so a rejection is proven by constructing one and catching
// InvalidPage — true means the shape was refused at the boundary before it could become a row.
namespace {
bool rejects(const std::string& iso) {
  try {
    LocalDate day{iso};
    (void)day;
    return false;
  } catch (const InvalidPage&) {
    return true;
  }
}
}

TEST(local_date_accepts_iso_days) {
  CHECK_EQ(LocalDate{"2026-07-27"}.iso(), std::string("2026-07-27"));
  CHECK_EQ(LocalDate{"2000-01-01"}.iso(), std::string("2000-01-01"));
  CHECK_EQ(LocalDate{"2026-12-31"}.iso(), std::string("2026-12-31"));
}

TEST(local_date_rejects_malformed_shapes) {
  CHECK(rejects("2026-07-2"));     // too short
  CHECK(rejects("2026-07-277"));   // too long
  CHECK(rejects("2026/07/27"));    // missing dashes
  CHECK(rejects("20x6-07-27"));    // non-digit in the year
  CHECK(rejects("2026-00-15"));    // month 00
  CHECK(rejects("2026-13-15"));    // month 13
  CHECK(rejects("2026-07-00"));    // day 00
  CHECK(rejects("2026-07-32"));    // day 32
  CHECK(rejects("2026-7-1"));      // unpadded fields
}

TEST(mood_from_int_clamps_out_of_range_to_none) {
  CHECK_EQ(moodFromInt(0), Mood::none);
  CHECK_EQ(moodFromInt(1), Mood::m1);
  CHECK_EQ(moodFromInt(2), Mood::m2);
  CHECK_EQ(moodFromInt(3), Mood::m3);
  CHECK_EQ(moodFromInt(4), Mood::m4);
  CHECK_EQ(moodFromInt(5), Mood::m5);
  CHECK_EQ(moodFromInt(6), Mood::none);
  CHECK_EQ(moodFromInt(-1), Mood::none);
}

TEST(energy_from_int_clamps_out_of_range_to_none) {
  CHECK_EQ(energyFromInt(0), Energy::none);
  CHECK_EQ(energyFromInt(1), Energy::e1);
  CHECK_EQ(energyFromInt(2), Energy::e2);
  CHECK_EQ(energyFromInt(3), Energy::e3);
  CHECK_EQ(energyFromInt(4), Energy::none);
  CHECK_EQ(energyFromInt(-1), Energy::none);
}

TEST(source_parses_spoken_else_typed) {
  CHECK_EQ(parseSource("spoken"), Source::spoken);
  CHECK_EQ(parseSource("typed"), Source::typed);
  CHECK_EQ(parseSource(""), Source::typed);
  CHECK_EQ(parseSource("SPOKEN"), Source::typed);   // exact match only
}

TEST(enum_int_and_string_round_trips) {
  for (int v = 0; v <= 5; ++v) CHECK_EQ(toInt(moodFromInt(v)), v);
  for (int v = 0; v <= 3; ++v) CHECK_EQ(toInt(energyFromInt(v)), v);
  CHECK_EQ(toString(Source::spoken), std::string("spoken"));
  CHECK_EQ(toString(Source::typed), std::string("typed"));
  CHECK_EQ(parseSource(toString(Source::spoken)), Source::spoken);
  CHECK_EQ(parseSource(toString(Source::typed)), Source::typed);
}
