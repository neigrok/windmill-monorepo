#include "platform/domain/AiFuse.h"

namespace wm {

AiFuse::AiFuse(long long ceilingNanos, long long windowMs)
    : ceilingNanos_(ceilingNanos), windowMs_(windowMs) {}

bool AiFuse::allows(long long atMs) const {
  std::lock_guard<std::mutex> guard{mutex_};
  // Prune FIRST. Reading the running total without dropping what has aged out made this a latch:
  // nothing but spent() pruned, and spent() only runs on a call this gate let through, so one bad
  // hour disabled every seam permanently.
  dropOlderThan(atMs - windowMs_);
  if (trailingNanos_ < ceilingNanos_) return true;
  tripped_ = true;
  return false;
}

void AiFuse::spent(long long nanos, long long atMs) {
  std::lock_guard<std::mutex> guard{mutex_};
  dropOlderThan(atMs - windowMs_);
  samples_.emplace_back(atMs, nanos);
  trailingNanos_ += nanos;
}

long long AiFuse::trailingNanos(long long atMs) const {
  std::lock_guard<std::mutex> guard{mutex_};
  dropOlderThan(atMs - windowMs_);
  return trailingNanos_;
}

bool AiFuse::tripped() const {
  std::lock_guard<std::mutex> guard{mutex_};
  return tripped_;
}

void AiFuse::dropOlderThan(long long cutoffMs) const {
  while (!samples_.empty() && samples_.front().first <= cutoffMs) {
    trailingNanos_ -= samples_.front().second;
    samples_.pop_front();
  }
}

}
