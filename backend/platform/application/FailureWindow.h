#pragma once

#include "platform/ports/FailureReporter.h"

#include <chrono>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <utility>

namespace wm {

// A handled failure that repeats while its cause lasts — a saturated worker pool, a database refusing a push's bind —
// reported once per window under its static operation, so an outage is one Issue rather than one per request.
class FailureWindow {
public:
  using Now = std::function<std::chrono::steady_clock::time_point()>;

  FailureWindow(FailureReporter& reporter, std::string operation, std::chrono::milliseconds window = std::chrono::minutes(5),
                Now now = [] { return std::chrono::steady_clock::now(); })
      : reporter_(reporter), operation_(std::move(operation)), window_(window), now_(std::move(now)) {}

  // `detail` is a bounded diagnostic, never user content. A report inside the window of the last one sends nothing.
  void report(const std::string& detail) {
    {
      std::lock_guard lock(mutex_);
      const auto at = now_();
      if (last_ && at - *last_ < window_) return;
      last_ = at;
    }
    try {
      reporter_.report("platform", operation_, detail);
    } catch (...) {
    }
  }

private:
  FailureReporter& reporter_;
  const std::string operation_;
  const std::chrono::milliseconds window_;
  const Now now_;
  std::mutex mutex_;
  std::optional<std::chrono::steady_clock::time_point> last_;
};

}
