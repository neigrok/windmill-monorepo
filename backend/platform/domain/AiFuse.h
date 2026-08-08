#pragma once

#include <deque>
#include <mutex>
#include <utility>

namespace wm {

// The process-wide spend fuse: a trailing-window accumulator, in memory, guarded by a mutex, with no
// database behind it at all.
//
// Per-user budgets bound what a USER spends. They are structurally blind to what a MACHINE spends —
// a retry storm, a loop whose termination condition breaks, a cron that overlaps itself, a deploy
// that fans out. That is the shape that actually bankrupts a small company, and it is the shape that
// survives a Postgres outage, where failing open means the ledger stops recording and stops
// enforcing in the same instant. This has no such failure mode, because it has no dependency to fail.
//
// Every adapter adds what it spent and asks before it calls. Over the ceiling, refuse the vendor
// call and report it once through FailureReporter — that report IS the alert. Safe to call from
// several event-loop threads at once.
class AiFuse {
public:
  explicit AiFuse(long long ceilingNanos, long long windowMs = 3'600'000);

  bool allows() const;
  void spent(long long nanos, long long atMs);
  long long trailingNanos(long long atMs) const;

  // True once it has ever refused, so the alert is sent once rather than on every blocked call.
  bool tripped() const;

private:
  // Pruning is what makes the window trailing rather than cumulative, and it happens on the read as
  // well as the write — so the state it touches is mutable, and every entry point holds the mutex.
  void dropOlderThan(long long cutoffMs) const;

  mutable std::mutex mutex_;
  mutable std::deque<std::pair<long long, long long>> samples_;
  long long ceilingNanos_;
  long long windowMs_;
  mutable long long trailingNanos_ = 0;
  mutable bool tripped_ = false;
};

// $20 an hour across the whole process. A legitimate hour of real users never comes near it; a
// runaway loop passes it in minutes, which is the entire point.
constexpr long long kHourlyFuseNanos = 20'000'000'000;

}
