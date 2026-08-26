#include "products/gym/domain/Bodyweight.h"

#include <cmath>
#include <ctime>
#include <utility>

namespace wm::gym {

namespace {
constexpr std::uint64_t kDayMs = 86'400'000;

bool digitsAt(std::string_view text, std::size_t from, std::size_t count) {
  for (std::size_t at = from; at < from + count; ++at)
    if (text[at] < '0' || text[at] > '9') return false;
  return true;
}

int numberAt(std::string_view text, std::size_t from, std::size_t count) {
  int value = 0;
  for (std::size_t at = from; at < from + count; ++at) value = value * 10 + (text[at] - '0');
  return value;
}

int daysIn(int year, int month) {
  if (month == 2) {
    const bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    return leap ? 29 : 28;
  }
  if (month == 4 || month == 6 || month == 9 || month == 11) return 30;
  return 31;
}
}

bool wellFormedLocalDate(std::string_view text) {
  if (text.size() != 10 || text[4] != '-' || text[7] != '-') return false;
  if (!digitsAt(text, 0, 4) || !digitsAt(text, 5, 2) || !digitsAt(text, 8, 2)) return false;
  const int year = numberAt(text, 0, 4);
  const int month = numberAt(text, 5, 2);
  const int day = numberAt(text, 8, 2);
  if (year < 1) return false;   // there is no year zero, and the column agrees
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysIn(year, month);
}

bool beyondTomorrowUtc(std::string_view dateLocal, std::uint64_t nowMs) {
  const std::time_t tomorrow = static_cast<std::time_t>((nowMs + kDayMs) / 1000);
  std::tm utc{};
  gmtime_r(&tomorrow, &utc);
  char day[11];
  std::strftime(day, sizeof(day), "%Y-%m-%d", &utc);
  return dateLocal > std::string_view(day);
}

Bodyweight::Bodyweight(UserId user, std::string dateLocal, double weightKg,
                       std::uint64_t recordedAtMs)
    : user(std::move(user)), dateLocal(std::move(dateLocal)),
      weightKg(std::round(weightKg * 100.0) / 100.0), recordedAtMs(recordedAtMs) {
  if (this->user.empty()) throw InvalidTraining("a weigh-in belongs to an account");
  if (!wellFormedLocalDate(this->dateLocal)) throw InvalidTraining("could not read that date");
  // Bounded after the rounding, as the column checks the value it stores.
  if (!std::isfinite(this->weightKg) || this->weightKg < kMinBodyweightKg ||
      this->weightKg > kMaxBodyweightKg)
    throw InvalidTraining("Between 20 and 400 kg — check the number.");
  if (recordedAtMs == 0 || recordedAtMs > kMaxInstantMs)
    throw InvalidTraining("could not read that weigh-in");
}

}
