#include "products/journal/domain/Page.h"
#include "test/testing.h"

#include <optional>
#include <string>

using namespace wm;

// Neither LocalDate nor Score has a throwing observer, so a rejection is proven by constructing
// one and catching InvalidPage.
namespace {
bool throwsScore(int value) {
  try {
    Score score{value};
    (void)score;
    return false;
  } catch (const InvalidPage&) {
    return true;
  }
}

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

TEST(local_date_rejects_days_the_calendar_does_not_have) {
  CHECK(rejects("2026-02-29"));   // 2026 is not a leap year
  CHECK(rejects("2026-02-31"));
  CHECK(rejects("2026-04-31"));   // April has 30
  CHECK(rejects("2026-06-31"));
  CHECK(rejects("2026-09-31"));
  CHECK(rejects("2026-11-31"));
  CHECK(rejects("1900-02-29"));   // divisible by 100, not by 400
  CHECK(rejects("2100-02-29"));
}

TEST(local_date_keeps_the_leap_days_that_exist) {
  CHECK_EQ(LocalDate{"2024-02-29"}.iso(), std::string("2024-02-29"));   // divisible by 4
  CHECK_EQ(LocalDate{"2000-02-29"}.iso(), std::string("2000-02-29"));   // divisible by 400
  CHECK_EQ(LocalDate{"2026-02-28"}.iso(), std::string("2026-02-28"));
  CHECK_EQ(LocalDate{"2026-01-31"}.iso(), std::string("2026-01-31"));
  CHECK_EQ(LocalDate{"2026-04-30"}.iso(), std::string("2026-04-30"));
}

TEST(local_date_rejects_the_year_that_is_not_a_year) {
  CHECK(rejects("0000-01-01"));
  CHECK(rejects("0000-12-31"));
  // 0001-01-01 stands: it is the open-ended window every echo read sends as `from`.
  CHECK_EQ(LocalDate{"0001-01-01"}.iso(), std::string("0001-01-01"));
  CHECK_EQ(LocalDate{"9999-12-31"}.iso(), std::string("9999-12-31"));
}

TEST(score_accepts_every_step_of_the_scale) {
  for (int v = 0; v <= 10; ++v) CHECK_EQ(Score{v}.value(), v);
  CHECK_EQ(Score{0}.value(), 0);
  CHECK_EQ(Score{10}.value(), 10);
}

TEST(score_constructor_throws_outside_the_scale) {
  CHECK(throwsScore(-1));
  CHECK(throwsScore(11));
  CHECK(throwsScore(-100));
  CHECK(throwsScore(1000));
  CHECK_FALSE(throwsScore(0));
  CHECK_FALSE(throwsScore(10));
}

TEST(score_from_narrows_out_of_range_to_unset) {
  CHECK_EQ(Score::from(-1), std::optional<Score>{});
  CHECK_EQ(Score::from(11), std::optional<Score>{});
  CHECK_EQ(Score::from(-2147483647), std::optional<Score>{});
  CHECK_EQ(Score::from(2147483647), std::optional<Score>{});
  for (int v = 0; v <= 10; ++v) CHECK_EQ(Score::from(v), std::optional<Score>{Score{v}});
}

// Zero is an answer and unset is the absence of one; nothing in the domain may conflate them.
TEST(score_zero_is_not_the_unset_state) {
  const std::optional<Score> zero = Score::from(0);
  const std::optional<Score> unset = Score::from(-1);
  CHECK(zero.has_value());
  CHECK_FALSE(unset.has_value());
  CHECK_FALSE(zero == unset);
  CHECK_EQ(zero->value(), 0);
}

TEST(score_orders_by_its_value) {
  CHECK(Score{0} < Score{1});
  CHECK(Score{9} < Score{10});
  CHECK_EQ(Score{7}, Score{7});
  CHECK_FALSE(Score{7} == Score{8});
}

// A default-constructed page has answered neither scale, and both scales are independent.
TEST(a_blank_page_has_both_scales_unset) {
  Page page{UserId{"11111111-1111-1111-1111-111111111111"}, LocalDate{"2026-08-23"}};
  CHECK_EQ(page.mood, std::optional<Score>{});
  CHECK_EQ(page.energy, std::optional<Score>{});
  CHECK_EQ(page.body, std::string(""));
  CHECK_EQ(page.source, Source::typed);
  CHECK_EQ(page.updatedAtMs, 0u);

  page.mood = Score::from(0);
  CHECK_EQ(page.mood, std::optional<Score>{Score{0}});
  CHECK_EQ(page.energy, std::optional<Score>{});
}

TEST(source_parses_spoken_else_typed) {
  CHECK_EQ(parseSource("spoken"), Source::spoken);
  CHECK_EQ(parseSource("typed"), Source::typed);
  CHECK_EQ(parseSource(""), Source::typed);
  CHECK_EQ(parseSource("SPOKEN"), Source::typed);   // exact match only
}

TEST(source_string_round_trips) {
  CHECK_EQ(toString(Source::spoken), std::string("spoken"));
  CHECK_EQ(toString(Source::typed), std::string("typed"));
  CHECK_EQ(parseSource(toString(Source::spoken)), Source::spoken);
  CHECK_EQ(parseSource(toString(Source::typed)), Source::typed);
}
