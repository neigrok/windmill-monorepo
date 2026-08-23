#pragma once

#include <deque>
#include <mutex>
#include <utility>

namespace wm {

// Process-wide spend fuse: a trailing-window accumulator in memory, with no database behind it.
// Every adapter adds what it spent and asks before it calls; over the ceiling, refuse the vendor
// call and report it once through FailureReporter. Safe to call from several loop threads at once.
class AiFuse {
public:
  explicit AiFuse(long long ceilingNanos, long long windowMs = 3'600'000);

  // Takes the clock because it must prune before it answers, or the window latches shut.
  bool allows(long long atMs) const;
  void spent(long long nanos, long long atMs);
  long long trailingNanos(long long atMs) const;

  // True once it has ever refused, so the alert is sent once rather than on every blocked call.
  bool tripped() const;

private:
  // Pruning happens on reads as well as writes, so the state is mutable and every entry point
  // holds the mutex.
  void dropOlderThan(long long cutoffMs) const;

  mutable std::mutex mutex_;
  mutable std::deque<std::pair<long long, long long>> samples_;
  long long ceilingNanos_;
  long long windowMs_;
  mutable long long trailingNanos_ = 0;
  mutable bool tripped_ = false;
};

// $20 an hour across the whole process.
constexpr long long kHourlyFuseNanos = 20'000'000'000;

}
