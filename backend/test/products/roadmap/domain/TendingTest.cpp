#include "products/roadmap/domain/Tending.h"

#include "test/testing.h"

using namespace wm;

namespace {
// Exact UTC epoch-ms vectors.
constexpr std::uint64_t k2026_07_01 = 1782864000000ull;  // 2026-07-01T00:00:00Z
constexpr std::uint64_t k2026_07_20_noon = 1784548800000ull;  // 2026-07-20T12:00:00Z
constexpr std::uint64_t k2026_08_01 = 1785542400000ull;  // 2026-08-01T00:00:00Z
constexpr std::uint64_t k2026_12_15 = 1797292800000ull;  // 2026-12-15T00:00:00Z
constexpr std::uint64_t k2026_12_01 = 1796083200000ull;  // 2026-12-01T00:00:00Z
constexpr std::uint64_t k2027_01_01 = 1798761600000ull;  // 2027-01-01T00:00:00Z
}

TEST(monthly_limit_is_thirty_free_and_three_hundred_pro) {
  CHECK_EQ(monthlyLimitFor(Plan::free), 30);
  CHECK_EQ(monthlyLimitFor(Plan::pro), 300);
}

TEST(an_allowance_permits_until_the_limit_is_reached) {
  CHECK((TendingAllowance{Plan::free, 30, 0}.allows()));
  CHECK((TendingAllowance{Plan::free, 30, 29}.allows()));
  CHECK((!TendingAllowance{Plan::free, 30, 30}.allows()));
  CHECK((!TendingAllowance{Plan::free, 30, 31}.allows()));
  CHECK((TendingAllowance{Plan::pro, 300, 299}.allows()));
  CHECK((!TendingAllowance{Plan::pro, 300, 300}.allows()));
}

TEST(remaining_counts_down_and_never_goes_negative) {
  CHECK_EQ((TendingAllowance{Plan::free, 30, 0}.remaining()), 30);
  CHECK_EQ((TendingAllowance{Plan::free, 30, 18}.remaining()), 12);
  CHECK_EQ((TendingAllowance{Plan::free, 30, 30}.remaining()), 0);
  CHECK_EQ((TendingAllowance{Plan::free, 30, 44}.remaining()), 0);  // over-spend floors at zero
}

TEST(month_start_is_the_first_midnight_of_the_instants_month) {
  CHECK_EQ(monthStartMsUtc(k2026_07_20_noon), k2026_07_01);
  CHECK_EQ(monthStartMsUtc(k2026_07_01), k2026_07_01);  // an instant already at the boundary is its own start
  CHECK_EQ(monthStartMsUtc(k2026_12_15), k2026_12_01);
}

TEST(next_month_start_is_the_reset_instant) {
  CHECK_EQ(nextMonthStartMsUtc(k2026_07_20_noon), k2026_08_01);
  CHECK_EQ(nextMonthStartMsUtc(k2026_07_01), k2026_08_01);
}

TEST(december_rolls_the_reset_into_january_of_the_next_year) {
  CHECK_EQ(nextMonthStartMsUtc(k2026_12_15), k2027_01_01);
  CHECK_EQ(monthStartMsUtc(k2027_01_01), k2027_01_01);
}
