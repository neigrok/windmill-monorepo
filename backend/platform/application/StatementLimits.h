#pragma once

#include "platform/ports/Clock.h"

#include <chrono>
#include <cstdint>
#include <stdexcept>

namespace wm {

// A borrow made once a scope's deadline had passed: no statement was sent.
struct StatementDeadlinePassed : std::runtime_error {
  StatementDeadlinePassed() : std::runtime_error("the statements' deadline has passed") {}
};

// While one is open on a thread, every statement that thread sends waits for a lock at most `lockWait` and runs no later
// than the deadline, `deadlineMs` on `clock`: the Postgres pool applies both to each connection borrowed meanwhile
// (PgLease) and refuses a borrow past the deadline. Work that must answer in bounded time opens one around its
// statements. A scope opened inside another holds until it closes, when the outer one holds again.
class StatementLimits {
public:
  StatementLimits(std::chrono::milliseconds lockWait, Clock& clock, std::uint64_t deadlineMs);
  ~StatementLimits();
  StatementLimits(const StatementLimits&) = delete;
  StatementLimits& operator=(const StatementLimits&) = delete;

  // The scope open on this thread, or none.
  static const StatementLimits* current();

  std::chrono::milliseconds lockWait() const { return lockWait_; }
  // What is left of the time before the deadline: zero once it has passed.
  std::chrono::milliseconds remaining() const;

private:
  std::chrono::milliseconds lockWait_;
  Clock& clock_;
  std::uint64_t deadlineMs_;
  const StatementLimits* outer_;
};

}
