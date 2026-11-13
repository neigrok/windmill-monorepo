#include "platform/application/StatementLimits.h"

namespace wm {

namespace {
thread_local const StatementLimits* open = nullptr;
}

StatementLimits::StatementLimits(std::chrono::milliseconds lockWait, Clock& clock, std::uint64_t deadlineMs)
    : lockWait_(lockWait), clock_(clock), deadlineMs_(deadlineMs), outer_(open) {
  open = this;
}

StatementLimits::~StatementLimits() { open = outer_; }

const StatementLimits* StatementLimits::current() { return open; }

std::chrono::milliseconds StatementLimits::remaining() const {
  const std::uint64_t now = clock_.nowMs();
  return std::chrono::milliseconds{now >= deadlineMs_ ? 0 : deadlineMs_ - now};
}

}
