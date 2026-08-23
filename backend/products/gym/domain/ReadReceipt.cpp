#include "products/gym/domain/ReadReceipt.h"

namespace wm::gym {

std::uint64_t weekStartMs(std::uint64_t atMs) {
  // The epoch was a Thursday, so the instant shifts three days forward before it is floored to a
  // week and shifts back — the same walk `date_trunc('week', ts AT TIME ZONE 'UTC')` makes. Signed
  // throughout and clamped, so the first week of 1970 cannot come back as a negative bucket.
  constexpr long long kWeekMs = 604'800'000;
  constexpr long long kEpochToMonday = 259'200'000;
  const long long shifted = static_cast<long long>(atMs) + kEpochToMonday;
  const long long start = (shifted / kWeekMs) * kWeekMs - kEpochToMonday;
  return start < 1 ? 1 : static_cast<std::uint64_t>(start);
}

void ReadReceipt::sawSet(const SetId& id, std::uint64_t completedAtMs) {
  sets_.insert(id.str());
  weeks_.insert(weekStartMs(completedAtMs));
}

void ReadReceipt::sawSession(const SessionId& id, std::uint64_t startedAtMs) {
  sessions_.insert(id.str());
  weeks_.insert(weekStartMs(startedAtMs));
}

void ReadReceipt::sawWeek(std::uint64_t weekStartedAtMs) { weeks_.insert(weekStartMs(weekStartedAtMs)); }

void ReadReceipt::merge(const ReadReceipt& other) {
  sets_.insert(other.sets_.begin(), other.sets_.end());
  sessions_.insert(other.sessions_.begin(), other.sessions_.end());
  weeks_.insert(other.weeks_.begin(), other.weeks_.end());
}

ReadTally ReadReceipt::tally() const {
  return ReadTally{static_cast<int>(sets_.size()), static_cast<int>(sessions_.size()),
                   static_cast<int>(weeks_.size())};
}

}
