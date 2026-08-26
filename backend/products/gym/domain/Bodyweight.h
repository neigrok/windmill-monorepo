#pragma once

#include "products/gym/domain/Training.h"

#include <cstdint>
#include <string>
#include <string_view>

namespace wm::gym {

// The band a weigh-in lives in, in kilograms. The column's CHECK carries the same two numbers and
// the weigh-in sheet's refusal states them; a bound moved here moves there.
constexpr double kMinBodyweightKg = 20.0;
constexpr double kMaxBodyweightKg = 400.0;

// A weigh-in: one number for one LOCAL calendar day. The day is the identity — a second write to
// the same day is a correction, never a second row — so the date is the lifter's own calendar,
// never the server's, and never an instant. `recordedAtMs` is the device's clock at the save: it
// can support an omission and never an assertion, so it decides only which of two writes to one
// day is newer (the later one wins) and is otherwise nobody's fact. Kilograms to two decimals, as
// the column stores them.
struct Bodyweight {
  UserId user;
  std::string dateLocal;   // YYYY-MM-DD, a real calendar date
  double weightKg;
  std::uint64_t recordedAtMs;

  // Rounds the weight to two decimals, then refuses: a date that is not a real calendar day, a
  // weight outside [kMinBodyweightKg, kMaxBodyweightKg] (or not a finite number), an instant
  // outside (0, kMaxInstantMs]. The sentences are the wire's own 400s, forwarded verbatim.
  Bodyweight(UserId user, std::string dateLocal, double weightKg, std::uint64_t recordedAtMs);

  bool operator==(const Bodyweight&) const = default;
};

// Whether `text` is a real calendar day written `YYYY-MM-DD`: four digits, two, two, years 0001 to
// 9999, months 1 to 12, days inside that month (leap years included). The one rule for the row's
// key, a range bound and an export column alike.
bool wellFormedLocalDate(std::string_view text);

// Whether `dateLocal` (well-formed) lies more than one calendar day past the UTC day `nowMs` falls
// in. The server's forecast gate: a lifter's local today runs at most a day ahead of UTC, so a day
// past UTC tomorrow was nobody's today and is refused, while no honest local today ever is. Days
// written YYYY-MM-DD order as text.
bool beyondTomorrowUtc(std::string_view dateLocal, std::uint64_t nowMs);

}
