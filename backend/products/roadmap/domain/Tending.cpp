#include "products/roadmap/domain/Tending.h"

#include <cstdint>

namespace wm {

namespace {
// Days since 1970-01-01 for a civil (y,m,d), and its inverse — Howard Hinnant's public-domain
// algorithms (howardhinnant.github.io/date_algorithms.html). Pure integer math: no <ctime>, no
// timezone, no dependence on the platform's <chrono> calendar, so the month window is byte-identical
// on the mac dev box and on CI Linux.
constexpr std::int64_t kMsPerDay = 86'400'000;

std::int64_t daysFromCivil(std::int64_t y, unsigned m, unsigned d) {
  y -= m <= 2;
  const std::int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<std::int64_t>(doe) - 719468;
}

struct Civil {
  std::int64_t y;
  unsigned m;
};

Civil civilFromDays(std::int64_t z) {
  z += 719468;
  const std::int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const std::int64_t y = static_cast<std::int64_t>(yoe) + era * 400;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  const unsigned m = mp + (mp < 10 ? 3 : -9);
  return {y + (m <= 2), m};
}
}

std::uint64_t monthStartMsUtc(std::uint64_t nowMs) {
  const Civil c = civilFromDays(static_cast<std::int64_t>(nowMs / kMsPerDay));
  return static_cast<std::uint64_t>(daysFromCivil(c.y, c.m, 1) * kMsPerDay);
}

std::uint64_t nextMonthStartMsUtc(std::uint64_t nowMs) {
  const Civil c = civilFromDays(static_cast<std::int64_t>(nowMs / kMsPerDay));
  const std::int64_t y = c.m == 12 ? c.y + 1 : c.y;
  const unsigned m = c.m == 12 ? 1 : c.m + 1;
  return static_cast<std::uint64_t>(daysFromCivil(y, m, 1) * kMsPerDay);
}

}
